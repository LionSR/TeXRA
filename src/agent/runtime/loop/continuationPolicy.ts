/**
 * What a run does next when no one has asked it anything.
 *
 * The tool-use loop parks in `waiting` after every turn, a failed one
 * included. Before it blocks on the follow-up queue it asks the run's
 * continuation policy once: a `turn` opens a synthetic turn with that text,
 * and null parks the run. A follow-up that is already queued outranks the
 * policy's turn; that choice is the loop's, since the loop owns the queue,
 * and the loop tells the policy whether a turn could be taken at all so an
 * unusable one is never built.
 *
 * A policy with `rounds` runs its turns as rounds instead (`./rounds`): it
 * takes no input, and after each round it opens the next one or ends the run
 * with an outcome.
 *
 * A policy is a plugin's contribution: the run resolves it once, when the
 * loop is set up, from the plugins switched on then, so a switched-off
 * plugin applies to it as it does to tools. Each policy serves one agent
 * category: goal mode a tool-use conversation, the documents plugin's
 * rounds a workflow agent. With no continuation plugin on for its category,
 * a conversation parks.
 */
import { Effect } from 'effect';

import { maybeBuildGoalContinuation } from '@agent/goal/maybeBuildGoalContinuation';
import { AgentCategory, type RunId, type RunOutcome } from '@shared/schemas';
import type { RunState } from '@shared/session/runStateFold';
import { switchedOffPlugins, type ToolPluginEntry } from '@tools/plugins';
import { goalOf, pauseGoal, setGoalSessionAutoApproval } from '@tools/goal';
import { getDisabledToolIds } from '@utils/config/constants';

import { AgentRun, type AgentRunShape } from '../run/AgentRun';
import { roundsContinuation, type RoundTurns } from './rounds';
import type { SessionHandle } from '../SessionHandle';

/** A synthetic turn with this text, the round to open, the run's end with
 *  this outcome, or null to park. */
type IdleDecision =
  | { readonly turn: string }
  | { readonly round: number }
  | { readonly finish: RunOutcome }
  | null;

export interface ContinuationPolicy {
  /**
   * At idle: what the run does next. `canContinue` is false when the run
   * ends at this park or a follow-up is already queued.
   */
  readonly atIdle: (
    state: RunState,
    canContinue: boolean,
  ) => Effect.Effect<IdleDecision, Error>;
  /** Present when the policy's turns are rounds. */
  readonly rounds?: RoundTurns;
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
 * `continuation`, each with the agent category it serves.
 */
const PLUGIN_CONTINUATIONS = {
  goal: {
    category: AgentCategory.ToolUse,
    policy: (run: AgentRunShape) =>
      Effect.succeed(goalContinuation(run.session, run.runId)),
  },
  documents: { category: AgentCategory.Workflow, policy: roundsContinuation },
} as const satisfies {
  readonly [
    Id in Extract<ToolPluginEntry, { readonly continuation: true }>['id']
  ]: {
    readonly category: AgentCategory;
    readonly policy: (
      run: AgentRunShape,
    ) => Effect.Effect<ContinuationPolicy, Error, AgentRun>;
  };
};

/** The run's policy: that of the first continuation plugin switched on for
 *  its category when the loop is set up, or null when none is on. */
export function continuationFor(
  run: AgentRunShape,
): Effect.Effect<ContinuationPolicy | null, Error, AgentRun> {
  return Effect.flatMap(getDisabledToolIds(run.stores.globalState), (ids) => {
    const off = switchedOffPlugins(ids);
    const id = (
      Object.keys(PLUGIN_CONTINUATIONS) as (keyof typeof PLUGIN_CONTINUATIONS)[]
    ).find(
      (plugin) =>
        PLUGIN_CONTINUATIONS[plugin].category === run.config.agentCategory &&
        !off.has(plugin),
    );
    return id === undefined
      ? Effect.succeed(null)
      : PLUGIN_CONTINUATIONS[id].policy(run);
  });
}
