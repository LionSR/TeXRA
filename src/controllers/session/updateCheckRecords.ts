/** Each update-record operation releases SQLite before fetching or notifying. */
import { Effect, Layer } from 'effect';
import { Database } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { UpdateCheckRecords } from '@shared/session/updateCheckRecords';
import { withScopedDatabase } from './Database';

export const updateCheckRecordsLayer = (storagePath: string) =>
  Layer.effect(
    UpdateCheckRecords,
    Effect.gen(function* () {
      const identity = yield* ProcessIdentity;
      const withDatabase = <A, E>(operation: Effect.Effect<A, E, Database>) =>
        withScopedDatabase(storagePath, identity.ownerId, operation);
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
