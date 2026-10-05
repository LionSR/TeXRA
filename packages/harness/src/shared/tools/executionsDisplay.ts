import { isObject } from '@utils/core';

const EXECUTIONS_DEFAULT_ACTION = 'view';

/** The executions action a call is performing, defaulted when absent or blank. */
export function executionsAction(input: Record<string, unknown>): string {
  const action = typeof input.action === 'string' ? input.action.trim() : '';
  return action || EXECUTIONS_DEFAULT_ACTION;
}

/** The runs an `executions` call may name, by id: the session's `view.runs`.
 *  A run whose label is its id adds nothing, so it counts as unlabeled. */
export type RunLabels = ReadonlyMap<string, { readonly label: string }>;

function labelOf(labels: RunLabels, id: string): string | undefined {
  const label = labels.get(id)?.label.trim();
  return label && label !== id ? label : undefined;
}

interface RunPathTarget {
  id: string;
  resourceSuffix: string;
}

function runTargetFromPath(path: unknown): RunPathTarget | undefined {
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
  labels: RunLabels,
): string | undefined {
  if (!isObject(input)) return undefined;

  const listedIds = Array.isArray(input.ids)
    ? input.ids.filter((id): id is string => typeof id === 'string' && !!id)
    : [];
  const pathTarget = runTargetFromPath(input.path);
  const targets: RunPathTarget[] = listedIds.map((id) => ({
    id,
    resourceSuffix: '',
  }));
  if (targets.length === 0 && pathTarget) targets.push(pathTarget);
  if (targets.length === 0) return undefined;

  const hasKnownTarget = targets.some(({ id }) => labelOf(labels, id));
  if (!hasKnownTarget) return undefined;

  const displayTargets = targets.map(
    ({ id, resourceSuffix }) => `${labelOf(labels, id) ?? id}${resourceSuffix}`,
  );

  return `${executionsAction(input)}: ${displayTargets.join(', ')}`;
}
