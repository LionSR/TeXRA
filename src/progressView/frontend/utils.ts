// @ts-nocheck
// Shared utility functions for the progress view frontend.

const DECIMAL_RADIX = 10;

export function parseTimestamp(timestampStr) {
  if (!timestampStr) return new Date();
  const numericValue = parseInt(timestampStr, DECIMAL_RADIX);
  if (!Number.isNaN(numericValue) && numericValue > 0) {
    return new Date(numericValue);
  }
  return new Date(timestampStr);
}

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

  if (len === 0) {
    container.appendChild(element);
    return;
  }

  const lastChildTime = childExtractor(children[len - 1]);
  if (lastChildTime !== null && targetTime >= lastChildTime) {
    container.appendChild(element);
    return;
  }

  const firstChildTime = childExtractor(children[0]);
  if (firstChildTime !== null && targetTime < firstChildTime) {
    container.insertBefore(element, children[0]);
    return;
  }

  for (let i = 0; i < len; i += 1) {
    const childTime = childExtractor(children[i]);
    if (childTime !== null && targetTime < childTime) {
      container.insertBefore(element, children[i]);
      return;
    }
  }
  container.appendChild(element);
}

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
