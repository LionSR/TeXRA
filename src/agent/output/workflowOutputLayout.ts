/**
 * Single source of truth for workflow output-file layout.
 *
 * Current format (runDir-relative):
 *   r{round}/output.<ext>
 *
 * Merge output (single-output, non-round, runDir-relative):
 *   _full.<ext>
 *
 * Legacy format (frozen; pre-r{round}/ refactor):
 *   <inputDir>/<inputBase>_<agentChunk>_r{round}_<normalizedModel>.*
 *
 * Per-execution isolation (executions/{id}/...) provides uniqueness;
 * agent/model/round-in-basename tokens are no longer needed.
 */

import { getCleanAgentName } from '@agent/index';
import { escapeRegExp } from '@utils/core/stringCore';

// ---------------------------------------------------------------------------
// Current layout
// ---------------------------------------------------------------------------

/** The fixed basename of every workflow output file (no extension). */
export const WORKFLOW_OUTPUT_BASENAME = 'output';

/** Build the `r{round}` subdirectory name. */
export function workflowOutputRoundDir(round: number): string {
  return `r${round}`;
}

/** Parse a directory name of the form `r{round}` into its round index. */
export function parseWorkflowOutputRoundDir(dirName: string): number | null {
  const match = /^r(\d+)$/.exec(dirName);
  return match ? Number(match[1]) : null;
}

/** Build a runDir-relative workflow output path for a round. */
export function workflowOutputPath(params: {
  ext: string;
  round: number;
}): string {
  return `${workflowOutputRoundDir(params.round)}/${WORKFLOW_OUTPUT_BASENAME}.${params.ext}`;
}

/** Anchored regex matching an output `.tex` filename in the current layout. */
export function workflowOutputTexRegex(): RegExp {
  return new RegExp(`^${escapeRegExp(WORKFLOW_OUTPUT_BASENAME)}\\.tex$`);
}

/**
 * Glob prefix (within the round dir) for the current layout:
 *   `r{round}/output`
 * Callers append suffixes (`_diff`, `_thinking`) and extensions.
 */
export function workflowOutputGlobPrefix(params: { round: number }): string {
  return `${workflowOutputRoundDir(params.round)}/${WORKFLOW_OUTPUT_BASENAME}`;
}

// ---------------------------------------------------------------------------
// Merge layout — runDir-relative, fixed basename
// ---------------------------------------------------------------------------

/** Build the runDir-relative merge output path. */
export function workflowMergeOutputPath(params: { ext: string }): string {
  return `_full.${params.ext}`;
}

// ---------------------------------------------------------------------------
// Legacy layout (frozen; pre-r{round}/ refactor) — read-only for migration
// ---------------------------------------------------------------------------

/** Normalize a model name to the legacy form (dots stripped). */
export function normalizeLegacyModel(model: string): string {
  return model.replaceAll('.', '');
}

/** Legacy first-name chunk used in pre-refactor filenames. */
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

/** Legacy filename stem (no extension): `<base>_<chunk>_r{round}_<normalizedModel>`. */
export function legacyWorkflowOutputStem(params: {
  base: string;
  agent: string;
  model: string;
  round: number;
}): string {
  return `${params.base}_${getAgentFirstNameChunk(params.agent)}_r${params.round}_${normalizeLegacyModel(params.model)}`;
}

/** Anchored regex capturing the round from legacy flat filenames. */
export function legacyWorkflowOutputRoundRegex(
  base: string,
  agent: string,
  model: string,
): RegExp {
  return new RegExp(
    `${escapeRegExp(base)}_${escapeRegExp(getAgentFirstNameChunk(agent))}_r(\\d+)_${escapeRegExp(normalizeLegacyModel(model))}`,
  );
}
