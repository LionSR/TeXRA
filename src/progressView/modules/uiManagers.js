// Local imports
import { progressViewState } from './progressViewState.js';
import { formatTokens } from './formatters.js';
import { STATUS, TOOLBAR_BUTTONS, SPLIT_SIZES } from './constants.js';
import { createIconButton } from '@common/templateUtils.js';
import { CHEVRON_RIGHT_CLASS, vscode } from '@common/webviewContext.js';
import Split from 'split.js';

/**
 * Manages stream tab UI updates.
 */
export class StreamTabs {
  /**
   * Updates UI to show stream tabs and highlight the active stream
   * @param {Array} streams - Array of stream names
   * @param {string} activeStream - Currently active stream
   */
  update(streams, activeStream) {
    if (!Array.isArray(streams)) {
      console.error('StreamTabs.update: streams must be an array');
      return;
    }
    const tabsContainer = document.getElementById('streamTabs');
    if (!tabsContainer) {
      console.error('StreamTabs.update: streamTabs container not found');
      return;
    }
    tabsContainer.innerHTML = streams
      .map((stream) => {
        if (!stream || typeof stream !== 'string') {
          console.warn('StreamTabs.update: invalid stream value:', stream);
          return '';
        }
        return `<div class="tab-container ${stream === activeStream ? 'active' : ''}" title="${stream}">
            <button class="tab" data-stream="${stream}" title="${stream}">${stream}</button>
            <button class="tab-delete" data-stream="${stream}" title="Delete stream">
              <i class="codicon codicon-close"></i>
            </button>
          </div>`;
      })
      .join('');

    // Update current stream name
    const streamNameElem = document.getElementById('currentStreamName');
    if (streamNameElem) {
      streamNameElem.textContent = activeStream || '';
    }
  }
}

/**
 * Manages toolbar rendering.
 */
export class Toolbar {
  render() {
    const container = document.getElementById('toolbarContainer');
    if (!container) {
      console.error('Toolbar.render: toolbarContainer not found');
      return;
    }
    container.innerHTML = '';
    TOOLBAR_BUTTONS.forEach((def) => {
      try {
        const btn = createIconButton({
          id: def.id,
          icon: def.icon,
          title: def.title,
          className: def.className,
          disabled: def.disabled,
          dataset: { command: def.command },
        });
        container.appendChild(btn);
      } catch (error) {
        console.error('Toolbar.render: error creating button:', def.id, error);
      }
    });
  }
}

/**
 * Manages status display and button states.
 */
export class Status {
  constructor() {
    this.STATUS_MAP = {
      [STATUS.RUNNING]: {
        className: 'running',
        label: 'Running',
        enable: ['stopStreamBtn', 'restoreStateBtn'],
      },
      [STATUS.ERROR]: {
        className: 'error',
        label: 'Error',
        enable: [
          'runAgainBtn',
          'packStreamBtn',
          'cleanStreamBtn',
          'restoreStateBtn',
          'diffStreamBtn',
          'eraseStreamBtn',
        ],
      },
      [STATUS.STOPPED]: {
        className: 'stopped',
        label: 'Stopped',
        enable: [
          'runAgainBtn',
          'packStreamBtn',
          'cleanStreamBtn',
          'restoreStateBtn',
          'diffStreamBtn',
          'eraseStreamBtn',
        ],
      },
      [STATUS.READY]: {
        className: 'ready',
        label: 'Ready',
        enable: ['restoreStateBtn'],
      },
    };

    this.BUTTON_IDS = TOOLBAR_BUTTONS.map((b) => b.id);
    this._buttonElements = null; // Cache for button elements
  }

  /**
   * Updates the stream status indicator and enables/disables buttons accordingly
   * @param {string} status - The status to set
   */
  update(status) {
    const statusIndicator = document.getElementById('statusIndicator');
    if (!statusIndicator) {
      console.error('Status.update: statusIndicator element not found');
      return;
    }

    const buttons = (this._buttonElements ||= this.BUTTON_IDS.map((id) =>
      document.getElementById(id),
    ).filter(Boolean));

    buttons.forEach((b) => {
      if (b) b.disabled = true;
    });

    statusIndicator.className = 'status-indicator';
    statusIndicator.dataset.status = 'Ready';

    if (status) {
      if (typeof status !== 'string') {
        console.error('Status.update: status must be a string');
        return;
      }

      statusIndicator.classList.remove('running', 'error', 'stopped', 'ready');

      const cfg = this.STATUS_MAP[status] || {
        className: 'stopped',
        label: status || 'Ready',
        enable: [],
      };

      statusIndicator.classList.add(cfg.className);
      statusIndicator.dataset.status = cfg.label;

      cfg.enable.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = false;
      });

