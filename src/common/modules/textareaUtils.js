/**
 * Resolve textarea target to get both the host element and wrapped textarea.
 * For vscode-textarea, we use the wrappedElement property per API docs.
 * @param {HTMLElement|HTMLTextAreaElement} target
 * @returns {{host: HTMLElement|null, textarea: HTMLTextAreaElement|null}}
 */
function resolveTextareaTarget(target) {
  if (!target) {
    return { host: null, textarea: null };
  }

  // Native textarea
  if (target instanceof HTMLTextAreaElement) {
    return { host: null, textarea: target };
  }

  // vscode-textarea web component - use wrappedElement API
  if (target?.wrappedElement instanceof HTMLTextAreaElement) {
    return { host: target, textarea: target.wrappedElement };
  }

  return { host: null, textarea: null };
}

/**
 * Sync value from wrapped textarea to host element.
 * vscode-textarea should handle this automatically, but we do it for safety.
 */
function syncHostValue(host, textarea) {
  if (host && textarea && host.value !== textarea.value) {
    host.value = textarea.value;
  }
}

/**
 * Insert text at the current cursor position in a textarea.
 * Works with both native textarea and vscode-textarea elements.
 * @param {HTMLElement|HTMLTextAreaElement} target - The textarea element
 * @param {string} text - The text to insert
 */
export function insertTextAtCursor(target, text) {
  const { host, textarea } = resolveTextareaTarget(target);
  if (!textarea || typeof text !== 'string') {
    return;
  }

  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const original = textarea.value;
  textarea.value = original.slice(0, start) + text + original.slice(end);
  const newCursorPos = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = newCursorPos;
  syncHostValue(host, textarea);
}

export { resolveTextareaTarget };
