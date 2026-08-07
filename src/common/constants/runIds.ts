/**
 * Run identifier utilities shared across agent runtime and UI layers.
 *
 * ## When to use normalizeRunId()
 * - For workflow agents: Always normalize, as they may have null runId in legacy data
 * - For legacy data migration: Normalize to DEFAULT_RUN_ID for backward compatibility
 *
 * ## When NOT to use normalizeRunId()
 * - For tool-use agents: Use executionId directly as the runId
 * - For ExecutionId values: Never normalize - they are always valid by design
 */
import type { StorageKey } from '@shared/schemas';

/**
 * Sentinel run identifier retained for legacy sessions that predate
 * per-run scoping. Persisted state may still reference this ID when no
 * explicit task group identifier was available at the time.
 */
const DEFAULT_RUN_ID: StorageKey = '__default__' as StorageKey;

/**
 * Normalize a run ID for workflow agents, falling back to the default sentinel value.
 *
 * Use this for workflow agents and legacy data where runId may be null/undefined.
 * Do NOT use this for tool-use agents or ExecutionId values.
 *
 * @param runId - The run ID to normalize, may be null or undefined
 * @returns StorageKey - the branded type for storage operations
 */
export function normalizeRunId(runId: string | null | undefined): StorageKey {
  return (runId ?? DEFAULT_RUN_ID) as StorageKey;
}
