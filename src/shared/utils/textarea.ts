/**
 * Textarea utilities for VS Code web components.
 */

export type TextareaTarget = HTMLElement | HTMLTextAreaElement | null;

interface TextareaResolution {
  host: HTMLElement | null;
  textarea: HTMLTextAreaElement | null;
}

/**
 * Resolve textarea target to get both the host element and wrapped textarea.
 * For vscode-textarea, we use the wrappedElement property per API docs.
 */
export function resolveTextareaTarget(
  target: TextareaTarget,
): TextareaResolution {
  if (!target) {
    return { host: null, textarea: null };
  }

  if (target instanceof HTMLTextAreaElement) {
    return { host: null, textarea: target };
  }

  const maybeHost = target as HTMLElement & {
    wrappedElement?: HTMLTextAreaElement;
  };

  if (maybeHost.wrappedElement instanceof HTMLTextAreaElement) {
    return { host: target, textarea: maybeHost.wrappedElement };
  }

  return { host: null, textarea: null };
}

/**
 * Sync value from wrapped textarea to host element.
 * vscode-textarea should handle this automatically, but we do it for safety.
 */
function syncHostValue(
  host: HTMLElement | null,
  textarea: HTMLTextAreaElement | null,
): void {
  if (
    host &&
    textarea &&
    (host as HTMLTextAreaElement).value !== textarea.value
  ) {
    (host as HTMLTextAreaElement).value = textarea.value;
  }
}

/**
 * Insert text at the current cursor position in a textarea.
 * Works with both native textarea and vscode-textarea elements.
 */
export function insertTextAtCursor(target: TextareaTarget, text: string): void {
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
