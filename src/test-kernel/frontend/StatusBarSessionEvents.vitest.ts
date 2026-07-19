// Test support imports

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - status bar state
import { StatusBarUsageTracker } from '@frontend/statusBar/StatusBarUsageTracker';
import { subscribeStatusBarSessionEvents } from '@frontend/statusBar/statusBarSessionEvents';
import { STREAM_PHASE, type StorageKey } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';

describe('subscribeStatusBarSessionEvents', () => {
  it('tracks stream status changes from the session status plane', () => {
    const session = createTestSession();
    const tracker = new StatusBarUsageTracker();
    const onStatusChanged = vi.fn();
    const onUsageChanged = vi.fn();
    const dispose = subscribeStatusBarSessionEvents({
      session,
      tracker,
      onStatusChanged,
      onUsageChanged,
    });

    session.status.transition('stream-a', STREAM_PHASE.RUNNING, 'lifecycle');

    expect(tracker.activeStreamCount).toBe(1);
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
    expect(onUsageChanged).not.toHaveBeenCalled();

    dispose();
    session.status.transition('stream-a', STREAM_PHASE.COMPLETED, 'lifecycle');
    expect(tracker.activeStreamCount).toBe(1);
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
  });

  it('records valid run usage events after an in-flight status', () => {
    const session = createTestSession();
    const tracker = new StatusBarUsageTracker();
    const onStatusChanged = vi.fn();
    const onUsageChanged = vi.fn();
    const dispose = subscribeStatusBarSessionEvents({
      session,
      tracker,
      onStatusChanged,
      onUsageChanged,
    });

    session.status.transition('stream-a', STREAM_PHASE.RUNNING, 'lifecycle');
    session.events.emit({
      scope: 'run',
      streamId: 'stream-a',
      event: {
        type: 'usage',
        payload: {
          streamId: 'stream-a',
          storageKey: 'run-a' as StorageKey,
          usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
        },
      },
    });

    expect(tracker.totalUsage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cost: 0.01,
    });
    expect(onUsageChanged).toHaveBeenCalledTimes(1);

    dispose();
  });

  it('ignores usage for unknown streams', () => {
    const session = createTestSession();
    const tracker = new StatusBarUsageTracker();
    const onStatusChanged = vi.fn();
    const onUsageChanged = vi.fn();
    const dispose = subscribeStatusBarSessionEvents({
      session,
      tracker,
      onStatusChanged,
      onUsageChanged,
    });

    session.events.emit({
      scope: 'run',
      streamId: 'stream-a',
      event: {
        type: 'usage',
        payload: {
          streamId: 'stream-a',
          storageKey: 'run-a' as StorageKey,
          usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
        },
      },
    });

    expect(tracker.totalUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    });
    expect(onUsageChanged).not.toHaveBeenCalled();

    dispose();
  });
});
