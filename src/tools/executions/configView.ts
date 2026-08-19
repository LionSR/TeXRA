/**
 * Serialization of a run's stored config for `/executions/{id}/config`.
 */

// Local imports
import type { RunRecord } from '@agent/core/definition/RunRecord';

/**
 * Per-category config-field exclusions: `toolUse` hides the workflow-only
 * file fields, `workflow` hides the toolUse-only `toolConfig`. Unknown
 * categories get no filtering.
 */
const HIDDEN_CONFIG_FIELDS_BY_CATEGORY: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  toolUse: new Set([
    'inputFile',
    'inputFiles',
    'contextFile',
    'contextFiles',
    'mediaFile',
    'mediaFiles',
    'outputFiles',
    'editedFile',
    'editedFiles',
  ]),
  workflow: new Set(['toolConfig']),
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
