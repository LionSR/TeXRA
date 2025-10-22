const DEFAULT_MAX_HEIGHT = 400;

function getNativeTextarea(textarea) {
  if (!textarea) {
    return null;
  }

  if (textarea instanceof HTMLTextAreaElement) {
    return textarea;
  }

  if (
    typeof textarea === 'object' &&
    'tagName' in textarea &&
    typeof textarea.tagName === 'string' &&
    textarea.tagName.toLowerCase() === 'vscode-textarea'
  ) {
    const wrapped =
      'wrappedElement' in textarea ? textarea.wrappedElement : undefined;
    if (wrapped instanceof HTMLTextAreaElement) {
      return wrapped;
    }
    const shadowTextarea = textarea.querySelector?.('textarea');
    if (shadowTextarea instanceof HTMLTextAreaElement) {
      return shadowTextarea;
    }
  }

  return null;
}

/**
 * Automatically resize a textarea based on its scroll height.
 * @param {HTMLElement|HTMLTextAreaElement} textarea
 * @param {number} [maxHeight]
 */
export function autoResizeTextarea(textarea, maxHeight = DEFAULT_MAX_HEIGHT) {
  const nativeTextarea = getNativeTextarea(textarea);
  if (!nativeTextarea) {
    return;
  }

  nativeTextarea.style.height = 'auto';
  const newHeight = Math.min(nativeTextarea.scrollHeight, maxHeight);
  nativeTextarea.style.height = `${newHeight}px`;
  nativeTextarea.style.overflowY =
    nativeTextarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

/**
 * Insert text at the current cursor position in a textarea.
 * @param {HTMLElement|HTMLTextAreaElement} textarea
 * @param {string} text
 */
export function insertTextAtCursor(textarea, text) {
  if (typeof text !== 'string') {
    return;
  }

  const nativeTextarea = getNativeTextarea(textarea);
  if (!nativeTextarea) {
    return;
  }

  const start = nativeTextarea.selectionStart ?? nativeTextarea.value.length;
  const end = nativeTextarea.selectionEnd ?? nativeTextarea.value.length;
  const original = nativeTextarea.value;
  nativeTextarea.value =
    original.slice(0, start) + text + original.slice(end);
  const newCursorPos = start + text.length;
  nativeTextarea.selectionStart = nativeTextarea.selectionEnd = newCursorPos;
}

/**
 * Reset the height styles applied during auto-resize.
 * @param {HTMLElement|HTMLTextAreaElement} textarea
 */
export function resetTextareaHeight(textarea) {
  const nativeTextarea = getNativeTextarea(textarea);
  if (!nativeTextarea) {
    return;
  }

  nativeTextarea.style.height = '';
  nativeTextarea.style.overflowY = '';
}
