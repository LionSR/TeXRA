// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';

// Local imports - shared helpers
import { safeGetElementById } from '@common/domUtils.js';

function sortRootGroups(groups) {
  if (!Array.isArray(groups)) {
    return [];
  }
  return groups
    .filter((group) => group && !group.parentGroupId)
    .slice()
    .sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
}

function formatGroupLabel(group) {
  const baseLabel = group?.name || 'Session';
  const timestamp = typeof group?.startTime === 'number' ? group.startTime : 0;

  if (!timestamp) {
    return baseLabel;
  }

  const formatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  return `${baseLabel} • ${formatter.format(new Date(timestamp))}`;
}

export class SessionSelector {
  constructor() {
    this._elements = null;
    this._changeHandler = null;
    this._boundOnChange = this._handleChange.bind(this);
  }

  _ensureElements() {
    if (this._elements) {
      return this._elements;
    }

    const container = safeGetElementById(
      ELEMENT_IDS.SESSION_SELECTOR_CONTAINER,
    );
    const select = safeGetElementById(ELEMENT_IDS.SESSION_SELECTOR);

    if (!container || !select) {
      return null;
    }

    select.addEventListener('change', this._boundOnChange);
    this._elements = { container, select };
    return this._elements;
  }

  _handleChange(event) {
    if (!this._changeHandler) {
      return;
    }
    const value = event?.target?.value || '';
    this._changeHandler(value);
  }

  setOnChange(handler) {
    this._changeHandler = handler;
  }

  update(groups, selectedId) {
    const elements = this._ensureElements();
    if (!elements) {
      return '';
    }

    const rootGroups = sortRootGroups(groups);
    const { container, select } = elements;
    const previousValue = select.value;

    select.innerHTML = '';

    for (const group of rootGroups) {
      const option = document.createElement('option');
      option.value = group.id;
      option.textContent = formatGroupLabel(group);
      select.appendChild(option);
    }

    let nextValue = '';
    if (rootGroups.length > 0) {
      if (
        selectedId &&
        rootGroups.some((group) => String(group.id) === String(selectedId))
      ) {
        nextValue = String(selectedId);
      } else if (
        previousValue &&
        rootGroups.some((g) => g.id === previousValue)
      ) {
        nextValue = previousValue;
      } else {
        nextValue = String(rootGroups[rootGroups.length - 1].id);
      }
      select.value = nextValue;
    }

    const shouldHide = rootGroups.length <= 1;
    container.classList.toggle('is-hidden', shouldHide);
    container.setAttribute('aria-hidden', shouldHide ? 'true' : 'false');

    return nextValue;
  }

  getValue() {
    const elements = this._elements;
    return elements?.select?.value || '';
  }

  cleanup() {
    if (!this._elements?.select) {
      return;
    }
    this._elements.select.removeEventListener('change', this._boundOnChange);
    this._elements = null;
  }
}
