/**
 * Example 09: two goal strategies on one kernel.
 *
 * A plan the user runs as a goal calls a strategy: the `goal` export of the
 * script module the `goal.strategy` setting names. The kernel's part is the
 * same for both runs here: the plan approval, the background script, the
 * `self()` rounds, the spend each round reports.
 *
 * 1. Conversation A runs the default strategy, `builtIn:goal`: each round is
 *    forked from the conversation and told the previous round's report. Its
 *    second round needs the user, so the goal pauses with `needs_user`.
 * 2. A plugin ships a second strategy as a script module, `builtIn:goal-ledger`,
 *    and the setting selects it. Its rounds start fresh (`fork: false`) and
 *    are told every earlier round's report. With the spend cap set between
 *    one round's spend and two rounds', it pauses with `spend_cap`.
 * 3. Each goal's run ends with its result as structured output, which
 *    decodes with the public `GoalResultSchema`: outcome, pause reason with
 *    its data, rounds and spend.
 *
 * The conversation's turn holds on `hold_turn` while its goal runs, so the
 * goal's rounds are the only model calls in flight and the scripted model
 * answers them in order; the program stops the conversation once it has
 * read the goal's result.
 */
import { Effect, Layer, Schema, Stream } from 'effect';
import { Sessions, type LocalSession } from '@texra-ai/harness';
import {
  definePlugin,
  harnessBuiltins,
  defineTool,
} from '@texra-ai/harness/plugins';
import {
  GOAL_MAX_COST_SETTING,
  GOAL_STRATEGY_SETTING,
  GoalResultSchema,
  type SessionView,
  type PendingRequest,
} from '@texra-ai/harness/schemas';

import { makeExampleWorkspace } from './_support.ts';

/** Keeps the conversation's turn open while its goal runs. */
const holdTurn = defineTool({
  name: 'hold_turn',
  description: 'Wait here while the goal runs.',
  replay: 'safe',
  schema: Schema.Struct({}),
  execute: () => Effect.never,
});

/** The second strategy: fresh rounds that carry every earlier report. */
const LEDGER_STRATEGY = `
const schema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['continue', 'done', 'needs_user'] },
    report: { type: 'string' },
  },
  required: ['status', 'report'],
};
export const goal = async (objective, { maxCostUsd }) => {
  const ledger = [];
  let spent = 0;
  for (let round = 1; ; round += 1) {
    section('Round ' + round);
    const report = () => ledger.length === 0 ? '' : ledger[ledger.length - 1];
    const paused = (pause) => ({ outcome: 'paused', pause, rounds: round, spent, report: report() });
    const earlier = ledger.map((entry, index) => '\\nRound ' + (index + 1) + ': ' + entry).join('');
    let reply;
    try {
      reply = await self('Ledger round ' + round + ' of the goal: ' + objective + earlier, {
        fork: false, schema, label: 'Round ' + round,
      });
    } catch (error) {
      return paused({ reason: 'round_failed', error: { name: error.name, message: error.message } });
    }
    spent = reply.spent;
    if (reply.structured == null) return paused({ reason: 'no_verdict', response: reply.response });
    ledger.push(reply.structured.report);
    if (reply.structured.status === 'done') return { outcome: 'completed', rounds: round, spent, report: report() };
    if (reply.structured.status === 'needs_user') return paused({ reason: 'needs_user' });
    if (maxCostUsd > 0 && spent >= maxCostUsd) return paused({ reason: 'spend_cap', maxCostUsd });
  }
};`;

const ledgerPlugin = definePlugin({
  id: 'goal-ledger',
  tools: [holdTurn],
  scriptModules: { 'goal-ledger': LEDGER_STRATEGY },
});

const PERSONA = {
  name: 'goal_runner',
  description: 'Proposes a plan and runs it as a goal.',
  prompt: 'Propose a plan, then wait while it runs as a goal.',
  tools: ['hold_turn'],
};

/** A conversation's one turn: propose the plan, then hold. */
const proposeAndHold = (opening: string, objective: string) => ({
  expect: opening,
  toolCalls: [
    { name: 'plan', input: { objective } },
    { name: 'hold_turn', input: {} },
  ],
});

/** A round's verdict. */
const verdict = (
  expect: string,
  status: 'continue' | 'needs_user',
  report: string,
) => ({
  expect,
  toolCalls: [{ name: 'submit_output', input: { status, report } }],
});

