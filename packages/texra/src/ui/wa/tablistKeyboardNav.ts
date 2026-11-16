/**
 * APG tab-strip keyboard contract for the settings view's page and section
 * tabs: ArrowLeft/ArrowRight move to the adjacent tab (wrapping), Home/End
 * jump to the first/last tab. The caller owns the DOM lookup and the focus
 * and activation; this is only the index arithmetic.
 */
export function nextTablistIndex(
  key: string,
  currentIndex: number,
  tabCount: number,
): number | undefined {
  const last = tabCount - 1;
  switch (key) {
    case 'ArrowRight':
      return currentIndex === last ? 0 : currentIndex + 1;
    case 'ArrowLeft':
      return currentIndex === 0 ? last : currentIndex - 1;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return undefined;
  }
}
