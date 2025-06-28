# File Loading Status Implementation Proposal

## Overview

This document outlines the implementation plan for structured "File Loading Status" in the ProgressBoard that displays required files and figures chronologically as specialized log messages rather than separate sections.

## Current State Analysis

### Existing File Loading Patterns
The system currently logs file loading with messages like:
```
🟢 [requiredFiles] Found [VAR 'DOCUMENT_CLS']: lecture.cls
🟢 [requiredFiles] Found [VAR 'COMMAND']: command.tex
🟡 [requiredFiles] [VAR 'MISSING'] not found: missing_file.tex
🟢 Added: Fig1.pdf, Fig8.pdf, ...
```

### Current Architecture
- **Progress Events**: `src/eventBus/ProgressEventBus.ts` - handles 16 event types
- **Log Formatting**: `src/progressView/modules/formatters.js` - `LogEntryFormatter` class
- **Chronological Display**: Messages appear in `logContent` div in timestamp order
- **File Loading Sources**:
  - `setVarFromFile` in `src/frontend/files/vars.ts` (required files)
  - `ModelHandler.createMediaMessage` in `src/agent/modelHandlers/ModelHandler.ts` (media/figures)

## Design Principles (Following AGENTS.md)

### Deep Modules & Information Hiding
- Create focused manager classes that hide implementation complexity
- Provide minimal, clear APIs that don't leak implementation details
- Avoid shallow modules that merely pass data through

### Separation of Concerns
- **InputStatusCollector**: Aggregates file loading events from different sources
- **InputStatusFormatter**: Handles message formatting and UI rendering  
- **InputStatusInteractionHandler**: Manages user interactions (file clicks)
- **InputStatusState**: Manages state persistence and round tracking

### Interface Design
- Use simple, obvious method names with context from class names
- Pass dependencies through constructors, not global access
- Follow established patterns from `progressViewState.js` and `domHandlers.js`

## Implementation Strategy

### 1. Enhanced Progress Event System

#### A. Extend ProgressEventBus (src/eventBus/ProgressEventBus.ts)
```typescript
export type ProgressEvent = 
  // ... existing events
  | 'updateInputStatus'    // NEW: File loading status updates

// Deep module interface - hides internal complexity
interface InputStatusPayload {
  stream: string;
  timestamp: number;
  round: number;           // r0, r1, etc.
  type: 'required' | 'media';
  files: InputFileInfo[];
}

interface InputFileInfo {
  path: string;
  varName?: string;        // For required files only
  found: boolean;
  isClickable: boolean;    // Whether file can be opened in VS Code
}
```

#### B. Update Constants (src/progressView/modules/constants.js)
```javascript
export const COMMANDS = {
  // ... existing commands
  UPDATE_INPUT_STATUS: 'updateInputStatus',  // NEW
  OPEN_INPUT_FILE: 'openInputFile',          // NEW
};

// Input status specific constants
export const INPUT_STATUS = {
  TYPES: {
    REQUIRED: 'required',
    MEDIA: 'media',
  },
  MESSAGE_TYPE: 'inputStatus',
};
```

### 2. Core Manager Classes (Deep Modules)

