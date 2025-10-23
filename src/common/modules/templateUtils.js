// Local imports - common
import { setElementDisabled } from './domUtils.js';

export function renderTemplate(templateId) {
  const template = document.getElementById(templateId);
  if (!template) {
    console.warn(`Template ${templateId} not found`);
    return null;
  }
  return template.content.firstElementChild.cloneNode(true);
}

export function createFromTemplate(templateId, replacements = {}) {
  const element = renderTemplate(templateId);
  if (!element) return null;

  const { text = {}, attributes = {}, dataset = {} } = replacements;
  const apply = (selector, fn) => {
    const target = selector ? element.querySelector(selector) : element;
    if (target) fn(target);
  };

  Object.entries(text).forEach(([selector, value]) => {
    apply(selector, (el) => {
      el.textContent = value;
    });
  });

  Object.entries(attributes).forEach(([selector, attrs]) => {
    apply(selector, (el) => {
      Object.entries(attrs).forEach(([attr, val]) => {
        el.setAttribute(attr, val);
      });
    });
  });

  Object.entries(dataset).forEach(([selector, data]) => {
    apply(selector, (el) => {
      Object.entries(data).forEach(([key, val]) => {
        el.dataset[key] = val;
      });
    });
  });

  return element;
}

export function validateTemplates(templateIds) {
  return templateIds.every((id) => {
    const template = document.getElementById(id);
    if (!template) {
      console.error(`Template ${id} not found`);
      return false;
    }
    return true;
  });
}

export function createIconButton({
  id,
  icon,
  title = '',
  className = '',
  disabled = false,
  dataset = {},
}) {
  const element = document.createElement('vscode-toolbar-button');
  element.id = id;
  if (className) {
    element.className = className;
  }
  if (icon) {
    element.icon = icon;
  }
  if (title) {
    element.setAttribute('label', title);
    element.setAttribute('aria-label', title);
  }
  setElementDisabled(element, disabled);
  Object.entries(dataset).forEach(([key, value]) => {
    element.dataset[key] = value;
  });
  return element;
}

/**
 * Create a codicon element from the shared template.
 * @param {string} iconName - Icon name such as 'mic' or 'chevron-up'.
 * @returns {HTMLElement|null} The codicon element or null if template missing.
 */
export function createCodicon(iconName) {
  return createFromTemplate('codiconTemplate', {
    attributes: { '': { class: `codicon codicon-${iconName}` } },
  });
}
