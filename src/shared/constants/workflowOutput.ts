/**
 * Workflow output-file layout — current format (runDir-relative):
 *   r{round}/output.<ext>
 *
 * Per-execution isolation (executions/{id}/...) provides uniqueness;
 * agent/model/round-in-basename tokens are no longer needed.
 *
 * Filename-era compatibility helpers live separately in
 * `@shared/constants/legacyWorkflowOutput`; they require agent-name parsing
 * and are still consumed by workspace migration readers and one copy writer.
 */

/** The fixed basename of every workflow output file (no extension). */
export const WORKFLOW_OUTPUT_BASENAME = 'output';

/** The fixed extension for TeXRA-named LaTeX workflow outputs. */
export const WORKFLOW_DOCUMENT_OUTPUT_EXT = 'tex';

/** The fixed extension for raw workflow round output. */
export const WORKFLOW_RAW_OUTPUT_EXT = 'xml';

/** Parse a directory name of the form `r{round}` into its round index. */
export function parseWorkflowOutputRoundDir(dirName: string): number | null {
  const match = /^r(\d+)$/.exec(dirName);
  return match ? Number(match[1]) : null;
}

/** The runDir-relative `r{round}` directory segment for a workflow round. */
export function workflowOutputRoundDir(round: number): string {
  return `r${round}`;
}

/** Build a runDir-relative workflow output path for a round. */
export function workflowOutputPath(params: {
  ext: string;
  round: number;
}): string {
  return `${workflowOutputRoundDir(params.round)}/${WORKFLOW_OUTPUT_BASENAME}.${params.ext}`;
}
