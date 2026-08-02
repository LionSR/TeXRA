/**
 * Workflow output-file layout — current format (runDir-relative):
 *   r{round}/output.<ext>
 *
 * Per-execution isolation (executions/{id}/...) provides uniqueness;
 * agent/model/round-in-basename tokens are no longer needed.
 *
 * Filename-era compatibility helpers (the legacy grammar below) require
 * agent-name parsing and are still consumed by workspace migration readers
 * and one copy writer.
 */

// Third-party imports
import escapeRegExp from 'escape-string-regexp';

// Local imports
import { getCleanAgentName } from '@shared/schemas/agent';

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

// ============================================================================
// Filename-era workflow output compatibility grammar
// ============================================================================
//
// Before workflow outputs moved to execution-scoped `r{round}/output.*`
// paths, their agent, round, and model were encoded in workspace filenames.
// Housekeeping, XML packing, latexdiff discovery, and the extension's
// "Save as copy" action still consume this grammar.

/** Normalize a model name to the filename-era form (dots stripped). */
export function normalizeLegacyModel(model: string): string {
  return model.replaceAll('.', '');
}

/** First-name chunk used in pre-refactor filenames. */
export function getAgentFirstNameChunk(agent: string): string {
  const cleanAgent = getCleanAgentName(agent);
  if (cleanAgent.startsWith('write-')) {
    return cleanAgent.split('-')[1];
  }
  if (cleanAgent.includes('_')) {
    return cleanAgent.split('_')[0];
  }
  return cleanAgent.split('-')[0];
}

/** Filename-era stem: `<base>_<chunk>_r{round}_<normalizedModel>`. */
export function legacyWorkflowOutputStem(params: {
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
