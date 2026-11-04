import { Schema } from 'effect';

/**
 * A plan is a plain objective document: what to achieve, the intended
 * approach, and a verifiable stopping condition. It deliberately has no
 * structured steps, so the document stays a clear objective statement
 * that can seed an autonomous goal verbatim.
 */
export const PlanSchema = Schema.Struct({
  objective: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      'The plan document: what to achieve, the approach, and a verifiable stopping condition',
  }),
});
export type Plan = typeof PlanSchema.Type;

/** The goal plugin's row kind: the run's approved plan, a fact of the
 *  `plan` call the user approved. A fork starts with the plan its source
 *  held at the cut. */
export const GOAL_PLAN_KIND = Object.freeze({
  plugin: 'goal',
  kind: 'plan',
  version: 1,
  schema: PlanSchema,
  upcasters: Object.freeze([]),
  fork: 'copy',
} as const);

/**
 * Why a goal stopped short of its objective, told apart by `reason`: a
 * round said it needs the user (its report says what for), a round failed
 * (the error its `self()` call rejected with), a round ended without a
 * verdict (its reply instead), or the goal reached its spend cap.
 */
const GoalPauseSchema = Schema.Union([
  Schema.Struct({ reason: Schema.Literal('needs_user') }),
  Schema.Struct({
    reason: Schema.Literal('round_failed'),
    error: Schema.Struct({ name: Schema.String, message: Schema.String }),
  }),
  Schema.Struct({
    reason: Schema.Literal('no_verdict'),
    response: Schema.String,
  }),
  Schema.Struct({
    reason: Schema.Literal('spend_cap'),
    maxCostUsd: Schema.Finite,
  }),
]);

/** What every goal result carries, whatever its outcome. */
const GOAL_RESULT_FIELDS = {
  /** The rounds the goal started, the last one included. */
  rounds: Schema.Int,
  /** What the goal had spent in all, in US dollars, as its last finished
   *  round reported (`self()`'s `spent`): the figure the cap is checked
   *  against between rounds, never a bound on a round in flight. */
  spent: Schema.Finite,
  /** The latest report a round submitted; empty before the first. */
  report: Schema.String,
};

/**
 * A goal's result: what its strategy, the `goal` export of the script
 * module the `goal.strategy` setting names, returns, and so the structured
 * output its run ends with. `completed` when a round verified the
 * objective, `paused` with the reason otherwise. A pause is a result, not a
 * waiting run: work continues through a new goal or a new turn.
 */
export const GoalResultSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal('completed'),
    ...GOAL_RESULT_FIELDS,
  }),
  Schema.Struct({
    outcome: Schema.Literal('paused'),
    pause: GoalPauseSchema,
    ...GOAL_RESULT_FIELDS,
  }),
]);

/** The plan the user last approved in `run` (its `RunView.facts`), if any. */
export function planOf(run: {
  readonly facts: Readonly<Record<string, unknown>>;
}): Plan | null {
  const value = run.facts[`${GOAL_PLAN_KIND.plugin}/${GOAL_PLAN_KIND.kind}`];
  return value === undefined
    ? null
    : Schema.decodeUnknownSync(PlanSchema)(value);
}

const MARKDOWN_HEADING_RE = /^#{1,6}\s+/;

/** One-line label for a plan document: its first line of prose. A markdown
 *  heading (`### Objective`) names a section rather than the plan, so it
 *  labels the plan, markers stripped, only when the plan has no prose. */
export function planSummaryLine(objective: string): string {
  const lines = objective
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const prose = lines.find((line) => !MARKDOWN_HEADING_RE.test(line));
  return (
    prose ?? lines.at(0)?.replace(MARKDOWN_HEADING_RE, '') ?? '(empty plan)'
  );
}
