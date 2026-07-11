// Shared "... N previous / more rows" markers for scrollable modal bodies
// (bash approvals, agent proposals, external inquiries), plus the shared
// "+N earlier, +N more" inline overflow markers for row pickers (Select,
// ChildControlPicker) where the indicator sits inline with the focused row
// instead of on its own line.

export function previousRowsText(count: number): string {
  return `... ${count} previous rows`;
}

export function moreRowsText(count: number): string {
  return `... ${count} more rows`;
}

/** `noun` lets callers qualify what is hidden (e.g. `prompt rows`). */
export function hiddenRowsText(count: number, noun = 'rows'): string {
  return `... ${count} ${noun} hidden`;
}

/** One-line scroll position: both sides when the window is in the middle,
 *  otherwise whichever side overflows. */
export function scrollStatusText(
  hiddenBefore: number,
  hiddenAfter: number,
): string {
  if (hiddenBefore > 0 && hiddenAfter > 0) {
    return `... ${hiddenBefore} previous, ${hiddenAfter} more rows`;
  }
  if (hiddenBefore > 0) return previousRowsText(hiddenBefore);
  return moreRowsText(hiddenAfter);
}

/** Core "+N earlier, +N more" arithmetic shared by inline overflow
 *  indicators. Returns undefined when nothing is hidden on either side. */
function inlineOverflowCountText(
  hiddenBefore: number,
  hiddenAfter: number,
): string | undefined {
  if (hiddenBefore <= 0 && hiddenAfter <= 0) return undefined;
  if (hiddenBefore > 0 && hiddenAfter > 0) {
    return `+${hiddenBefore} earlier, +${hiddenAfter} more`;
  }
  if (hiddenBefore > 0) return `+${hiddenBefore} earlier`;
  return `+${hiddenAfter} more`;
}

/** Select's inline overflow suffix on the focused row. Suppressed when the
 *  list already shows dedicated `... N earlier` / `... N more` marker rows
 *  (`showOverflow`), since that would double up the count. */
export function selectInlineOverflowText({
  hiddenAfter,
  hiddenBefore,
  showOverflow,
}: {
  readonly hiddenAfter: number;
  readonly hiddenBefore: number;
  readonly showOverflow: boolean | undefined;
}): string | undefined {
  if (showOverflow) return undefined;
  return inlineOverflowCountText(hiddenBefore, hiddenAfter);
}

/** As {@link selectInlineOverflowText}, but suppressed entirely when there
 *  are no visible items to attach the suffix to. */
export function selectVisibleInlineOverflowText({
  hiddenAfter,
  hiddenBefore,
  showOverflow,
  visibleItemCount,
}: {
  readonly hiddenAfter: number;
  readonly hiddenBefore: number;
  readonly showOverflow: boolean | undefined;
  readonly visibleItemCount: number;
}): string | undefined {
  if (visibleItemCount <= 0) return undefined;
  return selectInlineOverflowText({ hiddenAfter, hiddenBefore, showOverflow });
}

/** ChildControlPicker's ultra-compact title suffix: the same "+N earlier,
 *  +N more" shape as Select, but derived from a flat index into the full
 *  list rather than an already-windowed hidden-before/after pair. */
export function compactPickerOverflowText({
  itemCount,
  selectedIndex,
}: {
  readonly itemCount: number;
  readonly selectedIndex: number;
}): string | undefined {
  const hiddenBefore = Math.max(0, selectedIndex);
  const hiddenAfter = Math.max(0, itemCount - selectedIndex - 1);
  return inlineOverflowCountText(hiddenBefore, hiddenAfter);
}
