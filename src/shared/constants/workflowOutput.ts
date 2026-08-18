/**
 * Workflow output-file layout — current format (runDir-relative):
 *   r{round}/output.<ext>
 *
 * Per-execution isolation (executions/{id}/...) provides uniqueness;
 * agent/model/round-in-basename tokens are no longer needed.
 *
 * The `<base>_<agent>_r{round}_<model>` grammar below is not purely historic:
 * workspace migration readers still match files pre-refactor runs wrote with
 * it, and the extension's "Save as copy" action still writes new files with
 * it today. Everything in it derives from one place so a reader can never
 * spell a name a writer would not produce.
 */

// Third-party imports
import escapeRegExp from 'escape-string-regexp';

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
 * executionId. The fixed-stem filename is only collision-safe when combined
 * with per-execution run storage; a workspace-scoped resolution would route
 * every round to the same `<workspace>/r{round}/output.{ext}` and clobber
 * outputs across runs.
 */
export function workflowOutputPath(params: {
  ext: string;
  round: number;
}): string {
  return `${workflowOutputRoundDir(params.round)}/${WORKFLOW_OUTPUT_BASENAME}.${params.ext}`;
}

// ============================================================================
// Agent/round/model filename grammar
// ============================================================================
//
// Before workflow outputs moved to execution-scoped `r{round}/output.*`
// paths, their agent, round, and model were encoded in workspace filenames.
// Housekeeping, XML packing, latexdiff discovery, and the extension's
// "Save as copy" action still consume this grammar — the last of those still
// writes it.

/** Normalize a model name to the filename-era form (dots stripped). */
export function normalizeLegacyModel(model: string): string {
  return model.replaceAll('.', '');
}

/** First-name chunk used in the `<base>_<chunk>_r{round}_<model>` grammar. */
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
 * The `<base>_<chunk>_r{round}_<normalizedModel>` stem: the name filename-era
 * runs wrote, and the one "Save as copy" still writes beside a base file
 * today. Every reader of that layout composes its names from here.
 */
export function workflowOutputCopyStem(params: {
  base: string;
  agent: string;
  model: string;
  round: number;
}): string {
  return `${params.base}_${getAgentFirstNameChunk(params.agent)}_r${params.round}_${normalizeLegacyModel(params.model)}`;
}

/**
 * Mid-era filename stem: `<base>_<cleanAgent>_<model>`.
 *
 * These files lived in workspace `r{round}/` directories, after the round
 * token left the basename but before outputs moved to execution storage.
 */
export function midEraWorkflowOutputStem(params: {
  base: string;
  agent: string;
  model: string;
}): string {
  return `${params.base}_${getCleanAgentName(params.agent)}_${params.model}`;
}

/** Regex capturing the round from a filename-era flat output name. */
export function legacyWorkflowOutputRoundRegex(
  base: string,
  agent: string,
  model: string,
): RegExp {
  return new RegExp(
    `${escapeRegExp(base)}_${escapeRegExp(getAgentFirstNameChunk(agent))}_r(\\d+)_${escapeRegExp(normalizeLegacyModel(model))}`,
  );
}