      const currentStream = progressViewState.getCurrentStream();
      if (currentStream && status !== STATUS.READY) {
        progressViewState.streamStatuses.set(currentStream, status);
      }
    }
  }
}

/**
 * Manages file list rendering.
 */
export class FileList {
  constructor(usageSummary = null) {
    this.usageSummary = usageSummary;
  }
  /**
   * Get the effective base file for comparison operations.
   * @param {string|null|undefined} base - The explicit base file path
   * @param {string|null|undefined} original - The original source file path
   * @param {string} current - The current generated file path
   * @returns {string|null} The effective base file path or null
   */
  getEffectiveBaseFile(base, original, current) {
    // Use explicit base if available
    if (base) {
      return base;
    }

    // Use original as base if it exists and differs from current
    if (original && original !== current) {
      return original;
    }

    return null;
  }

  /**
   * Update the generated files list
   * @param {Object} filesByRound - Files organized by round
   */
  update(filesByRound) {
    const container = document.getElementById('generatedFiles');
    if (!container) return;

    container.innerHTML = '';

    const template = document.getElementById('fileItemTemplate');
    if (!template) {
      console.error('File item template not found');
      return;
    }

    if (!filesByRound || Object.keys(filesByRound).length === 0) {
      container.textContent = 'No generated files';
      return;
    }

    // Add total usage header
    const usageHeader = document.createElement('div');
    usageHeader.className = 'files-usage-header';

    // Calculate total usage from all groups
    const totals = this.usageSummary?.computeTotal() || {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };

    if (totals.inputTokens || totals.outputTokens || totals.cost) {
      usageHeader.innerHTML = `
        <span class="files-usage-label">Total Usage:</span>
        <span class="files-usage-stats">
          <i class="codicon codicon-arrow-up"></i> ${formatTokens(totals.inputTokens)}, 
          <i class="codicon codicon-arrow-down"></i> ${formatTokens(totals.outputTokens)}, 
          $${totals.cost.toFixed(3)}
        </span>
      `;
      container.appendChild(usageHeader);
    }

    const rounds = Object.keys(filesByRound)
      .map((r) => parseInt(r, 10))
      .sort((a, b) => a - b);

    rounds.forEach((round) => {
      const files = filesByRound[round];
      if (!files || files.length === 0) return;

      files.forEach((file) => {
        // Skip invalid file entries
        if (!file || !file.current) {
          console.warn('FileList.update: Invalid file entry:', file);
          return;
        }

        const clone = template.content.cloneNode(true);
        const fileItem = clone.querySelector('.file-item');
        const filePathSpan = clone.querySelector('.file-path');
        const dirSpan = clone.querySelector('.file-dir');
        const basenameSpan = clone.querySelector('.file-basename');
        const fileActions = clone.querySelector('.file-actions');

        // Parse the file path
        const parts = file.current.split('/');
        const basename = parts.pop() || '';
        const dirPath = parts.length > 0 ? parts.join('/') + '/' : '';

        // Set file data attributes
        if (fileItem) {
          fileItem.dataset.file = file.current;
          fileItem.dataset.original = file.original || '';
          fileItem.dataset.base = file.base || '';
          fileItem.dataset.round = round;
        }

        // Set the file path display
        if (dirSpan) dirSpan.textContent = dirPath;
        if (basenameSpan) basenameSpan.textContent = basename;
        if (filePathSpan) filePathSpan.title = file.current;

        // Get effective base file for comparisons
        const effectiveBase = this.getEffectiveBaseFile(
          file.base,
          file.original,
          file.current,
        );

        // Update existing buttons based on file state
        this.updateFileButtons(clone, file, effectiveBase);

        container.appendChild(clone);
      });
    });
  }

