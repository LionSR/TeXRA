/**
 * The goal of a run, read and written as the run's `goalStateChanged` rows.
 *
 * The row is the goal: it carries the whole pursuit, the session fold parks
 * the latest one on `RunView.goal`, and `goalStateChanged` is a listing key,
 * so a cold read hydrates every run's current goal without replaying a single
 * aggregate. There is no goal store — a second persisted copy would be a
 * second owner of the same fact.
 */
import { DateTime, Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  type Goal,
  type GoalState,
  type RunId,
} from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';
import { hexId12 } from '@utils/core';

/** What a goal reader takes: the fold's per-run level. */
export type GoalReader = Pick<SessionHandle, 'runView'>;

/**
 * What a goal mutation takes: the reader plus the awaited commit. A mutation
 * reports the goal it wrote only once that row is in the log, so a refused or
 * failed append reaches the caller as the mutation's error instead of a
 * success over a row that never landed.
 */
type GoalWriter = GoalReader & Pick<SessionHandle, 'commit'>;

function goalOfRunView(runId: RunId, run: RunView | undefined): Goal | null {
  if (run?.category !== AgentCategory.ToolUse || !run.goal.active) return null;
  const { active: _active, ...goal } = run.goal;
  return { runId, ...goal };
}

function commitGoalState(
  session: GoalWriter,
  runId: RunId,
  state: GoalState,
): Effect.Effect<void, Error> {
  return session
    .commit([
      {
        type: 'goalStateChanged',
        aggregateId: qualifyAggregateId('run', runId),
        state,
      },
    ])
    .pipe(Effect.asVoid);
}

/** Commit the run's goal as its next row and hand it back to the caller. */
function commitGoal(
  session: GoalWriter,
  goal: Goal,
): Effect.Effect<Goal, Error> {
  const { runId, ...state } = goal;
  return commitGoalState(session, runId, { active: true, ...state }).pipe(
    Effect.as(goal),
  );
}

function requireNonEmpty(
  value: string,
  label: string,
): Effect.Effect<string, Error> {
  const trimmed = value.trim();
  return trimmed
    ? Effect.succeed(trimmed)
    : Effect.fail(new Error(`${label} must not be empty or whitespace-only.`));
}

/** The run's in-flight goal, or null when none is. */
export function goalOf(session: GoalReader, runId: RunId): Goal | null {
  return goalOfRunView(runId, session.runView(runId));
}

/**
 * Start a pursuit on the run, and succeed once its row is committed. Fails
 * when one is already in flight (active or paused): completing one and
 * starting another is normal, replacing a live one is `retargetGoal`.
 */
export function startGoal(
  session: GoalWriter,
  runId: RunId,
  objective: string,
): Effect.Effect<Goal, Error> {
  return Effect.gen(function* () {
    const trimmed = yield* requireNonEmpty(objective, 'objective');
    const existing = goalOf(session, runId);
    if (existing) {
      return yield* Effect.fail(
        new Error(
          `A goal is already in progress for this run (status: ${existing.status}). ` +
            `Abandon or complete it before starting a new one.`,
        ),
      );
    }
    return yield* commitGoal(session, {
      goalId: `goal_${hexId12()}`,
      runId,
      objective: trimmed,
      status: 'active',
      startedAt: DateTime.formatIso(yield* DateTime.now),
    });
  });
}

/**
 * Point the in-flight pursuit at a new objective and resume it. Used by the
 * Run as Goal path when a goal is already in flight — re-targeting an active
 * loop is preferable to silently leaving it pointed at a stale objective.
 * Fails when no goal is in flight.
 */
export function retargetGoal(
  session: GoalWriter,
  runId: RunId,
  objective: string,
): Effect.Effect<Goal, Error> {
  return Effect.gen(function* () {
    const trimmed = yield* requireNonEmpty(objective, 'objective');
    const existing = goalOf(session, runId);
    if (!existing) {
      return yield* Effect.fail(new Error('No goal found for this run.'));
    }
    return yield* commitGoal(session, {
      ...existing,
      objective: trimmed,
      status: 'active',
    });
  });
}

/**
 * Park the pursuit until the user comes back. Succeeds with the goal as it now
 * stands, or null when the run has none; pausing a paused goal is a no-op.
 */
export function pauseGoal(
  session: GoalWriter,
  runId: RunId,
): Effect.Effect<Goal | null, Error> {
  const existing = goalOf(session, runId);
  if (!existing || existing.status === 'paused')
    return Effect.succeed(existing);
  return commitGoal(session, { ...existing, status: 'paused' });
}

/**
 * End the pursuit (complete or abandon): a goal is a live one, not an
 * archived one, so the run's next row states that none is in flight. A run
 * with no goal commits nothing.
 */
export function clearGoal(
  session: GoalWriter,
  runId: RunId,
): Effect.Effect<void, Error> {
  if (!goalOf(session, runId)) return Effect.void;
  return commitGoalState(session, runId, { active: false });
}
