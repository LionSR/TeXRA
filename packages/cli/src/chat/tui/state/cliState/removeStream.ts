// Cross-slice cleanup when a stream goes away: drops it from the streams map,
// scrubs any child-reference lists that pointed at it, clears focus if it was
// active, and drops parent-map edges that touched it.

import type { StreamTabId } from '@shared/schemas';

import { activeStreamId } from './focusSlice';
import { parentStream } from './parentStreamSlice';
import { scrubChildStreamReferences, streams } from './streamsSlice';

export function removeStream(streamId: StreamTabId): void {
  const current = streams.get();
  const out = new Map(current);
  let changed = out.delete(streamId);
  for (const [id, slice] of out) {
    const next = scrubChildStreamReferences(slice, streamId);
    if (next === slice) continue;
    out.set(id, next);
    changed = true;
  }
  if (changed) streams.set(out);
  if (activeStreamId.get() === streamId) {
    activeStreamId.set(undefined);
  }
  // Drop any parent-map edges that touched this stream so the focus cycle
  // never lands on a stale id.
  const parents = parentStream.get();
  let nextParents: Map<StreamTabId, StreamTabId> | undefined;
  for (const [child, parent] of parents) {
    if (child !== streamId && parent !== streamId) continue;
    if (!nextParents) nextParents = new Map(parents);
    nextParents.delete(child);
  }
  if (nextParents) parentStream.set(nextParents);
}
