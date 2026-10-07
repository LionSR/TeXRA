import { z } from 'zod';

/**
 * A plan is a plain objective document: what to achieve, the intended
 * approach, and a verifiable stopping condition. It deliberately has no
 * structured steps, so the document stays a clear objective statement
 * that can seed an autonomous goal verbatim.
 *
 * Pre-June-2026 plans were structured ({summary, steps[]}); those simply
 * fail to parse and read back as "no plan", which is fine — a plan only
 * matters for the session it was approved in.
 */
export const PlanSchema = z.strictObject({
  objective: z
    .string()
    .min(1)
    .describe(
      'The plan document: what to achieve, the approach, and a verifiable stopping condition',
    ),
});
export type Plan = z.infer<typeof PlanSchema>;

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