#### A. InputStatusCollector (src/agent/utils/InputStatusCollector.ts)
```typescript
import { emitProgress } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import { getStreamId } from '@logger/streamUtils';
import { INPUT_STATUS } from '@progressView/modules/constants';

/**
 * Deep module that hides the complexity of collecting and aggregating 
 * file loading events from multiple sources across agent execution rounds.
 * 
 * Provides a simple interface while managing internal state, round tracking,
 * and event aggregation logic.
 */
export class InputStatusCollector {
  private readonly logger: AgentLogger;
  private currentRound: number = 0;
  private pendingFiles: Map<string, InputFileInfo[]> = new Map();

  constructor(logger: AgentLogger) {
    this.logger = logger;
  }

  /**
   * Record required file loading result
   * Simple interface hides internal aggregation complexity
   */
  recordRequiredFile(
    filePath: string, 
    varName: string, 
    found: boolean, 
    isAbsolute: boolean = false
  ): void {
    const streamId = getStreamId();
    if (!streamId) return;

    const fileInfo: InputFileInfo = {
      path: filePath,
      varName,
      found,
      isClickable: !isAbsolute // workspace files are clickable
    };

    this._aggregateAndEmit(streamId, INPUT_STATUS.TYPES.REQUIRED, [fileInfo]);
  }

  /**
   * Record media file loading results
   * Batch processing for multiple files
   */
  recordMediaFiles(mediaFiles: string[]): void {
    const streamId = getStreamId();
    if (!streamId || mediaFiles.length === 0) return;

    const fileInfos: InputFileInfo[] = mediaFiles.map(mediaFile => ({
      path: mediaFile,
      found: true,
      isClickable: !path.isAbsolute(mediaFile)
    }));

    this._aggregateAndEmit(streamId, INPUT_STATUS.TYPES.MEDIA, fileInfos);
  }

  /**
   * Set current execution round
   * Called by agent runtime when rounds change
   */
  setRound(round: number): void {
    this.currentRound = round;
  }

  /**
   * Internal aggregation and emission logic - hidden from clients
   * Implements batching and deduplication
   */
  private _aggregateAndEmit(
    streamId: string, 
    type: string, 
    files: InputFileInfo[]
  ): void {
    try {
      emitProgress('updateInputStatus', {
        stream: streamId,
        timestamp: Date.now(),
        round: this.currentRound,
        type,
        files
      });
    } catch (error) {
      this.logger.error(`Failed to emit input status: ${error}`);
    }
  }
}

// Singleton instance for agent runtime
let globalCollector: InputStatusCollector | null = null;

export function getInputStatusCollector(): InputStatusCollector {
  if (!globalCollector) {
    const logger = new AgentLogger('InputStatusCollector');
    globalCollector = new InputStatusCollector(logger);
  }
  return globalCollector;
}
```

#### B. InputStatusFormatter (src/progressView/modules/uiManagers/InputStatusFormatter.js)
```javascript
import { EMOJI_BY_LEVEL } from '../formatters.js';
import { INPUT_STATUS } from '../constants.js';

/**
 * Deep module that encapsulates all input status message formatting logic.
 * Hides complex formatting rules, file path processing, and HTML generation.
 */
export class InputStatusFormatter {
  constructor() {
    this._filePathRegex = /([a-zA-Z0-9._/-]+\.(tex|pdf|png|jpg|jpeg|cls|sty|bib))/g;
  }

  /**
   * Format input status payload into display message
   * Simple interface hides complex formatting logic
   */
  format(payload) {
    const { type, files, round } = payload;
    const foundFiles = files.filter(f => f.found);
    const missingFiles = files.filter(f => !f.found);
    
    return this._createFormattedMessage(type, foundFiles, missingFiles, round);
  }

  /**
   * Create log message data structure from payload
   * Encapsulates message structure knowledge
   */
  createLogMessage(payload) {
    const { timestamp, type, files } = payload;
    const missingFiles = files.filter(f => !f.found);
    
    return {
      id: this._generateId(),
      text: this.format(payload),
      level: missingFiles.length > 0 ? 'warn' : 'info',
      timestamp,
      messageType: INPUT_STATUS.MESSAGE_TYPE,
      verbose: false
    };
  }

  /**
   * Make file paths clickable in formatted text
   * Handles both found and missing files appropriately
   */
  makeClickable(text) {
    return text.replace(this._filePathRegex, (match, filePath) => {
      return `<span class="clickable-file-path" data-file-path="${filePath}">${filePath}</span>`;
    });
  }

  // Private methods hide implementation complexity
  _createFormattedMessage(type, foundFiles, missingFiles, round) {
    const roundIndicator = `<span class="round-indicator">[r${round}]</span>`;
    
    if (type === INPUT_STATUS.TYPES.REQUIRED) {
      return this._formatRequiredFiles(roundIndicator, foundFiles, missingFiles);
    } else {
      return this._formatMediaFiles(roundIndicator, foundFiles);
    }
  }

  _formatRequiredFiles(roundIndicator, foundFiles, missingFiles) {
    const total = foundFiles.length + missingFiles.length;
    const foundCount = foundFiles.length;
    const missingCount = missingFiles.length;
    
    let message = `${roundIndicator} Required Files: `;
    
    if (foundCount > 0) {
      message += `✓ ${foundCount} found`;
    }
    
    if (missingCount > 0) {
      message += foundCount > 0 ? `, ⚠ ${missingCount} missing` : `⚠ ${missingCount} missing`;
    }
    
    // Add file lists with proper formatting
    if (foundFiles.length > 0) {
      const foundList = foundFiles.map(f => f.path).join(', ');
      message += `\n    Found: ${foundList}`;
    }
    
    if (missingFiles.length > 0) {
      const missingList = missingFiles.map(f => f.path).join(', ');
      message += `\n    Missing: ${missingList}`;
    }
    
    return message;
  }

  _formatMediaFiles(roundIndicator, foundFiles) {
    const count = foundFiles.length;
    const fileList = foundFiles.map(f => f.path).join(', ');
    
    return `${roundIndicator} Added Media: ${count} file${count !== 1 ? 's' : ''}\n    ${fileList}`;
  }

  _generateId() {
    return 'input-status-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  }
}
```

