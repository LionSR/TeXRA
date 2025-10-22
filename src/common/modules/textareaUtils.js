const DEFAULT_MAX_HEIGHT = 400;

function resolveTextareaTarget(target) {
  if (!target) {
    return { host: null, textarea: null };
  }

  if (target instanceof HTMLTextAreaElement) {
    return { host: null, textarea: target };
  }

  const maybeElement = target;
  const tagName = maybeElement?.tagName?.toLowerCase?.();
  if (tagName === 'vscode-textarea') {
    const host = maybeElement;
    const wrapped = host.wrappedElement;
    if (wrapped instanceof HTMLTextAreaElement) {
      return { host, textarea: wrapped };
    }
    const shadowTextarea = host.shadowRoot?.querySelector('textarea');
    if (shadowTextarea instanceof HTMLTextAreaElement) {
      return { host, textarea: shadowTextarea };
    }
    return { host, textarea: null };
  }

  if (maybeElement?.wrappedElement instanceof HTMLTextAreaElement) {
    return { host: maybeElement, textarea: maybeElement.wrappedElement };
  }

  return { host: null, textarea: null };
}

function syncHostValue(host, textarea) {
  if (host && textarea) {
    host.value = textarea.value;
  }
}

export function autoResizeTextarea(target, maxHeight = DEFAULT_MAX_HEIGHT) {
  const { host, textarea } = resolveTextareaTarget(target);
  if (!textarea) {
    return;
  }

  textarea.style.height = 'auto';
  const newHeight = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = `${newHeight}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  syncHostValue(host, textarea);
}

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

export function resetTextareaHeight(target) {
  const { host, textarea } = resolveTextareaTarget(target);
  if (!textarea) {
    return;
  }

  textarea.style.height = '';
  textarea.style.overflowY = '';
  syncHostValue(host, textarea);
}

export { resolveTextareaTarget };
