export const DEFAULT_RUN_ID = '__default__';

export function normalizeRunId(runId: string | null | undefined): string {
  return runId ?? DEFAULT_RUN_ID;
}
