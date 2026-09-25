// Local imports - run state
import { SubscriptionRef } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import { sumUsageStats, type TokenUsageStats } from '@shared/schemas';
import { isActivePhase } from '@shared/runs/runStatus';
import { isLiveRun, type RunView } from '@shared/session/sessionView';

/**
 * Projects the accumulated spend of the runs currently in flight for the
 * extension status bar.
 *
 * Holds no state of its own: the session's fold is the one reader of which
 * runs are live (`isLiveRun`, the reading every host shares; an interrupted
 * run spends nothing, so it counts towards neither figure) and carries each
 * run's metered total (`RunView.usage`). The spinner counts the live runs
 * that are working right now, not an idle conversation waiting for input.
 * Both getters read that view live, so a run leaving flight drops out of the
 * total without any bookkeeping here, and the summing rule has a single home
 * (`sumUsageStats`).
 */
export class StatusBarUsageTracker {
  constructor(private readonly session: Pick<SessionHandle, 'view'>) {}

  public get activeRunCount(): number {
    return this.runs.filter(
      (run) => isLiveRun(run) && isActivePhase(run.status),
    ).length;
  }

  public get totalUsage(): TokenUsageStats {
    return sumUsageStats(this.runs.filter(isLiveRun).map((run) => run.usage));
  }

  /** The view's runs, in fold order. */
  private get runs(): RunView[] {
    return [...SubscriptionRef.getUnsafe(this.session.view).runs.values()];
  }
}
