/**
 * Single source of truth for workflow output-file layout.
 *
 * Current format (runDir-relative):
 *   r{round}/output.<ext>
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

/** The fixed extension for TeXRA-named LaTeX workflow outputs. */
export const WORKFLOW_DOCUMENT_OUTPUT_EXT = 'tex';

/** The fixed extension for raw workflow round output. */
export const WORKFLOW_RAW_OUTPUT_EXT = 'xml';

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
  return `r${params.round}/${WORKFLOW_OUTPUT_BASENAME}.${params.ext}`;
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

/**
 * Mid-era filename stem (no extension): `<base>_<cleanAgent>_<model>`.
 *
 * Between the legacy flat layout and the current runDir-scoped layout, the
 * output filename dropped the `_r{round}_` token but the files still lived
 * in the workspace under an `r{round}/` subdirectory. Returned here as the
 * filename stem only — callers combine it with the round-dir glob prefix.
 */
export function midEraWorkflowOutputStem(params: {
  base: string;
  agent: string;
  model: string;
}): string {
  return `${params.base}_${getCleanAgentName(params.agent)}_${params.model}`;
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
