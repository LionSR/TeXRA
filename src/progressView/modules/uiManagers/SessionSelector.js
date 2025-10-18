// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';

// Local imports - shared helpers
import { safeGetElementById } from '@common/domUtils.js';

/**
 * Manages the session selector dropdown above the instruction panel.
 */
export class SessionSelector {
  constructor() {
    this._elements = null;
    this._changeHandler = null;
    this._boundOnChange = this._handleChange.bind(this);
    this._currentSelection = '';
  }

  _ensureElements() {
    if (!this._elements) {
      const container = safeGetElementById(
        ELEMENT_IDS.SESSION_SELECTOR_CONTAINER,
      );
      const select = safeGetElementById(ELEMENT_IDS.SESSION_SELECTOR_SELECT);

      if (!container || !(select instanceof HTMLSelectElement)) {
        return null;
      }

      select.addEventListener('change', this._boundOnChange);
      this._elements = { container, select };
    }

    return this._elements;
  }

  setChangeHandler(handler) {
    this._changeHandler = typeof handler === 'function' ? handler : null;
  }

  update(groups, selectedId) {
    const elements = this._ensureElements();
    if (!elements) {
      return;
    }

    const rootGroups = Array.isArray(groups)
      ? groups.filter((group) => !group.parentGroupId)
      : [];
    rootGroups.sort((a, b) => a.startTime - b.startTime);

    elements.select.innerHTML = '';

    for (const group of rootGroups) {
      const option = document.createElement('option');
      option.value = group.id;
      option.textContent = group.name || group.id;
      elements.select.appendChild(option);
    }

    const hasMultiple = rootGroups.length > 1;
    elements.container.classList.toggle('is-visible', hasMultiple);
    elements.container.setAttribute(
      'aria-hidden',
      hasMultiple ? 'false' : 'true',
    );
    elements.select.disabled = rootGroups.length === 0;

    const defaultSelection = rootGroups.find((group) => group.id === selectedId)
      ? selectedId
      : rootGroups[0]?.id || '';

    this._currentSelection = defaultSelection || '';
    if (elements.select.value !== this._currentSelection) {
      elements.select.value = this._currentSelection;
    }
  }

  setSelection(groupId) {
    const elements = this._ensureElements();
    if (!elements) {
      return;
    }

    this._currentSelection = groupId || '';
    if (elements.select.value !== this._currentSelection) {
      elements.select.value = this._currentSelection;
    }
  }

  hide() {
    const elements = this._ensureElements();
    if (!elements) {
      return;
    }

    elements.container.classList.remove('is-visible');
    elements.container.setAttribute('aria-hidden', 'true');
    elements.select.disabled = true;
    elements.select.innerHTML = '';
    this._currentSelection = '';
  }

  _handleChange(event) {
    const value = event?.target?.value ?? '';
    this._currentSelection = value;

    if (this._changeHandler) {
      this._changeHandler(value || null);
    }
  }
}
