const DEFAULT_MAX_HEIGHT = 400;

function getNativeTextarea(element) {
  if (!element) {
    return null;
  }
  if (element instanceof HTMLTextAreaElement) {
    return element;
  }
  if (typeof element.tagName === 'string') {
    const tag = element.tagName.toLowerCase();
    if (tag === 'vscode-textarea') {
      return element.wrappedElement ?? element;
    }
  }
  return null;
}

/**
 * Automatically resize a textarea based on its scroll height.
 * @param {HTMLElement} textarea
 * @param {number} [maxHeight]
 */
export function autoResizeTextarea(textarea, maxHeight = DEFAULT_MAX_HEIGHT) {
  const native = getNativeTextarea(textarea);
  if (!native) {
    return;
  }

  native.style.height = 'auto';
  const newHeight = Math.min(native.scrollHeight, maxHeight);
  native.style.height = `${newHeight}px`;
  native.style.overflowY = native.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

/**
 * Insert text at the current cursor position in a textarea.
 * @param {HTMLElement} textarea
 * @param {string} text
 */
export function insertTextAtCursor(textarea, text) {
  if (typeof text !== 'string') {
    return;
  }
  const native = getNativeTextarea(textarea);
  if (!native) {
    return;
  }

  const start = native.selectionStart ?? native.value.length;
  const end = native.selectionEnd ?? native.value.length;
  const original = native.value;
  native.value = original.slice(0, start) + text + original.slice(end);
  const newCursorPos = start + text.length;
  native.selectionStart = native.selectionEnd = newCursorPos;
}

/**
 * Reset the height styles applied during auto-resize.
 * @param {HTMLElement} textarea
 */
export function resetTextareaHeight(textarea) {
  const native = getNativeTextarea(textarea);
  if (!native) {
    return;
  }

  native.style.height = '';
  native.style.overflowY = '';
}
