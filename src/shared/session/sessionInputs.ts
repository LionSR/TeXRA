/** Ordered fold inputs shared by the runtime, transport framer, and webview. */
import { Context } from 'effect';
import type {
  CommitOrdinal,
  FoldInput,
  TranscriptSubscription,
} from '@shared/schemas';
import type { Stream } from 'effect';

export class SessionInputs extends Context.Service<
  SessionInputs,
  {
    /** A complete replay batch followed by ordered event, text, and local
     *  batches. A reader never observes a partially collected replay. */
    readonly read: (
      aggregates: readonly TranscriptSubscription[],
      fromCommit: CommitOrdinal,
    ) => Stream.Stream<readonly FoldInput[]>;
  }
>()('@texra/session/SessionInputs') {}
