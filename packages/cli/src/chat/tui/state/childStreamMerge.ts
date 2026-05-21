// Local imports - shared schemas
import type { ActiveChildInfo } from '@shared/schemas';

export function mergeChildStreams(
  current: readonly ActiveChildInfo[],
  next: readonly ActiveChildInfo[],
): readonly ActiveChildInfo[] {
  const byStream = new Map<string, ActiveChildInfo>();
  for (const child of [...current, ...next]) {
    const key = child.childStreamId ?? child.executionId;
    byStream.set(key, child);
  }
  return [...byStream.values()];
}

export function visibleSubagentRows(
  activeSubagents: readonly ActiveChildInfo[],
  retainedChildStreams: readonly ActiveChildInfo[],
): readonly ActiveChildInfo[] {
  const activeKeys = new Set(
    activeSubagents.map((child) => child.childStreamId ?? child.executionId),
  );
  return [
    ...activeSubagents,
    ...retainedChildStreams.filter(
      (child) => !activeKeys.has(child.childStreamId ?? child.executionId),
    ),
  ];
}
