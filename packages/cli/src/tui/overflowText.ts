// The one "… N previous / more / hidden rows" vocabulary for every TUI
// overflow marker (scrollable bodies, lists, elided output; "lines" where
// the unit is source lines), plus the compact "+N earlier, +N more" suffix
// Select puts inline on the focused row instead of on its own line.

export function previousRowsText(count: number): string {
  return `… ${count} previous rows`;
}

export function moreRowsText(count: number): string {
  return `… ${count} more rows`;
}

/** `noun` lets callers qualify what is hidden (e.g. `diff lines`). */
export function hiddenRowsText(count: number, noun = 'rows'): string {
  return `… ${count} ${noun} hidden`;
}

/** One-line scroll position: both sides when the window is in the middle,
 *  otherwise whichever side overflows. */
export function scrollStatusText(
  hiddenBefore: number,
  hiddenAfter: number,
): string {
  if (hiddenBefore > 0 && hiddenAfter > 0) {
    return `… ${hiddenBefore} previous, ${hiddenAfter} more rows`;
  }
  if (hiddenBefore > 0) return previousRowsText(hiddenBefore);
  return moreRowsText(hiddenAfter);
}

/** Select's inline "+N earlier, +N more" suffix on the focused row.
 *  Suppressed when there are no visible items to attach the suffix to, when
 *  nothing is hidden on either side, or when the list already shows dedicated
 *  `… N previous rows` / `… N more rows` marker rows (`showOverflow`), since that
 *  would double up the count. */
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
  if (visibleItemCount <= 0 || showOverflow) return undefined;
  if (hiddenBefore > 0 && hiddenAfter > 0) {
    return `+${hiddenBefore} earlier, +${hiddenAfter} more`;
  }
  if (hiddenBefore > 0) return `+${hiddenBefore} earlier`;
  if (hiddenAfter > 0) return `+${hiddenAfter} more`;
  return undefined;
}
