/**
 * Goal mode as a script: a goal is a child run opened on one program that
 * runs its agent in rounds, each an `agent()` call on a fresh context whose
 * child submits a verdict (`{ status, report }`), until a round verifies the
 * objective, needs the user, or the rounds reach the spend cap. What earlier
 * rounds did reaches the next through the files it works on and the last
 * round's report.
 *
 * The `goal` tool launches it like any `agent` call, its proposal asked;
 * a plan the user runs as a goal launches the same program through
 * {@link launchGoal}, approved by that answer with the grants it chose.
 */
import { Effect, Predicate } from 'effect';
import { z } from 'zod';

import { offeredBy } from '@agent/runtime/loop/step';
import { requireToolRun } from '@agent/runtime/RunCall';
import { goalGrant } from '@agent/runtime/runApprovalQueue';
import {
  NO_APPROVAL_GRANTS,
  type ApprovalBypassKind,
} from '@shared/approvalBypassKind';
import { Settings } from '@shared/config/settings';
import {
  agentKey,
  agentName,
  GOAL_MAX_COST_SETTING,
  toJsonValue,
  type AgentProposal,
  type ToolResult,
} from '@shared/schemas';
import { defineTool } from '@tools/core/definition';
import {
  CALL_FIELDS,
  launchChildAgent,
  type ChildLaunch,
} from '@tools/delegation/AgentTool';

/** What a goal a person armed auto-approves: commands alone, or all agent
 *  work. A goal the `goal` tool launched grants nothing of its own. */
type GoalAutoApproval = 'commands' | 'allAgentWork';

const AUTO_APPROVED: Record<GoalAutoApproval, readonly ApprovalBypassKind[]> = {
  commands: ['bash'],
  allAgentWork: ['superYolo', 'toolEdit', 'bash'],
};

/** The longest a goal's program runs: the script tool's own limit. */
const GOAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** The tools a goal's rounds are never offered: they would open a plan
 *  approval, or a goal, in the middle of one. */
const NOT_IN_ROUNDS = new Set(['plan', 'goal', 'script']);

/** The verdict each round's child submits. */
const ROUND_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['continue', 'done', 'needs_user'],
      description:
        '`done` only once authoritative evidence shows every requirement of the objective holds now; `needs_user` when you cannot go on without the user; `continue` otherwise.',
    },
    report: {
      type: 'string',
      description:
        'What you did this round, the evidence you inspected and what it shows, and what remains (or what you need from the user). The next round reads only this and the files.',
    },
  },
  required: ['status', 'report'],
  additionalProperties: false,
};

/** What every round is told before the objective. */
const ROUND_BRIEF = [
  '<goal_round>',
  "You are working on an autonomous goal, one round at a time. Each round starts fresh: what earlier rounds did is in the files and in the previous round's report below, not in your memory.",
  'Make as much verified progress toward the objective as you can this round, then submit your verdict. Persist when a tool call or command fails: diagnose, adjust and retry rather than stopping.',
  '- Do not redefine success around a smaller or easier task, and do not substitute a narrower, safer, or merely test-passing solution for the behavior the objective asks for.',
  '- Treat completion as unproven until you have inspected authoritative evidence (file contents, command output, test results, runtime behavior) for every requirement, at the scope of the requirement.',
  '</goal_round>',
].join('\n');

/**
 * The goal's program for the agent `agent` (its catalog key): rounds until
 * a verdict ends it, returning `{ status, rounds, report, cost }`. Plain
 * string concatenation, so the source holds no host interpolation.
 */
const goalSource = (
  agent: string,
  objective: string,
  memories: readonly string[],
  maxCostUsd: number,
): string => String.raw`const agentName = ${JSON.stringify(agent)};
const objective = ${JSON.stringify(objective)};
const memories = ${JSON.stringify(memories)};
const maxCostUsd = ${JSON.stringify(maxCostUsd)};
const brief = ${JSON.stringify(ROUND_BRIEF)};
const schema = ${JSON.stringify(ROUND_SCHEMA)};
let cost = 0;
let report = '';
for (let round = 1; ; round += 1) {
  phase('Round ' + round);
  const previous = round === 1 ? '' : '\n\n<previous_round round="' + (round - 1) + '">\n' + report + '\n</previous_round>';
  let reply;
  try {
    reply = await agent(brief + '\n\n<objective>\n' + objective + '\n</objective>' + previous, {
      agentName, schema, memories, id: 'round-' + round, label: 'Round ' + round,
    });
  } catch (error) {
    return { status: 'paused', rounds: round, cost, report: 'Round ' + round + ' ended without a verdict (' + error.name + '): ' + error.message };
  }
  cost += reply.cost;
  report = reply.structured.report;
  if (reply.structured.status === 'done') return { status: 'completed', rounds: round, cost, report };
  if (reply.structured.status === 'needs_user') return { status: 'paused', rounds: round, cost, report };
  if (maxCostUsd > 0 && cost >= maxCostUsd)
    return { status: 'paused', rounds: round, cost, report: 'The rounds spent $' + cost.toFixed(2) + ', reaching the goal cap of $' + maxCostUsd + ' (texra.goal.maxCostUsd).\n\n' + report };
}`;