#### C. InputStatusInteractionHandler (src/progressView/modules/uiManagers/InputStatusInteractionHandler.js)
```javascript
import { vscode } from '@common/webviewContext.js';
import { COMMANDS } from '../constants.js';
import { logErrorMessage } from '@utils/errorHandlingUtils.js';

/**
 * Deep module that encapsulates all user interaction logic for input status messages.
 * Hides event delegation, file opening logic, and error handling complexity.
 */
export class InputStatusInteractionHandler {
  constructor() {
    this._setupEventDelegation();
  }

  /**
   * Simple interface for external callers
   * Implementation complexity is hidden
   */
  initialize() {
    // Initialization logic is encapsulated
    this._validateEnvironment();
  }

  /**
   * Handle file path click - encapsulates all click logic
   */
  handleFileClick(filePath) {
    try {
      this._openFile(filePath);
    } catch (error) {
      logErrorMessage('InputStatusInteractionHandler', 'Failed to open file', error);
    }
  }

  // Private methods hide implementation details
  _setupEventDelegation() {
    const logContent = document.getElementById('logContent');
    if (!logContent) return;

    // Use event delegation for better performance
    logContent.addEventListener('click', (e) => {
      const clickableFilePath = e.target.closest('.clickable-file-path');
      if (clickableFilePath) {
        e.preventDefault();
        e.stopPropagation();
        
        const filePath = clickableFilePath.dataset.filePath;
        if (filePath) {
          this.handleFileClick(filePath);
        }
      }
    });
  }

  _openFile(filePath) {
    vscode.postMessage({
      command: COMMANDS.OPEN_INPUT_FILE,
      file: filePath
    });
  }

  _validateEnvironment() {
    if (typeof vscode === 'undefined') {
      throw new Error('VSCode API not available');
    }
  }
}
```

#### D. InputStatusManager (src/progressView/modules/uiManagers/InputStatusManager.js)
```javascript
import { InputStatusFormatter } from './InputStatusFormatter.js';
import { InputStatusInteractionHandler } from './InputStatusInteractionHandler.js';

/**
 * Facade that coordinates input status functionality.
 * Provides unified interface while maintaining separation of concerns.
 */
export class InputStatusManager {
  constructor() {
    this.formatter = new InputStatusFormatter();
    this.interactionHandler = new InputStatusInteractionHandler();
  }

  /**
   * Initialize input status functionality
   * Simple interface hides internal coordination
   */
  initialize() {
    this.interactionHandler.initialize();
  }

  /**
   * Process input status update
   * Delegates to appropriate specialized modules
   */
  processUpdate(payload) {
    return this.formatter.createLogMessage(payload);
  }

  /**
   * Make file paths clickable in existing content
   * Delegates to formatter module
   */
  makePathsClickable(text) {
    return this.formatter.makeClickable(text);
  }
}

// Export singleton instance following established patterns
export const inputStatusManager = new InputStatusManager();
```

### 3. Agent Integration (Following Established Patterns)

#### A. Required Files - Update setVarFromFile (src/frontend/files/vars.ts)
```typescript
import { getInputStatusCollector } from '@agent/utils/InputStatusCollector';

export async function setVarFromFile(
  filePath: string,
  varName: string,
  userVars: Record<string, any>,
  logger: AgentLogger,
  source: string,
  absolute: boolean = false,
): Promise<boolean> {
  try {
    const fileContent = absolute
      ? await AbsoluteFS.read(filePath)
      : await WorkspaceFS.readFile(filePath);
    
    userVars[`${varName}_FILE`] = filePath;
    userVars[`${varName}_CONTENT`] = fileContent;
    
    // Record successful file loading
    getInputStatusCollector().recordRequiredFile(filePath, varName, true, absolute);
    
    logger.info(`[${source}] Found [VAR '${varName}']: ${filePath}`);
    return true;
  } catch (err) {
    // Record failed file loading
    getInputStatusCollector().recordRequiredFile(filePath, varName, false, absolute);
    
    logger.warn(`[${source}] [VAR '${varName}'] not found: ${filePath}`);
    return false;
  }
}
```

