// Local imports - common

/**
 * Tracks boolean toggle states and persists them when requested.
 */
export class ToggleStates {
  constructor(saveCallback) {
    this.states = new Map();
    this.saveCallback = saveCallback;
  }

  set(id, value) {
    if (!id) {
      return;
    }

    this.states.set(id, value);
    this.saveCallback?.();
  }

  get(id) {
    return this.states.get(id);
  }

  clearSelection(ids) {
    if (!Array.isArray(ids)) {
      return;
    }

    ids.forEach((id) => {
      if (id) {
        this.states.delete(id);
      }
    });

    this.saveCallback?.();
  }

  clearAll() {
    this.states.clear();
    this.saveCallback?.();
  }

  entries() {
    return [...this.states.entries()];
  }

  load(data) {
    this.states = new Map(data);
  }
}

/**
 * Applies `open` attributes to DOM elements resolved from a map of ids.
 * @param {Map<string, boolean>|Array<[string, any]>} stateMap
 * @param {(id: string) => string} selectorFormatter
 * @param {(value: any, id: string) => boolean} [valueToOpenState]
 */
export function applyOpenStates(
  stateMap,
  selectorFormatter,
  valueToOpenState = (value) => Boolean(value),
) {
  if (typeof selectorFormatter !== 'function') {
    return;
  }

  const entries =
    stateMap instanceof Map
      ? stateMap.entries()
      : Array.isArray(stateMap)
        ? stateMap
        : (stateMap ?? []);

  for (const entry of entries) {
    if (!entry) {
      continue;
    }

    const [id, value] = entry;
    if (!id) {
      continue;
    }

    const selector = selectorFormatter(id);
    if (!selector) {
      continue;
    }

    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) {
      continue;
    }

    const isOpen = valueToOpenState(value, id);
    if (typeof isOpen !== 'boolean') {
      continue;
    }

    if ('open' in element) {
      element.open = isOpen;
    }

    if (isOpen) {
      element.setAttribute('open', '');
    } else {
      element.removeAttribute('open');
    }
  }
}
