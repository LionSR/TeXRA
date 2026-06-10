// Shared "... N previous / more rows" markers for scrollable modal bodies
// (bash approvals, agent proposals, external inquiries).

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
