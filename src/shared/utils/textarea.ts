export type TextareaTarget = HTMLElement | HTMLTextAreaElement | null;

interface TextareaResolution {
  host: HTMLElement | null;
  textarea: HTMLTextAreaElement | null;
}

interface VscodeTextarea extends HTMLElement {
  value?: string;
  wrappedElement?: HTMLTextAreaElement;
}

export function resolveTextareaTarget(
  target: TextareaTarget,
): TextareaResolution {
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

export function insertTextAtCursor(target: TextareaTarget, text: string): void {
  const { host, textarea } = resolveTextareaTarget(target);
  if (!textarea) return;

  const { selectionStart: start, selectionEnd: end, value } = textarea;
  textarea.value = value.slice(0, start) + text + value.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  syncHostValue(host, textarea.value);
}
