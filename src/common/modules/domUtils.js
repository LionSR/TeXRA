// Local imports - common
import { CHEVRON_UP_CLASS, CHEVRON_DOWN_CLASS } from './iconConstants.js';

export function addEventListenerSafely(elementOrId, event, handler) {
  const element =
    typeof elementOrId === 'string'
      ? safeGetElementById(elementOrId)
      : elementOrId;

  if (element) {
    element.addEventListener(event, handler);
  }
}

export function safeGetElementById(id) {
  const element = document.getElementById(id);
  if (!element) {
    console.warn(`Element with id '${id}' not found`);
  }
  return element;
}

const DEFAULTS = { value: '', checked: false };

export function safeElementProperty(
  id,
  key,
  value,
  defaultValue = DEFAULTS[key],
) {
  const element = document.getElementById(id);
  if (!element) {
    console.warn(`Element with id '${id}' not found`);
    if (value === undefined) return defaultValue;
    return;
  }
  if (value === undefined) {
    return element[key] ?? defaultValue;
  }
  element[key] = value;
}

/**
 * Set a chevron icon to indicate expanded/collapsed state.
 * @param {HTMLElement} element - The icon container or <i> element.
 * @param {boolean} expanded - Whether the section is expanded.
 */
export function setChevronIcon(element, expanded) {
  if (!element) return;
  let icon = element;
  if (icon.tagName.toLowerCase() !== 'i') {
    icon = element.querySelector('i');
    if (!icon) {
      icon = document.createElement('i');
      element.appendChild(icon);
    }
  }
  icon.className = expanded ? CHEVRON_UP_CLASS : CHEVRON_DOWN_CLASS;
}
