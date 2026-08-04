// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { StatusBarUsageTracker } from '@frontend/statusBar/StatusBarUsageTracker';
import { subscribeStatusBarSessionEvents } from '@frontend/statusBar/statusBarSessionEvents';
import { STREAM_PHASE, type StorageKey } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';

function subscribeOverTestSession() {
  const session = createTestSession();
  const tracker = new StatusBarUsageTracker(session.status, session.snapshots);
  const onStatusChanged = vi.fn();
  const onUsageChanged = vi.fn();
  const dispose = subscribeStatusBarSessionEvents({
    session,
    onStatusChanged,
    onUsageChanged,
  });
  return { session, tracker, onStatusChanged, onUsageChanged, dispose };
}

function emitUsage(session: SessionHandle): void {
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
}

describe('subscribeStatusBarSessionEvents', () => {
  it('tracks stream status changes from the session status plane', () => {
    const { session, tracker, onStatusChanged, onUsageChanged, dispose } =
      subscribeOverTestSession();

    session.status.transition('stream-a', STREAM_PHASE.RUNNING, 'lifecycle');

    expect(tracker.activeStreamCount).toBe(1);
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
    expect(onUsageChanged).not.toHaveBeenCalled();

    dispose();
    session.status.transition('stream-a', STREAM_PHASE.COMPLETED, 'lifecycle');
    // Disposal stops the status-bar refresh, not the underlying fact: the
    // count is read live from the session status plane, so it still follows
    // the terminal transition.
    expect(tracker.activeStreamCount).toBe(0);
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
  });

  it('projects run usage the session snapshot store accumulated', () => {
    const { session, tracker, onUsageChanged, dispose } =
      subscribeOverTestSession();

    session.status.transition('stream-a', STREAM_PHASE.RUNNING, 'lifecycle');
    emitUsage(session);
    emitUsage(session);

    // The snapshot store subscribed at session construction is the one
    // accumulator; the tracker's total is its per-run sum for the stream.
    expect(tracker.totalUsage.inputTokens).toBe(20);
    expect(tracker.totalUsage.outputTokens).toBe(40);
    expect(tracker.totalUsage.cost).toBeCloseTo(0.02);
    expect(onUsageChanged).toHaveBeenCalledTimes(2);

    dispose();
  });

  it('skips the refresh for usage on streams not in flight', () => {
    const { session, tracker, onUsageChanged, dispose } =
      subscribeOverTestSession();

    emitUsage(session);

    expect(tracker.totalUsage.inputTokens).toBe(0);
    expect(tracker.totalUsage.outputTokens).toBe(0);
    expect(tracker.totalUsage.cost).toBe(0);
    expect(onUsageChanged).not.toHaveBeenCalled();

    dispose();
  });
});
