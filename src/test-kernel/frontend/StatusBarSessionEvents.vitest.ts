// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { StatusBarUsageTracker } from '@frontend/statusBar/StatusBarUsageTracker';
import { subscribeStatusBarSessionEvents } from '@frontend/statusBar/statusBarSessionEvents';
import { RUN_PHASE, type RunId } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';

const runId = 'a0b0c0' as RunId;

function subscribeOverTestSession() {
  const session = createTestSession();
  publishTestRunStart(session, runId);
  const tracker = new StatusBarUsageTracker(session.status, session);
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
  session.publishRunEvent(runId, {
    type: 'usage',
    runId,
    usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
  });
}

describe('subscribeStatusBarSessionEvents', () => {
  it('tracks run status changes from the session status plane', async () => {
    const { session, tracker, onStatusChanged, onUsageChanged, dispose } =
      subscribeOverTestSession();

    session.status.transition(runId, RUN_PHASE.RUNNING, 'lifecycle');
    await session.settlePublications();

    expect(tracker.activeRunCount).toBe(1);
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
    expect(onUsageChanged).not.toHaveBeenCalled();

    dispose();
    await session.settlePublications();
    session.status.transition(runId, RUN_PHASE.COMPLETED, 'lifecycle');
    await session.settlePublications();
    // Disposal stops the status-bar refresh, not the underlying fact: the
    // count is read live from the session status plane, so it still follows
    // the terminal transition.
    expect(tracker.activeRunCount).toBe(0);
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
  });

  it('projects run usage the session view accumulated', async () => {
    const { session, tracker, onUsageChanged, dispose } =
      subscribeOverTestSession();

    session.status.transition(runId, RUN_PHASE.RUNNING, 'lifecycle');
    emitUsage(session);
    emitUsage(session);
    await session.settlePublications();

    // The session fold is the one accumulator; the tracker's total is the
    // run's `RunView.usage` total.
    expect(tracker.totalUsage.inputTokens).toBe(20);
    expect(tracker.totalUsage.outputTokens).toBe(40);
    expect(tracker.totalUsage.cost).toBeCloseTo(0.02);
    expect(onUsageChanged).toHaveBeenCalledTimes(2);

    dispose();
  });

  it('skips the refresh for usage on runs not in flight', async () => {
    const { session, tracker, onUsageChanged, dispose } =
      subscribeOverTestSession();

    emitUsage(session);
    await session.settlePublications();

    expect(tracker.totalUsage.inputTokens).toBe(0);
    expect(tracker.totalUsage.outputTokens).toBe(0);
    expect(tracker.totalUsage.cost).toBe(0);
    expect(onUsageChanged).not.toHaveBeenCalled();

    dispose();
  });
});
