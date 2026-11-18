/** Global, bounded CLI input history. Older entries are replaced, not archived. */
import { Cause, Clock, Effect, Fiber, Queue, Result, Stream } from 'effect';
import type { Scope } from 'effect';

import { GlobalDatabase, INPUT_HISTORY_LIMIT } from '@texra-ai/harness/node';
import type { InputHistoryRecord } from '@texra-ai/harness/schemas';

import { writeTextStderr } from '@cli/runtime/platform/logSinks';

/** The longest entry kept: a longer line is cut to this many characters. */
const INPUT_HISTORY_LINE_LIMIT = 4000;

/** Entries submitted and not yet stored. A person submits far slower than
 *  the store appends, so a submit waits for room only while the store is
 *  stuck. */
const PENDING_APPENDS = 64;

export interface InputHistory {
  /**
   * Add a nonempty entry: browsable at once, stored after the entries
   * submitted before it. A failed store is reported on stderr; an adjacent
   * duplicate is not stored again.
   */
  push(line: string): Effect.Effect<void>;
  reverseFind(
    needle: string,
    from?: number,
  ): { value: string; index: number } | undefined;
  at(index: number): string | undefined;
  length(): number;
}

/**
 * The process's global-root handle serves the history; browsing stays
 * synchronous. A stored history that cannot be read is returned as
 * `readFailure` for the caller to say so: this session's history starts
 * empty, and a later push may retry storage.
 *
 * One fiber in the caller's scope stores the entries in the order they were
 * submitted, and the scope's close waits until every submitted entry is
 * stored, so a line typed just before the chat exits is kept.
 */
export const loadInputHistory: Effect.Effect<
  { readonly history: InputHistory; readonly readFailure: Error | null },
  never,
  GlobalDatabase | Scope.Scope
> = Effect.gen(function* () {
  const database = yield* GlobalDatabase;
  const read = yield* Effect.result(database.inputHistory.read);
  let records: readonly InputHistoryRecord[] = Result.isSuccess(read)
    ? read.success
    : [];
  const appends = yield* Queue.bounded<InputHistoryRecord, Cause.Done>(
    PENDING_APPENDS,
  );
  const storing = yield* Stream.fromQueue(appends).pipe(
    Stream.runForEach((record) =>
      // Global adjacency belongs to SQLite, not this CLI's cached view.
      database.inputHistory.append(record).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            writeTextStderr(
              `texra: failed to persist input history: ${String(Cause.squash(cause))}`,
            );
          }),
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Queue.end(appends).pipe(Effect.andThen(Fiber.await(storing))),
  );
  const history: InputHistory = {
    push: (line) =>
      Effect.gen(function* () {
        const value = line.trim().slice(0, INPUT_HISTORY_LINE_LIMIT);
        if (value.length === 0) return;
        const record = { at: yield* Clock.currentTimeMillis, value };
        // Keep submitted text browsable even when storage fails.
        if (records.at(-1)?.value !== value)
          records = [...records, record].slice(-INPUT_HISTORY_LIMIT);
        yield* Queue.offer(appends, record);
      }),
    reverseFind(needle, from) {
      if (!needle) return undefined;
      const start = from === undefined ? records.length - 1 : from - 1;
      for (let i = start; i >= 0; i--) {
        const record = records[i];
        if (record?.value.includes(needle)) {
          return { value: record.value, index: i };
        }
      }
      return undefined;
    },
    at(index) {
      return records[index]?.value;
    },
    length() {
      return records.length;
    },
  };
  return {
    history,
    readFailure: Result.isFailure(read) ? read.failure : null,
  };
});
