/**
 * Workflow output-file layout — current format (runDir-relative):
 *   r{round}/output.<ext>
 *
 * Per-run isolation (executions/{id}/...) provides uniqueness;
 * agent/model/round-in-basename tokens are no longer needed.
 */

/** The fixed basename of every workflow output file (no extension). */
export const WORKFLOW_OUTPUT_BASENAME = 'output';

/** The fixed extension for a document task revision's raw output. */
export const WORKFLOW_RAW_OUTPUT_EXT = 'xml';

/**
 * Drop the leading `r{round}/` directory of a runDir-relative path; with
 * `round`, only that round's. Any other path comes back unchanged.
 */
export function stripWorkflowRoundDir(
  relativePath: string,
  round?: number,
): string {
  const match = /^r(\d+)[/\\]/.exec(relativePath);
  return match && (round === undefined || Number(match[1]) === round)
    ? relativePath.slice(match[0].length)
    : relativePath;
}

/** The runDir-relative `r{round}` directory segment for a document task revision. */
export function workflowOutputRoundDir(round: number): string {
  return `r${round}`;
}

/**
 * Build a runDir-relative workflow output path for a round: `r{round}/output.{ext}`.
 *
 * IMPORTANT: callers MUST resolve this through a RunFileService bound to an
 * runId. The fixed-stem filename is only collision-safe when combined
 * with per-run run storage; a workspace-scoped resolution would route
 * every round to the same `<workspace>/r{round}/output.{ext}` and clobber
 * outputs across runs.
 */
export function workflowOutputPath(params: {
  ext: string;
  round: number;
}): string {
  return `${workflowOutputRoundDir(params.round)}/${WORKFLOW_OUTPUT_BASENAME}.${params.ext}`;
}
