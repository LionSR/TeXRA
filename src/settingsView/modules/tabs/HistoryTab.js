/**
 * History Tab
 */
import { vscode } from '@common/webviewContext.js';
import { settingsViewState } from '../settingsViewState.js';
import { SETTINGS_VIEW_COMMANDS, ELEMENT_IDS } from '../constants.js';

export class HistoryTab {
  constructor() {
    this._elements = null;
    this._searchMatches = [];
    this._searchIndex = 0;
  }

  initialize() {
    this._elements = {
      historyList: document.getElementById(ELEMENT_IDS.HISTORY_LIST),
      historySearch: document.getElementById(ELEMENT_IDS.HISTORY_SEARCH),
      clearHistoryBtn: document.getElementById(ELEMENT_IDS.CLEAR_HISTORY_BTN),
      noHistoryMessage: document.getElementById(ELEMENT_IDS.NO_HISTORY_MESSAGE),
      searchCount: document.getElementById('searchCount'),
      searchPrev: document.getElementById('searchPrev'),
      searchNext: document.getElementById('searchNext'),
    };

    this.attachEventListeners();
  }

  attachEventListeners() {
    const {
      historyList,
      historySearch,
      clearHistoryBtn,
      searchPrev,
      searchNext,
    } = this._elements;

    if (historyList) {
      historyList.addEventListener('click', (e) => {
        this.handleHistoryAction(e);
      });
    }

    if (historySearch) {
      historySearch.addEventListener('input', () => {
        this.handleSearch(historySearch.value);
      });
    }

    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener('click', () => {
        this.clearHistory();
      });
    }

    if (searchPrev) {
      searchPrev.addEventListener('click', () => {
        this.navigateSearch(-1);
      });
    }

