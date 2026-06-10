/**
 * Category-aware filtering of agent config fields for the /config endpoint.
 * Hides fields that aren't meaningful for the execution's category so the
 * serialized config the orchestrator reads stays relevant.
 */

import type { AgentConfig } from '@agent/core/definition/AgentConfig';

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

/** Synthetic process configs carry agent-only defaults that are not meaningful. */
const PROCESS_HIDDEN_FIELDS = new Set(['model', 'agentCategory', 'toolConfig']);

function hiddenFieldsFor(category: string): ReadonlySet<string> {
  switch (category) {
    case 'process':
      return PROCESS_HIDDEN_FIELDS;
    case 'toolUse':
      return WORKFLOW_ONLY_FIELDS;
    default:
      return TOOL_USE_ONLY_FIELDS;
  }
}

/**
 * Serialize an agent config to pretty JSON, dropping fields irrelevant to the
 * resolved display category. When no category is known, the full config is
 * serialized unchanged.
 */
export function serializeFilteredConfig(
  config: AgentConfig,
  category: string | undefined,
): string {
  if (!category) {
    return JSON.stringify(config, null, 2);
  }
  const excludeSet = hiddenFieldsFor(category);
  const filtered = Object.fromEntries(
    Object.entries(config).filter(([key]) => !excludeSet.has(key)),
  );
  return JSON.stringify(filtered, null, 2);
}
