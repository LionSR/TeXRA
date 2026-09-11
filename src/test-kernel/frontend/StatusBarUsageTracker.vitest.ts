// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - run state
import { RunStatusMachine } from '@agent/runtime/RunStatusService';
import { StatusBarUsageTracker } from '@frontend/statusBar/StatusBarUsageTracker';
import { RUN_PHASE, type RunId, type TokenUsageStats } from '@shared/schemas';
import { RUN_TRANSITION_CAUSE } from '@shared/runs/runStatus';
import type { RunView } from '@shared/session/sessionView';
import { CHILD, fanOutView } from '@test/shared/session/fanOutScenario';

const runA = 'aaaaaa' as RunId;
const runB = 'bbbbbb' as RunId;
const FAN_OUT_VIEW = fanOutView();

/** A folded run, borrowed from the recorded fan-out so the stub states a
 *  real `RunView`; only the metered total matters to the tracker. */
function runViewWithUsage(runId: RunId, usage: TokenUsageStats): RunView {
  const folded = FAN_OUT_VIEW.runs.get(CHILD);
  if (!folded) throw new Error('fan-out fixture has no child run');
  return { ...folded, id: runId, usage };
}

/**
 * The tracker holds no state: it projects from the session status plane and
 * the metered total the session view carries for each run
 * (`RunView.usage`), stubbed here as the `runView` read the real session
 * serves.
 */
function trackerOverStatusPlane(): {
  status: RunStatusMachine;
  runViews: Map<RunId, RunView>;
  tracker: StatusBarUsageTracker;
} {
  const status = new RunStatusMachine(
    () => {},
    () => {},
  );
  const runViews = new Map<RunId, RunView>();
  const tracker = new StatusBarUsageTracker(status, {
    runView: (runId) => runViews.get(runId),
  });
  return { status, runViews, tracker };
}

function startRun(status: RunStatusMachine, runId: RunId): void {
  status.transition(runId, RUN_PHASE.RUNNING, RUN_TRANSITION_CAUSE.LIFECYCLE);
}

function setRunUsage(
  runViews: Map<RunId, RunView>,
  runId: RunId,
  usage: TokenUsageStats,
): void {
  runViews.set(runId, runViewWithUsage(runId, usage));
}

describe('StatusBarUsageTracker', () => {
  it('reports zero usage for runs without a known in-flight status', () => {
    const { runViews, tracker } = trackerOverStatusPlane();

    setRunUsage(runViews, runA, {
      cost: 0.01,
      inputTokens: 10,
      outputTokens: 20,
    });

    expect(tracker.totalUsage.cost).toBe(0);
    expect(tracker.totalUsage.inputTokens).toBe(0);
    expect(tracker.totalUsage.outputTokens).toBe(0);
  });

  it('sums the metered total of every in-flight run', () => {
    const { status, runViews, tracker } = trackerOverStatusPlane();
    startRun(status, runA);
    startRun(status, runB);
    setRunUsage(runViews, runA, {
      cost: 0.03,
      inputTokens: 40,
      outputTokens: 60,
    });
    setRunUsage(runViews, runB, {
      cost: 0.04,
      inputTokens: 5,
      outputTokens: 6,
    });

    expect(tracker.activeRunCount).toBe(2);
    expect(tracker.totalUsage.cost).toBeCloseTo(0.07);
    expect(tracker.totalUsage.inputTokens).toBe(45);
    expect(tracker.totalUsage.outputTokens).toBe(66);
  });

  it('keeps counting a run that waits for follow-up input', () => {
    const { status, runViews, tracker } = trackerOverStatusPlane();
    startRun(status, runA);
    setRunUsage(runViews, runA, {
      cost: 0.01,
      inputTokens: 10,
      outputTokens: 20,
    });

    status.transition(runA, RUN_PHASE.WAITING, RUN_TRANSITION_CAUSE.WAIT);

    // Waiting is in flight but not active: the spend stays in the tooltip
    // total while the spinner count drops to zero.
    expect(tracker.activeRunCount).toBe(0);
    expect(tracker.totalUsage.cost).toBeCloseTo(0.01);
    expect(tracker.totalUsage.inputTokens).toBe(10);
  });

  it('drops a run from the total once it reaches a final status', () => {
    const { status, runViews, tracker } = trackerOverStatusPlane();
    startRun(status, runA);
    setRunUsage(runViews, runA, {
      cost: 0.01,
      inputTokens: 10,
      outputTokens: 20,
    });

    status.transition(
      runA,
      RUN_PHASE.COMPLETED,
      RUN_TRANSITION_CAUSE.LIFECYCLE,
    );

    expect(tracker.activeRunCount).toBe(0);
    expect(tracker.totalUsage.cost).toBe(0);

    // Resuming re-enters flight, and the view's accumulated total is
    // projected again.
    status.transition(runA, RUN_PHASE.RUNNING, RUN_TRANSITION_CAUSE.RESUME);
    expect(tracker.totalUsage.cost).toBeCloseTo(0.01);
    expect(tracker.totalUsage.inputTokens).toBe(10);
    expect(tracker.totalUsage.outputTokens).toBe(20);
  });

  it('counts only the runs the session status plane reports as active', () => {
    const { status, tracker } = trackerOverStatusPlane();

    expect(tracker.activeRunCount).toBe(0);

    startRun(status, runA);
    startRun(status, runB);
    expect(tracker.activeRunCount).toBe(2);

    // A run cleared out of the status plane without a published phase
    // change stops being counted; there is no second copy to go stale.
    status.clearRun(runB);
    expect(tracker.activeRunCount).toBe(1);
  });
});
