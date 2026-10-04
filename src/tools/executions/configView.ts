/**
 * Serialization of a run's stored config for `/executions/{id}/config`.
 */

// Local imports
import type { RunRecord } from '@agent/core/definition/RunRecord';

/**
 * Per-category config-field exclusions: a conversation (`agent`) hides the
 * document task's file fields, a `task` hides its recipe's source. Unknown
 * categories get no filtering.
 */
const HIDDEN_CONFIG_FIELDS_BY_CATEGORY: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  agent: new Set([
    'inputFiles',
    'contextFiles',
    'outputFiles',
    'editedFile',
    'editedFiles',
  ]),
  task: new Set(['script']),
};

/**
 * Serialize a run record to pretty JSON, dropping agent-config fields
 * irrelevant to the resolved display category so the serialized config the
 * orchestrator reads stays relevant. Records without an agent execution mode
 * are honest by construction and serialize unchanged.
 */
export function serializeFilteredConfig(
  record: RunRecord,
  category: string | undefined,
): string {
  const excludeSet = category
    ? HIDDEN_CONFIG_FIELDS_BY_CATEGORY[category]
    : undefined;
  if (!excludeSet) {
    return JSON.stringify(record, null, 2);
  }
  const filtered = Object.fromEntries(
    Object.entries(record).filter(([key]) => !excludeSet.has(key)),
  );
  return JSON.stringify(filtered, null, 2);
}
