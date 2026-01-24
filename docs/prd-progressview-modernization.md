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

| Webview          | Handler Lines | JS Modules | Type Safety | Status   |
| ---------------- | ------------- | ---------- | ----------- | -------- |
| **ProgressView** | 1,526         | 67+        | None        | Critical |
| **MainView**     | 461           | 80+        | Partial     | High     |
| **MemoryView**   | 278           | 7          | None        | Low      |
| **ProfileView**  | 211           | 7          | None        | Low      |
| **HistoryView**  | 160           | 7          | None        | Low      |

## Goals

**Phase 1**: ProgressView — schema relocation + Lit UI
**Phase 2**: Extract shared infrastructure (proven patterns from Phase 1)
**Phase 3**: Migrate remaining webviews (MainView, HistoryView, ProfileView, MemoryView)

## Non-Goals

- Adding new features during migration
- Changing EventBus architecture
- Virtual scrolling (future optimization)
- CLI or web app support (but architecture doesn't preclude it)

---

## Existing Schemas (Single Source of Truth)

**60+ Zod schemas already exist.** The work is relocation to `src/shared/`, not re-exporting.

### Principle: No Re-Exports

Instead of creating `schemas.ts` files that re-export from multiple locations, **move schemas to a single location**:

```
BEFORE (scattered):
src/eventBus/schemas.ts      → TaskGroupSchema
src/logger/LogTypes.ts       → TaskGroupSchema (duplicate!)
src/agent/types/UsageTypes.ts → TokenUsageStatsSchema

AFTER (single source):
src/shared/schemas/
├── taskGroup.ts      → TaskGroupSchema (one location)
├── usage.ts          → TokenUsageStatsSchema
├── stream.ts         → StreamStatusSchema, StreamTabInfoSchema
├── prompts.ts        → ToolEditApprovalPromptSchema, etc.
├── output.ts         → OutputFileInfoSchema, FileLocationSchema
├── errors.ts         → ProviderErrorSchema
└── index.ts          → barrel export (only file that re-exports)
```

### Current Schema Locations (To Be Relocated)

| Current Location                       | Schemas                                                                                | New Location                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `src/eventBus/schemas.ts`              | `TodoItemSchema`, `AddTaskGroupPayloadSchema`, `UpdateTaskGroupPayloadSchema`          | `src/shared/schemas/taskGroup.ts`, `src/shared/schemas/todo.ts` |
| `src/eventBus/types.ts`                | `ToolEditApprovalPromptSchema`, `BashApprovalPromptSchema`, `RetryRequestPromptSchema` | `src/shared/schemas/prompts.ts`                                 |
| `src/logger/LogTypes.ts`               | `TaskGroupSchema`, `LogMessageDataSchema`                                              | `src/shared/schemas/taskGroup.ts`, `src/shared/schemas/log.ts`  |
| `src/logger/messageTypes.ts`           | `MessageTypeSchema`, `LogLevelSchema`                                                  | `src/shared/schemas/log.ts`                                     |
| `src/agent/types/UsageTypes.ts`        | `TokenUsageStatsSchema`                                                                | `src/shared/schemas/usage.ts`                                   |
| `src/agent/types/IdentifierTypes.ts`   | `StreamTabIdSchema`, `ExecutionIdSchema`                                               | `src/shared/schemas/identifiers.ts`                             |
| `src/agent/output/types.ts`            | `OutputFileInfoSchema`, `FileLineageSchema`                                            | `src/shared/schemas/output.ts`                                  |
| `src/common/constants/streamStatus.ts` | `StreamStatusSchema`, `TaskGroupStatusSchema`                                          | `src/shared/schemas/stream.ts`                                  |
| `src/common/errors/schemas.ts`         | `ProviderErrorSchema`, `RetryErrorInfoSchema`                                          | `src/shared/schemas/errors.ts`                                  |
| `src/progressView/types.ts`            | `StreamTabInfoSchema`, `StreamUITraitsSchema`                                          | `src/shared/schemas/stream.ts`                                  |

### Requires Extraction (Node.js Dependency)

| File                                | Issue                                               | Solution                                                    |
| ----------------------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| `src/utils/files/taskRunStorage.ts` | Mixes schemas with Node.js utilities (`path`, `fs`) | Move `FileLocationSchema` to `src/shared/schemas/output.ts` |

### Already Duplicated (Consolidate)

| Location 1                                 | Location 2                       | Action                                           |
| ------------------------------------------ | -------------------------------- | ------------------------------------------------ |
| `src/common/webview/commands.ts`           | `src/common/webview/commands.js` | Keep `.ts`, delete `.js` (ES module dual-export) |
| `src/logger/LogTypes.ts` (TaskGroupSchema) | `src/eventBus/schemas.ts`        | Consolidate in `src/shared/schemas/taskGroup.ts` |

Note: `src/progressView/modules/constants.js` already imports from `@common/webview/commands.js` (not a duplicate).

### Dependency Direction (Avoid Cycles)

Schemas must follow a strict dependency order to prevent circular imports:

```
identifiers.ts  → (no imports from shared/)
stream.ts       → identifiers
log.ts          → identifiers
usage.ts        → identifiers
output.ts       → identifiers, stream
taskGroup.ts    → stream, output
prompts.ts      → taskGroup
todo.ts         → (standalone)
errors.ts       → (standalone)
commands.ts     → (standalone, constants only)
```

**Rule**: Lower-level schemas cannot import from higher-level schemas.

### Migration Strategy (Atomic Per-Schema)

For each schema relocation, complete all steps in a **single commit** to avoid build breaks:

```bash
# Example: Relocating TaskGroupSchema

# 1. Create schema in shared/
# src/shared/schemas/taskGroup.ts

# 2. Find all consumers
grep -r "import.*TaskGroupSchema" src/

# 3. Update all imports atomically
# Change: import { TaskGroupSchema } from '@logger/LogTypes';
# To:     import { TaskGroupSchema } from '@shared/schemas';

# 4. Delete original definition from old file

# 5. If old file is empty, delete it

# 6. Single commit with all changes
git add . && git commit -m "refactor: relocate TaskGroupSchema to shared/schemas"
```

**Critical**: Never leave the codebase in a state where a schema is defined in two places or where imports point to a deleted location.

---

## Phase 1: ProgressView

### Milestone 1: Type-Safe IPC

#### Step 1.1: Create Shared Schema Directory

Create `src/shared/schemas/` with consolidated schemas (single source of truth):

```
src/shared/schemas/
├── identifiers.ts    # StreamTabIdSchema, ExecutionIdSchema
├── stream.ts         # StreamStatusSchema, StreamTabInfoSchema
├── taskGroup.ts      # TaskGroupSchema, TaskGroupStatusSchema
├── log.ts            # LogMessageDataSchema, MessageTypeSchema, LogLevelSchema
├── usage.ts          # TokenUsageStatsSchema
├── output.ts         # OutputFileInfoSchema, FileLocationSchema
├── prompts.ts        # ToolEditApprovalPromptSchema, BashApprovalPromptSchema, etc.
├── todo.ts           # TodoItemSchema, TodoStatusSchema
├── errors.ts         # ProviderErrorSchema, RetryErrorInfoSchema
├── commands.ts       # All command constants (replaces duplicates)
└── index.ts          # Single barrel export
```

**Example: `src/shared/schemas/identifiers.ts`**

```typescript
import { z } from 'zod';

export const StreamTabIdSchema = z.string().min(1);
export type StreamTabId = z.infer<typeof StreamTabIdSchema>;

export const ExecutionIdSchema = z.string().uuid();
export type ExecutionId = z.infer<typeof ExecutionIdSchema>;

export const StorageKeySchema = z.union([
  z.string().uuid(),
  z.literal('__default__'),
]);
export type StorageKey = z.infer<typeof StorageKeySchema>;
```

**Example: `src/shared/schemas/output.ts`** (includes relocated FileLocationSchema)

```typescript
import { z } from 'zod';
import { ExecutionIdSchema } from './identifiers';

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

export const OutputFileInfoSchema = z.object({
  source: z.string(),
  location: FileLocationSchema,
  round: z.number().optional(),
  // ... other fields
});

export type OutputFileInfo = z.infer<typeof OutputFileInfoSchema>;
```

#### Step 1.2: Update All Imports to Use Shared Directly

**No re-exports for backward compatibility.** Update all imports to point to `@shared/schemas`:

```typescript
// BEFORE: Import from scattered locations
import { TaskGroupSchema } from '@logger/LogTypes';
import { StreamStatusSchema } from '@common/constants/streamStatus';
import { FileLocationSchema } from '@utils/files/taskRunStorage';

// AFTER: Import from single source
import {
  TaskGroupSchema,
  StreamStatusSchema,
  FileLocationSchema,
} from '@shared/schemas';
```

**Migration approach:**

1. Create schemas in `src/shared/schemas/`
2. Find all imports of the old location (use grep/find-references)
3. Update imports to `@shared/schemas`
4. Delete the schema definition from the old file
5. If old file is now empty, delete it

**Example: `src/utils/files/taskRunStorage.ts`**

```typescript
// BEFORE: Schema + Node.js utilities mixed
export const FileLocationSchema = z.discriminatedUnion(...);
export function createRunStorageDir() { /* Node.js code */ }

// AFTER: Only Node.js utilities remain
import { FileLocationSchema } from '@shared/schemas';  // Use, don't define
export function createRunStorageDir() { /* Node.js code */ }
```

This ensures:

- **Single source of truth** - schema lives in ONE file
- **No re-export chains** - imports go directly to source
- **Clear ownership** - grep for schema name finds definition immediately
- **Browser safety** - `src/shared/` has no Node.js dependencies

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

### Milestone 2: Lit UI with vscode-elements

#### Current State

**M1 Complete:** Shared schemas in `src/shared/schemas/`, webpack bundle target configured, basic Lit `<progress-app>` shell exists with message handling. The current placeholder uses native HTML buttons instead of vscode-elements.

**Goal:** Rewrite the ProgressView frontend using Lit components while preserving the exact UI (vscode-elements) and all functionality from the legacy implementation.

#### Why Lit

| Vanilla JS Pain               | Lit Solution                                       |
| ----------------------------- | -------------------------------------------------- |
| 53 lines fragment batching    | `html\`${items.map(i => html\`...\`)}\``           |
| `if (container)` null checks  | Reactive `@property` auto-renders                  |
| 8 duplicate approval handlers | Single `<approval-panel kind="...">`               |
| 18 `isToolUse` conditionals   | Separate `<workflow-content>` / `<tooluse-content>`|
| `classList.add/remove/toggle` | `class=${classMap({ active: this.isActive })}`     |
| 7 "active" state locations    | Single reactive store                              |
| Manual event wiring           | Declarative `@click=${this.handler}`               |
| HTML `<template>` cloning     | Lit template functions (type-safe)                 |
| DOM queries in handlers       | Component state + refs via `@query`                |

#### Architecture Principles

##### 1. External CSS, Not Lit Scoped Styles

**Rationale:** The existing 26 CSS files (`src/progressView/styles/`) define a cohesive design system with VS Code theme integration. Rewriting these as Lit `css` tagged templates would be error-prone and wasteful.

**Strategy:**
- Keep external CSS files loaded via `<link>` in `index.html`
- Components render with standard class names (`.log-header`, `.stream-tab`, etc.)
- Use `static styles = css\`:host { display: contents; }\`` to make components transparent to external styles
- Only add component-scoped styles for layout that doesn't exist in external CSS

```typescript
// Components are transparent wrappers around styled DOM
@customElement('stream-tabs')
export class StreamTabs extends LitElement {
  // No shadowRoot styling - external CSS applies to light DOM classes
  protected createRenderRoot() { return this; }

  render() {
    // Classes like .tabs, .tab-container come from external tabs.css
    return html`<div class="tabs-content">...</div>`;
  }
}
```

##### 2. vscode-elements Integration

**Available Components (from `@vscode-elements/elements`):**
- Layout: `vscode-split-layout`, `vscode-scrollable`, `vscode-collapsible`
- Controls: `vscode-button`, `vscode-toolbar-button`, `vscode-toolbar-container`
- Forms: `vscode-textarea`, `vscode-single-select`, `vscode-option`, `vscode-checkbox`, `vscode-radio`, `vscode-radio-group`
- Menus: `vscode-context-menu`, `vscode-context-menu-item`
- Feedback: `vscode-progress-ring`

**Usage in Lit:**
```typescript
render() {
  return html`
    <vscode-toolbar-container class="header-actions">
      <vscode-toolbar-button
        icon="play"
        label="Run"
        @click=${this.handleRun}
      ></vscode-toolbar-button>
    </vscode-toolbar-container>
  `;
}
```

##### 3. Template Replacement Strategy

The legacy HTML has 17 `<template>` elements for dynamic content. Replace each with a Lit template function:

| Legacy Template                | Lit Replacement                          |
| ------------------------------ | ---------------------------------------- |
| `#streamTabTemplate`           | `renderStreamTab(stream: StreamTabInfo)` |
| `#fileItemTemplate`            | `renderFileItem(file: OutputFileInfo)`   |
| `#logLineTemplate`             | `renderLogLine(log: LogMessageData)`     |
| `#approvalRequestTemplate`     | `renderToolEditApproval(prompt)`         |
| `#bashApprovalRequestTemplate` | `renderBashApproval(prompt)`             |
| `#retryRequestTemplate`        | `renderRetryRequest(prompt)`             |
| `#workflowProposalTemplate`    | `renderAgentProposal(proposal)`          |
| `#userMessageTemplate`         | `renderUserMessage(msg)`                 |
| `#groupHeaderTemplate`         | `renderGroupHeader(group)`               |
| `#groupDetailsTemplate`        | `renderGroupContent(group)`              |
| `#roundHeaderTemplate`         | `renderRoundHeader(round)`               |
| `#usageTemplate`               | `renderUsageStats(usage)`                |
| `#queuedFollowUpTemplate`      | `renderQueuedFollowUp(text)`             |
| `#bannerDetailsTemplate`       | `renderBannerDetails(banner)`            |
| `#toolUseTemplate`             | `renderToolUse(toolUse)`                 |
| `#nativeStatusTemplate`        | `renderNativeStatus(status)`             |
| `#statisticsDetailsTemplate`   | `renderStatistics(stats)`                |

##### 4. State Architecture

**Current ProgressApp.ts State (to keep):**
```typescript
@state() private streams: StreamTabInfo[] = [];
@state() private activeStreamId: StreamTabId | null = null;
@state() private activeStatus: StreamStatus = STREAM_STATUS.READY;
@state() private streamFilter: AgentCategoryFilter = 'all';
@state() private toolEditBypass: Record<string, boolean> = {};
@state() private toolEditPrompts: ToolEditApprovalPrompt[] = [];
@state() private bashPrompts: BashApprovalPrompt[] = [];
@state() private retryPrompts: RetryRequestPrompt[] = [];
@state() private proposalPrompts: AgentProposalPrompt[] = [];
private streamStates = new Map<StreamTabId, StreamState>();
```

**StreamState (per-stream data):**
```typescript
interface StreamState {
  logs: LogMessageData[];
  groups: TaskGroup[];
  todos: TodoItem[];
  queuedFollowUps: string[];
  runInstructions: Record<string, InstructionUpdate>;
  activeRunId: string | null;
  outputFilesByRun: Record<string, Record<string, OutputFileInfo[]>>;
  missingOutputsByRun: Record<string, Record<string, string[]>>;
  usageByRun: Record<string, TokenUsageStats>;
  contextState: ContextState | null;
  instruction: InstructionUpdate | null;
}
```

**Key Pattern:** The current message handling in `ProgressApp.ts` is already well-structured. Keep it; extend the rendering.

---

#### Component Architecture

##### File Structure

```
src/progressView/frontend/
├── index.ts                    # Entry: imports ProgressApp
├── vscode.ts                   # VS Code postMessage wrapper
├── ProgressApp.ts              # Root component (extend existing)
└── components/
    ├── layout/
    │   ├── SplitLayout.ts      # Main split layout wrapper
    │   ├── LogHeader.ts        # Header with status, YOLO toggle
    │   └── UsageFooter.ts      # Context state, run summary
    ├── streams/
    │   ├── StreamTabs.ts       # Right panel: tab list + filters
    │   └── StreamTab.ts        # Single tab with delete button
    ├── content/
    │   ├── ContentArea.ts      # Switches workflow/tooluse based on category
    │   ├── WorkflowContent.ts  # Run selector, instruction, groups, files
    │   └── ToolUseContent.ts   # Logs, todos, follow-up input
    ├── logs/
    │   ├── LogContainer.ts     # vscode-scrollable with log entries
    │   ├── LogEntry.ts         # Single log line (text, banner, tool-use)
    │   └── UserMessage.ts      # User message bubble
    ├── tasks/
    │   ├── TaskGroup.ts        # Collapsible group with header
    │   ├── TodoList.ts         # Todo items display
    │   └── RunSelector.ts      # vscode-single-select for runs
    ├── files/
    │   ├── FileList.ts         # Generated files with round headers
    │   ├── FileItem.ts         # Single file with actions
    │   └── RoundCollapsible.ts # Round header (vscode-collapsible)
    ├── prompts/
    │   ├── PromptContainer.ts  # Container for all prompt types
    │   ├── ToolEditApproval.ts # File edit approval UI
    │   ├── BashApproval.ts     # Command approval UI
    │   ├── RetryRequest.ts     # Retry prompt UI
    │   └── AgentProposal.ts    # Workflow proposal UI
    ├── followup/
    │   ├── FollowUpInput.ts    # vscode-textarea with actions
    │   ├── FollowUpSection.ts  # Mode toggle, agent/model selects
    │   └── QueuedFollowUps.ts  # Queued messages collapsible
    └── shared/
        ├── InstructionPanel.ts # Instruction display with copy
        ├── MarkdownContent.ts  # Rendered markdown (reuse formatter)
        └── StatusIndicator.ts  # Status pill component
```

##### Component Hierarchy (Visual)

```
<progress-app>
└── <split-layout>                           # vscode-split-layout
    ├── [slot=start] <content-area>
    │   ├── <log-header>                     # Stream name, status, YOLO, toolbar
    │   │   └── <vscode-toolbar-container>
    │   ├── <run-selector>                   # (workflow only) vscode-single-select
    │   ├── <instruction-panel>              # (workflow only) Collapsible instruction
    │   ├── <prompt-container>               # Approval/retry/proposal prompts
    │   │   ├── <tool-edit-approval>[]
    │   │   ├── <bash-approval>[]
    │   │   ├── <retry-request>[]
    │   │   └── <agent-proposal>[]
    │   ├── <log-container>                  # vscode-scrollable
    │   │   ├── <user-message>[]             # (tooluse) User messages
    │   │   ├── <log-entry>[]                # Log lines, banners, tool-use
    │   │   └── <task-group>[]               # (workflow) Collapsible groups
    │   ├── <file-list>                      # vscode-collapsible
    │   │   └── <round-collapsible>[]
    │   │       └── <file-item>[]
    │   ├── <followup-section>               # (workflow) Mode toggle, selects
    │   ├── <todo-list>                      # vscode-collapsible (tooluse)
    │   ├── <usage-footer>                   # Context state, run summary
    │   └── <follow-up-input>                # vscode-textarea + actions
    │       └── <queued-follow-ups>          # vscode-collapsible
    │
    └── [slot=end] <stream-tabs>
        ├── <stream-tab>[]                   # Tab buttons with delete
        ├── <vscode-radio-group>             # Filter: All/Workflow/Chat
        └── <vscode-toolbar-container>       # Sort buttons, delete all
```

---

#### Migration Steps

##### Step 2.1: Setup Light DOM Rendering

Modify existing `ProgressApp.ts` to use light DOM for external CSS compatibility:

```typescript
@customElement('progress-app')
export class ProgressApp extends LitElement {
  // Use light DOM so external CSS applies
  protected createRenderRoot() {
    return this;
  }

  // ... existing state and handlers ...

  render() {
    return html`
      <div class="main-container">
        <vscode-split-layout initial-handle-position="80%">
          <div slot="start" class="content-area">
            ${this.renderLogHeader()}
            ${this.renderPromptContainer()}
            ${this.renderContentArea()}
            ${this.renderFollowUpInput()}
          </div>
          <div slot="end" class="tabs">
            ${this.renderStreamTabs()}
          </div>
        </vscode-split-layout>
      </div>
    `;
  }
}
```

##### Step 2.2: Port Log Header

Replace imperative DOM with declarative Lit template:

```typescript
private renderLogHeader() {
  const stream = this.activeStream;
  return html`
    <div class="log-header">
      <div class="log-header__primary">
        <div class="header-left">
          <div class="stream-header">
            <span id="activeStreamName">${stream?.label ?? ''}</span>
          </div>
          <span
            class="status-indicator ${this.getStatusClass()}"
            data-status="${this.activeStatus}"
          ></span>
          <vscode-toolbar-button
            id="yoloToggleBtn"
            icon="shield"
            label="${this.isYoloEnabled ? 'Disable' : 'Enable'} YOLO mode"
            title="${this.isYoloEnabled ? 'Disable' : 'Enable'} YOLO mode"
            class="yolo-toggle-button ${this.isYoloEnabled ? 'active' : ''}"
            @click=${this.handleToolEditBypassToggle}
          ></vscode-toolbar-button>
        </div>
        ${this.renderToolbar()}
      </div>
      ${this.isWorkflow ? this.renderRunSelectorRow() : nothing}
    </div>
  `;
}

private renderToolbar() {
  const isWorkflow = this.activeStream?.agentCategory === 'workflow';
  return html`
    <vscode-toolbar-container class="header-actions">
      ${isWorkflow ? html`
        <vscode-toolbar-button icon="play" label="Run" title="Start new run"
          @click=${() => this.handleStreamAction(PROGRESS_VIEW_COMMANDS.RUN_NEW)}
        ></vscode-toolbar-button>
        <vscode-toolbar-button icon="debug-continue" label="Resume" title="Resume"
          @click=${() => this.handleStreamAction(PROGRESS_VIEW_COMMANDS.RESUME)}
        ></vscode-toolbar-button>
        <vscode-toolbar-button icon="diff" label="Diff" title="Compare outputs"
          @click=${() => this.handleStreamAction(PROGRESS_VIEW_COMMANDS.DIFF_STREAM)}
        ></vscode-toolbar-button>
      ` : nothing}
      <vscode-toolbar-button icon="debug-stop" label="Stop" title="Stop execution"
        @click=${this.handleStreamStop}
      ></vscode-toolbar-button>
      <vscode-toolbar-button icon="folder" label="Storage" title="Open task storage"
        @click=${() => this.handleStreamAction(PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE)}
      ></vscode-toolbar-button>
    </vscode-toolbar-container>
  `;
}
```

##### Step 2.3: Port Stream Tabs

Replace template cloning with Lit iteration:

```typescript
private renderStreamTabs() {
  return html`
    <div id="streamTabs" class="tabs-content">
      ${this.streams.map(stream => this.renderStreamTab(stream))}
    </div>
    <div class="clear-all-container">
      <vscode-radio-group
        class="agent-filter-group"
        id="agentFilterButtons"
        value=${this.streamFilter}
        @change=${this.handleFilterChange}
      >
        <vscode-radio value="all">All</vscode-radio>
        <vscode-radio value="workflow">Workflow</vscode-radio>
        <vscode-radio value="toolUse">Chat</vscode-radio>
      </vscode-radio-group>
      ${this.renderSortButtons()}
    </div>
  `;
}

private renderStreamTab(stream: StreamTabInfo) {
  const isActive = stream.name === this.activeStreamId;
  return html`
    <div class="tab-container" title="${stream.label}">
      <button
        class="tab ${isActive ? 'active' : ''}"
        data-stream="${stream.name}"
        @click=${() => this.handleStreamClick(stream.name)}
      >
        <div class="tab-header">
          <span class="tab-status status-indicator ${this.getStreamStatusClass(stream)}"></span>
          <div class="tab-title">${stream.label}</div>
        </div>
        <div class="tab-meta">
          <span class="model">${stream.model}</span>
          <span class="last-active">${this.formatTimestamp(stream.lastTimestamp)}</span>
          ${stream.isRemote ? html`<i class="remote-agent codicon codicon-cloud"></i>` : nothing}
          <i class="agent-category codicon ${stream.agentCategory === 'workflow' ? 'codicon-workflow' : 'codicon-comment'}"></i>
        </div>
      </button>
      <vscode-toolbar-button
        class="tab-delete"
        data-stream="${stream.name}"
        icon="close"
        label="Delete stream"
        title="Delete stream"
        @click=${(e: Event) => {
          e.stopPropagation();
          this.handleStreamDelete(stream.name);
        }}
      ></vscode-toolbar-button>
    </div>
  `;
}
```

##### Step 2.4: Port Approval Prompts

Consolidate 4 approval templates into typed render methods:

```typescript
private renderPromptContainer() {
  const hasPrompts = this.toolEditPrompts.length || this.bashPrompts.length ||
                     this.retryPrompts.length || this.proposalPrompts.length;
  if (!hasPrompts) return nothing;

  return html`
    ${this.toolEditPrompts.length ? html`
      <div id="approvalRequests" class="approval-requests">
        <div class="approval-requests__header">
          <i class="codicon codicon-diff"></i>
          <span>Pending approvals</span>
        </div>
        <div class="approval-requests__list">
          ${this.toolEditPrompts.map(p => this.renderToolEditApproval(p))}
        </div>
      </div>
    ` : nothing}

    ${this.bashPrompts.length ? html`
      <div id="bashApprovalRequests" class="bash-approval-requests">
        <div class="bash-approval-requests__header">
          <i class="codicon codicon-terminal"></i>
          <span>Command approval</span>
        </div>
        <div class="bash-approval-requests__list">
          ${this.bashPrompts.map(p => this.renderBashApproval(p))}
        </div>
      </div>
    ` : nothing}

    ${this.retryPrompts.length ? html`
      <div id="retryRequests" class="retry-requests">
        <div class="retry-requests__header">
          <i class="codicon codicon-refresh"></i>
          <span>Retry available</span>
        </div>
        <div class="retry-requests__list">
          ${this.retryPrompts.map(p => this.renderRetryRequest(p))}
        </div>
      </div>
    ` : nothing}

    ${this.proposalPrompts.length ? html`
      <div id="workflowProposals" class="workflow-proposals">
        <div class="workflow-proposals__header">
          <i class="codicon codicon-play-circle"></i>
          <span>Agent Proposal</span>
        </div>
        <div class="workflow-proposals__list">
          ${this.proposalPrompts.map(p => this.renderAgentProposal(p))}
        </div>
      </div>
    ` : nothing}
  `;
}

private renderToolEditApproval(prompt: ToolEditApprovalPrompt) {
  return html`
    <div class="approval-request" data-request-id="${prompt.requestId}">
      <div class="approval-request__details">
        <div class="approval-request__path">${prompt.relativePath}</div>
        <div class="approval-request__meta">
          +${prompt.addedLines} / -${prompt.removedLines} lines
        </div>
      </div>
      <vscode-toolbar-container class="approval-request__actions">
        <vscode-toolbar-button icon="diff" label="Open diff"
          @click=${() => this.handlePromptAction(PROGRESS_VIEW_COMMANDS.TOOL_EDIT_OPEN_DIFF, { requestId: prompt.requestId })}
        >Open diff</vscode-toolbar-button>
        <vscode-toolbar-button icon="check" label="Approve"
          @click=${() => this.handlePromptAction(PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION, { requestId: prompt.requestId, action: 'approve' })}
        >Approve</vscode-toolbar-button>
        <vscode-toolbar-button icon="close" label="Reject"
          @click=${() => this.handlePromptAction(PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION, { requestId: prompt.requestId, action: 'reject' })}
        >Reject</vscode-toolbar-button>
      </vscode-toolbar-container>
    </div>
  `;
}

// Similar patterns for renderBashApproval, renderRetryRequest, renderAgentProposal
```

##### Step 2.5: Port File List with Collapsibles

```typescript
private renderFileList() {
  const state = this.activeStreamState;
  if (!state) return nothing;

  const runId = state.activeRunId ?? Object.keys(state.outputFilesByRun).at(-1);
  if (!runId) return nothing;

  const rounds = state.outputFilesByRun[runId] ?? {};
  const roundEntries = Object.entries(rounds).sort(([a], [b]) => Number(a) - Number(b));
  if (!roundEntries.length) return nothing;

  const showRoundHeaders = this.activeStream?.agentCategory !== 'toolUse';

  return html`
    <vscode-collapsible
      id="generatedFilesCollapsible"
      title="Generated Files"
      class="progress-collapsible files-collapsible"
      open
    >
      <div id="generatedFiles" class="files-container">
        ${roundEntries.map(([round, files]) =>
          showRoundHeaders
            ? this.renderRoundCollapsible(round, files)
            : files.map(f => this.renderFileItem(f))
        )}
      </div>
    </vscode-collapsible>
  `;
}

private renderRoundCollapsible(round: string, files: OutputFileInfo[]) {
  return html`
    <vscode-collapsible class="round-collapsible" open title="Round ${round}">
      <div class="round-content">
        ${files.map(f => this.renderFileItem(f))}
      </div>
    </vscode-collapsible>
  `;
}

private renderFileItem(file: OutputFileInfo) {
  const location = file.location;
  const displayPath = location.kind === 'workspace' || location.kind === 'runStorage'
    ? location.relativePath
    : location.absolutePath;

  return html`
    <div class="file-item">
      <span class="file-name">
        <span class="file-path clickable-link" @click=${() => this.handleFileOpen(file)}>
          <span class="file-dir">${this.getDirPart(displayPath)}</span>
          <span class="file-basename">${this.getBasename(displayPath)}</span>
        </span>
      </span>
      <vscode-toolbar-container class="file-actions">
        <vscode-toolbar-button class="compare-btn" icon="diff" label="Compare with base"
          @click=${() => this.handleFileCompareOriginal(file)}
        ></vscode-toolbar-button>
        <vscode-toolbar-button class="accept-btn" icon="check" label="Accept edits"
          @click=${() => this.handleFileAccept(file)}
        ></vscode-toolbar-button>
        <vscode-toolbar-button class="merge-btn" icon="git-merge" label="Merge edits"
          @click=${() => this.handleFileMerge(file)}
        ></vscode-toolbar-button>
        <vscode-toolbar-button class="prev-btn" icon="diff-added" label="Compare with previous"
          @click=${() => this.handleFileComparePrevious(file)}
        ></vscode-toolbar-button>
      </vscode-toolbar-container>
    </div>
  `;
}
```

##### Step 2.6: Port Follow-Up Input

```typescript
private renderFollowUpInput() {
  if (!this.activeStream) return nothing;

  const queued = this.activeStreamState?.queuedFollowUps ?? [];

  return html`
    <div id="followUpContainer" class="follow-up-container">
      ${queued.length ? html`
        <vscode-collapsible
          id="queuedFollowUpsCollapsible"
          title="Queued Messages"
          class="queued-follow-ups-collapsible"
          open
        >
          <div id="queuedFollowUpsList" class="queued-follow-ups-list">
            ${queued.map(text => html`
              <div class="queued-follow-up-item">
                <i class="codicon codicon-comment queued-follow-up-icon"></i>
                <span class="queued-follow-up-text">${text}</span>
              </div>
            `)}
          </div>
        </vscode-collapsible>
      ` : nothing}

      <div class="follow-up-input-row">
        <vscode-textarea
          id="followUpInput"
          placeholder="Send follow-up message"
          rows="10"
          resize="vertical"
          @keydown=${this.handleFollowUpKeydown}
        ></vscode-textarea>
        <div class="follow-up-actions">
          <vscode-toolbar-button id="polishFollowUpBtn" icon="sparkle"
            label="Polish" title="Polish with AI"
            @click=${this.handleFollowUpPolish}
          ></vscode-toolbar-button>
          <vscode-toolbar-button id="clearFollowUpBtn" icon="clear-all"
            label="Clear" title="Clear input"
            @click=${this.handleFollowUpClear}
          ></vscode-toolbar-button>
          <vscode-toolbar-button id="sendFollowUpBtn" icon="send"
            label="Send" title="Send follow-up"
            @click=${this.handleFollowUpSend}
          ></vscode-toolbar-button>
        </div>
      </div>
    </div>
  `;
}
```

##### Step 2.7: Port Log Container with Entry Types

```typescript
private renderLogContainer() {
  const logs = this.activeStreamState?.logs ?? [];
  const groups = this.activeStreamState?.groups ?? [];
  const isWorkflow = this.activeStream?.agentCategory === 'workflow';

  return html`
    <vscode-scrollable id="logContent" class="log-container">
      ${isWorkflow
        ? groups.map(group => this.renderTaskGroup(group))
        : logs.map(log => this.renderLogEntry(log))
      }
    </vscode-scrollable>
  `;
}

private renderLogEntry(log: LogMessageData) {
  // Dispatch to appropriate renderer based on log type
  switch (log.messageType) {
    case 'userMessage':
      return this.renderUserMessage(log);
    case 'toolUse':
      return this.renderToolUseEntry(log);
    case 'banner':
      return this.renderBannerDetails(log);
    default:
      return this.renderLogLine(log);
  }
}

private renderLogLine(log: LogMessageData) {
  return html`
    <div class="log-line" data-id="${log.id}">
      <span class="timestamp">${this.formatTime(log.timestamp)}</span>
      <span class="level ${log.level}">${log.level}</span>
      <span class="message">${log.text}</span>
    </div>
  `;
}

private renderUserMessage(log: LogMessageData) {
  return html`
    <div class="user-message-container">
      <div class="user-message">
        <div class="user-message-header">
          <i class="codicon codicon-account user-message-icon"></i>
          <span class="user-message-timestamp">${this.formatTime(log.timestamp)}</span>
        </div>
        <div class="user-message-content">${log.text}</div>
      </div>
    </div>
  `;
}

private renderTaskGroup(group: TaskGroup) {
  return html`
    <div class="log-group" data-group-id="${group.id}" data-run-id="${group.runId}">
      <details class="log-group-details" ?open=${group.status !== 'completed'}>
        <summary class="log-group-header">
          <span class="group-status-icon ${group.status}"></span>
          <span class="group-title">${group.name}</span>
          <span class="group-time">
            <span class="group-start-time">${this.formatTime(group.startTime)}</span>
            ${group.duration ? html`<span class="group-duration">${group.duration}ms</span>` : nothing}
          </span>
        </summary>
        <div class="log-group-content">
          ${group.children?.map(child => this.renderTaskGroup(child)) ?? nothing}
        </div>
      </details>
    </div>
  `;
}
```

---

#### Lit Patterns Reference

##### Conditional Rendering

```typescript
// Use `nothing` for empty output (not null/undefined)
${condition ? html`<div>content</div>` : nothing}

// Use `when` directive for lazy evaluation
${when(this.isLoading, () => html`<vscode-progress-ring></vscode-progress-ring>`)}
```

##### List Rendering with Keys

```typescript
// Use `repeat` for keyed lists (better performance for reordering)
${repeat(this.streams, stream => stream.name, stream => this.renderStreamTab(stream))}

// Use `map` for simple lists
${this.logs.map(log => this.renderLogLine(log))}
```

##### Class Binding

```typescript
// Use classMap for multiple conditional classes
class=${classMap({
  'stream-tab': true,
  'active': this.isActive,
  'is-running': this.status === 'running',
})}
```

##### Event Handling

```typescript
// Inline handlers for simple cases
@click=${this.handleClick}

// Arrow functions for parameters
@click=${() => this.handleAction(item.id)}

// Stop propagation inline
@click=${(e: Event) => { e.stopPropagation(); this.handleDelete(id); }}
```

##### DOM Queries

```typescript
// Use @query decorator instead of getElementById
@query('#followUpInput') private followUpInput!: HTMLTextAreaElement;

// Access in methods
this.followUpInput.value = '';
this.followUpInput.focus();
```

##### Refs for vscode-elements

```typescript
// vscode-elements have custom properties/methods
@query('vscode-single-select') private runSelector!: HTMLElement & { value: string };

handleRunChange() {
  const runId = this.runSelector.value;
  this.postCommand(PROGRESS_VIEW_COMMANDS.SELECT_RUN, { runId });
}
```

---

#### Migration Checklist

| Legacy Module                | Status | Lit Replacement                        |
| ---------------------------- | ------ | -------------------------------------- |
| `messageHandlers.js`         | ✅     | Already ported to `ProgressApp.ts`     |
| `progressViewState.js`       | ✅     | Using `@state()` decorators            |
| `domHandlers.js`             | 🔄     | Replace with render methods            |
| `StreamTabs.js`              | 🔄     | `renderStreamTabs()` + `renderStreamTab()` |
| `Toolbar.js`                 | 🔄     | `renderToolbar()`                      |
| `Status.js`                  | 🔄     | Inline in `renderLogHeader()`          |
| `FileList.js`                | 🔄     | `renderFileList()` + `renderFileItem()` |
| `RunSelector.js`             | 🔄     | `renderRunSelectorRow()`               |
| `InstructionPanel.js`        | 🔄     | `renderInstructionPanel()`             |
| `FollowUpInputManager.js`    | 🔄     | `renderFollowUpInput()`                |
| `ApprovalRequests.js`        | 🔄     | `renderToolEditApproval()`             |
| `BashApprovalRequests.js`    | 🔄     | `renderBashApproval()`                 |
| `RetryRequests.js`           | 🔄     | `renderRetryRequest()`                 |
| `WorkflowProposals.js`       | 🔄     | `renderAgentProposal()`                |
| `TodoList.js`                | 🔄     | `renderTodoList()`                     |
| `FollowupSectionManager.js`  | 🔄     | `renderFollowupSection()`              |
| `formatters/*.js`            | 🔄     | Port to TypeScript, use in renders     |
| `handlers/themeHandlers.js`  | ✅     | Keep external (CSS handles theming)    |
| `taskManagers.js`            | ✅     | Backend handles task management        |
| `usageManagers.js`           | 🔄     | `renderUsageFooter()`                  |

**Legend:** ✅ Complete | 🔄 To Port | ❌ Delete

---

#### M2 Deliverables

**Functional:**
- Full UI parity with legacy implementation
- All vscode-elements components working
- All 17 templates replaced with Lit render methods
- Message handling unchanged (already working)

**Code Quality:**
- Single `ProgressApp.ts` file (~2000-2500 lines) or split into components
- Type-safe templates (no string concatenation)
- Reactive state drives all rendering
- No imperative DOM manipulation

**Files:**
- Deleted: `src/progressView/modules/` (entire directory if still exists)
- Modified: `src/progressView/frontend/ProgressApp.ts` (extended)
- Kept: `src/progressView/styles/` (all 26 CSS files)
- Kept: `src/progressView/index.html` (minimal, loads bundle)

**Metrics:**
- External CSS: 26 files preserved (no duplication)
- Templates: 17 `<template>` → 17 render methods
- isToolUse checks: Encapsulated in `ContentArea` switching
- State locations: 1 (ProgressApp `@state()` properties)

---

## Phase 2: Extract Shared Infrastructure

**After ProgressView is stable**, extract patterns for other webviews.

### Existing Infrastructure to Leverage

Already exists in `src/common/`:

| Existing                  | Location          | Lit Migration Path                      |
| ------------------------- | ----------------- | --------------------------------------- |
| `BaseViewContentProvider` | `common/webview/` | Keep for HTML shell generation          |
| `BaseViewMessageHandler`  | `common/webview/` | Replace with `BaseWebviewApp` Lit class |
| `BaseWebviewProvider`     | `common/webview/` | Keep, add Lit bundle loading            |
| `domUtils.js`             | `common/modules/` | Delete after Lit migration              |
| `templateUtils.js`        | `common/modules/` | Delete after Lit migration              |
| `common.css`              | `common/styles/`  | Port design tokens to Lit CSS           |
| `WebviewStateManager`     | `common/modules/` | Wrap in Lit reactive controller         |
| `ToggleStateStore`        | `common/modules/` | Replace with Lit `@state`               |

### What Gets Extracted from ProgressView

| Pattern                | From ProgressView        | Shared Location                |
| ---------------------- | ------------------------ | ------------------------------ |
| Base Lit app class     | `ProgressApp.ts`         | `src/shared/BaseWebviewApp.ts` |
| Common Lit components  | `<prompt-overlay>`, etc. | `src/shared/components/`       |
| Reactive store pattern | `store.ts`               | `src/shared/createStore.ts`    |
| VS Code API wrapper    | Message posting          | `src/shared/vscode.ts`         |
| Design tokens          | CSS variables            | `src/shared/styles/tokens.css` |

Note: Schemas already live in `src/shared/schemas/` from Phase 1 (single source of truth).

### Shared Components (Proven in ProgressView)

Only extract components **actually used** by multiple webviews:

| Component           | ProgressView | MainView | Others |
| ------------------- | ------------ | -------- | ------ |
| `<texra-button>`    | ✓            | ✓        | ✓      |
| `<texra-tabs>`      | ✓            | ✓        | -      |
| `<texra-file-list>` | ✓            | ✓        | -      |
| `<texra-toolbar>`   | ✓            | ✓        | -      |

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

| Order | Webview         | Effort    | Rationale                             |
| ----- | --------------- | --------- | ------------------------------------- |
| 1     | **HistoryView** | 2-3 days  | Simplest (160 lines), good validation |
| 2     | **ProfileView** | 2-3 days  | Simple, mostly static display         |
| 3     | **MemoryView**  | 3-4 days  | Has toggle state, moderate complexity |
| 4     | **MainView**    | 1-2 weeks | Most complex after ProgressView       |

### Per-Webview Migration Template

For each webview:

#### Step 1: Schema Setup

```typescript
// src/{viewName}/schemas.ts
export * from '@shared/schemas'; // Common schemas
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
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
};

const webviewConfigs = [
  'progressView',
  'webview',
  'historyView',
  'profileView',
  'memoryView',
].map((name) => ({
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
    },
  },
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

**Mitigation**: Atomic migration — update all imports in single commit (see Migration Strategy). No re-exports.

### Medium: Shared Component Scope Creep

Tendency to over-extract into shared library.

**Mitigation**: Hard rule — nothing in `src/shared/components/` until used by 2+ webviews.

### Low: Bundle Size

Lit adds ~5KB gzipped per webview.

**Mitigation**: Acceptable tradeoff for maintainability. Modern VS Code handles this fine.

---

## Success Metrics

### After Phase 1 (ProgressView)

| Metric                   | Current    | After M1 | After M2 |
| ------------------------ | ---------- | -------- | -------- |
| Typed messages           | 0%         | 100%     | 100%     |
| Duplicate schema code    | 600+ lines | 0        | 0        |
| `isToolUse` conditionals | 18         | 18       | 0        |
| State tracking locations | 7          | 7        | 1        |
| Frontend lines           | ~3,700     | ~3,700   | ~1,550   |
| Approval handlers        | 8          | 8        | 1        |
| Files in modules/        | 67+        | 67+      | 0        |

### After Phase 2 (Shared Infrastructure)

| Metric            | Before | After        |
| ----------------- | ------ | ------------ |
| Shared components | 0      | 4-6          |
| Shared schemas    | 0      | 1 index file |
| Code reuse        | 0%     | ~30%         |

### After Phase 3 (All Webviews)

| Metric                       | Current | After  |
| ---------------------------- | ------- | ------ |
| Total webview JS files       | 168+    | ~40    |
| Type coverage (all webviews) | ~10%    | 100%   |
| Lit components               | 0       | ~50    |
| Total lines (all frontends)  | ~6,000  | ~3,000 |

---

## Timeline

| Phase                     | Scope                          | Duration  |
| ------------------------- | ------------------------------ | --------- |
| **Phase 1: ProgressView** |                                |           |
| M1: Type Safety           | Schema extraction + validation | 3-4 days  |
| M2: Lit UI                | Components + store             | 1-2 weeks |
| **Phase 2: Shared Infra** | Extract proven patterns        | 2-3 days  |
| **Phase 3: Other Views**  |                                |           |
| HistoryView               | Simplest migration             | 2-3 days  |
| ProfileView               | Static display                 | 2-3 days  |
| MemoryView                | Toggle state                   | 3-4 days  |
| MainView                  | Most complex                   | 1-2 weeks |

**Total: 5-7 weeks**

---

## Appendix: Current Issues

### Seven Places Track "Active" State

| Location                                 | Tracks                         |
| ---------------------------------------- | ------------------------------ |
| Backend `_activeStream`                  | Current stream                 |
| Backend `StreamSessionState.activeRunId` | Per-stream run                 |
| Frontend `state.activeStream`            | Current stream                 |
| Frontend `state.lastRenderedStream`      | Last rendered (band-aid)       |
| Frontend `state.activeRunIds`            | Per-stream run                 |
| Frontend `runSelector._pendingActiveId`  | UI selection buffer (band-aid) |
| Frontend `streamStatuses`                | Lifecycle                      |

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
