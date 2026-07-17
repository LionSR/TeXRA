import { isObject } from '@utils/core';

export const EXECUTIONS_DEFAULT_ACTION = 'view';

export type ExecutionLabels = ReadonlyMap<string, string>;

function executionIdFromPath(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined;
  const segments = path.split('/').filter(Boolean);
  if (segments[0] !== 'executions' || segments.length < 2) return undefined;
  return segments[1] === 'current' ? undefined : segments[1];
}

/**
 * Build the identity-aware summary for an executions tool call.
 *
 * Returning `undefined` when none of the targets are known subagents is
 * deliberate: each host then keeps its existing background-process title.
 * Mixed waits substitute the known subagents while retaining opaque IDs for
 * process targets, so the summary still describes the complete wait set.
 */
export function executionsSubagentSummary(
  input: unknown,
  labels: ExecutionLabels,
): string | undefined {
  if (!isObject(input)) return undefined;

  const listedIds = Array.isArray(input.ids)
    ? input.ids.filter((id): id is string => typeof id === 'string' && !!id)
    : [];
  const pathId = executionIdFromPath(input.path);
  let targetIds = listedIds;
  if (targetIds.length === 0) {
    targetIds = pathId ? [pathId] : [];
  }
  if (targetIds.length === 0) return undefined;

  let matchedSubagent = false;
  const targets = targetIds.map((id) => {
    const label = labels.get(id)?.trim();
    if (!label) return id;
    matchedSubagent = true;
    return label;
  });
  if (!matchedSubagent) return undefined;

  const action =
    typeof input.action === 'string' && input.action.trim()
      ? input.action.trim()
      : EXECUTIONS_DEFAULT_ACTION;
  return `${action}: ${targets.join(', ')}`;
}
