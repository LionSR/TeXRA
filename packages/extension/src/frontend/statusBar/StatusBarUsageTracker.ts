// Local imports - run state
import type { SessionHandle } from '@agent/runtime';
import { sumUsageStats, type TokenUsageStats } from '@shared/schemas';
import { isActivePhase, isInFlightPhase } from '@shared/runs/runStatus';

/**
 * Projects the accumulated spend of the runs currently in flight for the
 * extension status bar.
 *
 * Holds no state of its own: the session status plane is the one writer of
 * which runs are in flight, and the session's view carries each run's
 * metered total (`RunView.usage`). Both getters read those planes live, so
 * a run leaving flight drops out of the total without any bookkeeping
 * here, and the summing rule has a single home (`sumUsageStats`).
 */
export class StatusBarUsageTracker {
  constructor(
    private readonly status: Pick<SessionHandle['status'], 'getAllRunStates'>,
    private readonly session: Pick<SessionHandle, 'runView'>,
  ) {}

  public get activeRunCount(): number {
    let count = 0;
    for (const state of this.status.getAllRunStates().values()) {
      if (isActivePhase(state.phase)) count += 1;
    }
    return count;
  }

  public get totalUsage(): TokenUsageStats {
    const usages: TokenUsageStats[] = [];
    for (const [runId, state] of this.status.getAllRunStates()) {
      if (!isInFlightPhase(state.phase)) continue;
      const run = this.session.runView(runId);
      if (run) usages.push(run.usage);
    }
    return sumUsageStats(usages);
  }
}
