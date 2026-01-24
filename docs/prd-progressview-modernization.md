# PRD: ProgressView Modernization

## Overview

Rewrite ProgressView in Lit + TypeScript with type-safe IPC via relocated Zod schemas. Use ProgressView as the proving ground, then migrate other webviews.

## Problem Statement

### 1. No Type Safety Across Process Boundary

- EventBus has Zod schemas, but webview receives untyped messages
- Frontend uses JSDoc (~367 lines) instead of real types
- `commands.js` / `commands.ts` duplicated (298 lines each)

### 2. Overengineered State Management

- 7 places track "active" state (see Appendix)
- TaskGroup means "run" for Workflow, "turn" for ToolUse (semantic overloading)
- 6 band-aid workarounds scattered across codebase

### 3. Maintenance Burden

- `messageHandlers.js`: 1268-line switch statement
- 18 `isToolUse` references (10 branching conditionals, 8 derived)

### 4. Imperative DOM Patterns

- 53 lines of manual fragment batching (messageHandlers.js:632-684)
- DOM queries during render: `if (container)` checks
- 8 nearly-identical approval handlers (show/resolve pairs)
- Manual `classList.add/remove/toggle` everywhere

### 5. All Webviews Share These Problems

| Webview | Handler Lines | JS Modules | Type Safety | Status |
|---------|---------------|------------|-------------|--------|
| **ProgressView** | 1,526 | 67+ | None | Critical |
| **MainView** | 461 | 80+ | Partial | High |
| **MemoryView** | 278 | 7 | None | Low |
| **ProfileView** | 211 | 7 | None | Low |
| **HistoryView** | 160 | 7 | None | Low |

## Goals

**Phase 1**: ProgressView — schema relocation + Lit UI
**Phase 2**: Extract shared infrastructure (proven patterns from Phase 1)
**Phase 3**: Migrate remaining webviews (MainView, HistoryView, ProfileView, MemoryView)

## Non-Goals

- Adding new features during migration
- Changing EventBus architecture
- Virtual scrolling (future optimization)

---

## Cross-Webview Coordination Benefits

The codebase has significant cross-webview coordination that benefits from unified Lit + Zod infrastructure.

### Current Coordination Patterns

**1. Central Event Bus (ProgressEventBus)**
- Broadcasts 30+ event types to all subscribers
- Typed `ProgressEventPayloads` interface
- Event buffer replays events for late subscribers

**2. WebviewUpdater - Multi-View Broadcasting**
```typescript
// Sends to BOTH sidebar AND panel simultaneously
this.webviewUpdater = new WebviewUpdater(() => [
  this._view?.webview,      // Sidebar
  this._panelView?.webview, // Editor tab panel
]);
```

**3. Dual-View Architecture**
- ProgressView runs as both sidebar AND editor tab
- Both share single `ProgressViewState` (single source of truth)
- `retainContextWhenHidden: true` keeps webviews alive

**4. Promise-Based Coordinators**
- `RetryRequestCoordinator` - waits for user retry decision
- `AgentProposalCoordinator` - waits for proposal approval
- Tool approval handlers with YOLO bypass state per-stream

**5. Shared State via WorkspaceState**
```typescript
// Keys accessed by multiple views
STREAM_TABS, TASK_GROUPS, OUTPUT_FILES, ACTIVE_RUN_IDS,
ACTIVE_STREAM_TAB, TASK_STATES, EXECUTION_IDS, USAGE_STATS
```

### Shared Utilities Already Exist

| Utility | Used By | Purpose |
|---------|---------|---------|
| `BaseViewContentProvider` | All 5 views | HTML generation, module loading |
| `BaseViewMessageHandler` | All 5 views | Message routing, validation |
| `BaseWebviewProvider` | All 5 views | Lifecycle, panel management |
| `domUtils.js` | All 5 views | 25+ DOM manipulation functions |
| `templateUtils.js` | All 5 views | Template cloning, icon buttons |
| `common.css` | All 5 views | Design tokens, component styles |
| `WebviewStateManager` | All 5 views | VS Code state persistence |
| `ToggleStateStore` | Progress, History | Collapse/expand tracking |
| `RecordingManager` | Main, Progress | Audio recording |

