/**
 * The session view's shape. The session layer builds it
 * (`makeSessionViewAccess`); its tag is `SessionViewAccess`
 * (`sessionInputs.ts`).
 */

import type {
  LocalRuntimeState,
  ResumeBlocked,
  RunId,
  TranscriptSubscription,
} from '@shared/schemas';
import type { Context, Effect, Stream, SubscriptionRef } from 'effect';
import type { SessionInputs } from './sessionInputs';
import type { RunView, SessionView } from './sessionView';

/**
 * The session's view: the one state every renderer reads, the transport
 * replay it is built from, the transcript subscriptions that decide what it
 * holds, and the local state it keeps beside the rows.
 */
export interface SessionViewAccessShape {
  /** The current view, written only by the fiber that updates it.
   *  Synchronous readers take `SubscriptionRef.getUnsafe(ref)`. */
  readonly ref: SubscriptionRef.SubscriptionRef<SessionView>;
  /** {@link ref} as a stream, ending when the updating fiber does (with its
   *  defect if it died), so a reader waiting on a view never hangs. */
  readonly changes: Stream.Stream<SessionView>;
  /** One run of the current view; its transcript tier is complete only
   *  while some port subscribes the run. */
  run(runId: RunId): RunView | undefined;
  /** The view rebuilt from the log as of this call: the listing tier of
   *  every run and the whole history of the runs named. */
  read(runIds: readonly RunId[]): Effect.Effect<SessionView>;
  /** Ordered view inputs for one transport subscription: complete replay,
   *  then events before live text. */
  readonly inputs: Context.Service.Shape<typeof SessionInputs>['read'];
  /** Replace one port's transcript subscription set; an empty set removes
   *  the port. The view's set is the union over every port. */
  subscribe(
    port: string,
    set: readonly TranscriptSubscription[],
  ): Effect.Effect<void>;
  /** Record what a resume of a run waits for in this process, or null when
   *  nothing blocks it any more: a fact about this process's catalog, never
   *  a row. */
  markResumeBlocked(
    runId: RunId,
    blocked: ResumeBlocked | null,
  ): Effect.Effect<void>;
  /** The runs a resume found blocked here, with what each waits for. */
  resumeBlocks(): LocalRuntimeState['resumeBlocked'];
}
