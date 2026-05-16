// Ctrl-A / Ctrl-B focus cycle.
//
// Ctrl-A advances forward through the focused stream's active subagents and
// processes (in the order they're listed in the SubagentList pane). When at
// the end of the list, it wraps back to the parent — keeping the cycle
// closed even when no descendants exist (a noop).
//
// Ctrl-B steps back to the parent if one is registered, otherwise stays put.
//
// We intentionally avoid `Ctrl-Shift-*` chords — many terminals collapse
// shift over a letter to the unshifted Ctrl combo (see 10-architecture.md).

import { type StreamTabId } from '@shared/schemas';

import { cliState } from './cliState';

/** Returns the next stream id the focus cycle should land on, or `undefined`
 *  if the cycle would not move (e.g. no descendants and no parent). The
 *  caller is responsible for assigning the result to
 *  `cliState.activeStreamId`. */
export function nextFocusForward(): StreamTabId | undefined {
  const activeId = cliState.activeStreamId.get();
  if (!activeId) return undefined;
  const slice = cliState.streams.get().get(activeId);
  // Missing slice means we landed on a child stream we haven't received any
  // progress events for yet — treat it as a leaf so the cycle closes via
  // the parent edge instead of stranding the focus.
  const descendants: StreamTabId[] = [];
  for (const child of slice?.activeSubagents ?? []) {
    if (child.childStreamId) descendants.push(child.childStreamId);
  }
  for (const proc of slice?.activeProcesses ?? []) {
    if (proc.childStreamId) descendants.push(proc.childStreamId);
  }
  if (descendants.length === 0) {
    return cliState.parentStream.get().get(activeId);
  }
  // The active stream itself is the "start of the cycle"; advancing from it
  // lands on the first descendant. If the active stream is already a
  // descendant, advance through the list and wrap to the parent at the end.
  const idx = descendants.indexOf(activeId);
  if (idx === -1) return descendants[0];
  if (idx + 1 < descendants.length) return descendants[idx + 1];
  return cliState.parentStream.get().get(activeId) ?? descendants[0];
}

/** Step up to the parent stream, if one is registered. */
export function nextFocusBack(): StreamTabId | undefined {
  const activeId = cliState.activeStreamId.get();
  if (!activeId) return undefined;
  return cliState.parentStream.get().get(activeId);
}

/** Returns the descendant at the given 1-based index for the active stream,
 *  combining subagents + processes in display order. Used by the `1`–`9`
 *  jump shortcuts. */
export function descendantAt(index: number): StreamTabId | undefined {
  if (index < 1) return undefined;
  const activeId = cliState.activeStreamId.get();
  if (!activeId) return undefined;
  const slice = cliState.streams.get().get(activeId);
  if (!slice) return undefined;
  const ordered: StreamTabId[] = [];
  for (const child of slice.activeSubagents) {
    if (child.childStreamId) ordered.push(child.childStreamId);
  }
  for (const proc of slice.activeProcesses) {
    if (proc.childStreamId) ordered.push(proc.childStreamId);
  }
  return ordered[index - 1];
}