### How Lit + Shared Schemas Help

| Current Pain | Improvement |
|--------------|-------------|
| 5 providers with boilerplate | Shared `BaseWebviewApp` Lit class |
| Untyped `postMessage` payloads | Zod-validated message schemas |
| Scattered visibility tracking | Unified lifecycle in Lit components |
| Duplicate UI patterns (badges, lists, collapsibles) | Shared Lit components |
| Manual DOM in `domUtils.js` | Declarative Lit templates |
| CSS class toggling | Lit's `classMap()` directive |
| Event handler registration | Type-safe event decorators |

### New Coordination Opportunities

With unified infrastructure:

```typescript
// Type-safe cross-view messaging
import { SyncStreamMessageSchema } from '@shared/schemas';

// In any webview
const result = SyncStreamMessageSchema.safeParse(message);
if (result.success) {
  store.updateStream(result.data);  // Same store pattern everywhere
}

// Shared components work identically in all views
html`<texra-file-list .files=${this.outputFiles}></texra-file-list>`
```

---

## Existing Schemas (Relocation, Not Creation)

**60+ Zod schemas already exist.** The work is relocation, not invention.

### Browser-Ready (No Changes Needed)

| Location | Schemas | Purpose |
|----------|---------|---------|
| `src/eventBus/schemas.ts` | `TaskGroupSchema`, `TodoItemSchema`, `AddTaskGroupPayloadSchema`, `UpdateTaskGroupPayloadSchema`, `UpdateTodosPayloadSchema`, `SetActiveStreamPayloadSchema` | Event payloads |
| `src/eventBus/types.ts` | `ToolEditApprovalPromptSchema`, `BashApprovalPromptSchema`, `RetryRequestPromptSchema`, `WorkflowAgentProposalSchema`, `ToolUseAgentProposalSchema` | Prompt types |
| `src/logger/LogTypes.ts` | `TaskGroupSchema`, `LogMessageDataSchema`, `LogMessageUpdateSchema` | Log entries |
| `src/logger/messageTypes.ts` | `MessageTypeSchema`, `LogLevelSchema`, `EndGroupStatusSchema`, `FileListEntrySchema` | Enums and types |
| `src/logger/UsageLogTypes.ts` | `UsageLogEntrySchema`, `UsageLogStatsSchema`, `UsageLogMetadataSchema` | Usage tracking |
| `src/agent/types/UsageTypes.ts` | `TokenUsageStatsSchema`, `ExtendedTokenUsageStatsSchema`, `StreamUsageMessageSchema` | Token counts |
| `src/agent/types/IdentifierTypes.ts` | `StreamTabIdSchema`, `ExecutionIdSchema`, `StorageKeySchema`, `ExecutionIdentitySchema` | Identifiers |
| `src/agent/output/types.ts` | `OutputFileSchema`, `OutputFileInfoSchema`, `FileLineageSchema` | Output files |
| `src/common/constants/streamStatus.ts` | `StreamStatusSchema`, `TaskGroupStatusSchema`, `ExecutionStatusSchema` | Status enums |
| `src/common/errors/schemas.ts` | `ProviderErrorSchema`, `RetryErrorInfoSchema`, `ErrorLogDataSchema` | Error types |
| `src/progressView/types.ts` | `StreamTabInfoSchema`, `StreamUITraitsSchema`, `InstructionMetadataSchema` | UI state |

### Requires Extraction

| File | Issue | Solution |
|------|-------|----------|
| `src/utils/files/taskRunStorage.ts` | Mixes schemas with Node.js utilities (`path`, `fs`) | Extract `FileLocationSchema`, `WorkspaceFileLocationSchema`, `RunStorageFileLocationSchema`, `ExternalFileLocationSchema` to `src/utils/files/FileLocationSchemas.ts` |

### Already Duplicated (Delete Frontend Copy)

| Backend (TypeScript) | Frontend (JavaScript) | Action |
|----------------------|----------------------|--------|
| `src/common/webview/commands.ts` | `src/progressView/modules/commands.js` | Delete JS (298 lines) |
| `src/common/constants/streamStatus.ts` | `src/progressView/modules/constants/streamStatus.js` | Delete JS |

