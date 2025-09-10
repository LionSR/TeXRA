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
const SUPPORTED_PROPERTIES = ['value', 'checked'];

/**
 * Get or set a DOM element property safely.
 * @param {string|HTMLElement} elementOrId - Element ID or the element itself
 * @param {string} key - Property name ('value', 'checked', etc.)
 * @param {*} [value] - Value to set (omit to get current value)
 * @param {*} [defaultValue] - Default value for getter mode
 * @returns {*|boolean} Property value when getting, true on successful set, false on failure
 */
export function safeElementProperty(
  elementOrId,
  key,
  value,
  defaultValue = DEFAULTS[key],
) {
  // Support both element references and IDs for better performance
  const element =
    typeof elementOrId === 'string'
      ? document.getElementById(elementOrId)
      : elementOrId;
  
  if (!element) {
    const id = typeof elementOrId === 'string' ? elementOrId : 'provided element';
    console.warn(`Element with id '${id}' not found`);
    if (value === undefined) return defaultValue;
    return false;
  }
  
  // Warn about potentially unsupported properties
  if (!SUPPORTED_PROPERTIES.includes(key) && defaultValue === undefined) {
    console.warn(`Property '${key}' may not have a default value. Consider providing one.`);
  }
  
  // Getter mode
  if (value === undefined) {
    return element[key] ?? defaultValue;
  }
  
  // Setter mode
  element[key] = value;
  return true;
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
