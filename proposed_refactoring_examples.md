# Proposed Refactoring Examples

This document provides concrete examples of the proposed changes to improve consistency across webview implementations.

## 1. Base Content Provider Implementation

### Create Base Class (New file: `src/common/webview/BaseViewContentProvider.ts`)

```typescript
import * as vscode from 'vscode';
import * as logger from '@logger/logUtils';
import { buildWebviewHtml } from '@frontend/webview/html';

export abstract class BaseViewContentProvider {
  protected readonly logger: logger.Logger;

  constructor(
    protected readonly context: vscode.ExtensionContext,
    protected readonly viewName: string,
  ) {
    this.logger = logger.getLogger(`${viewName}ContentProvider`);
  }

  /**
   * Subclasses must provide the relative path to their view directory
   */
  protected abstract getViewPath(): string;

  /**
   * Subclasses must provide their specific module URIs
   */
  protected abstract getModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri>;

  /**
   * Common method to get webview paths
   */
  protected getWebviewPath(filePath: string): vscode.Uri {
    return vscode.Uri.joinPath(
      this.context.extensionUri,
      'src',
      this.getViewPath(),
      filePath,
    );
  }

  protected getWebviewUri(webview: vscode.Webview, path: string): vscode.Uri {
    return webview.asWebviewUri(this.getWebviewPath(path));
  }

  protected getCommonUri(webview: vscode.Webview, path: string): vscode.Uri {
    return webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'src', 'common', path),
    );
  }

  protected getNodeModulesUri(
    webview: vscode.Webview,
    path: string,
  ): vscode.Uri {
    return webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', path),
    );
  }

  /**
   * Standard implementation that subclasses can override if needed
   */
  public getHtmlContent(webview: vscode.Webview): string {
    try {
      const htmlPath = this.getWebviewPath('index.html');
      const commonUris = this.getCommonModuleUris(webview);
      const specificUris = this.getModuleUris(webview);

      this.logger.debug(`Generated HTML content for ${this.viewName}`);

      return buildWebviewHtml(webview, htmlPath, {
        ...commonUris,
        ...specificUris,
      });
    } catch (err) {
      this.logger.error(
        `Error generating HTML content: ${err instanceof Error ? err.message : String(err)}`,
      );
      return '<html><body>Error loading content</body></html>';
    }
  }

  /**
   * Common URIs used by all views
   */
  private getCommonModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri> {
    return {
      commonStyleUri: this.getCommonUri(webview, 'styles/common.css'),
      webviewStateUri: this.getCommonUri(webview, 'modules/webviewState.js'),
      webviewContextUri: this.getCommonUri(
        webview,
        'modules/webviewContext.js',
      ),
      templateUtilsUri: this.getCommonUri(webview, 'modules/templateUtils.js'),
      domUtilsUri: this.getCommonUri(webview, 'modules/domUtils.js'),
      stringUtilsUri: this.getCommonUri(webview, 'modules/stringUtils.js'),
      codiconUri: this.getNodeModulesUri(
        webview,
        '@vscode/codicons/dist/codicon.css',
      ),
      codiconsFontUri: this.getNodeModulesUri(
        webview,
        '@vscode/codicons/dist/codicon.ttf',
      ),
    };
  }
}
```

### Refactored Progress View Content Provider

