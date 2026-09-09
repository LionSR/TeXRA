/** Each update-record operation releases SQLite before fetching or notifying. */
import { Effect, Layer } from 'effect';
import { Database } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { UpdateCheckRecords } from '@shared/session/updateCheckRecords';
import { ensureError } from '@utils/errors/errorMessage';
import { databaseLayer } from './Database';
import { WorkspaceRoots } from './WorkspaceRoots';

export const updateCheckRecordsLayer = (storagePath: () => string) =>
  Layer.effect(
    UpdateCheckRecords,
    Effect.gen(function* () {
      const identity = yield* ProcessIdentity;
      const withDatabase = <A, E>(operation: Effect.Effect<A, E, Database>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Effect.try({
              try: storagePath,
              catch: ensureError,
            });
            return yield* operation.pipe(
              Effect.provide(
                databaseLayer('persistent').pipe(
                  Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
                  Layer.provide(Layer.succeed(ProcessIdentity)(identity)),
                ),
              ),
            );
          }),
        );
      return {
        read: (host) =>
          withDatabase(
            Effect.flatMap(Database, (db) => db.readUpdateCheck(host)),
          ),
        recordChecked: (host, at) =>
          withDatabase(
            Effect.flatMap(Database, (db) =>
              db.recordUpdateCheck(host, { type: 'checked', at }),
            ),
          ),
        recordNotified: (host, version) =>
          withDatabase(
            Effect.flatMap(Database, (db) =>
              db.recordUpdateCheck(host, { type: 'notified', version }),
            ),
          ),
      };
    }),
  );
