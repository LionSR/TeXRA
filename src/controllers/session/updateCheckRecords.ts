/** The update-check row of the global root, on the process's one handle. */
import { Context, Effect, Layer, Result } from 'effect';
import type { UpdateCheckRecord } from '@shared/schemas';
import { GlobalDatabase } from '@shared/session/database';
import {
  UPDATE_CHECKS,
  UpdateCheckRecords,
} from '@shared/session/updateCheckRecords';

export const updateCheckRecordsLayer = Layer.effect(
  UpdateCheckRecords,
  Effect.map(
    GlobalDatabase,
    ({ values }): Context.Service.Shape<typeof UpdateCheckRecords> => {
      const record = (
        host: string,
        change: (current: UpdateCheckRecord) => UpdateCheckRecord,
      ) =>
        values.modify(UPDATE_CHECKS, host, (current) =>
          Result.succeed([
            undefined,
            change(
              current ?? { lastCheckedAt: null, lastNotifiedVersion: null },
            ),
          ] as const),
        );
      return {
        read: (host) =>
          Effect.map(
            values.get(UPDATE_CHECKS, host),
            (current) => current ?? null,
          ),
        recordChecked: (host, at) =>
          record(host, (current) => ({ ...current, lastCheckedAt: at })),
        recordNotified: (host, version) =>
          record(host, (current) => ({
            ...current,
            lastNotifiedVersion: version,
          })),
      };
    },
  ),
);
