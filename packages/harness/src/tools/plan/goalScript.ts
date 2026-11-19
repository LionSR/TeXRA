/**
 * The goal: "Run as Goal" runs a background script of the conversation
 * that approved the plan, and that script only calls a strategy, the `goal`
 * export of the script module `goal.strategy` names. The strategy decides
 * the rounds, what context each starts from and when to stop, and resolves
 * to the goal's result (`GoalResultSchema`). The default strategy is the
 * goal plugin's own module, `builtIn:goal`; a plugin replaces it by shipping
 * another module and naming it in the setting, and a script may call any of
 * them itself, or import the module's `judge` to check work its own way.
 */

/** The verdict each round of the default strategy submits. */
const ROUND_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['continue', 'done', 'needs_user'],
      description:
        '`done` only once evidence you inspected shows every requirement of the objective holds now; `needs_user` when you cannot go on without the user; `continue` otherwise.',
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

/** One claim a judge submits, per requirement. The shape is this module's
 *  own: a script may import `claimSchema` or write another. */
const CLAIM_SCHEMA = {
  type: 'object',
  properties: {
    requirement: {
      type: 'string',
      description: 'One requirement, derived from the objective.',
    },
    status: {
      type: 'string',
      enum: ['verified', 'failed', 'unverified'],
      description:
        '`verified` when your check shows the requirement holds; `failed` when it shows it does not; `unverified` when you could not check it.',
    },
    check: {
      type: 'string',
      description:
        'A check someone else can run again: a command, or a file and what to look for in it.',
    },
    observed: {
      type: 'string',
      description: 'What the check showed, quoted.',
    },
  },
  required: ['requirement', 'status', 'check', 'observed'],
  additionalProperties: false,
};

/** What the judge is told before the objective and the report. */
const JUDGE_BRIEF = [
  '<goal_judge>',
  'Decide whether the objective below is met, as things stand now.',
  '- You did not do this work. The report below, if any, is the claim of whoever did: a claim, not evidence.',
  '- Derive the requirements from the objective itself, and submit one claim per requirement.',
  '- Each claim names a check someone else can run again and quotes what it showed.',
  '- What you could not check is `unverified`, never `verified`.',
  '- Do not change the work under judgment; scratch files for a check are fine.',
  'How you check, and how deep, is yours to decide.',
  '</goal_judge>',
].join('\n');

/** What every round is told before the objective. */
const ROUND_BRIEF = [
  '<goal_round>',
  "You are one round of a goal the user approved: work on the objective below yourself, now. What earlier rounds did is in the project and in the previous round's report below.",
  'Make as much verified progress as you can, then submit your verdict.',
  '- Do not redefine success around a smaller or easier task, and do not substitute a narrower, safer, or merely test-passing solution for the behavior the objective asks for.',
  '- Treat completion as unproven until evidence you inspected shows every requirement holds.',
  '- Your `done` is a claim: a judge that did not do the work checks it, and what it finds not met comes back to the next round.',
  '</goal_round>',
].join('\n');

/**
 * The goal plugin's script module, `builtIn:goal`: two building blocks and
 * the default strategy composed of them. `judge` is this agent again with
 * no earlier conversation (`self()` with `fork: false`), so it holds the
 * tools the conversation's agent holds and none of the conversation the
 * work was done in. `goal` runs forked `self()` rounds, each told the
 * previous round's report; a round's `done` goes to `judge`, and the goal
 * completes when no claim failed, else the next round is told the failed
 * claims. It pauses when a round needs the user, when a round or the judge
 * fails or gives no verdict, or when the goal's spend after a round (and
 * its judge) reaches `maxCostUsd` (`0`: no cap), which also bounds a
 * worker and judge that keep disagreeing. `spent` is what the goal has
 * spent in all (every round and judge, failed ones too, and work a round
 * left running), never a sum of its own. Constants reach the source as
 * JSON literals; `String.raw` keeps the module's own escapes as written.
 */
export const GOAL_MODULE = String.raw`const roundBrief = ${JSON.stringify(ROUND_BRIEF)};
const roundSchema = ${JSON.stringify(ROUND_SCHEMA)};
const judgeBrief = ${JSON.stringify(JUDGE_BRIEF)};
const tagged = (tag, text) => '\n\n<' + tag + '>\n' + text + '\n</' + tag + '>';

// The JSON Schema of one claim: { requirement, status: 'verified' | 'failed' | 'unverified', check, observed }.
export const claimSchema = ${JSON.stringify(CLAIM_SCHEMA)};

// judge(objective, { report?, label? }): a fresh run of you, which did not do the work, checks every
// requirement of objective its own way; report is the worker's claim, shown to it as a hint only.
// Resolves to { claims, failed, spent }: one claim per requirement, the claims that failed, and what
// this run has spent in all. Rejects as self() does, or with an Error named NoVerdict (its reply as
// the message) when the judge submits no claims.
export const judge = async (objective, { report, label } = {}) => {
  const reply = await self(judgeBrief + tagged('objective', objective) + (report ? tagged('report', report) : ''), {
    fork: false, label: label ?? 'Judge',
    schema: { type: 'object', properties: { claims: { type: 'array', minItems: 1, items: claimSchema } }, required: ['claims'], additionalProperties: false },
  });
  if (reply.structured == null) {
    const error = new Error(reply.response);
    error.name = 'NoVerdict';
    throw error;
  }
  const { claims } = reply.structured;
  return { claims, failed: claims.filter((claim) => claim.status === 'failed'), spent: reply.spent };
};

// goal(objective, { maxCostUsd }): the default strategy, forked rounds and a judge of each done.
// Resolves to the goal's result: { outcome: 'completed' | 'paused', pause?, rounds, spent, report, claims? }.
export const goal = async (objective, { maxCostUsd }) => {
  let report = '';
  let spent = 0;
  let claims;
  let findings = '';
  for (let round = 1; ; round += 1) {
    section('Round ' + round);
    const previous = round === 1 ? '' : '\n\n<previous_round round="' + (round - 1) + '">\n' + report + '\n</previous_round>' + findings;
    const paused = (pause) => ({ outcome: 'paused', pause, rounds: round, spent, report, ...(claims && { claims }) });
    let reply;
    try {
      reply = await self(roundBrief + tagged('objective', objective) + previous, {
        schema: roundSchema, label: 'Round ' + round,
      });
    } catch (error) {
      return paused({ reason: 'round_failed', error: { name: error.name, message: error.message } });
    }
    spent = reply.spent;
    if (reply.structured == null) return paused({ reason: 'no_verdict', response: reply.response });
    report = reply.structured.report;
    findings = '';
    if (reply.structured.status === 'needs_user') return paused({ reason: 'needs_user' });
    if (reply.structured.status === 'done') {
      let verdict;
      try {
        verdict = await judge(objective, { report, label: 'Judge round ' + round });
      } catch (error) {
        return paused({ reason: 'judge_failed', error: { name: error.name, message: error.message } });
      }
      ({ claims, spent } = verdict);
      if (verdict.failed.length === 0) return { outcome: 'completed', rounds: round, spent, report, claims };
      findings = tagged('judge_findings', 'A judge that did not do the work found these requirements not met:\n' +
        verdict.failed.map((claim) => '- ' + claim.requirement + '\n  check: ' + claim.check + '\n  showed: ' + claim.observed).join('\n'));
    }
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
