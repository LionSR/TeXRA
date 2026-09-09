/** Global, bounded CLI input history. Older entries are replaced, not archived. */
import { Clock, Effect, Layer, Result, Semaphore } from 'effect';

import { databaseLayer } from '@controllers/session/Database';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import {
  nodeProcesses,
  processOwnerId,
} from '@platform/defaults/nodeProcesses';
import {
  Database,
  INPUT_HISTORY_LIMIT,
  INPUT_HISTORY_LINE_LIMIT,
  type InputHistoryRecord,
} from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { ensureError } from '@utils/errors/errorMessage';

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

/** Each I/O operation owns its database scope; browsing remains synchronous. */
export const loadInputHistory = (
  globalStorage: () => string,
): Effect.Effect<InputHistory, Error> =>
  Effect.gen(function* () {
    const access = <A, E>(operation: Effect.Effect<A, E, Database>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const ownerId = processOwnerId(
            yield* Effect.tryPromise({
              try: () => nodeProcesses.selfIdentity(),
              catch: ensureError,
            }),
          );

          const storage = yield* Effect.try({
            try: globalStorage,
            catch: ensureError,
          });
          return yield* operation.pipe(
            Effect.provide(
              databaseLayer('persistent').pipe(
                Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
                Layer.provide(ProcessIdentity.layer(ownerId)),
              ),
            ),
          );
        }),
      );
    const read = Effect.flatMap(Database, (database) =>
      database.readInputHistory(),
    );
    // History failure must not prevent typing. A subsequent push may retry storage.
    let records: readonly InputHistoryRecord[] = Result.getOrElse(
      yield* Effect.result(access(read)),
      () => [],
    );
    const pushes = Semaphore.makeUnsafe(1);
    return {
      push: (line) =>
        pushes.withPermit(
          Effect.gen(function* () {
            const value = line.trim().slice(0, INPUT_HISTORY_LINE_LIMIT);
            if (value.length === 0 || records.at(-1)?.value === value) return;
            const record = { at: yield* Clock.currentTimeMillis, value };
            // Keep submitted text browsable even when storage fails.
            records = [...records, record].slice(-INPUT_HISTORY_LIMIT);
            yield* access(
              Effect.gen(function* () {
                const database = yield* Database;
                yield* database.appendInputHistory(record);
              }),
            );
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
