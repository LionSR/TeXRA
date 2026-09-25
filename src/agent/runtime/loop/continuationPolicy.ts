/**
 * What a parked tool-use run does next when no one has asked it anything.
 *
 * The loop parks in `waiting` after every turn, a failed one included. Before
 * it blocks on the follow-up queue it asks the run's continuation policy once:
 * a `turn` opens a synthetic turn with that text, and null parks the run. A
 * follow-up that is already queued outranks the policy's turn; that choice is
 * the loop's, since the loop owns the queue, and the loop tells the policy
 * whether a turn could be taken at all so an unusable one is never built.
 *
 * A policy is a plugin's contribution: the run resolves it once, when the
 * loop is set up, from the plugins its pinned composition holds, so a
 * switched-off plugin and a delegated child's narrowing apply to it as they
 * do to tools. With no continuation plugin on, the run parks. Goal mode is
 * the one policy today.
 */
import { Effect } from 'effect';

import { maybeBuildGoalContinuation } from '@agent/goal/maybeBuildGoalContinuation';
import type { RunId } from '@shared/schemas';
import type { RunState } from '@shared/session/runStateFold';
import type { ToolPluginEntry } from '@tools/plugins';
import { goalOf, pauseGoal, setGoalSessionAutoApproval } from '@tools/goal';

import type { AgentRunShape } from '../run/AgentRun';
import type { SessionHandle } from '../SessionHandle';

interface ContinuationPolicy {
  /**
   * At idle: the next synthetic turn, or null to park. `canContinue` is
   * false when the run ends at this park or a follow-up is already queued.
   */
  readonly atIdle: (
    state: RunState,
    canContinue: boolean,
  ) => Effect.Effect<{ readonly turn: string } | null, Error>;
}

/**
 * Goal mode: an active goal opens the next turn itself. A failed turn pauses
 * the goal and revokes the goal's auto-approval instead, so the run parks for
 * the user. Goal state and its approval grants stay in `@tools/goal`; only the
 * decision lives here.
 */
const goalContinuation = (
  session: SessionHandle,
  runId: RunId,
): ContinuationPolicy => ({
  atIdle: Effect.fn('goal.atIdle')(function* (
    state: RunState,
    canContinue: boolean,
  ) {
    if (state.lastError !== null) {
      if (goalOf(session, runId)?.status === 'active') {
        yield* pauseGoal(session, runId);
        setGoalSessionAutoApproval(session, runId, false);
      }
      return null;
    }
    if (!canContinue) return null;
    const text = yield* maybeBuildGoalContinuation(session, runId);
    return text === null ? null : { turn: text };
  }),
});

/**
 * The continuation policy of each plugin that contributes one, keyed by
 * plugin id: exactly the plugins whose manifest entry declares
 * `continuation`.
 */
const PLUGIN_CONTINUATIONS = {
  goal: goalContinuation,
} as const satisfies {
  readonly [
    Id in Extract<ToolPluginEntry, { readonly continuation: true }>['id']
  ]: (session: SessionHandle, runId: RunId) => ContinuationPolicy;
};

/** The run's policy: that of the first continuation plugin its pinned
 *  composition holds, or null when none is on. */
export function continuationFor(
  run: Pick<AgentRunShape, 'composition' | 'session' | 'runId'>,
): ContinuationPolicy | null {
  const id = run.composition.key.composition.plugins.find(
    (plugin): plugin is keyof typeof PLUGIN_CONTINUATIONS =>
      Object.hasOwn(PLUGIN_CONTINUATIONS, plugin),
  );
  return id === undefined
    ? null
    : PLUGIN_CONTINUATIONS[id](run.session, run.runId);
}
