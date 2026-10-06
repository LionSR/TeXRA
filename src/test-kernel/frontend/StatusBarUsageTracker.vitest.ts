// Third-party imports
import { Effect, SubscriptionRef } from 'effect';
import { describe, expect, it } from 'vitest';

// Local imports - run state
import { StatusBarUsageTracker } from '@frontend/statusBar/StatusBarUsageTracker';
import { isInFlightPhase } from '@shared/runs/runStatus';
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

type Tree = Pick<RunView, 'parentId' | 'childIds'> &
  Partial<Pick<RunView, 'treeUsage'>>;

/** A folded run, borrowed from the recorded fan-out so the stub states a
 *  real `RunView`; only its phase, group, and metered totals matter to the
 *  tracker. A leaf's tree total is its own unless the case states one.
 *  The stub's runs are held, so an in-flight phase reads as live. */
function runViewWith(
  runId: RunId,
  status: RunPhase,
  usage: TokenUsageStats,
  tree: Tree,
): RunView {
  const folded = FAN_OUT_VIEW.runs.get(CHILD);
  if (!folded) throw new Error('fan-out fixture has no child run');
  const group = isInFlightPhase(status) ? 'running' : 'recent';
  return {
    ...folded,
    treeUsage: usage,
    ...tree,
    id: runId,
    status,
    group,
    usage,
  };
}

/**
 * The tracker holds no state: it projects from the session's fold, the one
 * authority on which runs are in flight (`RunView.status`) and on each run's
 * metered total (`RunView.usage`).
 */
function trackerOverSessionView(): {
  setRun(
    runId: RunId,
    status: RunPhase,
    usage?: TokenUsageStats,
    tree?: Tree,
  ): void;
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
    tracker: new StatusBarUsageTracker({
      view: { ref: view, changes: SubscriptionRef.changes(view) },
    }),
    setRun(
      runId,
      status,
      usage = NO_USAGE,
      tree = { parentId: null, childIds: [] },
    ) {
      updateRuns((runs) =>
        runs.set(runId, runViewWith(runId, status, usage, tree)),
      );
    },
  };
}

describe('StatusBarUsageTracker', () => {
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

  it("keeps a finished child's spend while its parent is in flight", () => {
    const { setRun, tracker } = trackerOverSessionView();
    // The fold states the parent's tree total (`treeUsage`); the tracker
    // reads it off the root and never sums the tree itself.
    const parentTree = {
      parentId: null,
      childIds: [runB],
      treeUsage: { cost: 0.03, inputTokens: 15, outputTokens: 26 },
    };
    setRun(
      runA,
      RUN_PHASE.RUNNING,
      { cost: 0.01, inputTokens: 10, outputTokens: 20 },
      parentTree,
    );
    setRun(
      runB,
      RUN_PHASE.COMPLETED,
      { cost: 0.02, inputTokens: 5, outputTokens: 6 },
      { parentId: runA, childIds: [] },
    );

    expect(tracker.totalUsage.cost).toBeCloseTo(0.03);
    expect(tracker.totalUsage.inputTokens).toBe(15);

    setRun(
      runA,
      RUN_PHASE.COMPLETED,
      { cost: 0.01, inputTokens: 10, outputTokens: 20 },
      parentTree,
    );
    expect(tracker.totalUsage.cost).toBe(0);
  });
});
