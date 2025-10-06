// Local imports - common
import {
  CHEVRON_UP_CLASS,
  CHEVRON_DOWN_CLASS,
  CHEVRON_RIGHT_CLASS,
} from './iconConstants.js';

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
