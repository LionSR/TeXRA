/**
 * DOM utilities for webview frontends.
 * Focused on VS Code web component helpers.
 */

// Icon constants for chevrons
const CHEVRON_DOWN_CLASS = 'codicon codicon-chevron-down';
const CHEVRON_RIGHT_CLASS = 'codicon codicon-chevron-right';

/**
 * Set a chevron icon for horizontal expansion (right/down).
 */
export function setChevronIconHorizontal(
  element: HTMLElement | null,
  expanded: boolean,
): void {
  if (!element) return;

  let icon: HTMLElement = element;
  if (element.tagName.toLowerCase() !== 'i') {
    const existingIcon = element.querySelector('i');
    if (existingIcon) {
      icon = existingIcon as HTMLElement;
    } else {
      icon = document.createElement('i');
      element.appendChild(icon);
    }
  }

  const existingClasses = icon.className
    .split(' ')
    .filter(
      (cls) => cls && !cls.startsWith('codicon-chevron-') && cls !== 'codicon',
    )
    .join(' ');
  const chevronClass = expanded ? CHEVRON_DOWN_CLASS : CHEVRON_RIGHT_CLASS;
  icon.className = existingClasses
    ? `${chevronClass} ${existingClasses}`
    : chevronClass;
}

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
 * Determine if element is a VS Code select-like component.
 */
export function isSelectLikeElement(
  element: Element | null,
): element is HTMLElement & { value?: string } {
  if (!element) return false;
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
  // eslint-disable-next-line unicorn/prefer-spread -- vscode-option typing lacks iterator support
  return Array.from(element.querySelectorAll('vscode-option')) as HTMLElement[];
}

/**
 * Get the currently selected option element for a select-like component.
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

  const currentValue = (element as HTMLElement & { value?: string }).value;
  if (currentValue !== null && currentValue !== undefined) {
    const matchingOption = options.find(
      (option) => option.getAttribute('value') === currentValue,
    );
    if (matchingOption) {
      return matchingOption;
    }
  }

  return (
    options.find(
      (option) =>
        option.hasAttribute('selected') ||
        (option as HTMLOptionElement).selected,
    ) ?? options[0]
  );
}
