/**
 * Scroll an element to its bottom.
 * Handles both VS Code webview elements (scrollPos/scrollMax) and standard DOM elements.
 */
export function scrollToBottom(element: HTMLElement | null): void {
  if (!element) {
    return;
  }

  // Handle VS Code webview scroll elements
  const vsElement = element as HTMLElement & {
    scrollPos?: number;
    scrollMax?: number;
  };
  if (
    typeof vsElement.scrollPos === 'number' &&
    typeof vsElement.scrollMax === 'number'
  ) {
    vsElement.scrollPos = vsElement.scrollMax;
    return;
  }

  // Handle standard DOM elements
  if ('scrollTop' in element && 'scrollHeight' in element) {
    element.scrollTop = element.scrollHeight;
  }
}
