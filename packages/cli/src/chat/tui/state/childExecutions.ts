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

/** Active subagents followed by any retained child streams that are no longer
 *  active — so completed/waiting subagent pages stay listed and addressable. */
export function visibleSubagentRows(slice: {
  readonly activeSubagents: readonly ActiveChildInfo[];
  readonly childStreams: readonly ActiveChildInfo[];
}): readonly ActiveChildInfo[] {
  const activeKeys = new Set(slice.activeSubagents.map(childExecutionKey));
  return [
    ...slice.activeSubagents,
    ...slice.childStreams.filter(
      (child) => !activeKeys.has(childExecutionKey(child)),
    ),
  ];
}
