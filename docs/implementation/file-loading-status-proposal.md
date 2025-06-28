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

## Implementation Strategy

### 1. Enhanced Progress Event System

#### A. Extend ProgressEventBus (src/eventBus/ProgressEventBus.ts)
```typescript
export type ProgressEvent = 
  // ... existing events
  | 'updateInputStatus'    // NEW: File loading status updates

interface InputStatusPayload {
  stream: string;
  timestamp: number;
  round: number;           // r0, r1, etc.
  type: 'required' | 'media';
  files: {
    path: string;
    varName?: string;      // For required files only
    found: boolean;
    isClickable: boolean;  // Whether file can be opened in VS Code
  }[];
}
```

#### B. Update Constants (src/progressView/modules/constants.js)
```javascript
export const COMMANDS = {
  // ... existing commands
  UPDATE_INPUT_STATUS: 'updateInputStatus',  // NEW
};
```

### 2. Agent-Side Event Emission

#### A. Required Files - Update setVarFromFile (src/frontend/files/vars.ts)
```typescript
export async function setVarFromFile(
  // ... existing parameters
): Promise<boolean> {
  // ... existing logic

  // NEW: Emit structured progress event
  if (typeof window === 'undefined') { // Only in Node.js context
    const streamId = getStreamId(); // Get current stream
    const round = getCurrentRound(); // Get current round (r0, r1, etc.)
    
    emitProgress('updateInputStatus', {
      stream: streamId,
      timestamp: Date.now(),
      round,
      type: 'required',
      files: [{
        path: filePath,
        varName,
        found: success,
        isClickable: !absolute // workspace files are clickable
      }]
    });
  }

  // Keep existing log message for backward compatibility
  if (success) {
    logger.info(`[${source}] Found [VAR '${varName}']: ${filePath}`);
  } else {
    logger.warn(`[${source}] [VAR '${varName}'] not found: ${filePath}`);
  }
  
  return success;
}
```

#### B. Media Files - Update ModelHandler.createMediaMessage (src/agent/modelHandlers/ModelHandler.ts)
```typescript
public async createMediaMessage(mediaFiles: string[]): Promise<any[]> {
  // ... existing logic

  // NEW: Emit structured progress event for added media
  if (addedMedia.length > 0) {
    const streamId = this.getStreamId();
    const round = this.getCurrentRound();
    
    emitProgress('updateInputStatus', {
      stream: streamId,
      timestamp: Date.now(),
      round,
      type: 'media',
      files: addedMedia.map(mediaFile => ({
        path: mediaFile,
        found: true,
        isClickable: !path.isAbsolute(mediaFile)
      }))
    });
  }

  // Keep existing log messages
  if (mediaFiles.length > 0) {
    // ... existing logging logic
  }

  return this.createMediaContent(mediaMessage);
}
```

### 3. ProgressViewProvider Integration

#### A. Event Listener (src/progressView/ProgressViewProvider.ts)
```typescript
public async initialize(): Promise<void> {
  // ... existing event listeners
  
  // NEW: Handle input status updates
  new vscode.Disposable(
    onProgress('updateInputStatus', (payload: InputStatusPayload) => 
      this.handleInputStatus(payload)
    )
  ),
}

private handleInputStatus(payload: InputStatusPayload): void {
  // Convert to special log message format
  const logMessage = this.createInputStatusLogMessage(payload);
  
  // Add to log stream
  this.addLogMessage(payload.stream, logMessage);
}

private createInputStatusLogMessage(payload: InputStatusPayload): LogMessageData {
  const { type, files, round } = payload;
  const foundFiles = files.filter(f => f.found);
  const missingFiles = files.filter(f => !f.found);
  
  // Create a structured message with clickable file paths
  let messageText = '';
  
  if (type === 'required') {
    messageText = this.formatRequiredFilesMessage(foundFiles, missingFiles, round);
  } else {
    messageText = this.formatMediaFilesMessage(foundFiles, round);
  }
  
  return {
    id: randomUUID(),
    text: messageText,
    level: missingFiles.length > 0 ? 'warn' : 'info',
    timestamp: payload.timestamp,
    messageType: 'inputStatus', // NEW message type
    verbose: false
  };
}
```

#### B. State Persistence (src/progressView/ProgressStateManager.ts)
Input status will be persisted as regular log messages, no additional storage needed.

### 4. UI Rendering Enhancement

