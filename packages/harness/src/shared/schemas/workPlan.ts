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
