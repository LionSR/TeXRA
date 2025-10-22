// Local imports - history view
import { COMMANDS, ELEMENT_IDS, CLASS_NAMES, LABELS } from '../constants.js';
import { historyViewState } from '../historyViewState.js';
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import { createFromTemplate, createCodicon } from '@common/templateUtils.js';
import { encodeHtml, encodeListForHtml } from '@common/htmlEncoding.js';
// Local imports
import { vscode } from '@common/webviewContext.js';

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
      historyContainer.innerHTML = `<div class="empty-state">${LABELS.EMPTY_STATE}</div>`;
      this.searchManager.initialize(historyContainer);
      return;
    }

    clearButtonContainer.innerHTML = `
      <vscode-button
        class="button-clear"
        id="${ELEMENT_IDS.CLEAR_HISTORY_BTN}"
        icon="trash"
      >
        ${LABELS.CLEAR_ALL_HISTORY}
      </vscode-button>
    `;
    addEventListenerSafely(ELEMENT_IDS.CLEAR_HISTORY_BTN, 'click', () => {
      vscode.postMessage({ command: COMMANDS.CLEAR_HISTORY });
    });

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
        '.delete-btn': {
          title: 'Delete this history item',
          'aria-label': 'Delete this history item',
        },
        '.restore-btn': {
          title: 'Load configuration to main view',
          'aria-label': 'Load configuration to main view',
        },
        '.rerun-btn': {
          title: 'Execute this configuration',
          'aria-label': 'Execute this configuration',
        },
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

    const encodedAgent = encodeHtml(config.agent);
    const encodedModel = encodeHtml(config.model);
    const encodedInstruction = config.instruction
      ? encodeHtml(config.instruction)
      : 'None';

    let basicHTML = `
      <span class="history-label">Agent:</span>
      <span class="history-value">${encodedAgent}</span>
      <span class="history-label">Model:</span>
      <span class="history-value">${encodedModel}</span>
      <span class="history-label">Instruction:</span>
      <span class="history-value">${encodedInstruction}</span>`;

    const basicFileTypes = [
      { type: 'input', singular: 'InputFile', plural: 'InputFiles' },
      { type: 'media', singular: 'MediaFile', plural: 'MediaFiles' },
    ];
    basicFileTypes.forEach(({ type, singular, plural }) => {
      const single = config[`${type}File`];
      const multiple = config[`${type}Files`];
      if (single) {
        const encodedSingle = encodeHtml(single);
        basicHTML += `
          <span class="history-label">${singular}:</span>
          <span class="history-value">${encodedSingle}</span>`;
      } else if (type === 'input') {
        basicHTML += `
          <span class="history-label">${singular}:</span>
          <span class="history-value">None</span>`;
      }
      if (multiple && multiple.length > 0) {
        const encodedMultiple = encodeListForHtml(multiple);
        basicHTML += `
          <span class="history-label">${plural}:</span>
          <span class="history-value">${encodedMultiple}</span>`;
      }
    });
    basicDetails.innerHTML = basicHTML;

    let detailsHTML = '';
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
        const encodedSingle = encodeHtml(single);
        detailsHTML += `
          <span class="history-label">${singular}:</span>
          <span class="history-value">${encodedSingle}</span>`;
      }
      if (multiple && multiple.length > 0) {
        const encodedMultiple = encodeListForHtml(multiple);
        detailsHTML += `
          <span class="history-label">${plural}:</span>
          <span class="history-value">${encodedMultiple}</span>`;
      }
    });

    if (config.outputFiles && config.outputFiles.length > 0) {
      const encodedOutputs = encodeListForHtml(config.outputFiles);
      detailsHTML += `
        <span class="history-label">Output Files:</span>
        <span class="history-value">${encodedOutputs}</span>`;
    }

    if (config.toolConfig) {
      const toolsIcon = createCodicon('tools');
      detailsHTML += this._renderToolConfig(
        `${toolsIcon ? toolsIcon.outerHTML : ''} Config`,
        config.toolConfig,
      );
    }

    if (detailsHTML) {
      detailsContainer.innerHTML = detailsHTML;
    } else {
      collapsible.remove();
      toggleButton.remove();
    }

    return container;
  }

  _renderToolConfig(label, obj, exclude = []) {
    if (!obj) return '';
    const entries = Object.entries(obj).filter(([key, value]) => {
      if (exclude.includes(key)) return false;
      if (value == null) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    });
    if (entries.length === 0) return '';
    let html = `
      <span class="history-label">${label}:</span>
      <div class="history-value config-section">`;
    entries.forEach(([key, value]) => {
      const encodedKey = encodeHtml(key);
      let display;
      let alreadyEncoded = false;

      if (Array.isArray(value)) {
        display = encodeListForHtml(value);
        alreadyEncoded = true;
      } else if (typeof value === 'boolean') {
        display = value ? 'Yes' : 'No';
      } else {
        display = encodeHtml(value);
        alreadyEncoded = true;
      }

      const safeDisplay = alreadyEncoded ? display : encodeHtml(display);
      html += `<div class="config-item"><span class="config-key">${encodedKey}:</span> ${safeDisplay}</div>`;
    });
    html += `</div>`;
    return html;
  }

  setupItemEventListeners() {
    const container = safeGetElementById(ELEMENT_IDS.HISTORY_CONTAINER);
    if (!container) return;
    addEventListenerSafely(ELEMENT_IDS.HISTORY_CONTAINER, 'click', (e) => {
      const btn = e.target.closest('[data-command]');
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
