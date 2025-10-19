// Local imports - common
import { safeGetElementById } from './domUtils.js';

const DEFAULT_MAX_HEIGHT = 400;

/**
 * Automatically resize a textarea to fit its content while respecting a max height.
 * @param {HTMLTextAreaElement|string|null} textareaOrId - Textarea element or its id.
 * @param {number} [maxHeight=DEFAULT_MAX_HEIGHT] - Maximum height in pixels.
 */
export function autoResizeTextarea(
  textareaOrId,
  maxHeight = DEFAULT_MAX_HEIGHT,
) {
  const textarea =
    typeof textareaOrId === 'string'
      ? safeGetElementById(textareaOrId)
      : textareaOrId;
  if (!textarea) {
    return;
  }
  textarea.style.height = 'auto';
  const boundedHeight = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = `${boundedHeight}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

/**
 * Insert text at the current cursor position of the textarea.
 * @param {HTMLTextAreaElement|string|null} textareaOrId - Textarea element or its id.
 * @param {string} text - Text to insert at the cursor.
 */
export function insertTextAtCursor(textareaOrId, text) {
  const textarea =
    typeof textareaOrId === 'string'
      ? safeGetElementById(textareaOrId)
      : textareaOrId;
  if (!textarea) {
    return;
  }
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const original = textarea.value;
  textarea.value = original.slice(0, start) + text + original.slice(end);
  const cursor = start + text.length;
  textarea.selectionStart = cursor;
  textarea.selectionEnd = cursor;
}

/**
 * Reset textarea sizing styles so the element can shrink back to its base height.
 * @param {HTMLTextAreaElement|string|null} textareaOrId - Textarea element or its id.
 */
export function resetTextareaHeight(textareaOrId) {
  const textarea =
    typeof textareaOrId === 'string'
      ? safeGetElementById(textareaOrId)
      : textareaOrId;
  if (!textarea) {
    return;
  }
  textarea.style.height = '';
  textarea.style.overflowY = '';
}
