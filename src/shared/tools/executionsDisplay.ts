import { isObject } from '@utils/core';

const EXECUTIONS_DEFAULT_ACTION = 'view';

/** The executions action a call is performing, defaulted when absent or blank. */
export function executionsAction(input: Record<string, unknown>): string {
  const action = typeof input.action === 'string' ? input.action.trim() : '';
  return action || EXECUTIONS_DEFAULT_ACTION;
}

export type ExecutionLabels = ReadonlyMap<string, string>;

interface ExecutionPathTarget {
  id: string;
  resourceSuffix: string;
}

function executionTargetFromPath(
  path: unknown,
): ExecutionPathTarget | undefined {
  if (typeof path !== 'string') return undefined;
  const segments = path.split('/').filter(Boolean);
  if (segments[0] !== 'executions' || segments.length < 2) return undefined;
  if (segments[1] === 'current') return undefined;
  return {
    id: segments[1],
    resourceSuffix:
      segments.length > 2 ? `/${segments.slice(2).join('/')}` : '',
  };
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
  const pathTarget = executionTargetFromPath(input.path);
  const targets: ExecutionPathTarget[] = listedIds.map((id) => ({
    id,
    resourceSuffix: '',
  }));
  if (targets.length === 0 && pathTarget) targets.push(pathTarget);
  if (targets.length === 0) return undefined;

  let matchedSubagent = false;
  const displayTargets = targets.map(({ id, resourceSuffix }) => {
    const label = labels.get(id)?.trim();
    if (!label) return `${id}${resourceSuffix}`;
    matchedSubagent = true;
    return `${label}${resourceSuffix}`;
  });
  if (!matchedSubagent) return undefined;

  return `${executionsAction(input)}: ${displayTargets.join(', ')}`;
}
