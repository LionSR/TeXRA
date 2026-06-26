// Local imports - stream state
import {
  isActiveStatus,
  isInFlightStatus,
  isTerminalStatus,
} from '@common/constants/streamStatus';
import type { StreamStatus } from '@shared/schemas/stream';
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

const MAX_TERMINATED_STREAM_GUARDS = 200;

/** Tracks active streams and usage totals for the extension status bar. */
export class StatusBarUsageTracker {
  private readonly activeStreams = new Set<string>();
  private readonly streamStatuses = new Map<string, StreamStatus>();
  private readonly terminatedStreams = new Set<string>();
  private readonly usageByStream = new Map<string, StatusBarUsageTotals>();

  public updateStreamStatus(streamId: string, status: StreamStatus): void {
    if (isActiveStatus(status)) {
      this.activeStreams.add(streamId);
    } else {
      this.activeStreams.delete(streamId);
    }

    if (isTerminalStatus(status) && !isInFlightStatus(status)) {
      this.streamStatuses.delete(streamId);
      this.rememberTerminatedStream(streamId);
      this.usageByStream.delete(streamId);
      return;
    }

    this.terminatedStreams.delete(streamId);
    this.streamStatuses.set(streamId, status);
  }

  /** Records a per-round usage delta; returns false for already-finished streams. */
  public recordUsage(streamId: string, usage: TokenUsageStats): boolean {
    if (this.terminatedStreams.has(streamId)) {
      return false;
    }

    const status = this.streamStatuses.get(streamId);
    if (status !== undefined && !isInFlightStatus(status)) {
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

  private rememberTerminatedStream(streamId: string): void {
    this.terminatedStreams.delete(streamId);
    this.terminatedStreams.add(streamId);

    if (this.terminatedStreams.size <= MAX_TERMINATED_STREAM_GUARDS) return;
    const oldest = this.terminatedStreams.values().next().value;
    if (oldest !== undefined) {
      this.terminatedStreams.delete(oldest);
    }
  }
}
