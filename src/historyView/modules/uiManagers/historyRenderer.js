// Local imports
import { vscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import { historyViewState } from '../historyViewState.js';
import { renderTemplate } from '@common/templateUtils.js';

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
      const empty = renderTemplate('emptyStateTemplate');
      if (empty) {
        empty.textContent = 'No history items found';
        historyContainer.appendChild(empty);
      }
      this.searchManager.initialize(historyContainer);
      return;
    }

    const clearBtn = renderTemplate('clearHistoryButtonTemplate');
    if (clearBtn) {
      clearButtonContainer.appendChild(clearBtn);
      addEventListenerSafely('clearHistoryBtn', 'click', () => {
        vscode.postMessage({ command: 'clearHistory' });
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

    const container = renderTemplate('historyItemTemplate');
    if (!container) return document.createElement('div');

    const headerTimestamp = container.querySelector('.history-timestamp');
    if (headerTimestamp) headerTimestamp.textContent = date;
    const delBtn = container.querySelector('.delete-btn');
    if (delBtn) {
      delBtn.dataset.id = item.id;
      delBtn.dataset.command = 'deleteAgent';
    }
    const restoreBtn = container.querySelector('.restore-btn');
    if (restoreBtn) {
      restoreBtn.dataset.id = item.id;
      restoreBtn.dataset.command = 'restoreAgent';
    }
    const rerunBtn = container.querySelector('.rerun-btn');
    if (rerunBtn) {
      rerunBtn.dataset.id = item.id;
      rerunBtn.dataset.command = 'rerunAgent';
    }

    const basicDetails = container.querySelector('.basic-details');
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

    const collapsible = container.querySelector('.collapsible');
    if (collapsible) {
      collapsible.id = `content-${item.id}`;
    }

    const detailsContainer = container.querySelector('.details-container');

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

    const toggleButton = container.querySelector('.toggle-button');

    if (detailsHTML && detailsContainer && collapsible && toggleButton) {
      detailsContainer.innerHTML = detailsHTML;
      collapsible.appendChild(detailsContainer);
      toggleButton.dataset.id = item.id;
      toggleButton.textContent = 'Show more';
    } else {
      collapsible?.remove();
      toggleButton?.remove();
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
