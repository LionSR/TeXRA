// Local imports - common
import { CHEVRON_UP_CLASS, CHEVRON_DOWN_CLASS } from './iconConstants.js';

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
  const element = safeGetElementById(id);
  if (!element) return;
  element.value = value;
}

export function safeSetElementChecked(id, checked) {
  const element = safeGetElementById(id);
  if (!element) return;
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
  const element = safeGetElementById(id);
  return element ? element.value : '';
}

export function safeGetElementChecked(id) {
  const element = safeGetElementById(id);
  return element ? element.checked : false;
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
