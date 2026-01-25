// Shared utility functions for the progress view frontend.

/**
 * Type for VSCode web components that expose a value property.
 * Used for vscode-radio-group, vscode-single-select, etc.
 */
export type VSCodeValueElement = HTMLElement & { value?: string };

/**
 * Extract value from a VSCode radio group change event.
 * Works around vscode-radio-group not updating .value synchronously on change.
 * Prefers the clicked radio element's value, falls back to group value.
 */
export function getRadioValue<T extends string>(event: Event): T | null {
  const target = event.target as Element | null;
  const radio = target?.closest('vscode-radio');
  const radioGroup = event.currentTarget as VSCodeValueElement | null;
  const value = radio?.getAttribute('value') || radioGroup?.value;
  return (value as T) || null;
}

export function parseTimestamp(timestampStr: string | null | undefined): Date {
  if (!timestampStr) return new Date();
  const numericValue = parseInt(timestampStr, 10);
  if (!Number.isNaN(numericValue) && numericValue > 0) {
    return new Date(numericValue);
  }
  return new Date(timestampStr);
}

export function appendFormatted(
  container: HTMLElement | DocumentFragment,
  formatted: HTMLElement | string | null,
): void {
  if (!formatted) return;

  if (formatted instanceof HTMLElement) {
    container.appendChild(formatted);
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.innerHTML = formatted;
  if (wrapper.firstElementChild) {
    container.appendChild(wrapper.firstElementChild);
  }
}

type ChildTimestampExtractor = (child: Element) => number | null;

export function insertChronologically({
  container,
  element,
  timestamp,
  getChildTimestamp,
}: {
  container: HTMLElement;
  element: HTMLElement;
  timestamp: number | Date;
  getChildTimestamp?: ChildTimestampExtractor;
}): void {
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

function defaultChildTimestamp(child: Element): number | null {
  if (!(child instanceof HTMLElement)) {
    return null;
  }
  if (child.classList.contains('log-group')) {
    const startElem = child.querySelector('.group-start-time');
    if (startElem instanceof HTMLElement) {
      const start = startElem.dataset.start;
      return start ? parseInt(start, 10) : null;
    }
    return null;
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
