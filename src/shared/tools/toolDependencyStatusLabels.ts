import type { ToolDependencyStatus } from '@shared/schemas';

import { safeLookup } from '@utils/core';

const TOOL_DEPENDENCY_STATUS_FALLBACK_LABELS = {
  available: 'Ready',
  'not-found': 'Needs setup',
  unknown: 'Not checked',
  'coming-soon': 'Coming soon',
} satisfies Record<ToolDependencyStatus, string>;

export function toolDependencyStatusLabel(
  status: string,
  statusLabel: string | undefined,
): string {
  if (statusLabel != null) return statusLabel;
  return safeLookup(TOOL_DEPENDENCY_STATUS_FALLBACK_LABELS, status, status);
}
