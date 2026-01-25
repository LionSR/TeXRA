/**
 * DOM utilities for webview frontends.
 * Focused on VS Code web component helpers.
 */

/**
 * Set checked state on an element (checkbox, radio, toggle button).
 * VS Code web components require both property and attribute for visual sync.
 */
export function setElementCheckedState(
  element: HTMLElement | null,
  checked: boolean,
): void {
  if (!element) return;
  (element as HTMLInputElement).checked = checked;
  element.toggleAttribute('checked', checked);
  element.setAttribute('aria-checked', String(checked));
}

/**
 * Set the active radio in a group of vscode-radio elements.
 */
export function setRadioGroupValue(
  radioGroup: HTMLElement | null,
  value: string,
  selector = 'vscode-radio',
): void {
  if (!radioGroup) return;
  if ('value' in radioGroup) {
    (radioGroup as unknown as { value: string }).value = value;
  }
  const radios = radioGroup.querySelectorAll(selector);
  radios.forEach((radio) => {
    const radioValue = (radio as unknown as { value?: string }).value;
    const isActive = radioValue === value;
    setElementCheckedState(radio as HTMLElement, isActive);
  });
}

/**
 * Extract the selected value from a vscode-radio-group change event.
 * The event.target may be the radio element itself or a child, so we need to
 * find the closest vscode-radio element and get its value.
 */
export function getRadioChangeValue(
  event: Event,
  radioGroup: HTMLElement | null,
): string {
  if (event?.target instanceof Element) {
    const selectedRadio =
      event.target.closest('vscode-radio') ??
      radioGroup?.querySelector('vscode-radio[checked]');
    if (selectedRadio) {
      return (
        (selectedRadio as unknown as { value?: string }).value ||
        selectedRadio.getAttribute('value') ||
        ''
      );
    }
  }
  // Fallback to radio group value
  return (radioGroup as unknown as { value?: string } | null)?.value ?? '';
}

/**
 * Set element disabled state using attribute toggle.
 */
export function setElementDisabled(
  element: Element | null,
  disabled: boolean,
): void {
  if (!(element instanceof Element)) {
    return;
  }
  element.toggleAttribute('disabled', Boolean(disabled));
}

/**
 * Waits for a DOM element matching the provided selector.
 * Uses a MutationObserver to watch for DOM changes until the element appears.
 */
export function waitForElement(
  selector: string,
  options: { timeout?: number } = {},
): { promise: Promise<Element | null>; dispose: () => void } {
  const existing = document.querySelector(selector);
  if (existing) {
    return {
      promise: Promise.resolve(existing),
      dispose: () => {},
    };
  }

  let observer: MutationObserver | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let resolved = false;
  let resolvePromise: (value: Element | null) => void;

  const finish = (value: Element | null) => {
    if (resolved) {
      return;
    }
    resolved = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    observer?.disconnect();
    observer = null;
    resolvePromise(value);
  };

  const promise = new Promise<Element | null>((resolve) => {
    resolvePromise = resolve;

    if (options.timeout && options.timeout > 0) {
      timeoutId = setTimeout(() => finish(null), options.timeout);
    }

    observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (!element) {
        return;
      }
      finish(element);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  });

  const dispose = () => finish(null);

  return { promise, dispose };
}

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
