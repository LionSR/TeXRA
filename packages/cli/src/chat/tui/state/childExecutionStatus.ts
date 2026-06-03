const ERROR_STATUSES = new Set(['error', 'failed', 'stopped']);
const IN_FLIGHT_STATUSES = new Set([
  'initializing',
  'resuming',
  'running',
  'waiting',
]);

export function isChildExecutionErrorStatus(
  status: string | undefined,
): boolean {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return false;
  if (ERROR_STATUSES.has(normalized)) return true;
  return /exit(?:ed)?(?:\s+with)?(?:\s+code)?\s+[1-9]\d*/.test(normalized);
}

export function completedChildExecutionStatus(
  status: string | undefined,
): string {
  const normalized = status?.trim().toLowerCase();
  if (!normalized || IN_FLIGHT_STATUSES.has(normalized)) return 'completed';
  return status ?? 'completed';
}
