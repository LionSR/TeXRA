/**
 * Scroll an element to its bottom.
 * Handles both VS Code webview elements (scrollPos/scrollMax) and standard DOM elements.
 */
export function scrollToBottom(element: HTMLElement | null): void {
  if (!element) {
    return;
  }

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

  element.scrollTop = element.scrollHeight;
}

/**
 * Workaround for vscode-context-menu component quirk where it auto-creates
 * an empty data array that prevents rendering of slotted children.
 * Call this in updated() lifecycle after the element is created.
 */
export function ensureContextMenuUsesSlot(
  menu: Element | null | undefined,
): void {
  const contextMenu = menu as HTMLElement & {
    data?: unknown[];
    _data?: unknown[];
    requestUpdate?: () => void;
  };
  if (
    contextMenu?.tagName?.toLowerCase() === 'vscode-context-menu' &&
    Array.isArray(contextMenu.data) &&
    contextMenu.data.length === 0
  ) {
    try {
      contextMenu.data = undefined;
      contextMenu.requestUpdate?.();
    } catch {
      contextMenu._data = undefined;
      contextMenu.requestUpdate?.();
    }
  }
}
