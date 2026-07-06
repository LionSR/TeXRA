// Local imports - shared schemas
import type { ActiveChildInfo } from '@shared/schemas';

export function childExecutionKey(child: ActiveChildInfo): string {
  return child.kind === 'subagent' ? child.childStreamId : child.executionId;
}

export function childExecutionLabel(child: ActiveChildInfo): string {
  // The agent name is always set by the runtime (for both kinds), so it's the
  // label; toolName/executionId are just defensive fallbacks for a malformed
  // entry. `kind` isn't needed here — it's `childExecutionKey` that actually
  // discriminates (only subagents have a stream tab to key by).
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
