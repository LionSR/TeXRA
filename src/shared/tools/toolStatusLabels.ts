import type { ToolStatus } from '@shared/schemas/settingsViewMessages';

const TOOL_STATUS_FALLBACK_LABELS = {
  available: 'Ready',
  'not-found': 'Needs setup',
  unknown: 'Not checked',
  'coming-soon': 'Coming soon',
} satisfies Record<ToolStatus, string>;

export function toolStatusLabel(
  status: string,
  statusLabel: string | undefined,
): string {
  if (statusLabel != null) return statusLabel;
  return Object.hasOwn(TOOL_STATUS_FALLBACK_LABELS, status)
    ? TOOL_STATUS_FALLBACK_LABELS[status as ToolStatus]
    : status;
}
