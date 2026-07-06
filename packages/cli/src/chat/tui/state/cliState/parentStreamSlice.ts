// child -> parent map populated from child stream ownership events. The focus
// cycle (Ctrl-A / Ctrl-B) walks this when stepping back to the parent, and
// transcript rendering uses it to keep child streams scoped to their own
// history.

import { signal } from '@lit-labs/signals';

import type { ActiveChildInfo, StreamTabId } from '@shared/schemas';

const PARENT_STREAM = signal<ReadonlyMap<StreamTabId, StreamTabId>>(new Map());

/** child -> parent stream-id map. */
export const parentStream = PARENT_STREAM;

interface ParentStreamEdgeUpdate {
  readonly childStreamId?: StreamTabId;
  readonly parentStreamId: StreamTabId | null | undefined;
}

function parentStreamMapUpdate(
  current: ReadonlyMap<StreamTabId, StreamTabId>,
  updates: readonly ParentStreamEdgeUpdate[],
): Map<StreamTabId, StreamTabId> | undefined {
  let out: Map<StreamTabId, StreamTabId> | undefined;
  for (const { childStreamId, parentStreamId } of updates) {
    if (!childStreamId) continue;
    const readable = out ?? current;
    if (parentStreamId == null) {
      if (!readable.has(childStreamId)) continue;
      out ??= new Map(current);
      out.delete(childStreamId);
      continue;
    }
    if (readable.get(childStreamId) === parentStreamId) continue;
    out ??= new Map(current);
    out.set(childStreamId, parentStreamId);
  }
  return out;
}

function commitParentStreamEdges(
  updates: readonly ParentStreamEdgeUpdate[],
): void {
  const next = parentStreamMapUpdate(PARENT_STREAM.get(), updates);
  if (next) PARENT_STREAM.set(next);
}

export function setParentStream(
  childStreamId: StreamTabId,
  parentStreamId: StreamTabId | null | undefined,
): void {
  // A null parent means the runtime promoted this child to a top-level stream.
  commitParentStreamEdges([{ childStreamId, parentStreamId }]);
}

export function registerChildStreams(
  parentStreamId: StreamTabId,
  children: readonly ActiveChildInfo[],
): void {
  commitParentStreamEdges(
    children.map((child) => ({
      childStreamId:
        child.kind === 'subagent' ? child.childStreamId : undefined,
      parentStreamId,
    })),
  );
}
