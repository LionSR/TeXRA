/**
 * Sentinel run identifier retained for legacy sessions that predate
 * per-run scoping. Persisted state may still reference this ID when no
 * explicit task group identifier was available at the time.
 */
export const DEFAULT_RUN_ID = '__default__';

export function normalizeRunId(runId: string | null | undefined): string {
  return runId ?? DEFAULT_RUN_ID;
}
