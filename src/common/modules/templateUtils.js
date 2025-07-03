export function renderTemplate(templateId) {
  const template = document.getElementById(templateId);
  if (!template) {
    console.warn(`Template ${templateId} not found`);
    return null;
  }
  const element = template.content.firstElementChild;
  if (!element) {
    console.warn(`Template ${templateId} has no content`);
    return null;
  }
  return element.cloneNode(true);
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
  if (id) {
    element.id = id;
  }
  element.className = className;
  element.title = title;
  element.disabled = disabled;
  Object.entries(dataset).forEach(([key, value]) => {
    element.dataset[key] = value;
  });
  return element;
}

export function createHistoryItem() {
  return renderTemplate('historyItemTemplate');
}
