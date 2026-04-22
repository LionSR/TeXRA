/**
 * Single source of truth for workflow output-file layout.
 *
 * Current format:
 *   <inputDir>/r{round}/<inputBase>_<cleanAgent>_<model>.<ext>
 *
 * Merge output (single-output, non-round):
 *   <inputDir>/<editedBase>_full_<model>.tex
 *
 * Legacy format (frozen; pre-r{round}/ refactor):
 *   <inputDir>/<inputBase>_<agentChunk>_r{round}_<normalizedModel>.*
 *
 * Writers (outputFileUtils), glob readers (housekeeping), and regex scanners
 * (latexdiff) all derive their patterns from the helpers here so a schema
 * change is a one-file edit.
 */

import * as path from 'path';

import { getCleanAgentName } from '@agent/index';
import { escapeRegExp } from '@utils/core/stringCore';

// ---------------------------------------------------------------------------
// Current layout
// ---------------------------------------------------------------------------

/** Build the `r{round}` subdirectory name. */
export function workflowOutputRoundDir(round: number): string {
  return `r${round}`;
}

/** Parse a directory name of the form `r{round}` into its round index. */
export function parseWorkflowOutputRoundDir(dirName: string): number | null {
  const match = /^r(\d+)$/.exec(dirName);
  return match ? Number(match[1]) : null;
}

/** Build the filename stem `<base>_<cleanAgent>_<model>` (no extension). */
export function workflowOutputFilenameStem(
  base: string,
  agent: string,
  model: string,
): string {
  return `${base}_${getCleanAgentName(agent)}_${model}`;
}

/** Build a full workflow output path for a round. */
export function workflowOutputPath(params: {
  inputFile: string;
  agent: string;
  model: string;
  ext: string;
  round: number;
}): string {
  const parsed = path.parse(params.inputFile);
  const stem = workflowOutputFilenameStem(
    parsed.name,
    params.agent,
    params.model,
  );
  return path.join(
    parsed.dir,
    workflowOutputRoundDir(params.round),
    `${stem}.${params.ext}`,
  );
}

/**
 * Anchored regex matching a `.tex` filename in the current layout.
 * Model dots are preserved in the stored name, so metachars are escaped.
 */
export function workflowOutputTexRegex(
  base: string,
  agent: string,
  model: string,
): RegExp {
  const stem = `${escapeRegExp(base)}_${escapeRegExp(getCleanAgentName(agent))}_${escapeRegExp(model)}`;
  return new RegExp(`^${stem}\\.tex$`);
}

/**
 * Glob prefix (within the round dir) for the current layout:
 *   `r{round}/<base>_<cleanAgent>_<model>`
 * Callers append suffixes (`_diff`, `_thinking`) and extensions.
 */
export function workflowOutputGlobPrefix(params: {
  base: string;
  agent: string;
  model: string;
  round: number;
}): string {
  const stem = workflowOutputFilenameStem(
    params.base,
    params.agent,
    params.model,
  );
  return `${workflowOutputRoundDir(params.round)}/${stem}`;
}

// ---------------------------------------------------------------------------
// Merge layout — single-output, model-discriminated
// ---------------------------------------------------------------------------

/** Build the merge output filename stem `<editedBase>_full_<model>` (no extension). */
export function workflowMergeFilenameStem(
  editedBase: string,
  model: string,
): string {
  return `${editedBase}_full_${model}`;
}

/** Build the full merge output path next to the input. */
export function workflowMergeOutputPath(params: {
  inputFile: string;
  editedBase: string;
  model: string;
}): string {
  const stem = workflowMergeFilenameStem(params.editedBase, params.model);
  return path.join(path.dirname(params.inputFile), `${stem}.tex`);
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
