// Local imports - run state
import { SubscriptionRef } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import { sumUsageStats, type TokenUsageStats } from '@shared/schemas';
import { isActivePhase, isInFlightPhase } from '@shared/runs/runStatus';

/**
 * Projects the accumulated spend of the runs currently in flight for the
 * extension status bar.
 *
 * Holds no state of its own: the session's fold is the one reader of which
 * runs are in flight (`RunView.status`) and carries each run's metered
 * total (`RunView.usage`). Both getters read that view live, so a run
 * leaving flight drops out of the total without any bookkeeping here, and
 * the summing rule has a single home (`sumUsageStats`).
 */
export class StatusBarUsageTracker {
  constructor(private readonly session: Pick<SessionHandle, 'view'>) {}

  public get activeRunCount(): number {
    let count = 0;
    for (const run of SubscriptionRef.getUnsafe(
      this.session.view,
    ).runs.values()) {
      if (isActivePhase(run.status)) count += 1;
    }
    return count;
  }

  public get totalUsage(): TokenUsageStats {
    const usages: TokenUsageStats[] = [];
    for (const run of SubscriptionRef.getUnsafe(
      this.session.view,
    ).runs.values()) {
      if (isInFlightPhase(run.status)) usages.push(run.usage);
    }
    return sumUsageStats(usages);
  }
}
