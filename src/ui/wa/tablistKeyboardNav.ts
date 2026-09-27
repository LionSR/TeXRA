/**
 * APG tab-strip keyboard contract, shared by the settings view's page/section
 * tabs and the desktop shell's workbench tabs: ArrowLeft/ArrowRight move to
 * the adjacent tab (wrapping), Home/End jump to the first/last tab. Each host
 * still owns its own DOM lookup and focus/activation mechanics — only the
 * index arithmetic is common.
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
