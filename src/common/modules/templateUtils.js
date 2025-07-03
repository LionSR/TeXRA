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

export function createIconButton({
  id,
  icon,
  title = '',
  className = 'vscode-button',
  disabled = false,
  dataset = {},
}) {
  const element = renderTemplate('iconButtonTemplate');
  if (!element) return null;
  const iconEl = element.querySelector('i');
  if (iconEl) {
    iconEl.classList.add(`codicon-${icon}`);
  }
  element.id = id;
  element.className = className;
  element.title = title;
  element.disabled = disabled;
  Object.entries(dataset).forEach(([key, value]) => {
    element.dataset[key] = value;
  });
  return element;
}
