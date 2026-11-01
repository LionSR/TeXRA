/** Ordered session view inputs shared by the runtime, transport framer, and
 *  webview, and the session view built over them. */
import { Context } from 'effect';
import type {
  CommitOrdinal,
  SessionViewInput,
  TranscriptSubscription,
} from '@shared/schemas';
import type { Stream } from 'effect';
import type { SessionViewAccessShape } from './sessionViewAccess';

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

/** The session's view: the one state every renderer reads, and the local
 *  state it keeps beside the rows. */
export class SessionViewAccess extends Context.Service<
  SessionViewAccess,
  SessionViewAccessShape
>()('@texra-ai/harness/session/SessionViewAccess') {}
