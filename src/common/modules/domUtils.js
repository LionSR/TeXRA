// Local imports - common
import {
  CHEVRON_UP_CLASS,
  CHEVRON_DOWN_CLASS,
  CHEVRON_RIGHT_CLASS,
} from './iconConstants.js';

function getTagName(element) {
  return typeof element?.tagName === 'string'
    ? element.tagName.toLowerCase()
    : '';
}

function isVsCodeSelectElement(element) {
  return getTagName(element) === 'vscode-single-select';
}

function setChevronIconImpl(
  element,
  expanded,
  { expandedClass, collapsedClass },
) {
  if (!element) return;
  let icon = element;
  if (icon.tagName.toLowerCase() !== 'i') {
    icon = element.querySelector('i');
    if (!icon) {
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
  const chevronClass = expanded ? expandedClass : collapsedClass;
  icon.className = existingClasses
    ? `${chevronClass} ${existingClasses}`
    : chevronClass;
}

export function addEventListenerSafely(elementOrId, event, handler, options) {
  const element =
    typeof elementOrId === 'string'
      ? safeGetElementById(elementOrId)
      : elementOrId;

  if (element) {
    element.addEventListener(event, handler, options);
  }
}

export function safeSetElementValue(id, value) {
  const element = document.getElementById(id);
  if (!element) {
    console.warn(`Element with id '${id}' not found`);
    return;
  }
  element.value = value;
}

export function safeSetElementChecked(id, checked) {
  const element = document.getElementById(id);
  if (!element) {
    console.warn(`Element with id '${id}' not found`);
    return;
  }
  element.checked = checked;
}

export function safeGetElementById(id) {
  const element = document.getElementById(id);
  if (!element) {
    console.warn(`Element with id '${id}' not found`);
  }
  return element;
}

export function safeGetElementValue(id) {
  const element = document.getElementById(id);
  if (!element) {
    console.warn(`Element with id '${id}' not found`);
    return '';
  }
  return element.value;
}

export function safeGetElementChecked(id) {
  const element = document.getElementById(id);
  if (!element) {
    console.warn(`Element with id '${id}' not found`);
    return false;
  }
  return element.checked;
}

export function setElementsDisabled(idsOrElements, disabled) {
  const elements = Array.isArray(idsOrElements)
    ? idsOrElements
    : [idsOrElements];
  elements.forEach((el) => {
    if (typeof el === 'string') {
      const elem = document.getElementById(el);
      if (elem) elem.disabled = disabled;
    } else if (el) {
      el.disabled = disabled;
    }
  });
}

export function isSelectLikeElement(element) {
  if (!element) {
    return false;
  }
  if (element instanceof HTMLSelectElement) {
    return true;
  }
  return isVsCodeSelectElement(element);
}

export function getSelectOptionElements(element) {
  if (!isSelectLikeElement(element)) {
    return [];
  }
  if (element instanceof HTMLSelectElement) {
    return Array.from(element.options);
  }
  return Array.from(element.querySelectorAll('vscode-option'));
}

export function getSelectedOptionElement(element) {
  if (!isSelectLikeElement(element)) {
    return null;
  }

  if (element instanceof HTMLSelectElement) {
    return element.options[element.selectedIndex] ?? null;
  }

  const options = getSelectOptionElements(element);
  if (options.length === 0) {
    return null;
  }

  const currentValue = element.value ?? '';
  if (currentValue) {
    const matchingOption = options.find(
      (option) => option.value === currentValue,
    );
    if (matchingOption) {
      return matchingOption;
    }
  }

  return (
    options.find(
      (option) => option.hasAttribute('selected') || option.selected,
    ) ??
    options[0] ??
    null
  );
}

/**
 * Set a chevron icon to indicate expanded/collapsed state.
 * @param {HTMLElement} element - The icon container or <i> element.
 * @param {boolean} expanded - Whether the section is expanded.
 */
export function setChevronIcon(element, expanded) {
  setChevronIconImpl(element, expanded, {
    expandedClass: CHEVRON_UP_CLASS,
    collapsedClass: CHEVRON_DOWN_CLASS,
  });
}

/**
 * Set a chevron icon for horizontal expansion (right/down).
 * @param {HTMLElement} element - The icon container or <i> element.
 * @param {boolean} expanded - Whether the section is expanded.
 */
export function setChevronIconHorizontal(element, expanded) {
  setChevronIconImpl(element, expanded, {
    expandedClass: CHEVRON_DOWN_CLASS,
    collapsedClass: CHEVRON_RIGHT_CLASS,
  });
}

/**
 * Waits for a DOM element matching the provided selector.
 *
 * Uses a MutationObserver to watch for DOM changes until the element appears.
 * If the element already exists, returns immediately. Supports optional timeout.
 *
 * @param {string} selector - CSS selector to match the desired element
 * @param {Object} [options] - Optional configuration
 * @param {number} [options.timeout] - Maximum time to wait in milliseconds (default: no timeout)
 * @returns {{ promise: Promise<Element | null>, dispose: () => void }}
 *          Returns an object with:
 *          - promise: Resolves with the element or null if disposed/timeout
 *          - dispose: Function to cancel the wait and clean up resources
 *
 * @example
 * const { promise, dispose } = waitForElement('#model', { timeout: 5000 });
 * const element = await promise;
 * if (element) {
 *   // Use the element
 * }
 */
export function waitForElement(selector, options = {}) {
  const existing = document.querySelector(selector);
  if (existing) {
    return {
      promise: Promise.resolve(existing),
      dispose: () => {},
    };
  }

  let observer = null;
  let resolver = null;
  let timeoutId = null;

  const promise = new Promise((resolve) => {
    resolver = resolve;

    // Set up optional timeout
    if (options.timeout && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        if (resolver) {
          resolver = null;
          resolve(null);
        }
      }, options.timeout);
    }

    observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (!element) {
        return;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      resolver = null;
      resolve(element);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  });

  const dispose = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (resolver) {
      const resolve = resolver;
      resolver = null;
      resolve(null);
    }
  };

  return { promise, dispose };
}
