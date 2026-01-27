/**
 * Clipboard utilities for webview frontends.
 * Provides consistent clipboard operations with UI feedback.
 */

/** Default delay before resetting copy button feedback (ms) */
export const COPY_RESET_DELAY_MS = 2000;

/**
 * Attempt to copy text to the clipboard using the asynchronous clipboard API.
 * Normalizes line endings to LF.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof text !== 'string' || !text) {
    return false;
  }

  const normalized = text.replaceAll(/\r?\n/g, '\n');

  try {
    await navigator.clipboard.writeText(normalized);
    return true;
  } catch {
    return false;
  }
}

interface CopyFeedbackOptions {
  defaultTitle?: string;
  successTitle?: string;
  successClass?: string;
  resetDelay?: number;
}

/**
 * Copy text to the clipboard and surface lightweight feedback on the button.
 * Manages button state (title, aria-label, CSS class) and auto-resets after delay.
 */
export async function copyWithFeedback(
  button: HTMLElement,
  text: string,
  options: CopyFeedbackOptions = {},
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const defaultTitle =
    options.defaultTitle ??
    button.dataset.defaultTitle ??
    button.getAttribute('title') ??
    'Copy text';
  const successTitle =
    options.successTitle ?? button.dataset.successTitle ?? 'Copied!';
  const successClass = options.successClass ?? 'copy-success';
  const resetDelay = options.resetDelay ?? COPY_RESET_DELAY_MS;

  // Clear any pending reset timers so we can restart the feedback window.
  const existingTimeoutId = button.dataset.copyResetTimeoutId;
  if (existingTimeoutId) {
    window.clearTimeout(Number(existingTimeoutId));
    delete button.dataset.copyResetTimeoutId;
  }

  button.classList.remove(successClass);
  button.setAttribute('title', defaultTitle);
  button.setAttribute('aria-label', defaultTitle);

  const copied = await copyTextToClipboard(text);
  if (!copied) {
    return false;
  }

  button.classList.add(successClass);
  button.setAttribute('title', successTitle);
  button.setAttribute('aria-label', successTitle);

  const timeoutId = window.setTimeout(() => {
    button.classList.remove(successClass);
    button.setAttribute('title', defaultTitle);
    button.setAttribute('aria-label', defaultTitle);
    delete button.dataset.copyResetTimeoutId;
  }, resetDelay);

  button.dataset.copyResetTimeoutId = `${timeoutId}`;
  button.dataset.defaultTitle = defaultTitle;
  button.dataset.successTitle = successTitle;

  return true;
}
