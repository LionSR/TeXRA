/** Global, bounded CLI input history. Older entries are replaced, not archived. */
import { Clock, Effect, Semaphore } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  GlobalDatabase,
  INPUT_HISTORY_LIMIT,
  INPUT_HISTORY_LINE_LIMIT,
  type InputHistoryRecord,
} from '@shared/session/database';

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

/** The process's global-root handle serves the history; browsing stays
 *  synchronous. */
export const loadInputHistory: Effect.Effect<
  InputHistory,
  never,
  GlobalDatabase
> = Effect.gen(function* () {
  const database = yield* GlobalDatabase;
  // History failure must not prevent typing. A subsequent push may retry storage.
  let records: readonly InputHistoryRecord[] = yield* database
    .readInputHistory()
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning('Input history could not be read.').pipe(
          withLogChannel('cli.tui'),
          Effect.annotateLogs({ data: error }),
          Effect.as([]),
        ),
      ),
    );
  const pushes = Semaphore.makeUnsafe(1);
  return {
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
          yield* database.appendInputHistory(record);
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
});
