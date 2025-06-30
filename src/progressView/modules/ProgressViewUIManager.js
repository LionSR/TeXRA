import { progressViewState } from './progressViewState.js';
import { COMMANDS, STATUS } from './constants.js';
import { vscode } from '@common/webviewContext.js';

/**
 * Consolidated UI manager for progress view components
 */
export class ProgressViewUIManager {
  constructor() {
    this.streamTabs = new StreamTabsManager();
    this.status = new StatusManager();
    this.fileList = new FileListManager();
    this.toolbar = new ToolbarManager();
    this.usageSummary = new UsageSummaryManager();
  }

  /**
   * Coordinated update of all UI components
   */
  updateAll(state) {
    this.streamTabs.update(state.streams, state.activeStream);
    this.status.update(state.status);
    this.fileList.update(state.files);
    this.toolbar.updateButtons(state.activeStream, state.status);
    this.usageSummary.update(state.usage);
  }

  // Delegate methods for specific updates
  updateStreamTabs(streams, activeStream) {
    this.streamTabs.update(streams, activeStream);
  }

  updateStatus(status) {
    this.status.update(status);
  }

  updateFiles(files) {
    this.fileList.update(files);
  }

  updateUsage(usage) {
    this.usageSummary.update(usage);
  }

  updateToolbar(activeStream, status) {
    this.toolbar.updateButtons(activeStream, status);
  }
}

/**
 * Manages stream tab UI
 */
class StreamTabsManager {
  update(streams, activeStream) {
    if (!Array.isArray(streams)) {
      console.error('StreamTabsManager.update: streams must be an array');
      return;
    }

    const tabsContainer = document.getElementById('streamTabs');
    if (!tabsContainer) {
      console.error('StreamTabsManager.update: streamTabs container not found');
      return;
    }

    tabsContainer.innerHTML = streams
      .map((stream) => this.createTabHTML(stream, activeStream))
      .join('');

    this.updateActiveStreamName(activeStream);
  }

  createTabHTML(stream, activeStream) {
    const isActive = stream === activeStream;
    return `
      <div class="tab-container ${isActive ? 'active' : ''}" title="${stream}">
        <button class="tab" data-stream="${stream}" title="${stream}">${stream}</button>
        <button class="tab-delete" data-stream="${stream}" title="Delete stream">
          <i class="codicon codicon-close"></i>
        </button>
      </div>
    `;
  }

  updateActiveStreamName(activeStream) {
    const streamNameElem = document.getElementById('activeStreamName');
    if (streamNameElem) {
      streamNameElem.textContent = activeStream || '';
    }
  }
}

/**
 * Manages status display
 */
class StatusManager {
  update(status) {
    const statusElement = document.getElementById('status');
    if (!statusElement) return;

    // Remove all status classes
    statusElement.className = statusElement.className
      .split(' ')
      .filter((cls) => !cls.startsWith('status-'))
      .join(' ');

    // Add current status class
    statusElement.classList.add(`status-${status}`);
    statusElement.textContent = this.getStatusText(status);
  }

  getStatusText(status) {
    const statusTexts = {
      [STATUS.RUNNING]: 'Running...',
      [STATUS.ERROR]: 'Error',
      [STATUS.STOPPED]: 'Stopped',
      [STATUS.READY]: 'Ready',
    };
    return statusTexts[status] || status;
  }
}

/**
 * Manages file list display
 */
class FileListManager {
  update(files) {
    const fileListElement = document.getElementById('fileList');
    if (!fileListElement) return;

    fileListElement.innerHTML = '';

    Object.entries(files || {}).forEach(([round, roundFiles]) => {
      if (roundFiles && roundFiles.length > 0) {
        const roundElement = this.createRoundElement(round, roundFiles);
        fileListElement.appendChild(roundElement);
      }
    });
  }

  createRoundElement(round, files) {
    const roundDiv = document.createElement('div');
    roundDiv.className = 'file-round';
    roundDiv.innerHTML = `
      <div class="round-header">Round ${round}</div>
      <div class="round-files">
        ${files.map((file) => this.createFileElement(file)).join('')}
      </div>
    `;
    return roundDiv;
  }

  createFileElement(file) {
    return `
      <div class="file-item" data-path="${file.path}">
        <span class="file-name">${file.name}</span>
        <div class="file-actions">
          <button class="file-action" data-action="open" data-file="${file.path}" title="Open file">
            <i class="codicon codicon-go-to-file"></i>
          </button>
          <button class="file-action" data-action="compare" data-base="${file.original}" data-file="${file.path}" title="Compare with original">
            <i class="codicon codicon-diff"></i>
          </button>
          <button class="file-action" data-action="accept" data-base="${file.original}" data-file="${file.path}" title="Accept changes">
            <i class="codicon codicon-check"></i>
          </button>
        </div>
      </div>
    `;
  }
}

/**
 * Manages toolbar state
 */
class ToolbarManager {
  updateButtons(activeStream, status) {
    const hasActiveStream = Boolean(activeStream);
    const isRunning = status === STATUS.RUNNING;

    // Update button states based on stream and status
    this.updateButtonState('stopStreamBtn', hasActiveStream && isRunning);
    this.updateButtonState('runAgainBtn', hasActiveStream && !isRunning);
    this.updateButtonState('restoreStateBtn', hasActiveStream);
    this.updateButtonState('diffStreamBtn', hasActiveStream && !isRunning);
    this.updateButtonState('packStreamBtn', hasActiveStream && !isRunning);
    this.updateButtonState('cleanStreamBtn', hasActiveStream && !isRunning);
    this.updateButtonState('eraseStreamBtn', hasActiveStream);
  }

  updateButtonState(buttonId, enabled) {
    const button = document.getElementById(buttonId);
    if (button) {
      button.disabled = !enabled;
      button.classList.toggle('disabled', !enabled);
    }
  }
}

/**
 * Manages usage summary display
 */
class UsageSummaryManager {
  update(usage) {
    const summaryElement = document.getElementById('usageSummary');
    if (!summaryElement || !usage) return;

    summaryElement.innerHTML = `
      <div class="usage-item">
        <span class="usage-label">Input Tokens:</span>
        <span class="usage-value">${usage.inputTokens || 0}</span>
      </div>
      <div class="usage-item">
        <span class="usage-label">Output Tokens:</span>
        <span class="usage-value">${usage.outputTokens || 0}</span>
      </div>
      <div class="usage-item">
        <span class="usage-label">Total Cost:</span>
        <span class="usage-value">$${(usage.totalCost || 0).toFixed(4)}</span>
      </div>
    `;
  }
}

// Export singleton instance
export const progressViewUIManager = new ProgressViewUIManager();