---

## Phase 1: ProgressView

### Milestone 1: Type-Safe IPC

#### Step 1.1: Extract FileLocationSchema

Create `src/utils/files/FileLocationSchemas.ts`:

```typescript
import { z } from 'zod';
import { ExecutionIdSchema } from '@agent/types/IdentifierTypes';

export const WorkspaceFileLocationSchema = z.object({
  kind: z.literal('workspace'),
  absolutePath: z.string(),
  relativePath: z.string(),
});

export const RunStorageFileLocationSchema = z.object({
  kind: z.literal('runStorage'),
  absolutePath: z.string(),
  relativePath: z.string(),
  executionId: ExecutionIdSchema,
});

export const ExternalFileLocationSchema = z.object({
  kind: z.literal('external'),
  absolutePath: z.string(),
});

export const FileLocationSchema = z.discriminatedUnion('kind', [
  WorkspaceFileLocationSchema,
  RunStorageFileLocationSchema,
  ExternalFileLocationSchema,
]);

export type FileLocation = z.infer<typeof FileLocationSchema>;
export type WorkspaceFileLocation = z.infer<typeof WorkspaceFileLocationSchema>;
export type RunStorageFileLocation = z.infer<typeof RunStorageFileLocationSchema>;
export type ExternalFileLocation = z.infer<typeof ExternalFileLocationSchema>;
```

Update `taskRunStorage.ts` to import from new file (backward compatible re-export).

#### Step 1.2: Create Schema Re-Export

Create `src/progressView/schemas.ts`:

```typescript
// Re-export existing schemas for browser use
// NO NEW SCHEMAS - just imports from existing locations

// ============ Identifiers ============
export {
  StreamTabIdSchema,
  ExecutionIdSchema,
  StorageKeySchema,
  ExecutionIdentitySchema,
  type StreamTabId,
  type ExecutionId,
} from '@agent/types/IdentifierTypes';

// ============ Status ============
export {
  StreamStatusSchema,
  TaskGroupStatusSchema,
  ExecutionStatusSchema,
  type StreamStatus,
  type TaskGroupStatus,
} from '@common/constants/streamStatus';

// ============ Task Groups ============
export {
  TaskGroupSchema,
  LogMessageDataSchema,
  type TaskGroup,
  type LogMessageData,
} from '@logger/LogTypes';

export {
  AddTaskGroupPayloadSchema,
  UpdateTaskGroupPayloadSchema,
  type AddTaskGroupPayload,
  type UpdateTaskGroupPayload,
} from '@eventBus/schemas';

// ============ Usage ============
export {
  TokenUsageStatsSchema,
  ExtendedTokenUsageStatsSchema,
  type TokenUsageStats,
} from '@agent/types/UsageTypes';

// ============ Errors ============
export {
  ProviderErrorSchema,
  RetryErrorInfoSchema,
  type ProviderError,
} from '@common/errors/schemas';

// ============ Prompts ============
export {
  ToolEditApprovalPromptSchema,
  BashApprovalPromptSchema,
  RetryRequestPromptSchema,
  WorkflowAgentProposalSchema,
  ToolUseAgentProposalSchema,
  type ToolEditApprovalPrompt,
  type BashApprovalPrompt,
  type RetryRequestPrompt,
} from '@eventBus/types';

// ============ Output Files ============
export {
  OutputFileSchema,
  OutputFileInfoSchema,
  FileLineageSchema,
  type OutputFileInfo,
} from '@agent/output/types';

export {
  FileLocationSchema,
  type FileLocation,
} from '@utils/files/FileLocationSchemas';

// ============ Todos ============
export {
  TodoItemSchema,
  TodoStatusSchema,
  UpdateTodosPayloadSchema,
  type TodoItem,
} from '@eventBus/schemas';

// ============ UI State ============
export {
  StreamTabInfoSchema,
  StreamUITraitsSchema,
  InstructionMetadataSchema,
  type StreamTabInfo,
} from './types';

// ============ Log Message Types ============
export {
  MessageTypeSchema,
  LogLevelSchema,
  type MessageType,
  type LogLevel,
} from '@logger/messageTypes';
```

#### Step 1.3: Add Message Validation