```typescript
// src/progressView/ProgressViewContentProvider.ts
import { BaseViewContentProvider } from '@common/webview/BaseViewContentProvider';
import * as vscode from 'vscode';

export class ProgressViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'ProgressView');
  }

  protected getViewPath(): string {
    return 'progressView';
  }

  protected getModuleUris(webview: vscode.Webview): Record<string, vscode.Uri> {
    return {
      styleUri: this.getWebviewUri(webview, 'styles/index.css'),
      scriptUri: this.getWebviewUri(webview, 'script.js'),
      splitJsUri: this.getNodeModulesUri(webview, 'split.js/dist/split.es.js'),

      // Progress view specific modules
      progressViewStateUri: this.getWebviewUri(
        webview,
        'modules/progressViewState.js',
      ),
      messageHandlersUri: this.getWebviewUri(
        webview,
        'modules/messageHandlers.js',
      ),
      domHandlersUri: this.getWebviewUri(webview, 'modules/domHandlers.js'),
      formattersUri: this.getWebviewUri(webview, 'modules/formatters.js'),
      constantsUri: this.getWebviewUri(webview, 'modules/constants.js'),

      // UI managers - consolidated into single manager
      uiManagerUri: this.getWebviewUri(
        webview,
        'modules/ProgressViewUIManager.js',
      ),
    };
  }
}
```

## 2. Consolidated UI Manager for Progress View

### New File: `src/progressView/modules/ProgressViewUIManager.js`

```javascript
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
      .map(stream => this.createTabHTML(stream, activeStream))
      .join('');

    this.updateActiveStreamName(activeStream);
  }

  private createTabHTML(stream, activeStream) {
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

  private updateActiveStreamName(activeStream) {
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
      .filter(cls => !cls.startsWith('status-'))
      .join(' ');

    // Add current status class
    statusElement.classList.add(`status-${status}`);
    statusElement.textContent = this.getStatusText(status);
  }

  private getStatusText(status) {
    const statusTexts = {
      [STATUS.RUNNING]: 'Running...',
      [STATUS.ERROR]: 'Error',
      [STATUS.STOPPED]: 'Stopped',
      [STATUS.READY]: 'Ready'
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

  private createRoundElement(round, files) {
    const roundDiv = document.createElement('div');
    roundDiv.className = 'file-round';
    roundDiv.innerHTML = `
      <div class="round-header">Round ${round}</div>
      <div class="round-files">
        ${files.map(file => this.createFileElement(file)).join('')}
      </div>
    `;
    return roundDiv;
  }

  private createFileElement(file) {
    return `
      <div class="file-item" data-path="${file.path}">
        <span class="file-name">${file.name}</span>
        <div class="file-actions">
          <button class="file-action" data-action="open" title="Open file">
            <i class="codicon codicon-go-to-file"></i>
          </button>
          <button class="file-action" data-action="compare" title="Compare with original">
            <i class="codicon codicon-diff"></i>
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

  private updateButtonState(buttonId, enabled) {
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
```

## 3. Standardized Command Constants

### New File: `src/common/webview/commands.js`

```javascript
/**
 * Standardized command constants for all webviews
 */

// Common commands used across all views
export const COMMON_COMMANDS = {
  THEME_SET: 'setTheme',
  DEBUG_MODE_SET: 'setDebugMode',
  STATE_RESTORE: 'restoreState',
  WEBVIEW_READY: 'webviewReady',
};

// Main view specific commands
export const MAIN_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  // File operations
  FILE_SELECT: 'selectFile',
  FILE_SELECTED: 'fileSelected',
  FILES_UPDATE: 'updateFiles',

  // Execution
  EXECUTE: 'execute',
  MERGE: 'merge',
  COMPARE: 'compare',

  // Settings
  MODEL_SELECTED: 'modelSelected',
  SETTINGS_OPEN: 'openSettings',
};

