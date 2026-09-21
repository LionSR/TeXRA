/** The update-check row of the global root, on the process's one handle. */
import { Context, Effect, Layer } from 'effect';
import { GlobalDatabase } from '@shared/session/database';
import { UpdateCheckRecords } from '@shared/session/updateCheckRecords';

export const updateCheckRecordsLayer = Layer.effect(
  UpdateCheckRecords,
  Effect.map(
    GlobalDatabase,
    (database): Context.Service.Shape<typeof UpdateCheckRecords> => ({
      read: (host) => database.readUpdateCheck(host),
      recordChecked: (host, at) =>
        database.recordUpdateCheck(host, { type: 'checked', at }),
      recordNotified: (host, version) =>
        database.recordUpdateCheck(host, { type: 'notified', version }),
    }),
  ),
);
