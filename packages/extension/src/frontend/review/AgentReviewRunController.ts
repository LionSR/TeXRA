import { Effect } from 'effect';

// Local imports
import {
  detachSubagentsOnStop,
  type AgentRunHandle,
  type SessionHandle,
} from '@agent/runtime';

/**
 * What one reviewer session is collecting findings against. Reported issues
 * are validated against this, so it is carried by the run token rather than
 * held beside it: a payload without a current run — or a current run whose
 * payload was cleared behind its back — is unrepresentable.
 */
interface AgentReviewCollection {
  readonly repoRoot: string;
  /**
   * Paths in the reviewed diff, already run through
   * `normalizeReviewFilePath` by the collector — `isPathInChangeSet`
   * validates per issue and must not re-normalize the whole list.
   */
  readonly changedFiles: readonly string[];
}

export interface AgentReviewRunToken {
  readonly session: SessionHandle;
  handle?: AgentRunHandle;
  stopRequested: boolean;
  /** Set by {@link AgentReviewRunController.discard}; results are dropped. */
  discarded: boolean;
  collection?: AgentReviewCollection;
}

/**
 * Owns the active Agent Review run: its stop request, the findings it
 * collects against, and whether its results are still wanted.
 *
 * Token identity plus the discarded bit is the sole currency test — a result
 * or a reported issue is applied only while {@link isCurrent} holds for the
 * token that produced it. `clear()` discards without releasing the slot,
 * because the underlying run settles on its own schedule.
 */
export class AgentReviewRunController {
  private activeRun: AgentReviewRunToken | undefined;

  /** Whether a review still owns the service run slot. */
  get isActive(): boolean {
    return this.activeRun !== undefined;
  }

  /** Whether the active run has already accepted a stop request. */
  get stopRequested(): boolean {
    return this.activeRun?.stopRequested ?? false;
  }

  /** What the current run collects findings against, while it wants them. */
  get collection(): AgentReviewCollection | undefined {
    const run = this.activeRun;
    if (!run || run.discarded) return undefined;
    return run.collection;
  }

  /** Claim the run slot for one explicit runtime session. */
  start(session: SessionHandle): AgentReviewRunToken {
    if (this.activeRun)
      throw new Error('An Agent Review run is already active.');
    const run: AgentReviewRunToken = {
      session,
      stopRequested: false,
      discarded: false,
    };
    this.activeRun = run;
    return run;
  }

  /** Whether this run still owns the slot and its results are still wanted. */
  isCurrent(run: AgentReviewRunToken): boolean {
    return this.activeRun === run && !run.discarded;
  }

  /** Open issue collection for a run that is still current. */
  collect(run: AgentReviewRunToken, collection: AgentReviewCollection): void {
    if (!this.isCurrent(run)) return;
    run.collection = collection;
  }

  /** Attach the exact run handle and replay any earlier stop. */
  bind(
    run: AgentReviewRunToken,
    handle: AgentRunHandle,
  ): Effect.Effect<void, Error> {
    if (this.activeRun !== run) return Effect.void;
    run.handle = handle;
    return run.stopRequested ? this.stop(run) : Effect.void;
  }

  /** Request one idempotent stop of the active run. */
  requestStop(): {
    readonly accepted: boolean;
    readonly settlement: Effect.Effect<void, Error>;
  } {
    const run = this.activeRun;
    if (!run || run.stopRequested)
      return { accepted: false, settlement: Effect.void };
    run.stopRequested = true;
    return { accepted: true, settlement: this.stop(run) };
  }

  /** Stop the active run and drop whatever it still produces. */
  discard(): Effect.Effect<void, Error> {
    const run = this.activeRun;
    if (!run) return Effect.void;
    const stop = this.requestStop();
    run.discarded = true;
    run.collection = undefined;
    return stop.settlement;
  }

  /** Release the run slot only when the caller still owns it. */
  finish(run: AgentReviewRunToken): boolean {
    if (this.activeRun !== run) return false;
    this.activeRun = undefined;
    return true;
  }

  /** Fails when the run's stop could not be written: the run is still in
   *  flight, and the caller that asked for it hears so. */
  private stop(run: AgentReviewRunToken): Effect.Effect<void, Error> {
    const handle = run.handle;
    if (!handle) return Effect.void;
    if (run.session.runs.getHandle(handle.runId) !== handle) return Effect.void;
    return run.session.runs.stopAgentRun(handle.runId, {
      detachActiveChildren: detachSubagentsOnStop(),
    });
  }
}
