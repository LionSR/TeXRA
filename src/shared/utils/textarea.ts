type TextareaTarget = HTMLElement | HTMLTextAreaElement | null;

interface TextareaResolution {
  host: HTMLElement | null;
  textarea: HTMLTextAreaElement | null;
}

interface VscodeTextarea extends HTMLElement {
  value?: string;
  wrappedElement?: HTMLTextAreaElement;
}

/**
 * Resolve a vscode-textarea element to its underlying HTMLTextAreaElement.
 * This is an internal helper for insertTextAtCursor - selection operations
 * (.selectionStart, .selectionEnd) are NOT proxied by vscode-textarea.
 *
 * For .value access, use the host element directly - vscode-textarea proxies .value.
 * For .focus(), use the host element directly - it works on the vscode-textarea host.
 */
function resolveTextareaTarget(target: TextareaTarget): TextareaResolution {
  if (!target) {
    return { host: null, textarea: null };
  }

  if (target instanceof HTMLTextAreaElement) {
    return { host: null, textarea: target };
  }

  const host = target as VscodeTextarea;
  if (host.wrappedElement instanceof HTMLTextAreaElement) {
    return { host: target, textarea: host.wrappedElement };
  }

  return { host: null, textarea: null };
}

function syncHostValue(host: HTMLElement | null, value: string): void {
  if (!host) return;
  const vscodeHost = host as VscodeTextarea;
  if (vscodeHost.value !== value) {
    vscodeHost.value = value;
  }
}

/** Get .value from a vscode-textarea or HTMLTextAreaElement. */
export function getTextareaValue(
  element: HTMLElement | null | undefined,
): string {
  return (element as VscodeTextarea | undefined)?.value ?? '';
}

export function insertTextAtCursor(target: TextareaTarget, text: string): void {
  const { host, textarea } = resolveTextareaTarget(target);
  if (!textarea) return;

  const { selectionStart: start, selectionEnd: end, value } = textarea;
  textarea.value = value.slice(0, start) + text + value.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  syncHostValue(host, textarea.value);
}
