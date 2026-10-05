/** Update-check persistence configured by the process's host. */
import { Context, type Effect } from 'effect';
import {
  UpdateCheckRecordSchema,
  type UpdateCheckHost,
  type UpdateCheckRecord,
} from '@shared/schemas';
import type { ValueFamily } from './valueFamily';

/** The global root's update-check record of each host, keyed by the host. */
export const UPDATE_CHECKS: ValueFamily<UpdateCheckRecord> = {
  name: 'update-check',
  schema: UpdateCheckRecordSchema,
  deletable: false,
};

export class UpdateCheckRecords extends Context.Service<
  UpdateCheckRecords,
  {
    readonly read: (
      host: UpdateCheckHost,
    ) => Effect.Effect<UpdateCheckRecord | null, Error>;
    readonly recordChecked: (
      host: UpdateCheckHost,
      at: number,
    ) => Effect.Effect<void, Error>;
    readonly recordNotified: (
      host: UpdateCheckHost,
      version: string,
    ) => Effect.Effect<void, Error>;
  }
>()('@texra/UpdateCheckRecords') {}
