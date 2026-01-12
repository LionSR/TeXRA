/**
 * Memory Tab
 */
import { vscode } from '@common/webviewContext.js';
import { settingsViewState } from '../settingsViewState.js';
import { SETTINGS_VIEW_COMMANDS, ELEMENT_IDS } from '../constants.js';

export class MemoryTab {
  constructor() {
    this._elements = null;
  }

  initialize() {
    this._elements = {
      memoryFilesList: document.getElementById(ELEMENT_IDS.MEMORY_FILES_LIST),
      refreshMemoryBtn: document.getElementById(ELEMENT_IDS.REFRESH_MEMORY_BTN),
      memoryStats: document.getElementById(ELEMENT_IDS.MEMORY_STATS),
      clearAllMemoryBtn: document.getElementById('clearAllMemoryBtn'),
    };

    this.attachEventListeners();
  }

  attachEventListeners() {
    const { refreshMemoryBtn, clearAllMemoryBtn, memoryFilesList } = this._elements;

    if (refreshMemoryBtn) {
      refreshMemoryBtn.addEventListener('click', () => {
        vscode.postMessage({ command: SETTINGS_VIEW_COMMANDS.REFRESH_MEMORY });
      });
    }

    if (clearAllMemoryBtn) {
      clearAllMemoryBtn.addEventListener('click', () => {
        this.clearAllMemory();
      });
    }

    if (memoryFilesList) {
      memoryFilesList.addEventListener('click', (e) => {
        this.handleMemoryAction(e);
      });
    }
  }

  handleMemoryAction(event) {
    const btn = event.target.closest('vscode-button');
    if (!btn) return;

    const memoryFileEl = btn.closest('.memory-file');
    if (!memoryFileEl) return;

    const filePath = memoryFileEl.dataset.path;
    if (!filePath) return;

    if (btn.classList.contains('view-full-btn')) {
      vscode.postMessage({
        command: SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FILE,
        path: filePath,
      });
    } else if (btn.classList.contains('delete-memory-btn')) {
      this.deleteMemoryFile(filePath);
    }
  }

  deleteMemoryFile(filePath) {
    vscode.postMessage({
      command: SETTINGS_VIEW_COMMANDS.DELETE_MEMORY,
      path: filePath,
    });
  }

  clearAllMemory() {
    // Confirm before clearing
    const files = settingsViewState.memoryFiles;
    if (files.length === 0) return;

    // Delete all files
    files.forEach((file) => {
      vscode.postMessage({
        command: SETTINGS_VIEW_COMMANDS.DELETE_MEMORY,
        path: file.path,
      });
    });
  }

  render(state) {
    this.renderMemoryFiles(state.memoryFiles);
    this.updateStats(state.memoryFiles);
  }

  renderMemoryFiles(files) {
    const { memoryFilesList, clearAllMemoryBtn } = this._elements;
    if (!memoryFilesList) return;

    if (!files || files.length === 0) {
      memoryFilesList.innerHTML = `
        <div class="empty-state">
          <span class="codicon codicon-folder-opened"></span>
          <p>No memory files yet</p>
          <p class="help-text">Memory files are created by tool-use agents during conversations.</p>
        </div>
      `;
      if (clearAllMemoryBtn) {
        clearAllMemoryBtn.disabled = true;
      }
      return;
    }

    if (clearAllMemoryBtn) {
      clearAllMemoryBtn.disabled = false;
    }

    const template = document.getElementById('memoryFileTemplate');
    if (!template) {
      memoryFilesList.innerHTML = this.renderMemoryFilesSimple(files);
      return;
    }

    memoryFilesList.innerHTML = '';
    files.forEach((file) => {
      const item = template.content.cloneNode(true).firstElementChild;
      this.populateMemoryFileItem(item, file);
      memoryFilesList.appendChild(item);
    });
  }

  renderMemoryFilesSimple(files) {
    return files.map((file) => `
      <div class="memory-file" data-path="${file.path}">
        <div class="memory-file-header">
          <span class="codicon codicon-file"></span>
          <span class="memory-file-name">${file.name}</span>
          <span class="memory-file-size">${this.formatSize(file.size)}</span>
          <span class="memory-file-date">${this.formatDate(file.modified)}</span>
        </div>
        <div class="memory-actions">
          <vscode-button appearance="secondary" class="view-full-btn">View</vscode-button>
          <vscode-button appearance="secondary" class="delete-memory-btn">Delete</vscode-button>
        </div>
      </div>
    `).join('');
  }

  populateMemoryFileItem(item, file) {
    item.dataset.path = file.path;
    item.querySelector('.memory-file-name').textContent = file.name;
    item.querySelector('.memory-file-size').textContent = this.formatSize(file.size);
    item.querySelector('.memory-file-date').textContent = this.formatDate(file.modified);

    // Load preview if available
    if (file.preview) {
      const preview = item.querySelector('.memory-preview');
      if (preview) {
        preview.textContent = file.preview;
      }
    }
  }

  updateStats(files) {
    const { memoryStats } = this._elements;
    if (!memoryStats) return;

    if (!files || files.length === 0) {
      memoryStats.textContent = 'Total: 0 files, 0 KB';
      return;
    }

    const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
    memoryStats.textContent = `Total: ${files.length} file${files.length !== 1 ? 's' : ''}, ${this.formatSize(totalSize)}`;
  }

  formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
  }

  formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
