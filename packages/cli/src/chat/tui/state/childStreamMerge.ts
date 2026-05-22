// Local imports - shared schemas
import type { ActiveChildInfo } from '@shared/schemas';

function childKey(child: ActiveChildInfo): string {
  return child.childStreamId ?? child.executionId;
}

export function mergeChildStreams(
  current: readonly ActiveChildInfo[],
  next: readonly ActiveChildInfo[],
): readonly ActiveChildInfo[] {
  const byStream = new Map<string, ActiveChildInfo>();
  for (const child of [...current, ...next]) {
    byStream.set(childKey(child), child);
  }
  return [...byStream.values()];
}

/** Active subagents followed by any retained child streams that are no longer
 *  active — so completed/waiting subagent pages stay listed and addressable. */
export function visibleSubagentRows(slice: {
  readonly activeSubagents: readonly ActiveChildInfo[];
  readonly childStreams: readonly ActiveChildInfo[];
}): readonly ActiveChildInfo[] {
  const activeKeys = new Set(slice.activeSubagents.map(childKey));
  return [
    ...slice.activeSubagents,
    ...slice.childStreams.filter((child) => !activeKeys.has(childKey(child))),
  ];
}