Update `ProgressViewMessageHandler.ts` to validate incoming messages:

```typescript
import {
  AddTaskGroupPayloadSchema,
  UpdateTaskGroupPayloadSchema,
  UpdateTodosPayloadSchema,
  // ... other schemas
} from './schemas';

private handleMessage(message: { command: string; payload?: unknown }): void {
  switch (message.command) {
    case 'addTaskGroup': {
      const result = AddTaskGroupPayloadSchema.safeParse(message.payload);
      if (!result.success) {
        console.error('[ProgressView] Invalid addTaskGroup:', result.error.issues);
        return;
      }
      this.handleAddTaskGroup(result.data);
      break;
    }
    case 'updateTaskGroup': {
      const result = UpdateTaskGroupPayloadSchema.safeParse(message.payload);
      if (!result.success) {
        console.error('[ProgressView] Invalid updateTaskGroup:', result.error.issues);
        return;
      }
      this.handleUpdateTaskGroup(result.data);
      break;
    }
    // ... other cases
  }
}
```

#### Step 1.4: Delete Duplicates

```
DELETE: src/progressView/modules/commands.js (298 lines)
DELETE: src/progressView/modules/constants/streamStatus.js
UPDATE: All imports to use TypeScript sources
```

#### M1 Deliverables

- All messages validated with existing Zod schemas
- 600+ duplicate lines deleted
- Frontend receives typed data
- No UI changes, no new dependencies
- Build passes, extension works

---

### Milestone 2: Lit UI

#### Why Lit

| Vanilla JS Pain | Lit Solution |
|-----------------|--------------|
| 53 lines fragment batching | `html\`${items.map(i => html\`...\`)}\`` |
| `if (container)` null checks | Reactive `@property` auto-renders |
| 8 duplicate approval handlers | Single `<prompt-overlay kind="...">` |
| 18 `isToolUse` conditionals | Separate `<workflow-view>` / `<conversation-view>` |
| `classList.add/remove/toggle` | `class=${classMap({ active: this.isActive })}` |
| 7 "active" state locations | Single reactive store |
| Manual event wiring | Declarative `@click=${this.handler}` |

#### Step 2.1: Add Dependencies

```bash
npm install lit
```

Update `tsconfig.json` (if not already set):

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "useDefineForClassFields": false
  }
}
```

#### Step 2.2: Create Webpack Entry

Add to `webpack.config.js`:

```javascript
const progressViewConfig = {
  name: 'progressView',
  entry: './src/progressView/frontend/index.ts',
  output: {
    path: path.resolve(__dirname, 'dist/progressView'),
    filename: 'bundle.js',
  },
  target: 'web',
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      // Same aliases as main config
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
};

module.exports = [extensionConfig, progressViewConfig];
```

#### Step 2.3: Create Store

Create `src/progressView/frontend/store.ts`:

```typescript
import { reactive } from '@lit-labs/preact-signals';
import type {
  StreamTabInfo,
  TaskGroup,
  TodoItem,
  OutputFileInfo,
  TokenUsageStats,
} from '../schemas';

export interface ProgressState {
  // Stream state
  activeStreamId: string | null;
  streams: Map<string, StreamTabInfo>;

  // Workflow data (per stream)
  taskGroups: Map<string, Map<string, TaskGroup>>;
  activeRunIds: Map<string, string>;
  outputFiles: Map<string, OutputFileInfo[]>;
  usageStats: Map<string, TokenUsageStats>;

  // Conversation data (per stream)
  todos: Map<string, TodoItem[]>;

  // UI state
  activePrompt: PromptState | null;
  streamSortOrder: 'time' | 'agent' | 'inputFile';
  streamFilter: 'all' | 'workflow' | 'toolUse';
}

export type PromptState =
  | { kind: 'toolEdit'; data: ToolEditApprovalPrompt }
  | { kind: 'bash'; data: BashApprovalPrompt }
  | { kind: 'retry'; data: RetryRequestPrompt }
  | { kind: 'proposal'; data: WorkflowAgentProposal | ToolUseAgentProposal };

