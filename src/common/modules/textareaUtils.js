// Utility helpers for managing textarea interactions across webviews.

/**
 * Automatically resize a textarea based on its scroll height while capping the
 * maximum height to maintain layout stability.
 *
 * @param {HTMLTextAreaElement} textarea - The textarea to resize.
 * @param {number} [maxHeight=400] - Maximum height in pixels.
 */
export function autoResizeTextarea(textarea, maxHeight = 400) {
  if (!textarea) return;

  textarea.style.height = 'auto';
  const newHeight = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = `${newHeight}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

/**
 * Insert text at the cursor position of a textarea, replacing any selected text.
 *
 * @param {HTMLTextAreaElement} textarea - Target textarea.
 * @param {string} text - Text to insert.
 */
export function insertTextAtCursor(textarea, text) {
  if (!textarea || typeof text !== 'string') {
    return;
  }

  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const original = textarea.value;
  textarea.value = `${original.slice(0, start)}${text}${original.slice(end)}`;
  const cursor = start + text.length;
  textarea.selectionStart = cursor;
  textarea.selectionEnd = cursor;
}
