/**
 * Filename-era workflow output compatibility grammar.
 *
 * Before workflow outputs moved to execution-scoped `r{round}/output.*`
 * paths, their agent, round, and model were encoded in workspace filenames.
 * Housekeeping, XML packing, latexdiff discovery, and the extension's
 * "Save as copy" action still consume this grammar. Keep it separate from
 * the browser-safe canonical layout in `workflowOutput.ts`.
 */

// Third-party imports
import escapeRegExp from 'escape-string-regexp';

// Local imports
import { getCleanAgentName } from '@shared/schemas/agent';

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