// Single source of truth
export const state = reactive<ProgressState>({
  activeStreamId: null,
  streams: new Map(),
  taskGroups: new Map(),
  activeRunIds: new Map(),
  outputFiles: new Map(),
  usageStats: new Map(),
  todos: new Map(),
  activePrompt: null,
  streamSortOrder: 'time',
  streamFilter: 'all',
});

// Derived state helpers
export function getActiveStream(): StreamTabInfo | undefined {
  return state.activeStreamId ? state.streams.get(state.activeStreamId) : undefined;
}

export function isWorkflow(): boolean {
  return getActiveStream()?.agentCategory === 'workflow';
}

export function getActiveRunId(): string | undefined {
  return state.activeStreamId ? state.activeRunIds.get(state.activeStreamId) : undefined;
}
```

#### Step 2.4: Build Components

**Component Hierarchy:**

```
<progress-app>                    # Root component, message handler
  ├── <stream-tabs>               # Tab bar with stream list
  │
  ├── <workflow-view>             # agentCategory === 'workflow'
  │   ├── <run-selector>          # Dropdown to switch runs
  │   ├── <instruction-panel>     # Shows run instruction
  │   ├── <task-list>             # Hierarchical task groups
  │   │   └── <task-group>        # Collapsible group with children
  │   ├── <file-list>             # Output files with round headers
  │   └── <workflow-toolbar>      # RUN_NEW, RESUME, DIFF, etc.
  │
  ├── <conversation-view>         # agentCategory === 'toolUse'
  │   ├── <todo-list>             # Todo items
  │   ├── <turn-list>             # Conversation turns
  │   │   └── <turn-item>         # Single turn with tool calls
  │   ├── <file-list>             # Output files (flat)
  │   ├── <followup-input>        # Input for follow-up messages
  │   └── <conversation-toolbar>  # STOP, RESTORE
  │
  └── <prompt-overlay>            # Modal for approvals/retry/proposal
      ├── <tool-edit-prompt>
      ├── <bash-prompt>
      ├── <retry-prompt>
      └── <proposal-prompt>
```

**Build Order:**

| Step | Component | Lines (est.) | Eliminates |
|------|-----------|--------------|------------|
| 1 | `<progress-app>` shell | ~100 | Entry point |
| 2 | `<stream-tabs>` | ~150 | Tab management code |
| 3 | `<prompt-overlay>` | ~200 | 8 duplicate handlers |
| 4 | `<workflow-view>` | ~300 | Half of isToolUse checks |
| 5 | `<conversation-view>` | ~250 | Other half of isToolUse |
| 6 | `<task-list>` + `<task-group>` | ~200 | Fragment batching |
| 7 | `<file-list>` | ~150 | File rendering logic |
| 8 | Remaining small components | ~200 | Cleanup |

**Total: ~1,550 lines replacing ~3,700 lines**

#### Step 2.5: Example Component

`src/progressView/frontend/components/PromptOverlay.ts`:

```typescript
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';
import type { PromptState } from '../store';

@customElement('prompt-overlay')
export class PromptOverlay extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      background: var(--vscode-editor-background, rgba(0,0,0,0.5));
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    :host([hidden]) { display: none; }

    .prompt-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 16px;
      max-width: 500px;
      width: 90%;
    }

    .actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 16px;
    }
  `;

  @property({ type: Object }) prompt: PromptState | null = null;

  render() {
    if (!this.prompt) return null;

    return html`
      <div class="prompt-card">
        ${when(this.prompt.kind === 'toolEdit', () => this._renderToolEdit())}
        ${when(this.prompt.kind === 'bash', () => this._renderBash())}
        ${when(this.prompt.kind === 'retry', () => this._renderRetry())}
        ${when(this.prompt.kind === 'proposal', () => this._renderProposal())}
      </div>
    `;
  }

  private _renderToolEdit() {
    const data = this.prompt!.data as ToolEditApprovalPrompt;
    return html`
      <h3>Tool Edit Approval</h3>
      <p>Allow edit to <code>${data.filePath}</code>?</p>
      <div class="actions">
        <button @click=${() => this._respond('reject')}>Reject</button>
        <button @click=${() => this._respond('approve')}>Approve</button>
      </div>
    `;
  }

  // ... similar for bash, retry, proposal

  private _respond(action: string) {
    this.dispatchEvent(new CustomEvent('prompt-response', {
      detail: { kind: this.prompt!.kind, action },
      bubbles: true,
    }));
  }
}
```

