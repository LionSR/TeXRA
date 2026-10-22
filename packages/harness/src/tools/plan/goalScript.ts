/**
 * The goal template: the script "Run as Goal" runs in the background of the
 * conversation that approved the plan. Each round is this agent again
 * (`self()`), forked from that conversation as it stood when the goal
 * started, and ends with a verdict; the
 * script stops when a round says the objective is done or needs the user,
 * when a round fails, or when the rounds reach the spend cap. An agent that
 * wants another stopping rule writes the same loop with its own check.
 */

/** The verdict each round submits. */
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
 * The goal's script for `objective`, stopping its rounds at `maxCostUsd` of
 * spend (`0`: no cap). The cap reads what the goal has spent in all after
 * each round (`spent`: every round, failed ones too, and work a round left
 * running), never a sum of its own. It returns `{ status, rounds, report }`,
 * with `status` `'completed'` or `'paused'`. Every value reaches the source as a JSON literal;
 * `String.raw` keeps the script's own escapes as written.
 */
export const goalScript = (objective: string, maxCostUsd: number): string =>
  String.raw`const objective = ${JSON.stringify(objective)};
const maxCostUsd = ${JSON.stringify(maxCostUsd)};
const brief = ${JSON.stringify(ROUND_BRIEF)};
const schema = ${JSON.stringify(ROUND_SCHEMA)};
let report = '';
for (let round = 1; ; round += 1) {
  phase('Round ' + round);
  const previous = round === 1 ? '' : '\n\n<previous_round round="' + (round - 1) + '">\n' + report + '\n</previous_round>';
  let reply;
  try {
    reply = await self(brief + '\n\n<objective>\n' + objective + '\n</objective>' + previous, {
      schema, label: 'Round ' + round,
    });
  } catch (error) {
    return { status: 'paused', rounds: round, report: 'Round ' + round + ' ended without a verdict (' + error.name + '): ' + error.message };
  }
  if (reply.structured == null)
    return { status: 'paused', rounds: round, report: 'Round ' + round + ' ended without a verdict: it did not submit one.\n\n' + reply.response };
  report = reply.structured.report;
  if (reply.structured.status === 'done') return { status: 'completed', rounds: round, report };
  if (reply.structured.status === 'needs_user') return { status: 'paused', rounds: round, report };
  if (maxCostUsd > 0 && reply.spent >= maxCostUsd)
    return { status: 'paused', rounds: round, report: 'The goal has spent $' + reply.spent.toFixed(2) + ', reaching its cap of $' + maxCostUsd + ' (texra.goal.maxCostUsd).\n\n' + report };
}`;
