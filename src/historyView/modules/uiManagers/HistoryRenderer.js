// Local imports
import { vscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import { historyViewState } from '../historyViewState.js';
import { COMMANDS, ELEMENT_IDS, CLASS_NAMES, LABELS } from '../constants.js';
import { createFromTemplate } from '@common/templateUtils.js';

/**
 * Renders history items and manages per-item events.
 */
export class HistoryRenderer {
  constructor(searchManager) {
    this.searchManager = searchManager;
  }

  /** Render list of history items */
  render(historyItems) {
    const historyContainer = safeGetElementById(ELEMENT_IDS.HISTORY_CONTAINER);
    const clearButtonContainer = safeGetElementById(
      ELEMENT_IDS.CLEAR_BUTTON_CONTAINER,
    );
    if (!historyContainer || !clearButtonContainer) return;

    historyContainer.innerHTML = '';
    clearButtonContainer.innerHTML = '';

    if (!historyItems || historyItems.length === 0) {
      const placeholder = createFromTemplate('emptyStateTemplate', {
        text: { '': LABELS.EMPTY_STATE },
      });
      if (placeholder) historyContainer.appendChild(placeholder);
      this.searchManager.initialize(historyContainer);
      return;
    }

    const clearBtn = createFromTemplate('clearHistoryButtonTemplate', {
      text: { '': LABELS.CLEAR_ALL_HISTORY },
      attributes: { '': { id: ELEMENT_IDS.CLEAR_HISTORY_BTN } },
    });
    if (clearBtn) {
      clearButtonContainer.appendChild(clearBtn);
      addEventListenerSafely(ELEMENT_IDS.CLEAR_HISTORY_BTN, 'click', () => {
        vscode.postMessage({ command: COMMANDS.CLEAR_HISTORY });
      });
    }

    const sorted = [...historyItems].sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp),
    );
    sorted.forEach((item) => {
      historyContainer.appendChild(this._createHistoryItemElement(item));
    });

    this.setupItemEventListeners();
    this.applyToggleStates();
    this.searchManager.initialize(historyContainer);
  }

  _createHistoryItemElement(item) {
    const config = item.config;
    const date = new Date(item.timestamp).toLocaleString();

    const container = createFromTemplate('historyItemTemplate', {
      text: {
        '.history-timestamp': date,
        '.toggle-button': LABELS.SHOW_MORE,
      },
      attributes: {
        '.collapsible': { id: `content-${item.id}` },
        '.delete-btn': { title: 'Delete this history item' },
        '.restore-btn': { title: 'Load configuration to main view' },
        '.rerun-btn': { title: 'Execute this configuration' },
      },
      dataset: {
        '.delete-btn': { id: item.id, command: COMMANDS.DELETE_AGENT },
        '.restore-btn': { id: item.id, command: COMMANDS.RESTORE_AGENT },
        '.rerun-btn': { id: item.id, command: COMMANDS.RERUN_AGENT },
        '.toggle-button': { id: item.id },
      },
    });

    if (!container) return document.createElement('div');

    const basicDetails = container.querySelector('.basic-details');
    const collapsible = container.querySelector(`.${CLASS_NAMES.COLLAPSIBLE}`);
    const detailsContainer = container.querySelector('.extra-details');
    const toggleButton = container.querySelector(
      `.${CLASS_NAMES.TOGGLE_BUTTON}`,
    );

    if (!basicDetails || !collapsible || !detailsContainer || !toggleButton) {
      console.warn('[HistoryRenderer] Invalid history item template');
      return document.createElement('div');
    }

    const addBasic = (label, value) => {
      const row = createFromTemplate('basicDetailTemplate');
      if (!row) return;
      const labelEl = row.querySelector('.history-label');
      const valueEl = row.querySelector('.history-value');
      if (labelEl) labelEl.textContent = label;
      if (valueEl) valueEl.textContent = String(value);
      basicDetails.appendChild(row);
    };

    addBasic('Agent:', config.agent);
    addBasic('Model:', config.model);
    addBasic('Instruction:', config.instruction || 'None');

    const basicFileTypes = [
      { type: 'input', singular: 'InputFile', plural: 'InputFiles' },
      { type: 'media', singular: 'MediaFile', plural: 'MediaFiles' },
    ];
    basicFileTypes.forEach(({ type, singular, plural }) => {
      const single = config[`${type}File`];
      const multiple = config[`${type}Files`];
      if (single) {
        addBasic(`${singular}:`, single);
      } else if (type === 'input') {
        addBasic(`${singular}:`, 'None');
      }
      if (multiple && multiple.length > 0) {
        addBasic(`${plural}:`, multiple.join(', '));
      }
    });

    const addExtra = (label, value) => {
      const row = createFromTemplate('extraDetailTemplate');
      if (!row) return;
      const labelEl = row.querySelector('.history-label');
      const valueEl = row.querySelector('.history-value');
      if (labelEl) labelEl.textContent = label;
      if (valueEl) valueEl.textContent = String(value);
      detailsContainer.appendChild(row);
    };

    const extraFileTypes = [
      {
        type: 'reference',
        singular: 'ReferenceFile',
        plural: 'ReferenceFiles',
      },
      {
        type: 'auxiliary',
        singular: 'AuxiliaryFile',
        plural: 'AuxiliaryFiles',
      },
    ];
    extraFileTypes.forEach(({ type, singular, plural }) => {
      const single = config[`${type}File`];
      const multiple = config[`${type}Files`];
      if (single) {
        addExtra(`${singular}:`, single);
      }
      if (multiple && multiple.length > 0) {
        addExtra(`${plural}:`, multiple.join(', '));
      }
    });

    if (config.outputFiles && config.outputFiles.length > 0) {
      addExtra('Output Files:', config.outputFiles.join(', '));
    }

    if (config.toolConfig) {
      const configRow = this._renderToolConfig(
        '<i class="codicon codicon-tools"></i> Config',
        config.toolConfig,
      );
      if (configRow) detailsContainer.appendChild(configRow);
    }

    if (detailsContainer.childElementCount === 0) {
      collapsible.remove();
      toggleButton.remove();
    }

    return container;
  }

  _renderToolConfig(label, obj, exclude = []) {
    if (!obj) return null;
    const entries = Object.entries(obj).filter(([key, value]) => {
      if (exclude.includes(key)) return false;
      if (value == null) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    });
    if (entries.length === 0) return null;

    const row = createFromTemplate('extraDetailTemplate');
    if (!row) return null;
    const labelEl = row.querySelector('.history-label');
    const valueEl = row.querySelector('.history-value');
    if (labelEl) labelEl.innerHTML = label;
    if (!valueEl) return row;

    const section = document.createElement('div');
    section.className = 'config-section';
    entries.forEach(([key, value]) => {
      const item = document.createElement('div');
      item.className = 'config-item';
      const keySpan = document.createElement('span');
      keySpan.className = 'config-key';
      keySpan.textContent = `${key}:`;
      item.appendChild(keySpan);
      const display = Array.isArray(value)
        ? value.join(', ')
        : typeof value === 'boolean'
          ? value
            ? 'Yes'
            : 'No'
          : value;
      item.appendChild(document.createTextNode(display));
      section.appendChild(item);
    });
    valueEl.appendChild(section);
    return row;
  }

  setupItemEventListeners() {
    const container = safeGetElementById(ELEMENT_IDS.HISTORY_CONTAINER);
    if (!container) return;
    addEventListenerSafely(ELEMENT_IDS.HISTORY_CONTAINER, 'click', (e) => {
      const btn = e.target.closest('button[data-command]');
      if (btn) {
        const command = btn.dataset.command;
        const historyId = btn.getAttribute('data-id');
        vscode.postMessage({ command, historyId });
        return;
      }
      const toggle = e.target.closest(`.${CLASS_NAMES.TOGGLE_BUTTON}`);
      if (toggle) {
        const id = toggle.getAttribute('data-id');
        const content = safeGetElementById(`content-${id}`);
        if (!content) return;
        const expanded = content.classList.toggle(CLASS_NAMES.EXPANDED);
        toggle.textContent = expanded ? LABELS.SHOW_LESS : LABELS.SHOW_MORE;
        historyViewState.toggleStates.set(id, expanded);
      }
    });
  }

  applyToggleStates() {
    const entries = historyViewState.toggleStates.entries();
    for (const [id, expanded] of entries) {
      const content = document.getElementById(`content-${id}`);
      const toggle = document.querySelector(
        `.${CLASS_NAMES.TOGGLE_BUTTON}[data-id="${id}"]`,
      );
      if (content && toggle) {
        if (expanded) {
          content.classList.add(CLASS_NAMES.EXPANDED);
          toggle.textContent = LABELS.SHOW_LESS;
        } else {
          content.classList.remove(CLASS_NAMES.EXPANDED);
          toggle.textContent = LABELS.SHOW_MORE;
        }
      }
    }
  }
}
