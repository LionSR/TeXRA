// Local imports - run state
import { SubscriptionRef } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import { sumUsageStats, type TokenUsageStats } from '@shared/schemas';
import type { SessionTitleState } from '@shared/sessionTitle';
import {
  descendantRuns,
  isLiveRun,
  isWorkingRun,
  runTreeUsage,
  sessionActivity,
} from '@shared/session/sessionView';

/**
 * Projects the accumulated spend of the runs currently in flight for the
 * extension status bar.
 *
 * Holds no state of its own: the session's fold is the one reader of which
 * runs are live (`isLiveRun`, the reading every host shares) and carries each
 * run's own metered total (`RunView.usage`); a live tree's total is
 * `runTreeUsage`, the sum every host's session total reads. The pill shows the session's
 * activity (`sessionActivity`, the reading every host's title shares), so a
 * request waiting on the user keeps it on screen; its spinner counts the live
 * runs that are working right now.
 * Both getters read that view live, so a tree leaving flight drops out of
 * the total without any bookkeeping here.
 */
export class StatusBarUsageTracker {
  constructor(private readonly session: Pick<SessionHandle, 'view'>) {}

  public get activity(): SessionTitleState {
    return sessionActivity(SubscriptionRef.getUnsafe(this.session.view));
  }

  public get activeRunCount(): number {
    const { runs } = SubscriptionRef.getUnsafe(this.session.view);
    return [...runs.values()].filter(isWorkingRun).length;
  }

  /** The spend of every run tree still in flight: a root counts, with all
   *  its runs, finished children included, while any run in its tree is
   *  live. A child's spend is on its own run only (`runTreeUsage`). */
  public get totalUsage(): TokenUsageStats {
    const view = SubscriptionRef.getUnsafe(this.session.view);
    const liveTreeRoots = [...view.runs.values()].filter(
      (run) =>
        (run.parentId === null || !view.runs.has(run.parentId)) &&
        descendantRuns(view, run.id, { includeRoot: true }).some((id) => {
          const member = view.runs.get(id);
          return member !== undefined && isLiveRun(member);
        }),
    );
    return sumUsageStats(
      liveTreeRoots.map((root) => runTreeUsage(view, root.id)),
    );
  }
}
