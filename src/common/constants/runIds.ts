/**
 * Run identifier utilities shared across agent runtime and UI layers.
 *
 * Moved from progressView to common to break the layer violation where
 * agent runtime was importing from the presentation layer.
 */

/**
 * Sentinel run identifier retained for legacy sessions that predate
 * per-run scoping. Persisted state may still reference this ID when no
 * explicit task group identifier was available at the time.
 */
export const DEFAULT_RUN_ID = '__default__';

/**
 * Normalize a run ID, falling back to the default sentinel value.
 * @param runId - The run ID to normalize, may be null or undefined
 * @returns Normalized run ID, never null or undefined
 */
export function normalizeRunId(runId: string | null | undefined): string {
  return runId ?? DEFAULT_RUN_ID;
}
