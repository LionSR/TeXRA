import type { ToolStatus } from '@shared/schemas/settingsViewMessages';

const TOOL_STATUS_FALLBACK_LABELS = {
  available: 'Ready',
  'not-found': 'Needs setup',
  unknown: 'Not checked',
  'coming-soon': 'Coming soon',
} satisfies Record<ToolStatus, string>;

export function toolStatusFallbackLabel(status: string): string {
  if (Object.hasOwn(TOOL_STATUS_FALLBACK_LABELS, status)) {
    return TOOL_STATUS_FALLBACK_LABELS[status as ToolStatus];
  }
  return status;
}

export function toolStatusLabel(
  status: string,
  statusLabel: string | undefined,
): string {
  return statusLabel ?? toolStatusFallbackLabel(status);
}