// Progress view specific commands
export const PROGRESS_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  // Stream management
  STREAM_SWITCH: 'switchStream',
  STREAM_DELETE: 'deleteStream',
  STREAM_STOP: 'stopStream',
  STREAM_ERASE: 'eraseStream',
  STREAMS_UPDATE: 'updateStreams',
  STREAMS_DELETE_ALL: 'deleteAll',

  // Logging
  LOGS_UPDATE: 'updateLogs',
  LOGS_CLEAR: 'clearLogs',
  LOG_APPEND: 'appendLog',
  LOG_UPDATE: 'updateLog',

  // Groups
  GROUP_ADD: 'addLogGroup',
  GROUP_UPDATE: 'updateLogGroup',

  // Status and files
  STATUS_UPDATE: 'updateStatus',
  FILES_UPDATE: 'updateFiles',

  // Usage
  USAGE_UPDATE: 'updateUsage',
  GROUP_USAGE_UPDATE: 'updateGroupUsage',

  // Actions
  RUN_AGAIN: 'runAgain',
  DIFF_STREAM: 'diffStream',
  PACK_STREAM: 'packStream',
  CLEAN_STREAM: 'cleanStream',

  // File operations
  FILE_OPEN: 'openFile',
  FILE_COMPARE_ORIGINAL: 'compareOriginal',
  FILE_COMPARE_PREVIOUS: 'comparePrevious',
  FILE_ACCEPT: 'acceptFile',
  FILE_MERGE: 'mergeFile',
  FILE_LATEXDIFF: 'latexdiffFile',
};

// History view specific commands
export const HISTORY_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  HISTORY_GET: 'getHistoryData',
  HISTORY_UPDATE: 'updateHistory',
  HISTORY_CLEAR: 'clearHistory',
  HISTORY_CLEARED: 'historyCleared',
  AGENT_RERUN: 'rerunAgent',
  AGENT_RESTORE: 'restoreAgent',
  AGENT_DELETE: 'deleteAgent',
};

// Export all commands in a single object for convenience
export const WEBVIEW_COMMANDS = {
  COMMON: COMMON_COMMANDS,
  MAIN_VIEW: MAIN_VIEW_COMMANDS,
  PROGRESS_VIEW: PROGRESS_VIEW_COMMANDS,
  HISTORY_VIEW: HISTORY_VIEW_COMMANDS,
};
```

## 4. Standardized Message Handler Base Class

### New File: `src/common/webview/BaseViewMessageHandler.ts`

```typescript
import * as vscode from 'vscode';
import * as logger from '@logger/logUtils';

export type MessageHandler = (
  message: any,
  webviewView: vscode.WebviewView,
) => Promise<void>;

export abstract class BaseViewMessageHandler {
  protected readonly logger: logger.Logger;
  protected readonly handlers: Record<string, MessageHandler>;

  constructor(protected readonly viewName: string) {
    this.logger = logger.getLogger(`${viewName}MessageHandler`);
    this.handlers = this.createHandlers();
  }

  /**
   * Subclasses must implement this to provide their specific handlers
   */
  protected abstract createHandlers(): Record<string, MessageHandler>;

