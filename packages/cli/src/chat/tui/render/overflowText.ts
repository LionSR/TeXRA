// Shared "… N previous / more rows" markers for scrollable modal bodies
// (bash approvals, agent proposals, external inquiries), plus the shared
// "+N earlier, +N more" inline overflow markers for Select, where the
// indicator sits inline with the focused row instead of on its own line.

export function previousRowsText(count: number): string {
  return `… ${count} previous rows`;
}

export function moreRowsText(count: number): string {
  return `… ${count} more rows`;
}

/** `noun` lets callers qualify what is hidden (e.g. `prompt rows`). */
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
 *  `… N earlier` / `… N more` marker rows (`showOverflow`), since that
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