#### Step 2.6: Delete Legacy Code

After all components working:

```
DELETE: src/progressView/modules/ (entire directory - 67+ files)
UPDATE: src/progressView/index.html to load bundle.js
```

#### M2 Deliverables

- Lit-based UI with reactive state
- 18 `isToolUse` conditionals → 0 (separate components)
- 7 state tracking locations → 1 (store.ts)
- 8 approval handlers → 1 (`<prompt-overlay>`)
- ~3,700 lines → ~1,550 lines
- 67+ files deleted

---

## Phase 2: Extract Shared Infrastructure

**After ProgressView is stable**, extract patterns for other webviews.

### Existing Infrastructure to Leverage

Already exists in `src/common/`:

| Existing | Location | Lit Migration Path |
|----------|----------|-------------------|
| `BaseViewContentProvider` | `common/webview/` | Keep for HTML shell generation |
| `BaseViewMessageHandler` | `common/webview/` | Replace with `BaseWebviewApp` Lit class |
| `BaseWebviewProvider` | `common/webview/` | Keep, add Lit bundle loading |
| `domUtils.js` | `common/modules/` | Delete after Lit migration |
| `templateUtils.js` | `common/modules/` | Delete after Lit migration |
| `common.css` | `common/styles/` | Port design tokens to Lit CSS |
| `WebviewStateManager` | `common/modules/` | Wrap in Lit reactive controller |
| `ToggleStateStore` | `common/modules/` | Replace with Lit `@state` |

### What Gets Extracted from ProgressView

| Pattern | From ProgressView | Shared Location |
|---------|-------------------|-----------------|
| Schema re-export pattern | `progressView/schemas.ts` | `src/shared/schemas/index.ts` |
| Base Lit app class | `ProgressApp.ts` | `src/shared/BaseWebviewApp.ts` |
| Common Lit components | `<prompt-overlay>`, etc. | `src/shared/components/` |
| Reactive store pattern | `store.ts` | `src/shared/createStore.ts` |
| VS Code API wrapper | Message posting | `src/shared/vscode.ts` |
| Design tokens | CSS variables | `src/shared/styles/tokens.css` |

### Shared Components (Proven in ProgressView)

Only extract components **actually used** by multiple webviews:

| Component | ProgressView | MainView | Others |
|-----------|--------------|----------|--------|
| `<texra-button>` | ✓ | ✓ | ✓ |
| `<texra-tabs>` | ✓ | ✓ | - |
| `<texra-file-list>` | ✓ | ✓ | - |
| `<texra-toolbar>` | ✓ | ✓ | - |

**Rule**: No component goes in `src/shared/` until it's used by 2+ webviews.

### Directory Structure After Phase 2

```
src/
├── shared/                      # Extracted from ProgressView
│   ├── schemas/
│   │   ├── index.ts            # Common schema re-exports
│   │   ├── identifiers.ts      # StreamTabId, ExecutionId, etc.
│   │   ├── status.ts           # StreamStatus, TaskGroupStatus
│   │   └── errors.ts           # ProviderError, RetryErrorInfo
│   ├── components/
│   │   ├── Button.ts
│   │   ├── Tabs.ts
│   │   └── index.ts
│   ├── BaseWebviewApp.ts       # Message handling base class
│   └── vscode.ts               # VS Code API wrapper
│
├── progressView/
│   ├── frontend/               # Lit components
│   │   ├── index.ts
│   │   ├── store.ts
│   │   ├── ProgressApp.ts
│   │   └── components/
│   ├── schemas.ts              # Progress-specific + shared imports
│   └── ProgressViewMessageHandler.ts
│
├── webview/                    # MainView (Phase 3)
├── historyView/                # Phase 3
├── profileView/                # Phase 3
└── memoryView/                 # Phase 3
```

---

## Phase 3: Migrate Other Webviews

### Migration Order

