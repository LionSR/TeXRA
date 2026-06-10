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
 *
 * The current-layout constants and helpers live in
 * `@shared/constants/workflowOutput` (a leaf module usable from low-level
 * code like `@utils/files`); they are re-exported here so agent-side callers
 * have one import point for both eras.
 */

import { getCleanAgentName } from '@shared/schemas/agent';
import { escapeRegExp } from '@utils/core/stringCore';

// ---------------------------------------------------------------------------
// Current layout (re-exported from the shared leaf module)
// ---------------------------------------------------------------------------

export {
  WORKFLOW_OUTPUT_BASENAME,
  WORKFLOW_DOCUMENT_OUTPUT_EXT,
  WORKFLOW_RAW_OUTPUT_EXT,
  parseWorkflowOutputRoundDir,
  workflowOutputPath,
} from '@shared/constants/workflowOutput';

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
