// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - stream state
import { StatusBarUsageTracker } from '@frontend/statusBar/StatusBarUsageTracker';
import { STREAM_STATUS } from '@shared/schemas/stream';

describe('StatusBarUsageTracker', () => {
  it('accumulates per-round usage deltas for an active stream', () => {
    const tracker = new StatusBarUsageTracker();
    tracker.updateStreamStatus('stream-a', STREAM_STATUS.RUNNING);

    expect(
      tracker.recordUsage('stream-a', {
        cost: 0.01,
        inputTokens: 10,
        outputTokens: 20,
      }),
    ).toBe(true);
    expect(
      tracker.recordUsage('stream-a', {
        cost: 0.02,
        inputTokens: 30,
        outputTokens: 40,
      }),
    ).toBe(true);

    expect(tracker.totalUsage.cost).toBeCloseTo(0.03);
    expect(tracker.totalUsage.inputTokens).toBe(40);
    expect(tracker.totalUsage.outputTokens).toBe(60);
  });

  it('retains accumulated usage while a stream waits for follow-up input', () => {
    const tracker = new StatusBarUsageTracker();
    tracker.updateStreamStatus('stream-a', STREAM_STATUS.RUNNING);
    tracker.recordUsage('stream-a', {
      cost: 0.01,
      inputTokens: 10,
      outputTokens: 20,
    });

    tracker.updateStreamStatus('stream-a', STREAM_STATUS.WAITING);

    expect(tracker.activeStreamCount).toBe(0);
    expect(
      tracker.recordUsage('stream-a', {
        cost: 0.02,
        inputTokens: 30,
        outputTokens: 40,
      }),
    ).toBe(true);
    expect(tracker.totalUsage.cost).toBeCloseTo(0.03);
    expect(tracker.totalUsage.inputTokens).toBe(40);
    expect(tracker.totalUsage.outputTokens).toBe(60);
  });

  it('ignores delayed usage after a stream reaches a final status', () => {
    const tracker = new StatusBarUsageTracker();
    tracker.updateStreamStatus('stream-a', STREAM_STATUS.RUNNING);
    tracker.recordUsage('stream-a', {
      cost: 0.01,
      inputTokens: 10,
      outputTokens: 20,
    });

    tracker.updateStreamStatus('stream-a', STREAM_STATUS.READY);

    expect(tracker.totalUsage).toEqual({
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(
      tracker.recordUsage('stream-a', {
        cost: 0.02,
        inputTokens: 30,
        outputTokens: 40,
      }),
    ).toBe(false);
    expect(tracker.totalUsage).toEqual({
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
    });

    tracker.updateStreamStatus('stream-a', STREAM_STATUS.RUNNING);
    expect(
      tracker.recordUsage('stream-a', {
        cost: 0.03,
        inputTokens: 50,
        outputTokens: 60,
      }),
    ).toBe(true);
    expect(tracker.totalUsage).toEqual({
      cost: 0.03,
      inputTokens: 50,
      outputTokens: 60,
    });
  });
});
