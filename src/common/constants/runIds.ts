/**
 * Run identifier utilities shared across agent runtime and UI layers.
 *
 * ## When to use normalizeRunId()
 * - For workflow agents: Always normalize, as they may have null runId in legacy data
 * - For legacy data migration: Normalize to DEFAULT_RUN_ID for backward compatibility
 *
 * ## When NOT to use normalizeRunId()
 * - For tool-use agents: Use executionId directly as the runId (it's always a UUID)
 * - For ExecutionId values: Never normalize - they are always UUIDs by design
 *
 * @see IdentifierTypes.ts for the full execution model documentation
 */

/**
 * Sentinel run identifier retained for legacy sessions that predate
 * per-run scoping. Persisted state may still reference this ID when no
 * explicit task group identifier was available at the time.
 */
export const DEFAULT_RUN_ID = '__default__';

/**
 * Normalize a run ID for workflow agents, falling back to the default sentinel value.
 *
 * Use this for workflow agents and legacy data where runId may be null/undefined.
 * Do NOT use this for tool-use agents or ExecutionId values.
 *
 * @param runId - The run ID to normalize, may be null or undefined
 * @returns Normalized run ID, never null or undefined
 */
export function normalizeRunId(runId: string | null | undefined): string {
  return runId ?? DEFAULT_RUN_ID;
}

/**
 * Check if a value is a valid UUID-format identifier (ExecutionId or task group RunId).
 *
 * Useful for distinguishing between UUID-based IDs and the DEFAULT_RUN_ID sentinel.
 */
export function isUuidRunId(runId: string | null | undefined): boolean {
  if (!runId || runId === DEFAULT_RUN_ID) {
    return false;
  }
  // UUID pattern: 8-4-4-4-12 hex digits (any version)
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidPattern.test(runId);
}
