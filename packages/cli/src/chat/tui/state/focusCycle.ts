// Ctrl-A / Ctrl-B focus cycle.
//
// Ctrl-A advances forward through the focused stream's *siblings* — the
// active descendants of its parent (or, if the active stream is the parent,
// its own descendants). When at the end of the list it wraps back to the
// parent — keeping the cycle closed for both leaves and roots.
//
// Ctrl-B steps back to the parent if one is registered, otherwise stays put.
//
// We intentionally avoid `Ctrl-Shift-*` chords — many terminals collapse
// shift over a letter to the unshifted Ctrl combo (see 10-architecture.md).

import { type StreamTabId } from '@shared/schemas';
import { unique } from '@utils/core';

import { visibleSubagentRows } from './childExecutions';
import { activeStreamId } from './cliState/focusSlice';
import { parentStream } from './cliState/parentStreamSlice';
import { streams as streamsSignal } from './cliState/streamsSlice';
import type { StreamSlice } from './cliState/types';

function orderedDescendantsFromSlice(
  slice:
    | Pick<StreamSlice, 'activeSubagents' | 'activeProcesses' | 'childStreams'>
    | undefined,
): StreamTabId[] {
  if (!slice) return [];
  const out: StreamTabId[] = [];
  for (const child of [
    ...visibleSubagentRows(slice),
    ...slice.activeProcesses,
  ]) {
    if (child.childStreamId) out.push(child.childStreamId);
  }
  return unique(out);
}

export function orderedDescendantsFromTree(init: {
  readonly parent: StreamTabId;
  readonly parentSlice: StreamSlice | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): StreamTabId[] {
  const out = orderedDescendantsFromSlice(init.parentSlice).filter((id) =>
    init.streams.has(id),
  );
  const seen = new Set(out);
  // `parentStream` is populated by its own `setParentStream` event, decoupled
  // from the `activeSubagents`/`childStreams` updates the slice-derived list
  // above reads. This walk is not redundant with it: it catches an edge
  // registered before its parent's slice reflects the child (event-ordering),
  // so a child stream is never unreachable from the focus cycle.
  for (const [child, recordedParent] of init.parentStream) {
    if (
      recordedParent !== init.parent ||
      !init.streams.has(child) ||
      seen.has(child)
    ) {
      continue;
    }
    seen.add(child);
    out.push(child);
  }
  return out;
}

function orderedDescendants(parent: StreamTabId): StreamTabId[] {
  const streams = streamsSignal.get();
  return orderedDescendantsFromTree({
    parent,
    parentSlice: streams.get(parent),
    parentStream: parentStream.get(),
    streams,
  });
}

/** Returns the next stream id the focus cycle should land on, or `undefined`
 *  if the cycle would not move (no parent edges, no descendants). The caller
 *  assigns the result to `activeStreamId`. */
export function nextFocusForward(): StreamTabId | undefined {
  const activeId = activeStreamId.get();
  if (!activeId) return undefined;

  // If we're sitting on a child stream, walk forward through the *parent's*
  // ordered descendant list — so root → child1 → child2 → root closes the
  // cycle even when child1/child2 are leaves themselves.
  const parent = parentStream.get().get(activeId);
  if (parent) {
    const siblings = orderedDescendants(parent);
    const idx = siblings.indexOf(activeId);
    if (idx !== -1 && idx + 1 < siblings.length) return siblings[idx + 1];
    return parent;
  }

  // We're at the root — drop into the first descendant.
  const descendants = orderedDescendants(activeId);
  return descendants[0];
}

/** Step up to the parent stream, if one is registered. */
export function nextFocusBack(): StreamTabId | undefined {
  const activeId = activeStreamId.get();
  if (!activeId) return undefined;
  return parentStream.get().get(activeId);
}