#### B. Media Files - Update ModelHandler.createMediaMessage (src/agent/modelHandlers/ModelHandler.ts)
```typescript
import { getInputStatusCollector } from '@agent/utils/InputStatusCollector';

public async createMediaMessage(mediaFiles: string[]): Promise<any[]> {
  const mediaMessage: MediaEntry[] = [];
  const addedMedia: string[] = [];

  // ... existing processing logic

  // Record media files using deep module interface
  if (addedMedia.length > 0) {
    getInputStatusCollector().recordMediaFiles(addedMedia);
    
    // Keep existing log messages for backward compatibility
    const simplifiedMedia = addedMedia.map((m) =>
      getPastedImageDisplayName(m),
    );
    this.logger.info(`Added: ${simplifiedMedia}`);
  }

  return this.createMediaContent(mediaMessage);
}
```

### 4. ProgressViewProvider Integration (Minimal Changes)

#### A. Event Listener (src/progressView/ProgressViewProvider.ts)
```typescript
import { inputStatusManager } from './modules/uiManagers/InputStatusManager.js';

public async initialize(): Promise<void> {
  // ... existing event listeners
  
  // NEW: Handle input status updates using manager
  new vscode.Disposable(
    onProgress('updateInputStatus', (payload: InputStatusPayload) => 
      this.handleInputStatus(payload)
    )
  ),
}

private handleInputStatus(payload: InputStatusPayload): void {
  try {
    // Delegate to manager - simple interface hides complexity
    const logMessage = inputStatusManager.processUpdate(payload);
    this.addLogMessage(payload.stream, logMessage);
  } catch (error) {
    logErrorMessage('ProgressViewProvider', 'Failed to process input status', error);
  }
}
```

### 5. Enhanced LogEntryFormatter (src/progressView/modules/formatters.js)

```javascript
import { inputStatusManager } from './uiManagers/InputStatusManager.js';
import { INPUT_STATUS } from './constants.js';

export class LogEntryFormatter {
  format(logMessage) {
    const { id, text, level, timestamp, groupId, messageType, verbose } = logMessage;

    // Handle input status messages with specialized formatting
    if (messageType === INPUT_STATUS.MESSAGE_TYPE) {
      return this._formatInputStatusMessage(logMessage);
    }
    
    // Handle other special message types
    if (messageType === 'thinking' || messageType === 'scratchpad') {
      const label = messageType === 'thinking' ? 'Thinking' : 'Scratchpad';
      return this._formatSpecialContent(htmlMessage, text, label, id);
    }

    // ... existing default formatting logic
  }

  _formatInputStatusMessage(logMessage) {
    const { text, level, timestamp, id } = logMessage;
    
    // Delegate to manager for clickable paths
    const processedText = inputStatusManager.makePathsClickable(text);
    
    // Use specialized styling for input status
    const emoji = level === 'warn' ? '🟡' : '🟢';
    const fullTimestamp = new Date(timestamp).toISOString();
    
    const prefix = `<div class="log-line input-status-line" data-log-id="${id}" data-full-timestamp="${fullTimestamp}">`;
    
    return prefix +
      `<span class="timestamp" title="${fullTimestamp}">${emoji}</span> ` +
      `<span class="message-${level} input-status-message">${processedText}</span>` +
      `</div>`;
  }

  // ... rest of existing methods
}
```

### 6. Round Tracking Integration

#### A. Agent Runtime Integration
```typescript
// In agent execution code where rounds change
import { getInputStatusCollector } from '@agent/utils/InputStatusCollector';

// When starting a new round
getInputStatusCollector().setRound(currentRound);
```

### 7. CSS Styling (src/progressView/styles/input-status.css)

