/** Update-check persistence configured by the process's host. */
import { Context, type Effect } from 'effect';
import type { UpdateCheckHost, UpdateCheckRecord } from '@shared/schemas';

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