/** A goal's envelope as a script reads it: its program's return value in
 *  place of the run's empty reply. Any other result is as launched. */
function goalResult(result: ToolResult): ToolResult {
  if (result.status !== 'executed' || !Predicate.isObject(result.value))
    return result;
  const {
    structured,
    response: _response,
    files: _files,
    ...envelope
    // cast: an executed child call's value is its run's envelope, an object.
  } = result.value as Record<string, unknown>;
  return Predicate.isObject(structured)
    ? { ...result, value: toJsonValue({ ...envelope, ...structured }) }
    : result;
}

/** One goal launch: the agent, its objective, and the `agent` call fields
 *  a goal takes, from the launching tool. */
type GoalLaunch = Pick<
  ChildLaunch,
  | 'tool'
  | 'agentName'
  | 'model'
  | 'memories'
  | 'workingDirectory'
  | 'id'
  | 'timeoutMs'
  | 'background'
> & {
  readonly objective: string;
  /** A goal a person armed with this answer: no proposal, and these
   *  auto-approvals for the goal and its rounds. */
  readonly armed?: GoalAutoApproval;
};

/**
 * Launch a goal as a child of the current call's run. Its rounds may be
 * offered what this run's step offers, less the tools in
 * {@link NOT_IN_ROUNDS}; the cap is read now, into the program.
 */
export const launchGoal = Effect.fn('goal.launch')(function* (
  launch: GoalLaunch,
) {
  const call = yield* requireToolRun(launch.tool);
  // The rounds' ceiling: what this run is offered, and the `agent` tool the
  // program runs them through. A round is its agent narrowed to it.
  const tools = [
    ...new Set([
      ...(yield* offeredBy(call.run)).flatMap(({ name, plugin }) =>
        plugin === 'run' || NOT_IN_ROUNDS.has(name) ? [] : [name],
      ),
      'agent',
    ]),
  ];
  const maxCostUsd = yield* Settings.get<number>(
    call.env.roots,
    GOAL_MAX_COST_SETTING.configKey,
  );
  const memories = [...launch.memories];
  const recipe = (chosen: AgentProposal) => ({
    // The exact entry: a bare name would re-resolve to whatever shadows it.
    code: goalSource(
      chosen.agentSource
        ? agentKey(chosen.agentSource, agentName(chosen.agent))
        : chosen.agent,
      launch.objective,
      memories,
      maxCostUsd,
    ),
    title: 'Goal',
    tools,
    timeoutMs: GOAL_TIMEOUT_MS,
    kind: 'recipe' as const,
    block: null,
    options: {},
  });
  const result = yield* launchChildAgent({
    ...launch,
    prompt: launch.objective,
    schema: null,
    files: {
      inputFiles: [],
      contextFiles: [],
      mediaFiles: [],
      outputFiles: [],
    },
    task: null,
    recipe,
    ...(launch.armed !== undefined && {
      approved: goalGrant(AUTO_APPROVED[launch.armed])(NO_APPROVAL_GRANTS),
    }),
  });
  return goalResult(result);
});

const GoalInputSchema = z.strictObject({
  objective: z
    .string()
    .min(1, 'objective is required')
    .describe(
      'What must be true when the goal is done, and how to verify it. Each round reads only this, the files and the last report: name the files and copy every constraint.',
    ),
  agentName: z
    .string()
    .min(1, 'agentName is required')
    .describe('The agent that works each round, with its own tools.'),
  model: z
    .string()
    .nullish()
    .describe(
      'Model reference for every round, `@effort` suffix allowed. Defaults to your current model when available.',
    ),
  ...CALL_FIELDS,
});
type GoalInput = z.infer<typeof GoalInputSchema>;

/** The `goal` tool. */
export const GoalTool = defineTool({
  name: 'goal',
  requiresApproval: 'inBody',
  // A resumed call finds the goal its earlier attempt launched.
  replay: 'safe',
  lane: 'own',
  scriptGlobal: { positional: 'objective' },
  scriptReturns:
    "{ status: 'completed' | 'paused'; rounds: number; report: string; cost: number; runId: string; outcome: 'completed' } | { runId: string }",
  slow: true,
  description: `Run a named agent as an autonomous goal: a script runs it in rounds, each on a fresh context, until a round verifies the objective is done, a round needs the user, or the rounds reach the goal spend cap. Each round works with the agent's own tools and submits a verdict and a report, which the next round reads.

From a script, \`goal(objective, opts)\` waits for the goal and resolves to \`{ status, rounds, report, cost, runId, outcome }\`: \`status\` is \`'completed'\`, or \`'paused'\` when a round needed the user, failed, or the cap was reached, with the reason in \`report\`. With \`background: true\` it resolves to \`{ runId }\` at once and the result arrives as a follow-up. Called directly, the goal runs in the background and its result arrives as a follow-up message; in a one-shot run the call waits for it.

A goal approves nothing on its own: its rounds' commands and edits follow this run's approval policy.`,
  schema: GoalInputSchema,
  execute: (input: GoalInput) =>
    launchGoal({
      tool: 'goal',
      objective: input.objective,
      agentName: input.agentName,
      model: input.model,
      memories: input.memories,
      workingDirectory: input.working_directory,
      id: input.id,
      timeoutMs: input.timeoutMs,
      background: input.background,
    }),
});
