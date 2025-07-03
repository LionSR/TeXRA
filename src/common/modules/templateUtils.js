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

export function createFileItem(path) {
  let element = renderTemplate('fileItemTemplate');
  if (!element) {
    element = document.createElement('div');
    element.className = 'file-item';
    element.dataset.path = path;
    element.textContent = path;
    const removeButton = document.createElement('span');
    removeButton.className = 'remove-button';
    removeButton.textContent = '-';
    element.appendChild(removeButton);
    return element;
  }
  element.dataset.path = path;
  const pathEl = element.querySelector('.file-path');
  if (pathEl) {
    pathEl.textContent = path;
  } else {
    element.prepend(document.createTextNode(path));
  }
  return element;
}
