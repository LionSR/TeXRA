// Local imports - stream state
import { isActivePhase, isInFlightPhase } from '@shared/streams/streamStatus';
import {
  DEFAULT_STREAM_METADATA_STATUS,
  type StreamLifecycleStatus,
  type StreamPhase,
} from '@shared/schemas';
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

function lifecyclePhase(
  status: StreamLifecycleStatus,
): StreamPhase | undefined {
  return status === DEFAULT_STREAM_METADATA_STATUS ? undefined : status;
}

/** Tracks active streams and usage totals for the extension status bar. */
export class StatusBarUsageTracker {
  private readonly activeStreams = new Set<string>();
  private readonly streamStatuses = new Map<string, StreamLifecycleStatus>();
  private readonly usageByStream = new Map<string, StatusBarUsageTotals>();

  public updateStreamStatus(
    streamId: string,
    status: StreamLifecycleStatus,
  ): void {
    const phase = lifecyclePhase(status);
    if (isActivePhase(phase)) {
      this.activeStreams.add(streamId);
    } else {
      this.activeStreams.delete(streamId);
    }

    if (!isInFlightPhase(phase)) {
      this.streamStatuses.delete(streamId);
      this.usageByStream.delete(streamId);
      return;
    }

    this.streamStatuses.set(streamId, status);
  }

  /**
   * Records a per-round usage delta only for streams known to be in flight.
   * The runtime emits the in-flight status before usage for a round; unknown or
   * terminated stream ids are ignored so stale async events cannot recreate
   * completed streams.
   */
  public recordUsage(streamId: string, usage: TokenUsageStats): boolean {
    const status = this.streamStatuses.get(streamId);
    if (status === undefined || !isInFlightPhase(lifecyclePhase(status))) {
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
    return this.activeStreams.size;
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
