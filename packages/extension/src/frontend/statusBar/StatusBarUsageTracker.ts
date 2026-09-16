// Local imports - run state
import { SubscriptionRef } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import { sumUsageStats, type TokenUsageStats } from '@shared/schemas';
import { isActivePhase, isInFlightPhase } from '@shared/runs/runStatus';
import type { RunView } from '@shared/session/sessionView';

/** A run whose durable phase says in flight but whose owner is gone: the
 *  fold's interrupted reading (5.2), which no durable row records — a crash
 *  leaves RUNNING or WAITING behind. Nothing is spending on it, so it counts
 *  towards neither the spinner nor the in-flight total. */
function ownerLost(run: RunView): boolean {
  return run.group === 'interrupted';
}

/**
 * Projects the accumulated spend of the runs currently in flight for the
 * extension status bar.
 *
 * Holds no state of its own: the session's fold is the one reader of which
 * runs are in flight (`RunView.status` beside the interrupted reading of
 * `RunView.group`) and carries each run's metered total (`RunView.usage`).
 * Both getters read that view live, so a run leaving flight drops out of the
 * total without any bookkeeping here, and the summing rule has a single home
 * (`sumUsageStats`).
 */
export class StatusBarUsageTracker {
  constructor(private readonly session: Pick<SessionHandle, 'view'>) {}

  public get activeRunCount(): number {
    return this.runs.filter(
      (run) => isActivePhase(run.status) && !ownerLost(run),
    ).length;
  }

  public get totalUsage(): TokenUsageStats {
    return sumUsageStats(
      this.runs
        .filter((run) => isInFlightPhase(run.status) && !ownerLost(run))
        .map((run) => run.usage),
    );
  }

  /** The view's runs, in fold order. */
  private get runs(): RunView[] {
    return [...SubscriptionRef.getUnsafe(this.session.view).runs.values()];
  }
}