    if (searchNext) {
      searchNext.addEventListener('click', () => {
        this.navigateSearch(1);
      });
    }
  }

  handleHistoryAction(event) {
    const btn = event.target.closest('vscode-button');
    if (!btn) return;

    const historyItem = btn.closest('.history-item');
    if (!historyItem) return;

    const historyId = historyItem.dataset.id;
    if (!historyId) return;

    if (btn.classList.contains('rerun-btn')) {
      vscode.postMessage({
        command: SETTINGS_VIEW_COMMANDS.RERUN_AGENT,
        historyId,
      });
    } else if (btn.classList.contains('restore-btn')) {
      vscode.postMessage({
        command: SETTINGS_VIEW_COMMANDS.RESTORE_AGENT,
        historyId,
      });
    } else if (btn.classList.contains('delete-btn')) {
      vscode.postMessage({
        command: SETTINGS_VIEW_COMMANDS.DELETE_HISTORY_ITEM,
        historyId,
      });
      // Optimistically remove from UI
      historyItem.remove();
      settingsViewState.removeHistoryItem(historyId);
      this.updateEmptyState();
    }
  }

  handleSearch(query) {
    const { historyList, searchCount, searchPrev, searchNext } = this._elements;
    if (!historyList) return;

    const items = historyList.querySelectorAll('.history-item');

    // Reset all items visibility
    items.forEach((item) => {
      item.classList.remove('search-match', 'search-current');
      item.style.display = '';
    });

    if (!query || query.trim() === '') {
      this._searchMatches = [];
      this._searchIndex = 0;
      if (searchCount) searchCount.textContent = '0 matches';
      if (searchPrev) searchPrev.disabled = true;
      if (searchNext) searchNext.disabled = true;
      return;
    }

    const lowerQuery = query.toLowerCase();
    this._searchMatches = [];

    items.forEach((item) => {
      const text = item.textContent.toLowerCase();
      if (text.includes(lowerQuery)) {
        item.classList.add('search-match');
        this._searchMatches.push(item);
      } else {
        item.style.display = 'none';
      }
    });

    this._searchIndex = 0;
    this.updateSearchUI();

    // Highlight first match
    if (this._searchMatches.length > 0) {
      this._searchMatches[0].classList.add('search-current');
      this._searchMatches[0].scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }

  navigateSearch(direction) {
    if (this._searchMatches.length === 0) return;

    // Remove current highlight
    this._searchMatches[this._searchIndex]?.classList.remove('search-current');

    // Update index
    this._searchIndex += direction;
    if (this._searchIndex < 0) {
      this._searchIndex = this._searchMatches.length - 1;
    } else if (this._searchIndex >= this._searchMatches.length) {
      this._searchIndex = 0;
    }

    // Add new highlight
    const current = this._searchMatches[this._searchIndex];
    current.classList.add('search-current');
    current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    this.updateSearchUI();
  }

  updateSearchUI() {
    const { searchCount, searchPrev, searchNext } = this._elements;

    if (searchCount) {
      if (this._searchMatches.length === 0) {
        searchCount.textContent = '0 matches';
      } else {
        searchCount.textContent = `${this._searchIndex + 1} of ${this._searchMatches.length}`;
      }
    }

    const hasMatches = this._searchMatches.length > 1;
    if (searchPrev) searchPrev.disabled = !hasMatches;
    if (searchNext) searchNext.disabled = !hasMatches;
  }

  clearHistory() {
    vscode.postMessage({
      command: SETTINGS_VIEW_COMMANDS.CLEAR_HISTORY,
    });
  }

  render(state) {
    this.renderHistoryItems(state.historyItems);
    this.updateEmptyState();
  }

  renderHistoryItems(items) {
    const { historyList } = this._elements;
    if (!historyList) return;

    if (!items || items.length === 0) {
      historyList.innerHTML = '';
      return;
    }

    const template = document.getElementById('historyItemTemplate');
    if (!template) {
      historyList.innerHTML = this.renderHistoryItemsSimple(items);
      return;
    }

    historyList.innerHTML = '';
    items.forEach((item) => {
      const itemEl = template.content.cloneNode(true).firstElementChild;
      this.populateHistoryItem(itemEl, item);
      historyList.appendChild(itemEl);
    });
  }

  getFirstFile(files, fallbackSingle) {
    // Handle both array (inputFiles/outputFiles) and singular (inputFile/outputFile) formats
    if (Array.isArray(files) && files.length > 0) return files[0];
    if (fallbackSingle) return fallbackSingle;
    return null;
  }

  renderHistoryItemsSimple(items) {
    return items
      .map((item) => {
        const inputFile = this.getFirstFile(item.inputFiles, item.inputFile);
        const outputFile = this.getFirstFile(item.outputFiles, item.outputFile);
        return `
      <div class="history-item" data-id="${item.id}">
        <div class="history-item-header">
          <span class="history-timestamp">${this.formatDate(item.timestamp)}</span>
          <div class="history-actions">
            <vscode-button appearance="icon" class="delete-btn" title="Delete">
              <span class="codicon codicon-trash"></span>
            </vscode-button>
            <vscode-button appearance="secondary" class="restore-btn">Restore</vscode-button>
            <vscode-button appearance="primary" class="rerun-btn">Run</vscode-button>
          </div>
        </div>
        <div class="history-item-body">
          <span class="history-agent">${item.agentName}</span>
          <span class="separator">-</span>
          <span class="history-model">${item.modelName}</span>
        </div>
        ${
          inputFile || outputFile
            ? `
          <div class="history-item-files">
            ${inputFile ? `<span class="history-input">${this.shortenPath(inputFile)}</span>` : ''}
            ${inputFile && outputFile ? '<span class="codicon codicon-arrow-right"></span>' : ''}
            ${outputFile ? `<span class="history-output">${this.shortenPath(outputFile)}</span>` : ''}
          </div>
        `
            : ''
        }
        ${
          item.instruction
            ? `
          <details class="history-details settings-details">
            <summary>Show details</summary>
            <div class="history-instruction">${this.escapeHtml(item.instruction)}</div>
          </details>
        `
            : ''
        }
      </div>
    `;
      })
      .join('');
  }

  populateHistoryItem(itemEl, item) {
    itemEl.dataset.id = item.id;
    itemEl.querySelector('.history-timestamp').textContent = this.formatDate(
      item.timestamp,
    );
    itemEl.querySelector('.history-agent').textContent = item.agentName;
    itemEl.querySelector('.history-model').textContent = item.modelName;

    const inputFile = this.getFirstFile(item.inputFiles, item.inputFile);
    const outputFile = this.getFirstFile(item.outputFiles, item.outputFile);

    const inputEl = itemEl.querySelector('.history-input');
    const outputEl = itemEl.querySelector('.history-output');
    const filesEl = itemEl.querySelector('.history-item-files');

    if (inputEl && inputFile) {
      inputEl.textContent = this.shortenPath(inputFile);
    }
    if (outputEl && outputFile) {
      outputEl.textContent = this.shortenPath(outputFile);
    }
    if (filesEl && !inputFile && !outputFile) {
      filesEl.style.display = 'none';
    }

    const instructionEl = itemEl.querySelector('.history-instruction');
    const detailsEl = itemEl.querySelector('.history-details');
    if (instructionEl && item.instruction) {
      instructionEl.textContent = item.instruction;
    } else if (detailsEl && !item.instruction) {
      detailsEl.style.display = 'none';
    }
  }

  updateEmptyState() {
    const { historyList, noHistoryMessage, clearHistoryBtn } = this._elements;
    if (!noHistoryMessage) return;

    const hasItems = historyList && historyList.children.length > 0;
    noHistoryMessage.style.display = hasItems ? 'none' : 'flex';
    if (clearHistoryBtn) {
      clearHistoryBtn.disabled = !hasItems;
    }
  }

  formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  shortenPath(filePath) {
    if (!filePath) return '';
    const parts = filePath.split(/[/\\]/);
    if (parts.length <= 2) return filePath;
    return `.../${parts.slice(-2).join('/')}`;
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
