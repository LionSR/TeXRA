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

/**
 * Check if element is a VS Code select-like component.
 */
export function isSelectLikeElement(
  element: Element | null,
): element is HTMLElement & { value?: string } {
  if (!element) {
    return false;
  }
  const tagName = element.tagName.toLowerCase();
  return tagName === 'vscode-single-select' || tagName === 'vscode-dropdown';
}

/**
 * Get vscode-option elements from a select-like component.
 */
export function getSelectOptionElements(
  element: Element | null,
): HTMLElement[] {
  if (!isSelectLikeElement(element)) {
    return [];
  }
  return [...element.querySelectorAll('vscode-option')] as HTMLElement[];
}

/**
 * Get the currently selected option element from a select-like component.
 */
export function getSelectedOptionElement(
  element: Element | null,
): HTMLElement | null {
  if (!isSelectLikeElement(element)) {
    return null;
  }

  const options = getSelectOptionElements(element);
  if (options.length === 0) {
    return null;
  }

  const currentValue = element.value;
  if (currentValue !== null && currentValue !== undefined) {
    const matchingOption = options.find(
      (opt) => opt.getAttribute('value') === currentValue,
    );
    if (matchingOption) {
      return matchingOption;
    }
  }

  return (
    options.find(
      (opt) =>
        opt.hasAttribute('selected') || (opt as HTMLOptionElement).selected,
    ) ?? options[0]
  );
}