| Order | Webview | Effort | Rationale |
|-------|---------|--------|-----------|
| 1 | **HistoryView** | 2-3 days | Simplest (160 lines), good validation |
| 2 | **ProfileView** | 2-3 days | Simple, mostly static display |
| 3 | **MemoryView** | 3-4 days | Has toggle state, moderate complexity |
| 4 | **MainView** | 1-2 weeks | Most complex after ProgressView |

### Per-Webview Migration Template

For each webview:

#### Step 1: Schema Setup
```typescript
// src/{viewName}/schemas.ts
export * from '@shared/schemas';  // Common schemas
// Add view-specific schemas if needed
```

#### Step 2: Create Lit App
```typescript
// src/{viewName}/frontend/index.ts
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import '@shared/components';  // Shared components

@customElement('{view-name}-app')
export class {ViewName}App extends LitElement {
  // ...
}
```

#### Step 3: Add Webpack Entry
```javascript
// webpack.config.js
const {viewName}Config = {
  name: '{viewName}',
  entry: './src/{viewName}/frontend/index.ts',
  // ... same pattern as progressView
};
```

#### Step 4: Delete Legacy
```
DELETE: src/{viewName}/modules/
UPDATE: src/{viewName}/index.html
```

### HistoryView Migration (Example)

**Current structure:**
- `HistoryViewMessageHandler.ts`: 160 lines
- `modules/`: 7 files (HistoryRenderer, SearchManager, etc.)

**After migration:**
```
src/historyView/
├── frontend/
│   ├── index.ts
│   ├── HistoryApp.ts          # ~200 lines total
│   └── components/
│       ├── HistoryList.ts
│       └── SearchBar.ts
├── schemas.ts                  # Re-exports + history-specific
└── HistoryViewMessageHandler.ts
```

**Estimated: 2-3 days**

### MainView Migration (Largest)

**Current structure:**
- `MainViewMessageHandler.ts`: 461 lines
- `modules/`: 80+ files (FileSelect, RecordingManager, etc.)

**Key challenges:**
- Complex file selection UI
- Multiple manager classes
- Recording functionality

**After migration:**
```
src/webview/
├── frontend/
│   ├── index.ts
│   ├── MainApp.ts
│   ├── store.ts
│   └── components/
│       ├── FileSelector/
│       │   ├── FileSelector.ts
│       │   ├── FileList.ts
│       │   └── FileItem.ts
│       ├── RecordingPanel.ts
│       ├── InstructionBox.ts
│       └── ActionButtons.ts
├── schemas.ts
└── MainViewMessageHandler.ts
```

**Estimated: 1-2 weeks**

---

## Build Configuration

### Final webpack.config.js

```javascript
const path = require('path');

const baseWebviewConfig = {
  target: 'web',
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@agent': path.resolve(__dirname, 'src/agent'),
      '@common': path.resolve(__dirname, 'src/common'),
      '@utils': path.resolve(__dirname, 'src/utils'),
      '@eventBus': path.resolve(__dirname, 'src/eventBus'),
      '@logger': path.resolve(__dirname, 'src/logger'),
    },
  },
  module: {
    rules: [
      { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
    ],
  },
};

const webviewConfigs = [
  'progressView',
  'webview',
  'historyView',
  'profileView',
  'memoryView',
].map(name => ({
  ...baseWebviewConfig,
  name,
  entry: `./src/${name}/frontend/index.ts`,
  output: {
    path: path.resolve(__dirname, `dist/${name}`),
    filename: 'bundle.js',
  },
}));

module.exports = [extensionConfig, ...webviewConfigs];
```

