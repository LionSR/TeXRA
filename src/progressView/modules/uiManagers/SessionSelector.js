// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';

// Local imports - shared helpers
import { safeGetElementById } from '@common/domUtils.js';

function formatSessionLabel(group) {
  const date = group?.startTime ? new Date(group.startTime) : null;
  const timeLabel = date
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  if (timeLabel) {
    return `${timeLabel} • ${group.name}`;
  }
  return group?.name ?? '';
}

export class SessionSelector {
  constructor() {
    this._elements = null;
    this._onChange = null;
    this._selected = null;

    this._handleChange = this._handleChange.bind(this);
  }

  _getElements() {
    if (!this._elements) {
      const container = safeGetElementById(
        ELEMENT_IDS.SESSION_SELECTOR_CONTAINER,
      );
      const dropdown = safeGetElementById(ELEMENT_IDS.SESSION_SELECTOR);

      if (!container || !dropdown) {
        return null;
      }

      dropdown.addEventListener('change', this._handleChange);
      this._elements = { container, dropdown };
    }

    return this._elements;
  }

  setOnChange(handler) {
    this._onChange = typeof handler === 'function' ? handler : null;
  }

  updateOptions(groups, preferredId) {
    const elements = this._getElements();
    if (!elements) {
      return null;
    }

    const rootGroups = Array.isArray(groups)
      ? groups.filter((group) => group && !group.parentGroupId)
      : [];

    const hasMultiple = rootGroups.length > 1;
    this._setVisibility(hasMultiple);

    const dropdown = elements.dropdown;
    dropdown.innerHTML = '';

    if (rootGroups.length === 0) {
      this._selected = null;
      elements.container.setAttribute('aria-hidden', 'true');
      return null;
    }

    const sortedGroups = [...rootGroups].sort(
      (a, b) => b.startTime - a.startTime,
    );

    const fragment = document.createDocumentFragment();
    let nextSelected = null;

    for (const group of sortedGroups) {
      const option = document.createElement('option');
      option.value = group.id;
      option.textContent = formatSessionLabel(group);
      fragment.appendChild(option);
    }

    dropdown.appendChild(fragment);

    const preferredExists = sortedGroups.some(
      (group) => group.id === preferredId,
    );
    if (preferredExists) {
      nextSelected = preferredId;
    } else {
      nextSelected = sortedGroups[0]?.id ?? null;
    }

    dropdown.value = nextSelected ?? '';
    this._selected = nextSelected;
    elements.container.setAttribute(
      'aria-hidden',
      hasMultiple ? 'false' : 'true',
    );

    return this._selected;
  }

  setSelected(groupId) {
    const elements = this._elements;
    if (!elements) {
      return;
    }

    const dropdown = elements.dropdown;
    if (!dropdown) {
      return;
    }

    if (groupId && dropdown.value === groupId) {
      return;
    }

    const hasOption = Array.from(dropdown.options).some(
      (option) => option.value === groupId,
    );

    if (!hasOption) {
      return;
    }

    dropdown.value = groupId;
    this._selected = groupId;
    this._notifyChange();
  }

  getSelected() {
    return this._selected;
  }

  clear() {
    const elements = this._elements;
    if (!elements) {
      return;
    }

    elements.dropdown.innerHTML = '';
    elements.container.classList.remove('is-visible');
    elements.container.setAttribute('aria-hidden', 'true');
    this._selected = null;
  }

  _setVisibility(visible) {
    const elements = this._elements;
    if (!elements) {
      return;
    }

    elements.container.classList.toggle('is-visible', Boolean(visible));
  }

  _handleChange(event) {
    const dropdown = event?.currentTarget;
    if (!dropdown) {
      return;
    }

    this._selected = dropdown.value || null;
    this._notifyChange();
  }

  _notifyChange() {
    if (this._onChange) {
      this._onChange(this._selected);
    }
  }
}