  /**
   * Standard message handling with consistent error handling and logging
   */
  public async handleMessage(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    if (!message?.command) {
      this.logger.warn('Received message without command');
      return;
    }

    this.logger.debug(`Received message: ${message.command}`);

    const handler = this.handlers[message.command];
    if (!handler) {
      this.logger.warn(`Unknown command: ${message.command}`);
      return;
    }

    try {
      await handler(message, webviewView);
    } catch (error) {
      this.logger.error(
        `Error handling command ${message.command}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      // Optionally notify the webview of the error
      webviewView.webview.postMessage({
        command: 'error',
        message: `Failed to handle command: ${message.command}`,
      });
    }
  }

  /**
   * Helper method for common theme handling
   */
  protected async handleTheme(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    if (!message?.theme) {
      this.logger.warn('Invalid theme message:', message);
      return;
    }

    webviewView.webview.postMessage({
      command: 'setTheme',
      theme: message.theme,
    });
  }

  /**
   * Helper method for common debug mode handling
   */
  protected async handleDebugMode(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    webviewView.webview.postMessage({
      command: 'setDebugMode',
      debugMode: message.debugMode,
    });
  }
}
```

### Refactored Progress View Message Handler

```typescript
// src/progressView/ProgressViewMessageHandler.ts
import {
  BaseViewMessageHandler,
  MessageHandler,
} from '@common/webview/BaseViewMessageHandler';
import { ProgressViewProvider } from './ProgressViewProvider';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import * as vscode from 'vscode';

export class ProgressViewMessageHandler extends BaseViewMessageHandler {
  constructor(private readonly provider: ProgressViewProvider) {
    super('ProgressView');
  }

  protected createHandlers(): Record<string, MessageHandler> {
    return {
      // Common handlers
      [PROGRESS_VIEW_COMMANDS.THEME_SET]: this.handleTheme.bind(this),
      [PROGRESS_VIEW_COMMANDS.DEBUG_MODE_SET]: this.handleDebugMode.bind(this),

      // Stream management
      [PROGRESS_VIEW_COMMANDS.STREAM_SWITCH]:
        this.handleSwitchStream.bind(this),
      [PROGRESS_VIEW_COMMANDS.STREAM_DELETE]:
        this.handleDeleteStream.bind(this),
      [PROGRESS_VIEW_COMMANDS.STREAM_ERASE]: this.handleEraseStream.bind(this),
      [PROGRESS_VIEW_COMMANDS.STREAMS_DELETE_ALL]:
        this.handleDeleteAllStreams.bind(this),
      [PROGRESS_VIEW_COMMANDS.STREAM_STOP]: this.handleStopStream.bind(this),

      // Actions
      [PROGRESS_VIEW_COMMANDS.RUN_AGAIN]: this.handleRunAgain.bind(this),
      [PROGRESS_VIEW_COMMANDS.DIFF_STREAM]: this.handleDiffStream.bind(this),
      [PROGRESS_VIEW_COMMANDS.PACK_STREAM]: this.handlePackStream.bind(this),
      [PROGRESS_VIEW_COMMANDS.CLEAN_STREAM]: this.handleCleanStream.bind(this),
      [PROGRESS_VIEW_COMMANDS.STATE_RESTORE]:
        this.handleRestoreState.bind(this),

      // File operations
      [PROGRESS_VIEW_COMMANDS.FILE_OPEN]: this.handleOpenFile.bind(this),
      [PROGRESS_VIEW_COMMANDS.FILE_COMPARE_ORIGINAL]:
        this.handleCompareOriginal.bind(this),
      [PROGRESS_VIEW_COMMANDS.FILE_COMPARE_PREVIOUS]:
        this.handleComparePrevious.bind(this),
      [PROGRESS_VIEW_COMMANDS.FILE_ACCEPT]: this.handleAcceptFile.bind(this),
      [PROGRESS_VIEW_COMMANDS.FILE_MERGE]: this.handleMergeFile.bind(this),
      [PROGRESS_VIEW_COMMANDS.FILE_LATEXDIFF]:
        this.handleLatexdiffFile.bind(this),
    };
  }

  // Implementation methods remain the same but use consistent naming
  private async handleSwitchStream(message: any): Promise<void> {
    this.provider.setActiveStream(message.stream);
  }

  private async handleDeleteStream(message: any): Promise<void> {
    this.provider.deleteStream(message.stream);
  }

  private async handleEraseStream(message: any): Promise<void> {
    this.provider.eraseStream(message.stream);
  }

  private async handleDeleteAllStreams(): Promise<void> {
    this.provider.deleteAllStreams();
  }

  private async handleStopStream(message: any): Promise<void> {
    await vscode.commands.executeCommand('texra.stopAgent', message.stream);
  }

  // ... other handler implementations
}
```

## 5. Simplified State Management

### Refactored Progress View State

```javascript
// src/progressView/modules/progressViewState.js
import { WebviewStateManager } from '@common/webviewState.js';

/**
 * Simplified state management for progress view
 */
export class ProgressViewState {
  constructor() {
    this.stateManager = new WebviewStateManager();

    // Core state properties
    this.activeStream = '';
    this.currentGroupId = null;

    // Direct Map usage for simple state
    this.streamStatuses = new Map();
    this.taskGroups = new Map();

    // Only use specialized classes where they add real value
    this.toggleStates = new ToggleStateManager(() => this.save());
  }

  initialize() {
    const previous = this.stateManager.getState();
    if (previous.groupToggleStates) {
      try {
        const data = JSON.parse(previous.groupToggleStates);
        this.toggleStates.load(data);
      } catch (e) {
        console.error('Failed to restore group toggle states:', e);
      }
    }
  }

  save() {
    try {
      const serialized = JSON.stringify(this.toggleStates.entries());
      this.stateManager.update({ groupToggleStates: serialized });
    } catch (e) {
      console.error('Failed to save state:', e);
    }
  }

  // Stream status methods with validation
  setStreamStatus(stream, status) {
    if (!stream || !status) {
      console.error(
        'ProgressViewState.setStreamStatus: stream and status are required',
      );
      return;
    }
    this.streamStatuses.set(stream, status);
  }

  getStreamStatus(stream) {
    return this.streamStatuses.get(stream);
  }

  deleteStreamStatus(stream) {
    this.streamStatuses.delete(stream);
  }

  // Task group methods with validation
  setTaskGroup(groupId, group) {
    if (!groupId || !group) {
      console.error(
        'ProgressViewState.setTaskGroup: groupId and group are required',
      );
      return;
    }
    this.taskGroups.set(groupId, group);
  }

  getTaskGroup(groupId) {
    return this.taskGroups.get(groupId);
  }

  updateTaskGroup(groupId, updates) {
    if (!groupId) {
      console.error('ProgressViewState.updateTaskGroup: groupId is required');
      return;
    }

    const group = this.taskGroups.get(groupId);
    if (!group) {
      console.error(
        `ProgressViewState.updateTaskGroup: group not found for id ${groupId}`,
      );
      return;
    }

    Object.assign(group, updates);
    this.taskGroups.set(groupId, group);
  }

  clearTaskGroups() {
    this.taskGroups.clear();
  }

  // Active stream methods
  getActiveStream() {
    return this.activeStream;
  }

  setActiveStream(stream) {
    this.activeStream = stream || '';
  }
}

/**
 * Specialized toggle state manager that adds real value
 */
class ToggleStateManager {
  constructor(saveCallback) {
    this.states = new Map();
    this.saveCallback = saveCallback;
  }

  set(id, collapsed) {
    if (!id || typeof collapsed !== 'boolean') {
      console.error(
        'ToggleStateManager.set: id and boolean collapsed are required',
      );
      return;
    }
    this.states.set(id, collapsed);
    if (this.saveCallback) {
      this.saveCallback();
    }
  }

  get(id) {
    return this.states.get(id);
  }

  clear(ids) {
    if (!Array.isArray(ids)) {
      console.error('ToggleStateManager.clear: ids must be an array');
      return;
    }
    ids.forEach((id) => {
      if (id) this.states.delete(id);
    });
    if (this.saveCallback) {
      this.saveCallback();
    }
  }

  clearAll() {
    this.states.clear();
    if (this.saveCallback) {
      this.saveCallback();
    }
  }

  entries() {
    return [...this.states.entries()];
  }

  load(data) {
    this.states = new Map(data);
  }
}

export const progressViewState = new ProgressViewState();
```

These examples demonstrate how the proposed changes would:

1. **Reduce Code Duplication**: Base classes eliminate repeated patterns
2. **Improve Consistency**: Standardized naming and structure across views
3. **Enhance Maintainability**: Consolidated UI managers reduce fragmentation
4. **Provide Cognitive Leverage**: Once you understand one view, others follow the same patterns
5. **Eliminate Empty Abstractions**: Direct Map usage where wrapper classes add no value
6. **Maintain Flexibility**: Specialized classes retained where they provide real benefits

The refactoring maintains backward compatibility while establishing patterns that make the codebase more predictable and easier to understand.
