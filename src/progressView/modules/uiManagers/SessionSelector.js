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
    .sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
}

const STATUS_OVERRIDES = new Map(
  Object.entries({
    succeeded: 'Completed',
    success: 'Completed',
    completed: 'Completed',
    failed: 'Failed',
    error: 'Error',
    cancelled: 'Canceled',
    canceled: 'Canceled',
  }),
);

function formatStatus(status) {
  if (!status) {
    return '';
  }
  const lower = String(status).toLowerCase();
  if (STATUS_OVERRIDES.has(lower)) {
    return STATUS_OVERRIDES.get(lower);
  }
  const normalized = lower.replace(/[_-]+/g, ' ');
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDuration(durationMs) {
  if (durationMs < 0) return '0s';
  if (durationMs < 1000) return '<1s';

  const seconds = Math.floor(durationMs / 1000) % 60;
  const minutes = Math.floor(durationMs / (1000 * 60));

  if (minutes === 0) {
    return `${seconds}s`;
  } else if (seconds === 0) {
    return `${minutes}m`;
  } else {
    return `${minutes}m ${seconds}s`;
  }
}

function formatGroupLabel(group) {
  const timestamp = typeof group?.startTime === 'number' ? group.startTime : 0;
  const statusLabel = formatStatus(group?.status);

  const parts = [];
  if (timestamp) {
    const formatter = new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    parts.push(formatter.format(new Date(timestamp)));
  }
  if (statusLabel) {
    parts.push(statusLabel);
  }

  // Add duration if available
  if (group?.endTime && group?.startTime) {
    const durationMs = group.endTime - group.startTime;
    parts.push(formatDuration(durationMs));
  }

  if (parts.length === 0) {
    return 'Session';
  }

  return parts.join(' • ');
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
    console.log('[SessionSelector] Change event fired:', {
      value: event?.target?.value,
      hasHandler: !!this._changeHandler,
    });
    if (!this._changeHandler) {
      console.warn('[SessionSelector] No change handler registered');
      return;
    }
    try {
      const value = event?.target?.value || '';
      console.log(
        '[SessionSelector] Calling change handler with value:',
        value,
      );
      this._changeHandler(value);
    } catch (error) {
      console.error('SessionSelector: Error in change handler:', error);
    }
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
        rootGroups.some((g) => String(g.id) === String(previousValue))
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
