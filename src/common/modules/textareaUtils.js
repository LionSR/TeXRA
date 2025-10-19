const DEFAULT_MAX_HEIGHT = 400;

/**
 * Automatically resize a textarea based on its scroll height.
 * @param {HTMLTextAreaElement} textarea
 * @param {number} [maxHeight]
 */
export function autoResizeTextarea(textarea, maxHeight = DEFAULT_MAX_HEIGHT) {
  if (!(textarea instanceof HTMLTextAreaElement)) {
    return;
  }

  textarea.style.height = 'auto';
  const newHeight = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = `${newHeight}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

/**
 * Insert text at the current cursor position in a textarea.
 * @param {HTMLTextAreaElement} textarea
 * @param {string} text
 */
export function insertTextAtCursor(textarea, text) {
  if (!(textarea instanceof HTMLTextAreaElement) || typeof text !== 'string') {
    return;
  }

  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const original = textarea.value;
  textarea.value = original.slice(0, start) + text + original.slice(end);
  const newCursorPos = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = newCursorPos;
}

/**
 * Reset the height styles applied during auto-resize.
 * @param {HTMLTextAreaElement} textarea
 */
export function resetTextareaHeight(textarea) {
  if (!(textarea instanceof HTMLTextAreaElement)) {
    return;
  }

  textarea.style.height = '';
  textarea.style.overflowY = '';
}
