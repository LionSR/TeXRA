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
 * Uses binary search for O(log n) insertion point finding instead of O(n) linear scan.
 *
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

  const lastChild = container.lastElementChild;
  if (!lastChild) {
    container.appendChild(element);
    return;
  }

  // Fast path: append at end (most common case for streaming)
  const lastChildTime = childExtractor(lastChild);
  if (lastChildTime !== null && targetTime >= lastChildTime) {
    container.appendChild(element);
    return;
  }

  // Fast path: insert at beginning
  const firstChild = container.firstElementChild;
  const firstChildTime = firstChild ? childExtractor(firstChild) : null;
  if (firstChildTime !== null && targetTime < firstChildTime) {
    container.insertBefore(element, firstChild);
    return;
  }

  // Binary search for insertion point
  const children = container.children;
  const childCount = children.length;

  // Skip binary search for small containers (threshold where linear is faster)
  if (childCount <= 8) {
    for (let i = 0; i < childCount; i++) {
      const child = children[i];
      const childTime = childExtractor(child);
      if (childTime !== null && targetTime < childTime) {
        container.insertBefore(element, child);
        return;
      }
    }
    container.appendChild(element);
    return;
  }

  // Binary search: find first child with timestamp > targetTime
  let low = 0;
  let high = childCount;

  while (low < high) {
    const mid = (low + high) >>> 1; // Unsigned right shift for floor division
    const child = children[mid];
    const childTime = childExtractor(child);

    // Treat null timestamps as infinity (insert before them)
    if (childTime === null || targetTime < childTime) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  // Insert at found position
  if (low < childCount) {
    container.insertBefore(element, children[low]);
  } else {
    container.appendChild(element);
  }
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
