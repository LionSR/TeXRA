// Local imports
import type { AgentRunHandle } from '@agent/runtime/ExecutionHandle';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import type { SessionHandle } from '@agent/runtime/SessionHandle';

/**
 * What one reviewer session is collecting findings against. Reported issues
 * are validated against this, so it is carried by the run token rather than
 * held beside it: a payload without a current run — or a current run whose
 * payload was cleared behind its back — is unrepresentable.
 */
export interface AgentReviewCollection {
  readonly repoRoot: string;
  readonly baseDescription: string;
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
 * Owns the active Agent Review execution: its stop request, the findings it
 * collects against, and whether its results are still wanted.
 *
 * Token identity plus the discarded bit is the sole currency test — a result
 * or a reported issue is applied only while {@link isCurrent} holds for the
 * token that produced it. `clear()` discards without releasing the slot,
 * because the underlying execution settles on its own schedule.
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

  /** Attach the exact execution handle and replay any earlier stop. */
  bind(run: AgentReviewRunToken, handle: AgentRunHandle): void {
    if (this.activeRun !== run) return;
    run.handle = handle;
    if (run.stopRequested) this.stop(run);
  }

  /** Request one idempotent stop of the active run. */
  requestStop(): boolean {
    const run = this.activeRun;
    if (!run || run.stopRequested) return false;
    run.stopRequested = true;
    this.stop(run);
    return true;
  }

  /** Stop the active run and drop whatever it still produces. */
  discard(): void {
    const run = this.activeRun;
    if (!run) return;
    this.requestStop();
    run.discarded = true;
    run.collection = undefined;
  }

  /** Release the run slot only when the caller still owns it. */
  finish(run: AgentReviewRunToken): boolean {
    if (this.activeRun !== run) return false;
    this.activeRun = undefined;
    return true;
  }

  private stop(run: AgentReviewRunToken): void {
    const handle = run.handle;
    if (!handle) return;
    if (run.session.executions.getHandle(handle.executionId) !== handle) return;
    run.session.executions.stopAgentStream(handle.childStreamId, {
      detachActiveChildren: detachSubagentsOnStop(),
    });
  }
}
