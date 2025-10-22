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

    clearButtonContainer.innerHTML = `<vscode-button class="button-clear" id="${ELEMENT_IDS.CLEAR_HISTORY_BTN}">${LABELS.CLEAR_ALL_HISTORY}</vscode-button>`;
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
      },
      attributes: {
        '.history-collapsible': { heading: LABELS.MORE_DETAILS },
        '.delete-btn': { title: 'Delete this history item' },
        '.restore-btn': { title: 'Load configuration to main view' },
        '.rerun-btn': { title: 'Execute this configuration' },
      },
      dataset: {
        '.history-collapsible': { id: item.id },
        '.delete-btn': { id: item.id, command: COMMANDS.DELETE_AGENT },
        '.restore-btn': { id: item.id, command: COMMANDS.RESTORE_AGENT },
        '.rerun-btn': { id: item.id, command: COMMANDS.RERUN_AGENT },
      },
    });

    if (!container) return document.createElement('div');

    const basicDetails = container.querySelector('.basic-details');
    const collapsible = container.querySelector(
      `.${CLASS_NAMES.HISTORY_COLLAPSIBLE}`,
    );
    const detailsContainer = container.querySelector('.extra-details');

    if (!basicDetails || !collapsible || !detailsContainer) {
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
    });

    const collapsibles = container.querySelectorAll(
      `.${CLASS_NAMES.HISTORY_COLLAPSIBLE}`,
    );
    collapsibles.forEach((element) => {
      if (!(element instanceof HTMLElement)) {
        return;
      }
      if (element.dataset.toggleListenerAttached === 'true') {
        return;
      }
      element.dataset.toggleListenerAttached = 'true';
      addEventListenerSafely(element, 'vsc-collapsible-toggle', (event) => {
        const id = element.dataset.id;
        if (!id) return;
        const detail = event?.detail;
        const isOpen =
          typeof detail?.open === 'boolean'
            ? detail.open
            : element.hasAttribute('open');
        historyViewState.toggleStates.set(id, isOpen);
      });
    });
  }

  applyToggleStates() {
    const entries = historyViewState.toggleStates.entries();
    for (const [id, expanded] of entries) {
      const collapsible = document.querySelector(
        `.${CLASS_NAMES.HISTORY_COLLAPSIBLE}[data-id="${id}"]`,
      );
      if (!collapsible) {
        continue;
      }
      if ('open' in collapsible) {
        collapsible.open = Boolean(expanded);
      }
      if (expanded) {
        collapsible.setAttribute('open', '');
      } else {
        collapsible.removeAttribute('open');
      }
    }
  }
}
