// Local imports - stream state
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamPhase } from '@shared/schemas';
import { isActivePhase, isInFlightPhase } from '@shared/streams/streamStatus';
import type { TokenUsageStats } from '@shared/schemas/usage';

export interface StatusBarUsageTotals {
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

const ZERO_USAGE: StatusBarUsageTotals = {
  cost: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/**
 * Accumulates the live spend of the streams currently running in a session,
 * for the extension status bar.
 *
 * The phase of each stream is *not* mirrored here: the session status plane
 * that feeds this tracker is also the thing it asks "is this stream in flight"
 * and "how many streams are active", so there is one writer of that fact.
 */
export class StatusBarUsageTracker {
  private readonly usageByStream = new Map<string, StatusBarUsageTotals>();

  constructor(
    private readonly status: Pick<
      SessionHandle['status'],
      'entries' | 'isInFlight'
    >,
  ) {}

  /**
   * Drops a stream's accumulated spend once it leaves flight, so the status bar
   * reports what the running streams have cost rather than a session total.
   */
  public updateStreamStatus(streamId: string, status: StreamPhase): void {
    if (isInFlightPhase(status)) return;
    this.usageByStream.delete(streamId);
  }

  /**
   * Records a per-round usage delta only for streams the session status plane
   * reports as in flight. The runtime publishes the in-flight status before
   * usage for a round; unknown or terminated stream ids are ignored so stale
   * async events cannot recreate completed streams.
   */
  public recordUsage(streamId: string, usage: TokenUsageStats): boolean {
    if (!this.status.isInFlight(streamId)) {
      return false;
    }

    const previous = this.usageByStream.get(streamId) ?? ZERO_USAGE;
    this.usageByStream.set(streamId, {
      cost: previous.cost + usage.cost,
      inputTokens: previous.inputTokens + usage.inputTokens,
      outputTokens: previous.outputTokens + usage.outputTokens,
    });
    return true;
  }

  public get activeStreamCount(): number {
    let count = 0;
    for (const [, phase] of this.status.entries()) {
      if (isActivePhase(phase)) count += 1;
    }
    return count;
  }

  public get totalUsage(): StatusBarUsageTotals {
    const total = { ...ZERO_USAGE };
    for (const usage of this.usageByStream.values()) {
      total.cost += usage.cost;
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
    }
    return total;
  }
}
