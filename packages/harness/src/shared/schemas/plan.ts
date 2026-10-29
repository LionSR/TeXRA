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
export const GOAL_PLAN_ARM = Object.freeze({
  plugin: 'goal',
  kind: 'plan',
  version: 1,
  schema: PlanSchema,
  upcasters: Object.freeze([]),
  fork: 'cut',
} as const);

/** The plan the user last approved in `run` (its `RunView.facts`), if any. */
export function planOf(run: {
  readonly facts: Readonly<Record<string, unknown>>;
}): Plan | null {
  const value = run.facts[`${GOAL_PLAN_ARM.plugin}/${GOAL_PLAN_ARM.kind}`];
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
