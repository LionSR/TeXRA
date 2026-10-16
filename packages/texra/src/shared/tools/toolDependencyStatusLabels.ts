import type { ToolDependencyStatus } from '@texra/shared/tools/toolPlugin';

const TOOL_DEPENDENCY_STATUS_FALLBACK_LABELS = {
  available: 'Ready',
  'not-found': 'Needs setup',
  unknown: 'Not checked',
} satisfies Record<ToolDependencyStatus, string>;

export function toolDependencyStatusLabel(
  status: string,
  statusLabel: string | undefined,
): string {
  if (statusLabel != null) return statusLabel;
  const labels: Readonly<Record<string, string>> =
    TOOL_DEPENDENCY_STATUS_FALLBACK_LABELS;
  return Object.hasOwn(labels, status) ? labels[status] : status;
}
