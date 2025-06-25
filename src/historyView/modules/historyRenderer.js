// Local imports
import { vscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import { historyViewState } from './historyViewState.js';

/**
 * Renders history items and manages per-item events.
 */
export class HistoryRenderer {
  constructor(searchManager) {
    this.searchManager = searchManager;
  }

  /** Render list of history items */
  render(historyItems) {
    const historyContainer = safeGetElementById('historyContainer');
    const clearButtonContainer = safeGetElementById('clearButtonContainer');
    if (!historyContainer || !clearButtonContainer) return;

    historyContainer.innerHTML = '';
    clearButtonContainer.innerHTML = '';

    if (!historyItems || historyItems.length === 0) {
      historyContainer.innerHTML =
        '<div class="empty-state">No history items found</div>';
      this.searchManager.initialize(historyContainer);
      return;
    }

    clearButtonContainer.innerHTML =
      '<button class="vscode-button button-clear" id="clearHistoryBtn">Clear All History</button>';
    addEventListenerSafely('clearHistoryBtn', 'click', () => {
      vscode.postMessage({ command: 'clearHistory' });
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

    const container = document.createElement('div');
    container.className = 'history-item';

    const header = document.createElement('div');
    header.className = 'history-item-header';
    header.innerHTML = `
      <div class="history-timestamp">${date}</div>
      <div class="history-actions button-group">
        <button class="vscode-button delete-btn" data-id="${item.id}" data-command="deleteAgent" title="Delete this history item">
          <i class="codicon codicon-trash"></i>
        </button>
        <button class="vscode-button restore-btn" data-id="${item.id}" data-command="restoreAgent" title="Load configuration to main view">
          <i class="codicon codicon-reply"></i>
        </button>
        <button class="vscode-button rerun-btn" data-id="${item.id}" data-command="rerunAgent" title="Execute this configuration">
          <i class="codicon codicon-debug-rerun"></i>
        </button>
      </div>`;

    const basicDetails = document.createElement('div');
    basicDetails.className = 'history-details';
    let basicHTML = `
      <span class="history-label">Agent:</span>
      <span class="history-value">${config.agent}</span>
      <span class="history-label">Model:</span>
      <span class="history-value">${config.model}</span>
      <span class="history-label">Instruction:</span>
      <span class="history-value">${config.instruction || 'None'}</span>`;

    const basicFileTypes = [
      { type: 'input', singular: 'InputFile', plural: 'InputFiles' },
      { type: 'media', singular: 'MediaFile', plural: 'MediaFiles' },
    ];
    basicFileTypes.forEach(({ type, singular, plural }) => {
      const single = config[`${type}File`];
      const multiple = config[`${type}Files`];
      if (single) {
        basicHTML += `
          <span class="history-label">${singular}:</span>
          <span class="history-value">${single}</span>`;
      } else if (type === 'input') {
        basicHTML += `
          <span class="history-label">${singular}:</span>
          <span class="history-value">None</span>`;
      }
      if (multiple && multiple.length > 0) {
        basicHTML += `
          <span class="history-label">${plural}:</span>
          <span class="history-value">${multiple.join(', ')}</span>`;
      }
    });
    basicDetails.innerHTML = basicHTML;

    const collapsible = document.createElement('div');
    collapsible.className = 'collapsible';
    collapsible.id = `content-${item.id}`;

    const detailsContainer = document.createElement('div');
    detailsContainer.className = 'history-details';

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
        detailsHTML += `
          <span class="history-label">${singular}:</span>
          <span class="history-value">${single}</span>`;
      }
      if (multiple && multiple.length > 0) {
        detailsHTML += `
          <span class="history-label">${plural}:</span>
          <span class="history-value">${multiple.join(', ')}</span>`;
      }
    });

    if (config.outputFiles && config.outputFiles.length > 0) {
      detailsHTML += `
        <span class="history-label">Output Files:</span>
        <span class="history-value">${config.outputFiles.join(', ')}</span>`;
    }

    if (config.toolConfig) {
      detailsHTML += this._renderToolConfig(
        '<i class="codicon codicon-tools"></i> Config',
        config.toolConfig,
      );
    }

    if (detailsHTML) {
      detailsContainer.innerHTML = detailsHTML;
      collapsible.appendChild(detailsContainer);
      const toggleButton = document.createElement('button');
      toggleButton.className = 'toggle-button';
      toggleButton.setAttribute('data-id', item.id);
      toggleButton.textContent = 'Show more';
      container.appendChild(header);
      container.appendChild(basicDetails);
      container.appendChild(collapsible);
      container.appendChild(toggleButton);
    } else {
      container.appendChild(header);
      container.appendChild(basicDetails);
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
      const display = Array.isArray(value)
        ? value.join(', ')
        : typeof value === 'boolean'
          ? value
            ? 'Yes'
            : 'No'
          : value;
      html += `<div class="config-item"><span class="config-key">${key}:</span> ${display}</div>`;
    });
    html += `</div>`;
    return html;
  }

  setupItemEventListeners() {
    const container = safeGetElementById('historyContainer');
    if (!container) return;
    addEventListenerSafely('historyContainer', 'click', (e) => {
      const btn = e.target.closest('button[data-command]');
      if (btn) {
        const command = btn.dataset.command;
        const historyId = btn.getAttribute('data-id');
        vscode.postMessage({ command, historyId });
        return;
      }
      const toggle = e.target.closest('.toggle-button');
      if (toggle) {
        const id = toggle.getAttribute('data-id');
        const content = safeGetElementById(`content-${id}`);
        if (!content) return;
        const expanded = content.classList.toggle('expanded');
        toggle.textContent = expanded ? 'Show less' : 'Show more';
        historyViewState.toggleStates.set(id, expanded);
      }
    });
  }

  applyToggleStates() {
    const entries = historyViewState.toggleStates.entries();
    for (const [id, expanded] of entries) {
      const content = document.getElementById(`content-${id}`);
      const toggle = document.querySelector(`.toggle-button[data-id="${id}"]`);
      if (content && toggle) {
        if (expanded) {
          content.classList.add('expanded');
          toggle.textContent = 'Show less';
        } else {
          content.classList.remove('expanded');
          toggle.textContent = 'Show more';
        }
      }
    }
  }
}