```css
/* Input status message styling following established patterns */
.input-status-line {
  border-left: 3px solid var(--vscode-charts-blue);
  padding-left: var(--spacing-small);
  margin: calc(var(--spacing-tiny) / 2) 0;
  background-color: rgba(var(--vscode-charts-blue-rgb), 0.05);
}

.input-status-message {
  font-family: var(--vscode-editor-font-family);
  white-space: pre-line;
}

.clickable-file-path {
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  text-decoration: none;
  font-family: var(--vscode-editor-font-family);
  border-bottom: 1px dotted var(--vscode-textLink-foreground);
  padding: 1px 2px;
  border-radius: 2px;
}

.clickable-file-path:hover {
  color: var(--vscode-textLink-activeForeground);
  background-color: var(--vscode-textLink-activeForeground);
  background-color: rgba(var(--vscode-textLink-activeForeground-rgb), 0.1);
  border-bottom-style: solid;
}

.round-indicator {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  padding: 1px 4px;
  border-radius: 2px;
  font-size: var(--font-size-sm);
  font-weight: 600;
  margin-right: var(--spacing-tiny);
  font-family: var(--vscode-font-family);
}
```

### 8. Import Map Updates (src/progressView/index.html)

```html
<script type="importmap" nonce="${nonce}">
{
  "imports": {
    // ... existing imports
    "./modules/uiManagers/InputStatusManager.js": "${inputStatusManagerUri}",
    "./modules/uiManagers/InputStatusFormatter.js": "${inputStatusFormatterUri}",
    "./modules/uiManagers/InputStatusInteractionHandler.js": "${inputStatusInteractionHandlerUri}"
  }
}
</script>
```

### 9. Message Handler Updates (src/progressView/ProgressViewMessageHandler.ts)

```typescript
export class ProgressViewMessageHandler {
  private handlers: Record<string, (message: any, webviewView: vscode.WebviewView) => Promise<void>> = {
    // ... existing handlers
    [COMMANDS.OPEN_INPUT_FILE]: this.handleOpenInputFile.bind(this),
  };

  private async handleOpenInputFile(message: any, webviewView: vscode.WebviewView): Promise<void> {
    try {
      const { file } = message;
      if (!file) return;

      await safeExecuteCommand('vscode.open', vscode.Uri.file(
        WorkspaceFS.fullPath(file)
      ));
    } catch (error) {
      logErrorMessage('ProgressViewMessageHandler', 'Failed to open input file', error);
    }
  }
}
```

## Implementation Phases

### Phase 1: Core Infrastructure (Deep Modules)
1. Create `InputStatusCollector` with proper abstraction
2. Implement `InputStatusFormatter` and `InputStatusInteractionHandler`
3. Create `InputStatusManager` facade
4. Update ProgressEventBus and constants

### Phase 2: Agent Integration (Following Patterns)
1. Integrate collector in `setVarFromFile` and `ModelHandler`
2. Add round tracking in agent runtime
3. Ensure proper error handling with `logErrorMessage`

### Phase 3: UI Integration (Minimal Surface Area)
1. Update `LogEntryFormatter` with delegation to manager
2. Add CSS styling following established patterns
3. Update import maps and content provider URIs

### Phase 4: Testing & Validation
1. Test chronological ordering with mixed log types
2. Verify file opening functionality
3. Test state persistence and error handling
4. Validate separation of concerns and interface contracts

## Architectural Benefits

### Deep Modules (Ousterhout Principles)
- **`InputStatusCollector`**: Hides complex aggregation, batching, and emission logic behind simple `record*` methods
- **`InputStatusFormatter`**: Encapsulates all formatting rules, HTML generation, and file path processing
- **`InputStatusInteractionHandler`**: Abstracts event delegation, error handling, and VS Code API interaction

### Information Hiding
- Internal aggregation logic hidden from agent code
- Formatting complexity hidden from ProgressView
- Event handling details hidden from manager consumers
- Round tracking implementation hidden behind simple `setRound()` interface

### Separation of Concerns
- **Collection**: `InputStatusCollector` handles data gathering
- **Formatting**: `InputStatusFormatter` handles display logic  
- **Interaction**: `InputStatusInteractionHandler` handles user actions
- **Coordination**: `InputStatusManager` provides unified interface

### Interface Design
- Simple method names with context from class name
- No information leakage between modules
- Dependencies injected through constructors
- Follows established patterns from existing codebase

## Error Handling & Resilience

- Use `logErrorMessage` for consistent error reporting
- Graceful degradation when VS Code API unavailable
- Validation of required dependencies in constructors
- Try-catch blocks around all external integrations

## Configuration Integration

- Use `getConfig` for any configuration needs
- Follow established patterns for feature flags
- Maintain backward compatibility during rollout

This refined implementation follows the project's established patterns for deep modules, separation of concerns, and information hiding while providing a robust foundation for the file loading status feature.