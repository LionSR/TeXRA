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
 * Optimized with fast paths for common cases (empty, append, prepend).
 * Falls back to linear scan for mid-insertion to correctly handle elements
 * without timestamps interspersed in the list.
 *
 * @param {HTMLElement} container - Parent element whose children are ordered
 * @param {HTMLElement} element - Element to insert
 * @param {number|Date} timestamp - Timestamp of the element to insert
 * @param {(child: HTMLElement) => number|null} [getChildTimestamp] - Optional
 *   callback to extract a timestamp from each child. Should return milliseconds
 *   since epoch or null if the child should be ignored.
 */
export function insertChronologically({
  container,
  element,
  timestamp,
  getChildTimestamp,
}) {
  if (!container || !element || timestamp === undefined || timestamp === null) {
    return;
  }

  const targetTime =
    timestamp instanceof Date ? timestamp.getTime() : timestamp;
  const childExtractor = getChildTimestamp ?? defaultChildTimestamp;

  const children = container.children;
  const len = children.length;

  // Fast path: empty container
  if (len === 0) {
    container.appendChild(element);
    return;
  }

  // Fast path: append at end (most common case for streaming logs)
  const lastChildTime = childExtractor(children[len - 1]);
  if (lastChildTime !== null && targetTime >= lastChildTime) {
    container.appendChild(element);
    return;
  }

  // Fast path: insert at beginning
  const firstChildTime = childExtractor(children[0]);
  if (firstChildTime !== null && targetTime < firstChildTime) {
    container.insertBefore(element, children[0]);
    return;
  }

  // Linear scan for mid-insertion. Binary search doesn't work reliably here
  // because some elements (file lists, statistics) don't have timestamps,
  // and treating nulls as "infinitely old" can skip valid insertion points.
  for (let i = 0; i < len; i++) {
    const childTime = childExtractor(children[i]);
    if (childTime !== null && targetTime < childTime) {
      container.insertBefore(element, children[i]);
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
  if (!child || !child.classList) {
    return null;
  }
  if (child.classList.contains('log-group')) {
    const startElem = child.querySelector('.group-start-time');
    const start = startElem?.dataset.start;
    return start ? parseInt(start, DECIMAL_RADIX) : null;
  }

  if (
    child.classList.contains('log-line') ||
    child.classList.contains('banner-details') ||
    child.classList.contains('native-status-line')
  ) {
    const fullTs = child.dataset.fullTimestamp;
    if (fullTs) {
      return parseTimestamp(fullTs).getTime();
    }
  }
  return null;
}
