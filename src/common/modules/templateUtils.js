export function renderTemplate(templateId) {
  const template = document.getElementById(templateId);
  if (!template) {
    console.warn(`Template ${templateId} not found`);
    return null;
  }
  return template.content.firstElementChild.cloneNode(true);
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

export function createOption({ value = '', text = '' } = {}) {
  const option = renderTemplate('optionTemplate');
  if (!option) return null;
  option.value = value;
  option.textContent = text;
  return option;
}

export function createFileListItem(file) {
  const element = renderTemplate('fileListItemTemplate');
  if (!element) return null;
  const nameSpan = element.querySelector('.file-name');
  if (nameSpan) nameSpan.textContent = file;
  element.dataset.path = file;
  return element;
}

export function createIcon(iconClass) {
  const icon = renderTemplate('iconTemplate');
  if (!icon) return null;
  icon.classList.add(iconClass);
  return icon;
}
