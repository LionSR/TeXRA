import type { RunId, SessionEvent } from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { Append } from '@shared/session/sessionEvents';
import type { Effect } from 'effect';

/**
 * The session doors the admission boundary works through, wired by
 * `SessionHandle` over its graph: one serializer, no second append path.
 */
export interface FollowUpRowPort {
  /** One job on the session's publisher: nothing else is written, and no
   *  other job runs, while it does (`SessionGraph.exclusive`). */
  readonly exclusive: <A, E>(
    job: (append: Append) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
  /** Enqueue a job on that publisher and return (`SessionGraph.detach`). */
  readonly detach: (job: Effect.Effect<void>) => void;
  /** The run's pending follow-ups (`SessionEvents.pendingFollowUps`). */
  readonly pending: (runId: RunId) => readonly QueuedFollowUp[];
  /** The run's parent as the session view folds it; `null` at top level. */
  readonly parentOf: (runId: RunId) => RunId | null | undefined;
  /** Every committed row of the run's aggregate. */
  readonly rows: (
    runId: RunId,
  ) => Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
  /**
   * The run aggregate's claim, acquired the way a resume acquires it (prior
   * owners proven dead first): returns the release of what this call took,
   * a no-op when the process already held it.
   */
  readonly acquireClaim: (
    runId: RunId,
  ) => Effect.Effect<Effect.Effect<void, Error>, Error>;
}
