/** Global, bounded CLI input history. Older entries are replaced, not archived. */
import { Clock, Effect, Result, Semaphore } from 'effect';

import { GlobalDatabase, INPUT_HISTORY_LIMIT } from '@texra-ai/harness/node';
import type { InputHistoryRecord } from '@texra-ai/harness/schemas';

/** The longest entry kept: a longer line is cut to this many characters. */
const INPUT_HISTORY_LINE_LIMIT = 4000;

export interface InputHistory {
  /** Persist a nonempty entry, suppressing an adjacent duplicate. */
  push(line: string): Effect.Effect<void, Error>;
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
 */
export const loadInputHistory: Effect.Effect<
  { readonly history: InputHistory; readonly readFailure: Error | null },
  never,
  GlobalDatabase
> = Effect.gen(function* () {
  const database = yield* GlobalDatabase;
  const read = yield* Effect.result(database.inputHistory.read);
  let records: readonly InputHistoryRecord[] = Result.isSuccess(read)
    ? read.success
    : [];
  const pushes = Semaphore.makeUnsafe(1);
  const history: InputHistory = {
    push: (line) =>
      pushes.withPermit(
        Effect.gen(function* () {
          const value = line.trim().slice(0, INPUT_HISTORY_LINE_LIMIT);
          if (value.length === 0) return;
          const record = { at: yield* Clock.currentTimeMillis, value };
          // Keep submitted text browsable even when storage fails.
          if (records.at(-1)?.value !== value)
            records = [...records, record].slice(-INPUT_HISTORY_LIMIT);
          // Global adjacency belongs to SQLite, not this CLI's cached view.
          yield* database.inputHistory.append(record);
        }),
      ),
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
