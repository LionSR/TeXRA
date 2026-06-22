// Local imports - shared schemas
import type { ActiveChildInfo } from '@shared/schemas';

export function childExecutionKey(
  child: Pick<ActiveChildInfo, 'childStreamId' | 'executionId'>,
): string {
  return child.childStreamId ?? child.executionId;
}

export function childExecutionLabel(
  child: Pick<ActiveChildInfo, 'agentName' | 'toolName' | 'executionId'>,
): string {
  return child.agentName || child.toolName || child.executionId;
}

export function mergeChildStreams(
  current: readonly ActiveChildInfo[],
  next: readonly ActiveChildInfo[],
): readonly ActiveChildInfo[] {
  const byStream = new Map<string, ActiveChildInfo>();
  for (const child of [...current, ...next]) {
    byStream.set(childExecutionKey(child), child);
  }
  return [...byStream.values()];
}

/** Retained child streams own display order; active rows overlay live status. */
export function visibleSubagentRows(slice: {
  readonly activeSubagents: readonly ActiveChildInfo[];
  readonly childStreams: readonly ActiveChildInfo[];
}): readonly ActiveChildInfo[] {
  const activeByKey = new Map(
    slice.activeSubagents.map((child) => [childExecutionKey(child), child]),
  );
  const retainedKeys = new Set(slice.childStreams.map(childExecutionKey));
  return [
    ...slice.childStreams.map(
      (child) => activeByKey.get(childExecutionKey(child)) ?? child,
    ),
    // Defensive fallback for partial slices where live rows arrive first.
    ...slice.activeSubagents.filter(
      (child) => !retainedKeys.has(childExecutionKey(child)),
    ),
  ];
}
