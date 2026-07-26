// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - stream state
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { StatusBarUsageTracker } from '@frontend/statusBar/StatusBarUsageTracker';
import { STREAM_PHASE } from '@shared/schemas/stream';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';

describe('StatusBarUsageTracker', () => {
  it('ignores usage for streams without a known in-flight status', () => {
    const status = new StreamStatusMachine();
    const tracker = new StatusBarUsageTracker(status);

    expect(
      tracker.recordUsage('stream-a', {
        cost: 0.01,
        inputTokens: 10,
        outputTokens: 20,
      }),
    ).toBe(false);
    expect(tracker.totalUsage).toEqual({
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('accumulates per-round usage deltas for an active stream', () => {
    const status = new StreamStatusMachine();
    const tracker = new StatusBarUsageTracker(status);
    status.transition(
      'stream-a',
      STREAM_PHASE.RUNNING,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );

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

    expect(tracker.activeStreamCount).toBe(1);
    expect(tracker.totalUsage.cost).toBeCloseTo(0.03);
    expect(tracker.totalUsage.inputTokens).toBe(40);
    expect(tracker.totalUsage.outputTokens).toBe(60);
  });

  it('retains accumulated usage while a stream waits for follow-up input', () => {
    const status = new StreamStatusMachine();
    const tracker = new StatusBarUsageTracker(status);
    status.transition(
      'stream-a',
      STREAM_PHASE.RUNNING,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    tracker.recordUsage('stream-a', {
      cost: 0.01,
      inputTokens: 10,
      outputTokens: 20,
    });

    status.transition(
      'stream-a',
      STREAM_PHASE.WAITING,
      STREAM_TRANSITION_CAUSE.WAIT,
    );
    tracker.updateStreamStatus('stream-a', STREAM_PHASE.WAITING);

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
    const status = new StreamStatusMachine();
    const tracker = new StatusBarUsageTracker(status);
    status.transition(
      'stream-a',
      STREAM_PHASE.RUNNING,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    tracker.recordUsage('stream-a', {
      cost: 0.01,
      inputTokens: 10,
      outputTokens: 20,
    });

    status.transition(
      'stream-a',
      STREAM_PHASE.COMPLETED,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    tracker.updateStreamStatus('stream-a', STREAM_PHASE.COMPLETED);

    expect(tracker.activeStreamCount).toBe(0);
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

    status.transition(
      'stream-a',
      STREAM_PHASE.RUNNING,
      STREAM_TRANSITION_CAUSE.RESUME,
    );
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

  it('counts only the streams the session status plane reports as active', () => {
    const status = new StreamStatusMachine();
    const tracker = new StatusBarUsageTracker(status);

    expect(tracker.activeStreamCount).toBe(0);

    status.transition(
      'stream-a',
      STREAM_PHASE.RUNNING,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    status.transition(
      'stream-b',
      STREAM_PHASE.RUNNING,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    expect(tracker.activeStreamCount).toBe(2);

    // A stream cleared out of the status plane without a published phase
    // change stops being counted; there is no second copy to go stale.
    status.clearStream('stream-b');
    expect(tracker.activeStreamCount).toBe(1);
  });
});
