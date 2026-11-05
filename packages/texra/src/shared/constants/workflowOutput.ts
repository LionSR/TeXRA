/**
 * Workflow output-file layout — current format (runDir-relative):
 *   r{round}/output.<ext>
 *
 * Per-run isolation (executions/{id}/...) provides uniqueness;
 * agent/model/round-in-basename tokens are no longer needed.
 */
import type { FileLocation } from '@texra-ai/harness/schemas';

/** The fixed basename of every workflow output file (no extension). */
export const WORKFLOW_OUTPUT_BASENAME = 'output';

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
 * The runDir-relative path where a revision keeps the model's version of
 * one of its outputs, as extraction wrote it: Accept diffs the accepted
 * file against it, so the model learns what the user changed. A
 * run-storage output keeps its path under the round, a workspace output its
 * workspace-relative path; an output outside both keeps none.
 */
export function modelOutputCopyPath(
  round: number,
  location: FileLocation,
): string | undefined {
  const dir = `${workflowOutputRoundDir(round)}/model`;
  switch (location.kind) {
    case 'runStorage':
      return `${dir}/run/${stripWorkflowRoundDir(location.relativePath, round)}`;
    case 'workspace':
      return `${dir}/workspace/${location.relativePath}`;
    case 'external':
      return undefined;
  }
}
