// Local imports - history view
import {
  COMMANDS,
  ELEMENT_IDS,
  CLASS_NAMES,
  LABELS,
  AGENT_CATEGORY,
} from '../constants.js';
import { historyViewState } from '../historyViewState.js';
import {
  addEventListenerSafely,
  safeGetElementById,
  clearElement,
} from '@common/domUtils.js';
import { createFromTemplate, createCodicon } from '@common/templateUtils.js';
import { encodeHtml, encodeListForHtml } from '@common/htmlEncoding.js';
import { getAgentCategoryDecorator } from '@common/iconConstants.js';
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

    clearElement(historyContainer);
    clearElement(clearButtonContainer);

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
    // Use agentConfig as primary (consistent with TaskState), with fallback for legacy data
    const config = item.agentConfig || item.config;
    const date = new Date(item.timestamp).toLocaleString();

    // Determine agent category display
    const isToolUse = config?.agentCategory === AGENT_CATEGORY.TOOL_USE;
    const category = isToolUse ? 'toolUse' : 'workflow';
    const { icon: categoryIcon, label: categoryLabel } =
      getAgentCategoryDecorator(category);
    const categoryClass = isToolUse ? 'category-tool-use' : 'category-workflow';

    const container = createFromTemplate('historyItemTemplate', {
      text: {
        '.history-timestamp': date,
      },
      attributes: {
        '.collapsible': { heading: LABELS.MORE_DETAILS },
        '.delete-btn': { title: 'Delete this history item' },
        '.restore-btn': { title: 'Load configuration to main view' },
        '.rerun-btn': { title: 'Execute this configuration' },
      },
      dataset: {
        '.collapsible': { id: item.id },
        '.delete-btn': { id: item.id, command: COMMANDS.DELETE_AGENT },
        '.restore-btn': { id: item.id, command: COMMANDS.RESTORE_AGENT },
        '.rerun-btn': { id: item.id, command: COMMANDS.RERUN_AGENT },
      },
    });

    if (!container) return document.createElement('div');

    const basicDetails = container.querySelector('.basic-details');
    const collapsible = container.querySelector(`.${CLASS_NAMES.COLLAPSIBLE}`);
    const detailsContainer = container.querySelector('.extra-details');

    if (!basicDetails || !collapsible || !detailsContainer) {
      console.warn('[HistoryRenderer] Invalid history item template');
      return document.createElement('div');
    }

    const encodedAgent = encodeHtml(config?.agent || 'Unknown');
    const encodedModel = encodeHtml(config?.model || 'Unknown');
    // Instruction is a primary field shown prominently, so it gets "Not set" indicator when empty.
    // Optional fields like reference/auxiliary files are in the collapsible section and can be omitted.
    const instructionText = config?.instruction;
    const encodedInstruction =
      instructionText && instructionText.trim()
        ? encodeHtml(instructionText)
        : '<em class="history-none">Not set</em>';

    // Build agent category badge with icon
    const categoryIconEl = createCodicon(categoryIcon);
    const categoryIconHtml = categoryIconEl ? categoryIconEl.outerHTML : '';

    let basicHTML = `
      <span class="history-label">Category:</span>
      <span class="history-value"><span class="badge agent-category-badge ${categoryClass}">${categoryIconHtml} ${categoryLabel}</span></span>
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

    // Only show toolConfig for workflow agents - these options don't apply to tool-use agents
    if (config.toolConfig && !isToolUse) {
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
      const display = this._formatConfigValue(value);
      html += `<div class="config-item"><span class="config-key">${encodedKey}:</span> ${display}</div>`;
    });
    html += `</div>`;
    return html;
  }

  /**
   * Format a config value for display, handling different types.
   * @private
   */
  _formatConfigValue(value) {
    if (Array.isArray(value)) {
      return encodeListForHtml(value);
    }
    if (typeof value === 'boolean') {
      return value ? 'Yes' : 'No';
    }
    return encodeHtml(value);
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
      `.${CLASS_NAMES.COLLAPSIBLE}`,
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
    for (const [id, expanded] of historyViewState.toggleStates.entries()) {
      const collapsible = document.querySelector(
        `.${CLASS_NAMES.COLLAPSIBLE}[data-id="${id}"]`,
      );
      if (!collapsible) continue;

      // vscode-collapsible has reflect:true on open property - setting .open syncs the attribute
      if ('open' in collapsible) {
        collapsible.open = Boolean(expanded);
      }
    }
  }
}
