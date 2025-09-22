// Shared utility functions for the progress view modules

// Constants
const DECIMAL_RADIX = 10; // Explicit base-10 for parseInt to avoid octal interpretation

/**
 * Parse a timestamp that could be either numeric or ISO-8601 string
 * @param {string} timestampStr - Timestamp string from dataset attribute
 * @returns {Date} Parsed date object
 */
export function parseTimestamp(timestampStr) {
  if (!timestampStr) return new Date();

  // Try parsing as a number first (for numeric timestamps)
  const numericValue = parseInt(timestampStr, DECIMAL_RADIX);
  if (!isNaN(numericValue) && numericValue > 0) {
    return new Date(numericValue);
  }

  // Fall back to ISO-8601 string parsing
  return new Date(timestampStr);
}

/**
 * Append formatted content to a container. Supports both DOM elements and
 * HTML strings.
 * @param {HTMLElement} container - Element to append to
 * @param {HTMLElement|string} formatted - Element or HTML string to append
 */
export function appendFormatted(container, formatted) {
  if (formatted instanceof HTMLElement) {
    container.appendChild(formatted);
    return;
  }

  if (typeof formatted === 'string') {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = formatted;
    if (wrapper.firstElementChild) {
      container.appendChild(wrapper.firstElementChild);
    }
  }
}

/**
 * Insert an element into a container keeping children sorted chronologically.
 * Handles log groups and log entries by default, but a custom extractor can
 * be provided for specialized cases.
 *
 * @param {HTMLElement} container - Parent element whose children are ordered
 * @param {HTMLElement} element - Element to insert
 * @param {number|Date} timestamp - Timestamp of the element to insert
 * @param {(child: HTMLElement) => number|null} [getChildTimestamp] - Optional
 *   callback to extract a timestamp from each child. Should return milliseconds
 *   since epoch or null if the child should be ignored.
 */
export function insertChronologically(
  container,
  element,
  timestamp,
  getChildTimestamp,
) {
  const targetTime =
    timestamp instanceof Date ? timestamp.getTime() : timestamp;
  const children = Array.from(container.children);
  for (const child of children) {
    const childTime = getChildTimestamp
      ? getChildTimestamp(child)
      : defaultChildTimestamp(child);
    if (childTime !== null && targetTime < childTime) {
      container.insertBefore(element, child);
      return;
    }
  }
  container.appendChild(element);
}

/**
 * Default child timestamp extractor that understands log groups and log
 * entries.
 * @param {HTMLElement} child - Child element in the container
 * @returns {number|null} The timestamp in ms or null if not applicable
 */
function defaultChildTimestamp(child) {
  if (child.classList.contains('log-group')) {
    const startElem = child.querySelector('.group-start-time');
    const start = startElem?.dataset.start;
    return start ? parseInt(start, DECIMAL_RADIX) : null;
  }

  if (
    child.classList.contains('log-line') ||
    child.classList.contains('model-response-line') ||
    child.classList.contains('special-details')
  ) {
    const fullTs = child.dataset.fullTimestamp;
    if (fullTs) {
      return parseTimestamp(fullTs).getTime();
    }
  }
  return null;
}

const COPY_RESET_DELAY_MS = 2000;

/**
 * Attempt to copy text to the clipboard using the modern API, falling back to
 * document.execCommand when necessary.
 * @param {string} text
 * @returns {Promise<boolean>} true when the copy succeeds.
 */
export async function copyTextToClipboard(text) {
  if (typeof text !== 'string' || !text) {
    return false;
  }

  const normalized = text.replace(/\r?\n/g, '\n');

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(normalized);
      return true;
    } catch {
      // Fall back to execCommand below
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = normalized;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

/**
 * Copy text to the clipboard and surface lightweight feedback on the button.
 * @param {HTMLElement} button
 * @param {string} text
 * @param {{
 *   defaultTitle?: string,
 *   successTitle?: string,
 *   successClass?: string,
 *   resetDelay?: number,
 * }} [options]
 * @returns {Promise<boolean>} true when copy succeeds.
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
