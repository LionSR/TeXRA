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

import {
  childStreamEntries as childStreamEntriesSignal,
  focusOrderDescendants,
  type ChildStreamEntries,
} from './childExecutions';
import {
  activeStreamId,
  parentStream,
  streams as streamsSignal,
  type StreamSlice,
} from './cliState';

/**
 * Ordered descendant stream ids for a parent's focus cycle: retained
 * children first (in retained order), then current-topology children not
 * already present. See `childExecutions.ts#focusOrderDescendants` for the
 * full ordering contract — this stays a thin wrapper so callers keep a
 * stable `{ parent, childStreamEntries, streams }` shape.
 */
export function orderedDescendantsFromTree(init: {
  readonly parent: StreamTabId;
  readonly childStreamEntries: ChildStreamEntries;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): StreamTabId[] {
  return [
    ...focusOrderDescendants(
      init.parent,
      init.childStreamEntries,
      init.streams,
    ),
  ];
}

function orderedDescendants(parent: StreamTabId): StreamTabId[] {
  return orderedDescendantsFromTree({
    parent,
    childStreamEntries: childStreamEntriesSignal.get(),
    streams: streamsSignal.get(),
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
