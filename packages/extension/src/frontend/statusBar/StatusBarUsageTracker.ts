// Local imports - stream state
import type { SessionHandle } from '@agent/runtime';
import { sumUsageStats, type TokenUsageStats } from '@shared/schemas';
import { isActivePhase, isInFlightPhase } from '@shared/streams/streamStatus';

/**
 * Projects the accumulated spend of the streams currently in flight for the
 * extension status bar.
 *
 * Holds no state of its own: the session status plane is the one writer of
 * which streams are in flight, and the session's `StreamSnapshotStore` is the
 * one accumulator of per-run usage. Both getters read those planes live, so
 * a stream leaving flight drops out of the total without any bookkeeping
 * here, and the summing rule has a single home (`sumUsageStats`).
 */
export class StatusBarUsageTracker {
  constructor(
    private readonly status: Pick<
      SessionHandle['status'],
      'getAllStreamStates'
    >,
    private readonly snapshots: Pick<SessionHandle['snapshots'], 'getRunUsage'>,
  ) {}

  public get activeStreamCount(): number {
    let count = 0;
    for (const state of this.status.getAllStreamStates().values()) {
      if (isActivePhase(state.phase)) count += 1;
    }
    return count;
  }

  public get totalUsage(): TokenUsageStats {
    const usages: TokenUsageStats[] = [];
    for (const [streamId, state] of this.status.getAllStreamStates()) {
      if (!isInFlightPhase(state.phase)) continue;
      usages.push(...this.snapshots.getRunUsage(streamId).values());
    }
    return sumUsageStats(usages);
  }
}