### tsconfig.json Updates

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "useDefineForClassFields": false,
    "paths": {
      "@shared/*": ["src/shared/*"],
      // ... existing paths
    }
  }
}
```

---

## Risks

### High: Breaking Existing Behavior

Schema validation may reject messages that currently "work" due to loose typing.

**Mitigation**: Use `safeParse`, log failures, don't crash. Fix upstream data issues.

### High: ProgressView Complexity

1,526-line handler is the hardest migration. If this fails, other webviews are at risk.

**Mitigation**: M1 (type safety) is independently valuable. Escape hatch preserves M1 if M2 fails.

### Medium: FileLocationSchema Extraction

Separating schemas from Node.js utilities may break imports elsewhere.

**Mitigation**: Re-export from original file for backward compatibility. Update imports incrementally.

### Medium: Shared Component Scope Creep

Tendency to over-extract into shared library.

**Mitigation**: Hard rule — nothing in `src/shared/components/` until used by 2+ webviews.

### Low: Bundle Size

Lit adds ~5KB gzipped per webview.

**Mitigation**: Acceptable tradeoff for maintainability. Modern VS Code handles this fine.

---

## Success Metrics

### After Phase 1 (ProgressView)

| Metric | Current | After M1 | After M2 |
|--------|---------|----------|----------|
| Typed messages | 0% | 100% | 100% |
| Duplicate schema code | 600+ lines | 0 | 0 |
| `isToolUse` conditionals | 18 | 18 | 0 |
| State tracking locations | 7 | 7 | 1 |
| Frontend lines | ~3,700 | ~3,700 | ~1,550 |
| Approval handlers | 8 | 8 | 1 |
| Files in modules/ | 67+ | 67+ | 0 |

### After Phase 2 (Shared Infrastructure)

| Metric | Before | After |
|--------|--------|-------|
| Shared components | 0 | 4-6 |
| Shared schemas | 0 | 1 index file |
| Code reuse | 0% | ~30% |

### After Phase 3 (All Webviews)

| Metric | Current | After |
|--------|---------|-------|
| Total webview JS files | 168+ | ~40 |
| Type coverage (all webviews) | ~10% | 100% |
| Lit components | 0 | ~50 |
| Total lines (all frontends) | ~6,000 | ~3,000 |

---

## Timeline

| Phase | Scope | Duration |
|-------|-------|----------|
| **Phase 1: ProgressView** | | |
| M1: Type Safety | Schema extraction + validation | 3-4 days |
| M2: Lit UI | Components + store | 1-2 weeks |
| **Phase 2: Shared Infra** | Extract proven patterns | 2-3 days |
| **Phase 3: Other Views** | | |
| HistoryView | Simplest migration | 2-3 days |
| ProfileView | Static display | 2-3 days |
| MemoryView | Toggle state | 3-4 days |
| MainView | Most complex | 1-2 weeks |

**Total: 5-7 weeks**

---

## Appendix: Current Issues

### Seven Places Track "Active" State

| Location | Tracks |
|----------|--------|
| Backend `_activeStream` | Current stream |
| Backend `StreamSessionState.activeRunId` | Per-stream run |
| Frontend `state.activeStream` | Current stream |
| Frontend `state.lastRenderedStream` | Last rendered (band-aid) |
| Frontend `state.activeRunIds` | Per-stream run |
| Frontend `runSelector._pendingActiveId` | UI selection buffer (band-aid) |
| Frontend `streamStatuses` | Lifecycle |

### Band-Aid Workarounds

1. `resolveActiveRunId()` - Iterates 4+ maps, called 9+ times per message
2. `lastRenderedStream` - Detecting stream switches via render state comparison
3. `_clearAgentCategoryState()` - Manual state wipe when switching workflow↔tooluse
4. `RunScopedMap` resolver closure - Hidden `activeStream` dependency
5. `_pendingActiveId` - Buffer for UI selection before backend confirms
6. 18 `isToolUse` references - Conditional logic scattered everywhere

### Imperative DOM Patterns

1. **Fragment batching** (messageHandlers.js:632-684)
   - 53 lines: `createDocumentFragment()` → nested loops → `appendChild()`

2. **DOM queries during render**
   - Pattern: `const el = getElementById(...); if (el) { el.innerHTML = ... }`

3. **Approval handler duplication**
   - 8 handlers: `showToolEditApproval`, `resolveToolEditApproval`, `showBashApproval`, `resolveBashApproval`, `showRetryRequest`, `resolveRetryRequest`, `showWorkflowProposal`, `resolveWorkflowProposal`

4. **Manual class toggling**
   - Pattern: `element.classList.add('active'); element.classList.remove('hidden');`

---

## References

- [Lit Documentation](https://lit.dev/)
- [Lit Reactive Controllers](https://lit.dev/docs/composition/controllers/)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [GitLens](https://github.com/gitkraken/vscode-gitlens) - Production Lit webviews in VS Code
- [Zod Documentation](https://zod.dev/)
