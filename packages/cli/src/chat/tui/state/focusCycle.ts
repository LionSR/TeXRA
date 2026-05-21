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

import { visibleSubagentRows } from './childStreamMerge';
import { cliState, type StreamSlice } from './cliState';

export function orderedDescendantsFromSlice(
  slice:
    | Pick<StreamSlice, 'activeSubagents' | 'activeProcesses' | 'childStreams'>
    | undefined,
): StreamTabId[] {
  if (!slice) return [];
  const out: StreamTabId[] = [];
  for (const child of [
    ...visibleSubagentRows(slice.activeSubagents, slice.childStreams),
    ...slice.activeProcesses,
  ]) {
    if (child.childStreamId) out.push(child.childStreamId);
  }
  return [...new Set(out)];
}

export function orderedDescendants(parent: StreamTabId): StreamTabId[] {
  const streams = cliState.streams.get();
  const out = orderedDescendantsFromSlice(streams.get(parent));
  for (const [child, recordedParent] of cliState.parentStream.get()) {
    if (recordedParent !== parent || !streams.has(child) || out.includes(child))
      continue;
    out.push(child);
  }
  return out;
}

/** Returns the next stream id the focus cycle should land on, or `undefined`
 *  if the cycle would not move (no parent edges, no descendants). The caller
 *  assigns the result to `cliState.activeStreamId`. */
export function nextFocusForward(): StreamTabId | undefined {
  const activeId = cliState.activeStreamId.get();
  if (!activeId) return undefined;

  // If we're sitting on a child stream, walk forward through the *parent's*
  // ordered descendant list — so root → child1 → child2 → root closes the
  // cycle even when child1/child2 are leaves themselves.
  const parent = cliState.parentStream.get().get(activeId);
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
  const activeId = cliState.activeStreamId.get();
  if (!activeId) return undefined;
  return cliState.parentStream.get().get(activeId);
}
