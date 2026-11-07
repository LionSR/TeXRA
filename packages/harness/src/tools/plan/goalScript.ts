/**
 * The goal: "Run as Goal" runs a background script of the conversation
 * that approved the plan, and that script only calls a strategy, the `goal`
 * export of the script module `goal.strategy` names. The strategy decides
 * the rounds, what context each starts from and when to stop, and resolves
 * to the goal's result (`GoalResultSchema`). The default strategy is the
 * goal plugin's own module, `builtIn:goal`; a plugin replaces it by shipping
 * another module and naming it in the setting, and a script may call any of
 * them itself.
 */

/** The verdict each round of the default strategy submits. */
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
        'What you did this round, the evidence you inspected and what it shows, and what remains (or what you need from the user). The next round reads it.',
    },
  },
  required: ['status', 'report'],
  additionalProperties: false,
};

/** What every round is told before the objective. */
const ROUND_BRIEF = [
  '<goal_round>',
  "You are one round of a goal the user approved: work on the objective below yourself, now. What earlier rounds did is in the files and in the previous round's report below.",
  'Make as much verified progress as you can, then submit your verdict. Persist when a tool call or command fails: diagnose, adjust and retry.',
  '- Do not redefine success around a smaller or easier task, and do not substitute a narrower, safer, or merely test-passing solution for the behavior the objective asks for.',
  '- Treat completion as unproven until you have inspected authoritative evidence (file contents, command output, test results, runtime behavior) for every requirement.',
  '</goal_round>',
].join('\n');

/**
 * The default strategy, the module `builtIn:goal`. Each round is this agent
 * again (`self()`), forked from the conversation as it stood when the goal
 * started, told the previous round's report, and ends with a verdict. It
 * stops when a round says the objective is done or needs the user, when a
 * round fails or submits no verdict, or when the goal's spend after a round
 * reaches `maxCostUsd` (`0`: no cap). `spent` is what the goal has spent in
 * all (every round, failed ones too, and work a round left running), never
 * a sum of its own. Constants reach the source as JSON literals;
 * `String.raw` keeps the module's own escapes as written.
 */
export const GOAL_MODULE = String.raw`const brief = ${JSON.stringify(ROUND_BRIEF)};
const schema = ${JSON.stringify(ROUND_SCHEMA)};
export const goal = async (objective, { maxCostUsd }) => {
  let report = '';
  let spent = 0;
  for (let round = 1; ; round += 1) {
    section('Round ' + round);
    const previous = round === 1 ? '' : '\n\n<previous_round round="' + (round - 1) + '">\n' + report + '\n</previous_round>';
    const paused = (pause) => ({ outcome: 'paused', pause, rounds: round, spent, report });
    let reply;
    try {
      reply = await self(brief + '\n\n<objective>\n' + objective + '\n</objective>' + previous, {
        schema, label: 'Round ' + round,
      });
    } catch (error) {
      return paused({ reason: 'round_failed', error: { name: error.name, message: error.message } });
    }
    spent = reply.spent;
    if (reply.structured == null) return paused({ reason: 'no_verdict', response: reply.response });
    report = reply.structured.report;
    if (reply.structured.status === 'done') return { outcome: 'completed', rounds: round, spent, report };
    if (reply.structured.status === 'needs_user') return paused({ reason: 'needs_user' });
    if (maxCostUsd > 0 && spent >= maxCostUsd) return paused({ reason: 'spend_cap', maxCostUsd });
  }
};`;

/**
 * The goal's script: the `goal` export of the module `strategy` names, on
 * `objective` with the cap `maxCostUsd`. What it resolves to is the
 * script's return, so the goal's run ends with it as its structured output.
 */
export const goalScript = (
  strategy: string,
  objective: string,
  maxCostUsd: number,
): string =>
  `const { goal } = await import(${JSON.stringify(strategy)});
return await goal(${JSON.stringify(objective)}, { maxCostUsd: ${JSON.stringify(maxCostUsd)} });`;
