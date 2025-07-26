export function addEventListenerSafely(elementOrId, event, handler) {
  const element =
    typeof elementOrId === 'string'
      ? safeGetElementById(elementOrId)
      : elementOrId;

  if (element) {
    element.addEventListener(event, handler);
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

/**
 * Update or insert a chevron icon inside the given toggle element.
 *
 * @param {HTMLElement} toggleElement - The element containing the chevron.
 * @param {boolean} expanded - True if the section is expanded.
 */
export function updateChevronIcon(toggleElement, expanded) {
  if (!toggleElement) {
    console.warn('[domUtils] Missing toggleElement for updateChevronIcon');
    return;
  }

  const icon = toggleElement.querySelector(
    '.codicon-chevron-up, .codicon-chevron-down',
  );
  if (icon) {
    icon.classList.toggle('codicon-chevron-up', expanded);
    icon.classList.toggle('codicon-chevron-down', !expanded);
  } else {
    const newIcon = document.createElement('i');
    newIcon.className = `codicon ${expanded ? 'codicon-chevron-up' : 'codicon-chevron-down'}`;
    toggleElement.appendChild(newIcon);
  }
}
