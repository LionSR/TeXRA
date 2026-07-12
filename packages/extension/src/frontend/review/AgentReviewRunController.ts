// Local imports
import type { AgentRunHandle } from '@agent/runtime/ExecutionHandle';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import type { SessionHandle } from '@agent/runtime/SessionHandle';

export interface AgentReviewRunToken {
  readonly session: SessionHandle;
  handle?: AgentRunHandle;
  stopRequested: boolean;
}

/** Owns the active Agent Review execution and its stop request. */
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

  /** Claim the run slot for one explicit runtime session. */
  start(session: SessionHandle): AgentReviewRunToken {
    if (this.activeRun)
      throw new Error('An Agent Review run is already active.');
    const run: AgentReviewRunToken = { session, stopRequested: false };
    this.activeRun = run;
    return run;
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
      runtimeHost: handle.runtimeHost,
      detachActiveChildren: detachSubagentsOnStop(),
    });
  }
}
