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

export function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function uncapitalize(str) {
  return str.charAt(0).toLowerCase() + str.slice(1);
}
