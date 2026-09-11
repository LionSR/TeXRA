/**
 * Workflow output-file layout — current format (runDir-relative):
 *   r{round}/output.<ext>
 *
 * Per-run isolation (executions/{id}/...) provides uniqueness;
 * agent/model/round-in-basename tokens are no longer needed.
 *
 * The one exception is the extension's "Save as copy" action, which still
 * names its copy `<base>_<chunk>_r{round}_<model>` beside the base file.
 * Those copies are ordinary user files: no reader parses that name.
 */

// Local imports
import { getCleanAgentName } from '@shared/schemas';

/** The fixed basename of every workflow output file (no extension). */
export const WORKFLOW_OUTPUT_BASENAME = 'output';

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

/**
 * Build a runDir-relative workflow output path for a round: `r{round}/output.{ext}`.
 *
 * IMPORTANT: callers MUST resolve this through a TaskRunFileService bound to an
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

/** First-name chunk used in the "Save as copy" stem. */
function getAgentFirstNameChunk(agent: string): string {
  const cleanAgent = getCleanAgentName(agent);
  if (cleanAgent.startsWith('write-')) {
    return cleanAgent.split('-')[1];
  }
  if (cleanAgent.includes('_')) {
    return cleanAgent.split('_')[0];
  }
  return cleanAgent.split('-')[0];
}

/**
 * The `<base>_<chunk>_r{round}_<model>` stem "Save as copy" writes beside a
 * base file.
 */
export function workflowOutputCopyStem(params: {
  base: string;
  agent: string;
  model: string;
  round: number;
}): string {
  return `${params.base}_${getAgentFirstNameChunk(params.agent)}_r${params.round}_${params.model}`;
}
