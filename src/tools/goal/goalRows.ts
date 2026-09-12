/**
 * The goal of a run, read and written as the run's `goalStateChanged` rows.
 *
 * The row is the goal: it carries the whole pursuit, the session fold parks
 * the latest one on `RunView.goal`, and `goalStateChanged` is a listing key,
 * so a cold read hydrates every run's current goal without replaying a single
 * aggregate. There is no goal store — a second persisted copy would be a
 * second owner of the same fact.
 */
import { Stream, SubscriptionRef } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  AgentCategory,
  type AggregateTarget,
  type Goal,
  type GoalState,
  type RunId,
} from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';
import { hexId12 } from '@utils/core';

/** One goal mutation as observed on a session's event plane. */
export interface GoalStateChange {
  readonly runId: RunId;
}

/** What a goal reader takes: the fold's per-run and whole-session levels. */
export type GoalReader = Pick<SessionHandle, 'runView' | 'view'>;

/** What a goal mutation takes: the reader plus the session's one publisher. */
export type GoalWriter = GoalReader & Pick<SessionHandle, 'publish'>;

function goalOfRunView(runId: RunId, run: RunView | undefined): Goal | null {
  if (run?.category !== AgentCategory.ToolUse || !run.goal.active) return null;
  const { active: _active, ...goal } = run.goal;
  return { runId, ...goal };
}

function publishGoalState(
  session: GoalWriter,
  runId: RunId,
  state: GoalState,
): void {
  session.publish([
    {
      type: 'goalStateChanged',
      aggregateId: qualifyAggregateId('run', runId),
      state,
    },
  ]);
}

/** Commit the run's goal as its next row and hand it back to the caller. */
function publishGoal(session: GoalWriter, goal: Goal): Goal {
  const { runId, ...state } = goal;
  publishGoalState(session, runId, { active: true, ...state });
  return goal;
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty or whitespace-only.`);
  }
  return trimmed;
}

/** The run's in-flight goal, or null when none is. */
export function goalOf(session: GoalReader, runId: RunId): Goal | null {
  return goalOfRunView(runId, session.runView(runId));
}

/** Every in-flight goal in the session, for the cross-run goal list. */
export function goalList(session: GoalReader): Goal[] {
  const goals: Goal[] = [];
  for (const [runId, run] of SubscriptionRef.getUnsafe(session.view).runs) {
    const goal = goalOfRunView(runId, run);
    if (goal) goals.push(goal);
  }
  return goals;
}

/**
 * Start a pursuit on the run. Throws when one is already in flight (active or
 * paused): completing one and starting another is normal, replacing a live one
 * is `retargetGoal`.
 */
export function startGoal(
  session: GoalWriter,
  runId: RunId,
  objective: string,
): Goal {
  const trimmed = requireNonEmpty(objective, 'objective');
  const existing = goalOf(session, runId);
  if (existing) {
    throw new Error(
      `A goal is already in progress for this run (status: ${existing.status}). ` +
        `Abandon or complete it before starting a new one.`,
    );
  }
  return publishGoal(session, {
    goalId: `goal_${hexId12()}`,
    runId,
    objective: trimmed,
    status: 'active',
    startedAt: new Date().toISOString(),
  });
}

/**
 * Point the in-flight pursuit at a new objective and resume it. Used by the
 * Run as Goal path when a goal is already in flight — re-targeting an active
 * loop is preferable to silently leaving it pointed at a stale objective.
 * Throws when no goal is in flight.
 */
export function retargetGoal(
  session: GoalWriter,
  runId: RunId,
  objective: string,
): Goal {
  const trimmed = requireNonEmpty(objective, 'objective');
  const existing = goalOf(session, runId);
  if (!existing) throw new Error('No goal found for this run.');
  return publishGoal(session, {
    ...existing,
    objective: trimmed,
    status: 'active',
  });
}

/**
 * Park the pursuit until the user comes back. Returns the goal as it now
 * stands, or null when the run has none; pausing a paused goal is a no-op.
 */
export function pauseGoal(session: GoalWriter, runId: RunId): Goal | null {
  const existing = goalOf(session, runId);
  if (!existing || existing.status === 'paused') return existing;
  return publishGoal(session, { ...existing, status: 'paused' });
}

/**
 * End the pursuit (complete or abandon): a goal is a live one, not an
 * archived one, so the run's next row states that none is in flight. A run
 * with no goal publishes nothing.
 */
export function clearGoal(session: GoalWriter, runId: RunId): void {
  if (!goalOf(session, runId)) return;
  publishGoalState(session, runId, { active: false });
}

/**
 * Goal mutations in one explicitly-owned session, from now on. Goal state is
 * session-scoped: consumers must pass the session they render, rather than
 * listening on a process-wide compatibility event. The stream is the whole
 * surface — the subscriber's host forks it at its own R1 boundary and
 * interrupts that fork when the view it renders closes, so this module owns
 * no fiber and no runtime.
 */
export function goalStateChanges(
  session: Pick<SessionHandle, 'folded' | 'now'>,
): Stream.Stream<GoalStateChange> {
  return session.folded(session.now()).pipe(
    Stream.filter(
      (event) =>
        event.type === 'goalStateChanged' || event.type === 'run.removed',
    ),
    Stream.map((event) => aggregateTarget(event.aggregateId)),
    Stream.filter(
      (target): target is Extract<AggregateTarget, { kind: 'run' }> =>
        target.kind === 'run',
    ),
    Stream.map((target) => ({ runId: target.id })),
  );
}
