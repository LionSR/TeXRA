/**
 * Clipboard utilities for webview frontends.
 * Provides consistent clipboard operations with UI feedback.
 */

/** Default delay before resetting copy button feedback (ms) */
export const COPY_RESET_DELAY_MS = 2000;

/**
 * Attempt to copy text to the clipboard using the asynchronous clipboard API.
 * Normalizes line endings to LF.
 * @param {string} text - The text to copy
 * @returns {Promise<boolean>} true when the copy succeeds
 */
export async function copyTextToClipboard(text) {
  if (typeof text !== 'string' || !text) {
    return false;
  }

  const normalized = text.replace(/\r?\n/g, '\n');

  try {
    await navigator.clipboard.writeText(normalized);
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Copy text to the clipboard and surface lightweight feedback on the button.
 * Manages button state (title, aria-label, CSS class) and auto-resets after delay.
 * @param {HTMLElement} button - The button element to update with feedback
 * @param {string} text - The text to copy
 * @param {{
 *   defaultTitle?: string,
 *   successTitle?: string,
 *   successClass?: string,
 *   resetDelay?: number,
 * }} [options] - Configuration options
 * @returns {Promise<boolean>} true when copy succeeds
 */
export async function copyWithFeedback(button, text, options = {}) {
  if (!(button instanceof HTMLElement)) {
    return false;
  }

  const trimmed = typeof text === 'string' ? text.trim() : '';
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
  const resetDelay =
    typeof options.resetDelay === 'number'
      ? options.resetDelay
      : COPY_RESET_DELAY_MS;

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