const { platform, requests, route } = await makeExampleWorkspace([
  proposeAndHold('Pursue goal A.', 'Goal A: tighten the abstract.'),
  verdict('<goal_round>', 'continue', 'A round one report.'),
  verdict('A round one report.', 'needs_user', 'A needs the venue.'),
  proposeAndHold('Pursue goal B.', 'Goal B: check the bound.'),
  verdict('Ledger round 1', 'continue', 'B round one report.'),
  verdict('B round one report.', 'continue', 'B round two report.'),
]);

/** What request `index` sent the model, as one string. */
const sent = (index: number): string => JSON.stringify(requests[index]);

/**
 * Start a conversation on `opening`, run its plan as a goal, and return the
 * goal's decoded result and its run's tree spend once the goal has ended.
 * The conversation is stopped after: its turn only held.
 */
const runGoal = (session: LocalSession, opening: string) =>
  Effect.gen(function* () {
    const conversation = yield* session.start({
      agent: PERSONA,
      instruction: opening,
      model: route.model,
      interactive: true,
    });
    const ended = (current: SessionView) =>
      [...current.runs.values()].find(
        (run) =>
          run.launchParentId === conversation.runId && run.outcome !== null,
      );
    // Ended, and its result delivered to the conversation as a follow-up.
    yield* Stream.runHead(
      Stream.filter(
        conversation.view,
        (current) =>
          ended(current) !== undefined &&
          (current.queuedFollowUps.get(conversation.runId)?.length ?? 0) > 0,
      ),
    );
    const goal = ended(session.view.current());
    if (goal === undefined) throw new Error('no goal run');
    yield* session.request({
      kind: 'run.stop',
      runId: conversation.runId,
      reason: 'user',
    });
    const result = yield* Schema.decodeUnknownEffect(GoalResultSchema)(
      goal.output?.structured,
    );
    return { result, treeCost: goal.treeUsage.cost };
  });

const program = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.open(platform.roots);
  yield* session.attach({
    approve: (request: PendingRequest) =>
      Effect.succeed(
        request.payload.kind === 'planApproval'
          ? { action: 'approve_and_goal' as const }
          : { action: 'approve' as const },
      ),
  });

  // 1. The default strategy: forked rounds, the previous report.
  const a = yield* runGoal(session, 'Pursue goal A.');
  if (
    a.result.outcome !== 'paused' ||
    a.result.pause.reason !== 'needs_user' ||
    a.result.rounds !== 2 ||
    a.result.report !== 'A needs the venue.' ||
    !(a.result.spent > 0)
  )
    throw new Error(`goal A: ${JSON.stringify(a.result)}`);
  // Forked: each round's request carries the conversation's opening.
  if (
    !sent(1).includes('Pursue goal A.') ||
    !sent(2).includes('Pursue goal A.')
  )
    throw new Error('goal A rounds were not forked from the conversation');
  console.log(
    `[09] default strategy: ${a.result.outcome} (${a.result.pause.reason}) after ${a.result.rounds} rounds, spent $${a.result.spent.toFixed(6)} (run tree $${a.treeCost.toFixed(6)})`,
  );

  // 2. The ledger strategy, selected by the setting, with a cap between
  // one round's spend and two rounds' (every scripted turn costs the same).
  yield* platform.roots.config.update(
    GOAL_STRATEGY_SETTING.key,
    'builtIn:goal-ledger',
    'global',
  );
  const cap = (a.result.spent / a.result.rounds) * 1.5;
  yield* platform.roots.config.update(GOAL_MAX_COST_SETTING.key, cap, 'global');
  const b = yield* runGoal(session, 'Pursue goal B.');
  if (
    b.result.outcome !== 'paused' ||
    b.result.pause.reason !== 'spend_cap' ||
    b.result.pause.maxCostUsd !== cap ||
    b.result.rounds !== 2 ||
    !(b.result.spent >= cap)
  )
    throw new Error(`goal B: ${JSON.stringify(b.result)}`);
  // Fresh: no round sees the conversation; the second sees the ledger.
  if (
    sent(4).includes('Pursue goal B.') ||
    sent(5).includes('Pursue goal B.') ||
    !sent(5).includes('Round 1: B round one report.')
  )
    throw new Error('goal B rounds did not start fresh on the ledger');
  console.log(
    `[09] ledger strategy: ${b.result.outcome} (${b.result.pause.reason} at $${b.result.pause.maxCostUsd.toFixed(6)}) after ${b.result.rounds} rounds, spent $${b.result.spent.toFixed(6)}`,
  );
  console.log(`[09] model turns=${requests.length}`);
}).pipe(
  Effect.scoped,
  Effect.provide(
    Sessions.layer({
      platform,
      plugins: [...harnessBuiltins, ledgerPlugin],
    }).pipe(Layer.provideMerge(route.transport)),
  ),
);

await Effect.runPromise(program);
