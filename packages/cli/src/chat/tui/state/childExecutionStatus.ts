// `stopped` is a user-initiated stop, not an error — the canonical run outcome
// keeps `cancelled` a sibling of `failed`, never folded into it (see
// RUN_OUTCOME in src/shared/schemas/stream.ts). Classifying it as an error made
// a stopped subagent show a red dot in the CLI while the progress view / webview
// show it neutral.
const ERROR_STATUSES = new Set(['error', 'failed']);

export function isChildExecutionErrorStatus(
  status: string | undefined,
): boolean {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return false;
  if (ERROR_STATUSES.has(normalized)) return true;
  return /exit(?:ed)?(?:\s+with)?(?:\s+code)?\s+[1-9]\d*/.test(normalized);
}
