type TextareaTarget = HTMLElement | HTMLTextAreaElement | null;

interface TextareaResolution {
  host: VscodeTextarea | null;
  textarea: HTMLTextAreaElement | null;
}

interface VscodeTextarea extends HTMLElement {
  value?: string;
  wrappedElement?: HTMLTextAreaElement;
}

/**
 * Resolve a vscode-textarea or wa-textarea element to its underlying
 * HTMLTextAreaElement. This is an internal helper for insertTextAtCursor —
 * selection operations (.selectionStart, .selectionEnd) are NOT proxied by
 * either host element.
 *
 * For .value access, use the host element directly — both vscode-textarea
 * and wa-textarea expose .value as a property on the host.
 * For .focus(), use the host element directly.
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
    return { host, textarea: host.wrappedElement };
  }

  // wa-textarea (and similar shadow-DOM-based hosts) keep the underlying
  // <textarea> inside their shadow root rather than exposing wrappedElement.
  const shadowTextarea =
    host.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea') ?? null;
  if (shadowTextarea) {
    return { host, textarea: shadowTextarea };
  }

  return { host: null, textarea: null };
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
  if (host && host.value !== textarea.value) {
    host.value = textarea.value;
  }
}
