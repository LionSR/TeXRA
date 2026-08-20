import { normalizeLineEndings } from '@utils/text/stringUtils';

export const COPY_RESET_DELAY_MS = 2000;

export function appendClipboardImageChips(
  text: string,
  fileNames: readonly string[],
): string {
  if (fileNames.length === 0) return text;
  const boundary =
    text && !text.endsWith(' ') && !text.endsWith('\n') ? ' ' : '';
  return `${text}${boundary}${fileNames.map((name) => `[${name}]`).join(' ')}`;
}

/**
 * Copy text to clipboard with LF-normalized line endings.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(normalizeLineEndings(text));
    return true;
  } catch {
    return false;
  }
}

interface CopyFeedbackOptions {
  successClass?: string;
}

/**
 * Copy text to clipboard and show feedback on a button element.
 * Auto-resets button state after the configured delay.
 */
export async function copyWithFeedback(
  button: HTMLElement,
  text: string,
  options: CopyFeedbackOptions = {},
): Promise<boolean> {
  if (!text.trim()) {
    return false;
  }

  const defaultTitle =
    button.dataset.defaultTitle ?? button.getAttribute('title') ?? 'Copy text';
  const successTitle = button.dataset.successTitle ?? 'Copied!';
  const successClass = options.successClass ?? 'copy-success';

  function setButtonState(title: string, showSuccess: boolean): void {
    button.classList.toggle(successClass, showSuccess);
    button.setAttribute('title', title);
    button.setAttribute('aria-label', title);
  }

  if (button.dataset.copyResetTimeoutId) {
    window.clearTimeout(Number(button.dataset.copyResetTimeoutId));
    delete button.dataset.copyResetTimeoutId;
  }

  setButtonState(defaultTitle, false);

  const copied = await copyTextToClipboard(text);
  if (!copied) {
    return false;
  }

  setButtonState(successTitle, true);

  const timeoutId = window.setTimeout(() => {
    setButtonState(defaultTitle, false);
    delete button.dataset.copyResetTimeoutId;
  }, COPY_RESET_DELAY_MS);

  button.dataset.copyResetTimeoutId = String(timeoutId);
  button.dataset.defaultTitle = defaultTitle;
  button.dataset.successTitle = successTitle;

  return true;
}