  /**
   * Update action buttons for a file item based on file state
   * @private
   */
  updateFileButtons(clone, file, effectiveBase) {
    const compareBtn = clone.querySelector('.compare-btn');
    const acceptBtn = clone.querySelector('.accept-btn');
    const mergeBtn = clone.querySelector('.merge-btn');
    const diffBtn = clone.querySelector('.diff-btn');
    const prevBtn = clone.querySelector('.prev-btn');

    // Compare button - show only if there's a base file
    if (compareBtn) {
      if (effectiveBase) {
        compareBtn.onclick = () => {
          vscode.postMessage({
            command: 'compareFile',
            file: file.current,
            base: effectiveBase,
          });
        };
      } else {
        compareBtn.style.display = 'none';
      }
    }

    // Accept button - show only if there's a base file
    if (acceptBtn) {
      if (effectiveBase) {
        acceptBtn.onclick = () => {
          vscode.postMessage({
            command: 'acceptFile',
            file: file.current,
            base: effectiveBase,
          });
        };
      } else {
        acceptBtn.style.display = 'none';
      }
    }

    // Merge button - show only if there's a base file
    if (mergeBtn) {
      if (effectiveBase) {
        mergeBtn.onclick = () => {
          vscode.postMessage({
            command: 'mergeFile',
            file: file.current,
            base: effectiveBase,
          });
        };
      } else {
        mergeBtn.style.display = 'none';
      }
    }

    // LaTeX diff button - show only if there's a base file
    if (diffBtn) {
      if (effectiveBase) {
        diffBtn.onclick = () => {
          vscode.postMessage({
            command: 'latexDiff',
            file: file.current,
            base: effectiveBase,
          });
        };
      } else {
        diffBtn.style.display = 'none';
      }
    }

    // Previous round comparison button - show only if there's a previous version
    if (prevBtn) {
      if (file.prev) {
        prevBtn.onclick = () => {
          vscode.postMessage({
            command: 'comparePrevious',
            file: file.current,
            prev: file.prev,
          });
        };
      } else {
        prevBtn.style.display = 'none';
      }
    }

    // Add click handler for the file path
    const filePathSpan = clone.querySelector('.file-path');
    if (filePathSpan && file.current) {
      filePathSpan.onclick = () => {
        vscode.postMessage({
          command: 'openFile',
          file: file.current,
        });
      };
    }
  }
}

/**
 * Manages event handling and state application.
 */
export class Events {
  /**
   * Apply saved toggle states to any groups already in the DOM
   */
  applyToggleStates() {
    const taskGroups = progressViewState.taskGroups.getAll();
    for (const [groupId, _] of taskGroups) {
      const isCollapsed = progressViewState.toggleStates.get(groupId);
      const detailsElem = document.getElementById(`group-${groupId}`);

      if (detailsElem && isCollapsed !== undefined) {
        detailsElem.open = !isCollapsed;
      }
    }
  }

  /**
   * Sets up all event listeners for the UI
   */
  setupEventListeners() {
    // Stream tab click handler
    document.getElementById('streamTabs').addEventListener('click', (e) => {
      const tabButton = e.target.closest('.tab');
      const deleteButton = e.target.closest('.tab-delete');

      if (tabButton && tabButton.dataset.stream) {
        vscode.postMessage({
          command: 'selectStream',
          stream: tabButton.dataset.stream,
        });
      } else if (deleteButton && deleteButton.dataset.stream) {
        vscode.postMessage({
          command: 'deleteStream',
          stream: deleteButton.dataset.stream,
        });
      }
    });

    // Toolbar click handler
    document
      .getElementById('toolbarContainer')
      .addEventListener('click', (e) => {
        const button = e.target.closest('button');
        if (button && button.dataset.command && !button.disabled) {
          vscode.postMessage({
            command: button.dataset.command,
          });
        }
      });

    // File list toggle - removed as filesToggle element doesn't exist in the HTML
    // This appears to be orphaned code from a previous design

    // File list button handler
    document.getElementById('generatedFiles').addEventListener(
      'click',
      (e) => {
        const button = e.target.closest('button');
        if (button && button.dataset.command) {
          const data = { command: button.dataset.command };
          if (button.dataset.file) data.file = button.dataset.file;
          if (button.dataset.base) data.base = button.dataset.base;
          vscode.postMessage(data);
        }
      },
      true,
    );
  }
}
