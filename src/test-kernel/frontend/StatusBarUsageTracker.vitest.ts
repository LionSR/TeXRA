// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - stream state
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { StatusBarUsageTracker } from '@frontend/statusBar/StatusBarUsageTracker';
import { STREAM_PHASE, type TokenUsageStats } from '@shared/schemas';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';

/**
 * The tracker holds no state: it projects from the session status plane and
 * the per-run usage accumulated by the snapshot store, stubbed here as the
 * `getRunUsage` read the real store serves.
 */
function trackerOverStatusPlane(): {
  status: StreamStatusMachine;
  usageByStream: Map<string, Map<string, TokenUsageStats>>;
  tracker: StatusBarUsageTracker;
} {
  const status = new StreamStatusMachine(new SessionEventHub());
  const usageByStream = new Map<string, Map<string, TokenUsageStats>>();
  const tracker = new StatusBarUsageTracker(status, {
    getRunUsage: (stream) => usageByStream.get(stream) ?? new Map(),
  });
  return { status, usageByStream, tracker };
}

function startStream(status: StreamStatusMachine, streamId: string): void {
  status.transition(
    streamId,
    STREAM_PHASE.RUNNING,
    STREAM_TRANSITION_CAUSE.LIFECYCLE,
  );
}

function setRunUsage(
  usageByStream: Map<string, Map<string, TokenUsageStats>>,
  streamId: string,
  runs: Record<string, TokenUsageStats>,
): void {
  usageByStream.set(streamId, new Map(Object.entries(runs)));
}

describe('StatusBarUsageTracker', () => {
  it('reports zero usage for streams without a known in-flight status', () => {
    const { usageByStream, tracker } = trackerOverStatusPlane();

    setRunUsage(usageByStream, 'stream-a', {
      'run-a': { cost: 0.01, inputTokens: 10, outputTokens: 20 },
    });

    expect(tracker.totalUsage.cost).toBe(0);
    expect(tracker.totalUsage.inputTokens).toBe(0);
    expect(tracker.totalUsage.outputTokens).toBe(0);
  });

  it('sums the accumulated per-run usage of every in-flight stream', () => {
    const { status, usageByStream, tracker } = trackerOverStatusPlane();
    startStream(status, 'stream-a');
    startStream(status, 'stream-b');
    setRunUsage(usageByStream, 'stream-a', {
      'run-1': { cost: 0.01, inputTokens: 10, outputTokens: 20 },
      'run-2': { cost: 0.02, inputTokens: 30, outputTokens: 40 },
    });
    setRunUsage(usageByStream, 'stream-b', {
      'run-3': { cost: 0.04, inputTokens: 5, outputTokens: 6 },
    });

    expect(tracker.activeStreamCount).toBe(2);
    expect(tracker.totalUsage.cost).toBeCloseTo(0.07);
    expect(tracker.totalUsage.inputTokens).toBe(45);
    expect(tracker.totalUsage.outputTokens).toBe(66);
  });

  it('keeps counting a stream that waits for follow-up input', () => {
    const { status, usageByStream, tracker } = trackerOverStatusPlane();
    startStream(status, 'stream-a');
    setRunUsage(usageByStream, 'stream-a', {
      'run-1': { cost: 0.01, inputTokens: 10, outputTokens: 20 },
    });

    status.transition(
      'stream-a',
      STREAM_PHASE.WAITING,
      STREAM_TRANSITION_CAUSE.WAIT,
    );

    // Waiting is in flight but not active: the spend stays in the tooltip
    // total while the spinner count drops to zero.
    expect(tracker.activeStreamCount).toBe(0);
    expect(tracker.totalUsage.cost).toBeCloseTo(0.01);
    expect(tracker.totalUsage.inputTokens).toBe(10);
  });

  it('drops a stream from the total once it reaches a final status', () => {
    const { status, usageByStream, tracker } = trackerOverStatusPlane();
    startStream(status, 'stream-a');
    setRunUsage(usageByStream, 'stream-a', {
      'run-1': { cost: 0.01, inputTokens: 10, outputTokens: 20 },
    });

    status.transition(
      'stream-a',
      STREAM_PHASE.COMPLETED,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );

    expect(tracker.activeStreamCount).toBe(0);
    expect(tracker.totalUsage.cost).toBe(0);

    // Resuming re-enters flight, and the store-accumulated usage — including
    // the earlier runs' — is projected again.
    status.transition(
      'stream-a',
      STREAM_PHASE.RUNNING,
      STREAM_TRANSITION_CAUSE.RESUME,
    );
    expect(tracker.totalUsage.cost).toBeCloseTo(0.01);
    expect(tracker.totalUsage.inputTokens).toBe(10);
    expect(tracker.totalUsage.outputTokens).toBe(20);
  });

  it('counts only the streams the session status plane reports as active', () => {
    const { status, tracker } = trackerOverStatusPlane();

    expect(tracker.activeStreamCount).toBe(0);

    startStream(status, 'stream-a');
    startStream(status, 'stream-b');
    expect(tracker.activeStreamCount).toBe(2);

    // A stream cleared out of the status plane without a published phase
    // change stops being counted; there is no second copy to go stale.
    status.clearStream('stream-b');
    expect(tracker.activeStreamCount).toBe(1);
  });
});
