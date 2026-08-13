/**
 * Category-aware filtering of agent config fields for the /config endpoint.
 * Hides fields that aren't meaningful for the agent's execution mode so the
 * serialized config the orchestrator reads stays relevant. Non-agent records
 * are honest by construction and serialize verbatim.
 */

import type { RunRecord } from '@agent/core/definition/RunRecord';

/** Config fields only relevant to workflow agents — hidden for toolUse. */
const WORKFLOW_ONLY_FIELDS = new Set([
  'inputFile',
  'inputFiles',
  'contextFile',
  'contextFiles',
  'mediaFile',
  'mediaFiles',
  'outputFiles',
  'editedFile',
  'editedFiles',
]);

/** Config fields only relevant to toolUse agents — hidden for workflow. */
const TOOL_USE_ONLY_FIELDS = new Set(['toolConfig']);

/** Per-category field-exclusion sets; unknown categories get no filtering. */
const HIDDEN_BY_CATEGORY: Readonly<Record<string, ReadonlySet<string>>> = {
  toolUse: WORKFLOW_ONLY_FIELDS,
  workflow: TOOL_USE_ONLY_FIELDS,
};

/**
 * Serialize a run record to pretty JSON, dropping agent-config fields
 * irrelevant to the resolved display category. Records without an agent
 * execution mode serialize unchanged.
 */
export function serializeFilteredConfig(
  record: RunRecord,
  category: string | undefined,
): string {
  const excludeSet = category ? HIDDEN_BY_CATEGORY[category] : undefined;
  if (!excludeSet) {
    return JSON.stringify(record, null, 2);
  }
  const filtered = Object.fromEntries(
    Object.entries(record).filter(([key]) => !excludeSet.has(key)),
  );
  return JSON.stringify(filtered, null, 2);
}
