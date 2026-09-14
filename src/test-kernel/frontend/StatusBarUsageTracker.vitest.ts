// Third-party imports
import { Effect, SubscriptionRef } from 'effect';
import { describe, expect, it } from 'vitest';

// Local imports - run state
import { StatusBarUsageTracker } from '@frontend/statusBar/StatusBarUsageTracker';
import {
  RUN_PHASE,
  type RunId,
  type RunPhase,
  type TokenUsageStats,
} from '@shared/schemas';
import {
  emptySessionView,
  type RunView,
  type SessionView,
} from '@shared/session/sessionView';
import { CHILD, fanOutView } from '@test/shared/session/fanOutScenario';

const runA = 'aaaaaa' as RunId;
const runB = 'bbbbbb' as RunId;
const FAN_OUT_VIEW = fanOutView();
const NO_USAGE: TokenUsageStats = {
  cost: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/** A folded run, borrowed from the recorded fan-out so the stub states a
 *  real `RunView`; only its phase and metered total matter to the tracker. */
function runViewWith(
  runId: RunId,
  status: RunPhase,
  usage: TokenUsageStats,
): RunView {
  const folded = FAN_OUT_VIEW.runs.get(CHILD);
  if (!folded) throw new Error('fan-out fixture has no child run');
  return { ...folded, id: runId, status, usage };
}

/**
 * The tracker holds no state: it projects from the session's fold, the one
 * authority on which runs are in flight (`RunView.status`) and on each run's
 * metered total (`RunView.usage`).
 */
function trackerOverSessionView(): {
  setRun(runId: RunId, status: RunPhase, usage?: TokenUsageStats): void;
  dropRun(runId: RunId): void;
  tracker: StatusBarUsageTracker;
} {
  const view = Effect.runSync(
    SubscriptionRef.make<SessionView>(emptySessionView('usage')),
  );
  const updateRuns = (change: (runs: Map<RunId, RunView>) => void): void => {
    Effect.runSync(
      SubscriptionRef.update(view, (current) => {
        const runs = new Map(current.runs);
        change(runs);
        return { ...current, runs };
      }),
    );
  };
  return {
    tracker: new StatusBarUsageTracker({ view }),
    setRun(runId, status, usage = NO_USAGE) {
      updateRuns((runs) => runs.set(runId, runViewWith(runId, status, usage)));
    },
    dropRun(runId) {
      updateRuns((runs) => runs.delete(runId));
    },
  };
}

describe('StatusBarUsageTracker', () => {
  it('reports zero usage for runs that are not in flight', () => {
    const { setRun, tracker } = trackerOverSessionView();

    setRun(runA, RUN_PHASE.COMPLETED, {
      cost: 0.01,
      inputTokens: 10,
      outputTokens: 20,
    });

    expect(tracker.totalUsage.cost).toBe(0);
    expect(tracker.totalUsage.inputTokens).toBe(0);
    expect(tracker.totalUsage.outputTokens).toBe(0);
  });

  it('sums the metered total of every in-flight run', () => {
    const { setRun, tracker } = trackerOverSessionView();
    setRun(runA, RUN_PHASE.RUNNING, {
      cost: 0.03,
      inputTokens: 40,
      outputTokens: 60,
    });
    setRun(runB, RUN_PHASE.RUNNING, {
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
    const { setRun, tracker } = trackerOverSessionView();
    const usage: TokenUsageStats = {
      cost: 0.01,
      inputTokens: 10,
      outputTokens: 20,
    };
    setRun(runA, RUN_PHASE.RUNNING, usage);

    setRun(runA, RUN_PHASE.WAITING, usage);

    // Waiting is in flight but not active: the spend stays in the tooltip
    // total while the spinner count drops to zero.
    expect(tracker.activeRunCount).toBe(0);
    expect(tracker.totalUsage.cost).toBeCloseTo(0.01);
    expect(tracker.totalUsage.inputTokens).toBe(10);
  });

  it('drops a run from the total once it reaches a final phase', () => {
    const { setRun, tracker } = trackerOverSessionView();
    const usage: TokenUsageStats = {
      cost: 0.01,
      inputTokens: 10,
      outputTokens: 20,
    };
    setRun(runA, RUN_PHASE.RUNNING, usage);

    setRun(runA, RUN_PHASE.COMPLETED, usage);

    expect(tracker.activeRunCount).toBe(0);
    expect(tracker.totalUsage.cost).toBe(0);

    // Resuming re-enters flight, and the view's accumulated total is
    // projected again.
    setRun(runA, RUN_PHASE.RUNNING, usage);
    expect(tracker.totalUsage.cost).toBeCloseTo(0.01);
    expect(tracker.totalUsage.inputTokens).toBe(10);
    expect(tracker.totalUsage.outputTokens).toBe(20);
  });

  it('counts only the runs the fold reports as active', () => {
    const { setRun, dropRun, tracker } = trackerOverSessionView();

    expect(tracker.activeRunCount).toBe(0);

    setRun(runA, RUN_PHASE.RUNNING);
    setRun(runB, RUN_PHASE.RUNNING);
    expect(tracker.activeRunCount).toBe(2);

    // A run the fold dropped stops being counted; there is no second copy
    // to go stale.
    dropRun(runB);
    expect(tracker.activeRunCount).toBe(1);
  });
});