#### A. Extended LogEntryFormatter (src/progressView/modules/formatters.js)
```javascript
export class LogEntryFormatter {
  format(logMessage) {
    // ... existing logic
    
    if (messageType === 'inputStatus') {
      return this._formatInputStatusMessage(logMessage);
    }
    
    // ... rest of existing logic
  }
  
  _formatInputStatusMessage(logMessage) {
    const { text, level, timestamp, id } = logMessage;
    
    // Parse the structured message text to create clickable elements
    const processedText = this._makeFilePathsClickable(text);
    
    // Use custom emoji for file loading
    const emoji = level === 'warn' ? '🟡' : '🟢';
    
    const prefix = `<div class="log-line input-status-line" data-log-id="${id}" data-full-timestamp="${new Date(timestamp).toISOString()}">`;
    
    return prefix +
      `<span class="timestamp" title="${new Date(timestamp).toISOString()}">${emoji}</span> ` +
      `<span class="message-${level} input-status-message">${processedText}</span>` +
      `</div>`;
  }
  
  _makeFilePathsClickable(text) {
    // Convert file paths in the message to clickable elements
    return text.replace(
      /([a-zA-Z0-9._/-]+\.(tex|pdf|png|jpg|jpeg|cls|sty|bib))/g, 
      '<span class="clickable-file-path" data-file-path="$1">$1</span>'
    );
  }
}
```

#### B. Click Handler Integration (src/progressView/modules/uiManagers/Events.js)
```javascript
export class Events {
  setupEventListeners() {
    // ... existing event listeners
    
    // NEW: Handle file path clicks in input status messages
    document.getElementById('logContent').addEventListener('click', (e) => {
      const clickableFilePath = e.target.closest('.clickable-file-path');
      if (clickableFilePath) {
        const filePath = clickableFilePath.dataset.filePath;
        vscode.postMessage({
          command: COMMANDS.OPEN_FILE,
          file: filePath
        });
      }
    });
  }
}
```

### 5. Message Format Examples

#### Required Files Messages
```
🟢 [r0] Required Files: ✓ 12 found, ⚠ 2 missing
    Found: lecture.cls, command.tex, intro.tex, ... (clickable)
    Missing: cover_letter.tex, editor_letter.txt

🟢 [r1] Required Files: ✓ 14 found
    Found: lecture.cls, command.tex, cover_letter.tex, ... (clickable)
```

#### Media Files Messages  
```
🟢 [r0] Added Media: 2 files
    Fig1.pdf, diagram.png (clickable)

🟢 [r1] Added Media: 3 files  
    Fig8.pdf, chart.jpg, illustration.pdf (clickable)
```

### 6. CSS Styling (src/progressView/styles/logs.css)

```css
/* Input status message styling */
.input-status-line {
  border-left: 3px solid var(--vscode-charts-blue);
  padding-left: 8px;
  margin: 2px 0;
}

.input-status-message {
  font-family: var(--vscode-editor-font-family);
}

.clickable-file-path {
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  text-decoration: underline;
  font-family: var(--vscode-editor-font-family);
}

.clickable-file-path:hover {
  color: var(--vscode-textLink-activeForeground);
}

/* Round indicator styling */
.round-indicator {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  padding: 1px 4px;
  border-radius: 2px;
  font-size: 0.8em;
  font-weight: bold;
  margin-right: 4px;
}
```

## Implementation Phases

### Phase 1: Core Infrastructure
1. Extend ProgressEventBus with `updateInputStatus` event
2. Add new message type `inputStatus` to LogEntryFormatter
3. Update constants and interfaces

### Phase 2: Agent Integration  
1. Modify `setVarFromFile` to emit structured events
2. Update `ModelHandler.createMediaMessage` to emit structured events
3. Ensure proper stream and round tracking

### Phase 3: UI Enhancement
1. Implement input status message formatting
2. Add clickable file path functionality
3. Add CSS styling for input status messages

### Phase 4: Testing & Polish
1. Test chronological ordering with mixed log types
2. Verify file opening functionality
3. Test state persistence across reloads
4. Add error handling for missing files

## Key Benefits

1. **Chronological Context**: File loading appears exactly when it happens in the process
2. **Actionable UI**: Click to open files directly in VS Code
3. **Round Separation**: Clear distinction between r0, r1, etc. file loading
4. **Backward Compatibility**: Existing log messages remain unchanged
5. **Persistent State**: Survives ProgressBoard reloads
6. **Structured Data**: Enables future enhancements like filtering or aggregation

## Migration Strategy

- Implement alongside existing log messages initially
- Gradually enhance the structured format
- Maintain backward compatibility with existing logs
- Add feature flag if needed for gradual rollout

## Documentation Updates

Update `docs/guide/progress-board.md` to include:
- Description of file loading status messages
- Examples of clickable file paths  
- Round-based organization explanation
- Screenshots of the enhanced UI