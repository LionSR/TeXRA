/**
 * VS Code webview scroll elements expose `scrollPos`/`scrollMax` instead of
 * the standard `scrollTop`/`scrollHeight`/`clientHeight` triplet. Returns the
 * pair when present so callers can read or write the extent uniformly.
 */
export function vsCodeScrollExtent(
  element: HTMLElement,
): { pos: number; max: number } | undefined {
  const vsElement = element as HTMLElement & {
    scrollPos?: number;
    scrollMax?: number;
  };
  if (
    typeof vsElement.scrollPos === 'number' &&
    typeof vsElement.scrollMax === 'number'
  ) {
    return { pos: vsElement.scrollPos, max: vsElement.scrollMax };
  }
  return undefined;
}

/**
 * Scroll an element to its bottom.
 * Handles both VS Code webview elements (scrollPos/scrollMax) and standard DOM elements.
 */
export function scrollToBottom(element: HTMLElement | null): void {
  if (!element) {
    return;
  }

  const vs = vsCodeScrollExtent(element);
  if (vs) {
    (element as HTMLElement & { scrollPos: number }).scrollPos = vs.max;
    return;
  }

  element.scrollTop = element.scrollHeight;
}
