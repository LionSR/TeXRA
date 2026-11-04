/** Ordered session view inputs shared by the runtime, transport framer, and
 *  webview. */
import { Context, type Stream } from 'effect';
import type {
  CommitOrdinal,
  SessionViewInput,
  TranscriptSubscription,
} from '@shared/schemas';

export class SessionInputs extends Context.Service<
  SessionInputs,
  {
    /** A complete replay batch followed by ordered event, text, and local
     *  batches. A reader never observes a partially collected replay. */
    readonly read: (
      aggregates: readonly TranscriptSubscription[],
      fromCommit: CommitOrdinal,
      previousDebug: boolean,
    ) => Stream.Stream<readonly SessionViewInput[]>;
  }
>()('@texra-ai/harness/session/SessionInputs') {}
