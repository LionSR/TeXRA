---
created: 2026-01-24
updated: 2026-05-04
---

# PRD: ProgressView Modernization - Phase 1

> **Parent doc:** [2026-01-24-prd-progressview-modernization.md](./2026-01-24-prd-progressview-modernization.md)

## Phase 1: ProgressView

This phase focuses on the ProgressView webview as the proving ground for the modernization approach.

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

### Milestone 2: Lit UI Implementation

This milestone rewrites the ProgressView frontend from imperative DOM manipulation to a modern Lit + TypeScript component architecture. The goal is **UI parity** with the existing implementation while dramatically improving code organization, type safety, and maintainability.

---

#### Implementation Status

##### Milestone 1: Schema Relocation

| Item              | Location              | Status  | Notes                          |
| ----------------- | --------------------- | ------- | ------------------------------ |
| identifiers.ts    | `src/shared/schemas/` | ✅ Done | StreamTabId, ExecutionId, etc. |
| stream.ts         | `src/shared/schemas/` | ✅ Done | StreamStatus, StreamTabInfo    |
| taskGroup.ts      | `src/shared/schemas/` | ✅ Done | TaskGroup, TaskGroupStatus     |
| log.ts            | `src/shared/schemas/` | ✅ Done | LogMessageData, MessageType    |
| usage.ts          | `src/shared/schemas/` | ✅ Done | TokenUsageStats                |
| output.ts         | `src/shared/schemas/` | ✅ Done | OutputFileInfo, FileLocation   |
| prompts.ts        | `src/shared/schemas/` | ✅ Done | All approval prompt schemas    |
| todo.ts           | `src/shared/schemas/` | ✅ Done | TodoItem, TodoStatus           |
| errors.ts         | `src/shared/schemas/` | ✅ Done | ProviderError, RetryErrorInfo  |
| agent.ts          | `src/shared/schemas/` | ✅ Done | Agent-related schemas          |
| proposalFields.ts | `src/shared/schemas/` | ✅ Done | Proposal field schemas         |
| index.ts          | `src/shared/schemas/` | ✅ Done | Barrel export                  |

##### Milestone 2: Frontend Infrastructure

| Item           | File                 | Status  | Notes                                   |
| -------------- | -------------------- | ------- | --------------------------------------- |
| Entry point    | `frontend/index.ts`  | ✅ Done | Registers `<progress-app>`              |
| HTML shell     | `index.html`         | ✅ Done | Loads bundle, CSP configured            |
| Host bridge    | `@shared/hostBridge` | ✅ Done | `postMessage()` wrapper                 |
| State types    | `frontend/store.ts`  | ✅ Done | `ProgressState`, `StreamState`, helpers |
| Webpack config | `webpack.config.js`  | ✅ Done | progressView bundle target              |

##### Milestone 2: Core Components

| Component         | File                             | Status  | Notes                              |
| ----------------- | -------------------------------- | ------- | ---------------------------------- |
| Root app          | `ProgressApp.ts`                 | ✅ Done | Lit layout + full message routing  |
| Prompt overlay    | `components/PromptOverlay.ts`    | ✅ Done | Tool edit, bash, retry, proposal   |
| Stream tabs       | `components/StreamTabs.ts`       | ✅ Done | Filter + sort + delete + clear all |
| Stream header     | `components/StreamHeader.ts`     | ✅ Done | Status + toolbar                   |
| Run selector      | `components/RunSelector.ts`      | ✅ Done | Workflow only                      |
| Instruction panel | `components/InstructionPanel.ts` | ✅ Done | Copyable instruction display       |
| Todo list         | `components/TodoList.ts`         | ✅ Done | Tool-use only                      |
| File list         | `components/FileList.ts`         | ✅ Done | With round headers                 |
| Task groups       | `components/TaskGroupList.ts`    | ✅ Done |                                    |
| Log list          | `components/LogList.ts`          | ✅ Done | Complex formatters                 |
| Usage panel       | `components/UsagePanel.ts`       | ✅ Done |                                    |
| Follow-up input   | `components/FollowUpInput.ts`    | ✅ Done | Text, record, polish, send         |
| Queued follow-ups | `components/QueuedFollowUps.ts`  | ✅ Done |                                    |

##### Message Handling (in ProgressApp.ts)

| Message Type                    | Handler                             | Status  | Notes         |
| ------------------------------- | ----------------------------------- | ------- | ------------- |
| UPDATE_STREAMS                  | `handleUpdateStreams`               | ✅ Done | Zod validated |
| UPDATE_LOGS                     | `handleUpdateLogs`                  | ✅ Done | Zod validated |
| APPEND_LOG                      | `handleAppendLog`                   | ✅ Done | Zod validated |
| UPDATE_LOG                      | `handleUpdateLog`                   | ✅ Done | Zod validated |
| UPDATE_STATUS                   | `handleUpdateStatus`                | ✅ Done | Zod validated |
| UPDATE_STREAM_STATUS            | `handleUpdateStreamStatus`          | ✅ Done | Zod validated |
| UPDATE_FILES                    | `handleUpdateFiles`                 | ✅ Done | Zod validated |
| UPDATE_MISSING_OUTPUTS          | `handleUpdateMissingOutputs`        | ✅ Done | Zod validated |
| UPDATE_INSTRUCTION              | `handleUpdateInstruction`           | ✅ Done | Zod validated |
| UPDATE_QUEUED_FOLLOW_UPS        | `handleUpdateQueuedFollowUps`       | ✅ Done | Zod validated |
| UPDATE_RUN_USAGE                | `handleUpdateRunUsage`              | ✅ Done | Zod validated |
| UPDATE_CONTEXT_STATE            | `handleUpdateContextState`          | ✅ Done | Zod validated |
| ADD_TASK_GROUP                  | `handleAddTaskGroup`                | ✅ Done | Zod validated |
| UPDATE_TASK_GROUP               | `handleUpdateTaskGroup`             | ✅ Done | Zod validated |
| UPDATE_TODOS                    | `handleUpdateTodos`                 | ✅ Done | Zod validated |
| SHOW_TOOL_EDIT_APPROVAL         | `handleShowToolEditApproval`        | ✅ Done | Zod validated |
| RESOLVE_TOOL_EDIT_APPROVAL      | `handleResolveToolEditApproval`     | ✅ Done | Zod validated |
| UPDATE_TOOL_EDIT_APPROVAL_STATE | `handleUpdateToolEditApprovalState` | ✅ Done | Zod validated |
| SHOW_BASH_APPROVAL              | `handleShowBashApproval`            | ✅ Done | Zod validated |
| RESOLVE_BASH_APPROVAL           | `handleResolveBashApproval`         | ✅ Done | Zod validated |
| SHOW_RETRY_REQUEST              | `handleShowRetryRequest`            | ✅ Done | Zod validated |
| RESOLVE_RETRY_REQUEST           | `handleResolveRetryRequest`         | ✅ Done | Zod validated |
| SHOW_AGENT_PROPOSAL             | `handleShowAgentProposal`           | ✅ Done | Zod validated |
| RESOLVE_AGENT_PROPOSAL          | `handleResolveAgentProposal`        | ✅ Done | Zod validated |

##### Formatters

| Formatter         | File                             | Status  | Notes              |
| ----------------- | -------------------------------- | ------- | ------------------ |
| Log formatter     | `formatters/logFormatter.ts`     | ✅ Done | Ported from legacy |
| Markdown renderer | `formatters/markdownRenderer.ts` | ✅ Done | Ported from legacy |
| Timestamp utils   | `formatters/timestampUtils.ts`   | ✅ Done | Ported from legacy |
| Word diff         | `formatters/wordDiff.ts`         | ✅ Done | Ported from legacy |

##### Legacy Modules (to delete after migration)

| Category    | Files        | Lines       | Status     |
| ----------- | ------------ | ----------- | ---------- |
| UI Managers | 17 files     | ~1,800      | ✅ Removed |
| Formatters  | 11 files     | ~1,200      | ✅ Removed |
| Core        | 5 files      | ~800        | ✅ Removed |
| **Total**   | **40 files** | **~10,000** | ✅ Removed |

##### CSS Files (with Lit-Specific Fixes)

External CSS in `styles/` directory works with light DOM rendering, with critical fixes for custom element flex layout.

**CSS Fixes Applied (2026-01-25):**

| File       | Fix                                                    | Issue Resolved                         |
| ---------- | ------------------------------------------------------ | -------------------------------------- |
| `logs.css` | Added `display: flex` + flex props for custom elements | Scrollbar not working on log container |
| `tabs.css` | Added `display: flex` for `stream-tabs`                | Tab panel overflow not scrolling       |

**Root cause:** Custom elements (`<log-list>`, `<task-group-list>`, `<stream-tabs>`) default to `display: inline` and don't participate in flex layout. Must explicitly set `display: flex` and flex properties.

```css
/* Example fix from logs.css */
task-group-list,
log-list {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
```

##### Regression Fixes and Stabilization (2026-01-25)

Fixes applied after initial Lit migration to address known regressions:

| Bug                                     | Root Cause                                             | Fix Location         | Status           |
| --------------------------------------- | ------------------------------------------------------ | -------------------- | ---------------- |
| Duplicate content on stream tab click   | `renderLogs()` appended without clearing first         | `LogList.ts:115`     | ✅ Fixed         |
| Leftover content when switching filters | `handleUpdateStreams()` didn't clear on stream change  | `messageHandlers.ts` | ✅ Fixed         |
| "No runs yet" placeholder not showing   | `clear()` didn't call `showPlaceholderIfEmpty()`       | `LogList.ts:266`     | ✅ Fixed         |
| Updates arriving before log exists      | Race condition between UPDATE_LOG and APPEND_LOG       | `messageHandlers.ts` | ✅ Fixed         |
| Radio group no default selection        | Property set but attribute not synced for vscode-radio | `StreamTabs.ts`      | ✅ Fixed         |
| Other UI regressions                    | Unknown - requires real-world testing                  | TBD                  | 🟡 Investigating |

**Key insight:** These bugs stemmed from data flow issues, not Lit-specific problems. The root causes were:

1. **Missing clearing** - Always clear container before full re-render
2. **Missing state transitions** - Clear content when switching streams or to empty categories
3. **Message ordering** - Handle UPDATE_LOG arriving before APPEND_LOG via pending updates Map

**Status:** UI parity testing is ongoing. The fixes above address known issues, but additional regressions may exist that require real-world usage to surface.

##### Message Handler Patterns Established

The following patterns were established to handle edge cases properly:

**1. Pending Log Updates Pattern**

Handles race condition where UPDATE_LOG arrives before APPEND_LOG:

```typescript
// messageHandlers.ts
const pendingLogUpdates = new Map<string, Partial<LogMessageData>>();

export function handleUpdateLog(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const logId = result.data.logMessage.id;
  const logExists = streamState.logs.some((entry) => entry.id === logId);

  if (!logExists) {
    // Store update for when APPEND_LOG arrives
    pendingLogUpdates.set(logId, {
      ...existingUpdate,
      ...result.data.logMessage,
    });
    return;
  }
  // Normal update path...
}

export function handleAppendLog(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const pendingUpdate = logId ? pendingLogUpdates.get(logId) : null;
  const mergedLogMessage = pendingUpdate
    ? { ...result.data.logMessage, ...pendingUpdate }
    : result.data.logMessage;

  if (logId && pendingUpdate) {
    pendingLogUpdates.delete(logId);
  }
  // Append merged message...
}
```

**2. Stream Switch Clearing Pattern**

Clear content when switching streams or filtering to empty category:

```typescript
// messageHandlers.ts - handleUpdateStreams
const isStreamSwitch = activeStream !== previousStreamId;
if (!activeStream || isStreamSwitch) {
  const logList = ctx.getLogListRef();
  logList?.clear(); // Triggers placeholder display
}
```

**3. Auto-Expand Pattern for Specific Message Types**

```typescript
const AUTO_EXPAND_MESSAGE_TYPES = new Set(['thinking', 'scratchpad']);

// In handleAppendLog:
const shouldAutoExpand = AUTO_EXPAND_MESSAGE_TYPES.has(
  mergedLogMessage.messageType ?? '',
);
ctx
  .getLogListRef()
  ?.appendLog(mergedLogMessage, { defaultOpen: shouldAutoExpand });
```

**4. Stream-Scoped Prompt Filtering**

Prompts only shown for tool-use agents, filtered by active stream:

```typescript
// ProgressApp.ts
private getFilteredPrompts(activeStreamId: string | null, isToolUse: boolean): PromptState[] {
  if (!isToolUse) return [];
  if (!activeStreamId) return [];

  return this.prompts.filter((prompt) => {
    const promptStreamId = prompt.data.streamId;
    if (!promptStreamId) return true;  // Global prompts
    return promptStreamId === activeStreamId;
  });
}
```

---

#### Clean Implementation Principles

##### Principle 1: Avoid Unnecessary Map Conversions

**Current Problem:** `recordToRoundMap()`, `mergeRecordIntoMap()`, `mergeRunRoundMap()` convert JSON Records to Maps.

**Question:** Do we actually need Maps?

| Use Case                      | Record                     | Map                    | Verdict          |
| ----------------------------- | -------------------------- | ---------------------- | ---------------- |
| Property lookup by string key | ✅ `obj[key]`              | ✅ `map.get(key)`      | Either works     |
| Iteration                     | ✅ `Object.entries()`      | ✅ `map.entries()`     | Either works     |
| Numeric keys (rounds)         | ⚠️ Keys coerced to strings | ✅ Native number keys  | Map preferred    |
| JSON wire format              | ✅ Native                  | ❌ Requires conversion | Record preferred |

**Decision:** Keep wire format (Records) in state. Sort rounds at render time only when needed.

```typescript
// Simpler state - matches wire format, no conversion
interface StreamState {
  runInstructions: Record<string, InstructionUpdate>;
  runUsage: Record<string, TokenUsageStats>;
  runFiles: Record<string, Record<string, OutputFileInfo[]>>; // runId → round → files
}

// Sort rounds lazily at render time
function getSortedRounds(
  roundsRecord: Record<string, OutputFileInfo[]>,
): [number, OutputFileInfo[]][] {
  return Object.entries(roundsRecord)
    .map(([k, v]) => [Number(k), v] as [number, OutputFileInfo[]])
    .sort((a, b) => a[0] - b[0]);
}
```

**Result:** Eliminates 3 conversion methods. State shape matches wire format directly.

##### Principle 2: Schemas Stay Separate (They Differ)

The 24 message schemas have **genuinely different shapes** - this is correct:

| Schema                       | Unique Fields                            |
| ---------------------------- | ---------------------------------------- |
| `UpdateStreamsMessageSchema` | `streams`, `activeStream`, `agentFilter` |
| `AppendLogMessageSchema`     | `stream`, `logMessage`                   |
| `UpdateFilesMessageSchema`   | `stream`, `runId`, `rounds`, `reset`     |
| `ShowToolEditApprovalSchema` | `request` (ToolEditApprovalPrompt)       |

**Keep 24 separate schemas.** Don't force them into a discriminated union.

##### Principle 3: Unified Prompt State (Internal)

**Current:** 4 show + 4 resolve handlers with different ID field names.

| Prompt Type | ID Field in Wire Format |
| ----------- | ----------------------- |
| Tool Edit   | `requestId`             |
| Bash        | `requestId`             |
| Retry       | `streamId`              |
| Proposal    | `proposalId`            |

**Clean Approach:** Keep wire handlers (faithful to backend), normalize to unified internal state:

```typescript
// Unified prompt with consistent `id` field
type PromptState =
  | { kind: 'toolEdit'; id: string; data: ToolEditApprovalPrompt }
  | { kind: 'bash'; id: string; data: BashApprovalPrompt }
  | { kind: 'retry'; id: string; data: RetryRequestPrompt }
  | { kind: 'proposal'; id: string; data: AgentProposalPrompt };

// Show handlers normalize ID field
private handleShowToolEditApproval(raw: unknown) {
  const result = ShowToolEditApprovalSchema.safeParse(raw);
  if (!result.success) return;
  this.addPrompt({
    kind: 'toolEdit',
    id: result.data.request.requestId,  // Normalize to `id`
    data: result.data.request,
  });
}

// Single internal resolve method
private resolvePromptById(kind: PromptState['kind'], id: string) {
  this.prompts = this.prompts.filter(p => !(p.kind === kind && p.id === id));
}

// Wire handlers delegate to unified method
private handleResolveToolEditApproval(raw: unknown) {
  const result = ResolveToolEditApprovalSchema.safeParse(raw);
  if (!result.success) return;
  this.resolvePromptById('toolEdit', result.data.requestId);
}
```

**Result:** 8 wire handlers remain (faithful to backend). Internal logic is consolidated.

##### Principle 4: Workflow vs Tool-Use Component Separation

**Problem:** `isToolUse` checks scattered in render methods.

**Clean Approach:** Dedicated container components as separation boundary.

```
<progress-app>
  <stream-tabs />

  <!-- Workflow: runs, hierarchical tasks, round-grouped files -->
  <workflow-content>          <!-- Only renders if agentCategory === 'workflow' -->
    <run-selector />
    <instruction-panel />
    <task-group-list />
    <file-list showRoundHeaders />
    <workflow-toolbar />
  </workflow-content>

  <!-- Tool-use: turns, todos, flat files -->
  <tooluse-content>           <!-- Only renders if agentCategory === 'toolUse' -->
    <todo-list />
    <turn-list />
    <file-list flat />
    <follow-up-input />
    <tooluse-toolbar />
  </tooluse-content>

  <prompt-overlay />
</progress-app>
```

**Component Ownership Matrix:**

| Component             | Workflow-only | Tool-use-only |        Shared        |
| --------------------- | :-----------: | :-----------: | :------------------: |
| `<stream-tabs>`       |               |               |          ✅          |
| `<run-selector>`      |      ✅       |               |                      |
| `<instruction-panel>` |      ✅       |               |                      |
| `<task-group-list>`   |      ✅       |               |                      |
| `<todo-list>`         |               |      ✅       |                      |
| `<turn-list>`         |               |      ✅       |                      |
| `<file-list>`         |               |               | ✅ (different props) |
| `<follow-up-input>`   |               |               |          ✅          |
| `<usage-panel>`       |               |               |          ✅          |
| `<workflow-toolbar>`  |      ✅       |               |                      |
| `<tooluse-toolbar>`   |               |      ✅       |                      |
| `<prompt-overlay>`    |               |               |          ✅          |

**Key Insight:** No `isToolUse` checks inside leaf components. The `<workflow-content>` and `<tooluse-content>` wrappers are the single branching point.

---

#### Architecture Decisions

##### Decision 1: Component Splitting Strategy

**Approach: Modular Component Tree**

Split into focused components rather than a single large file. Each component handles one UI concern.

```
src/progressView/frontend/
├── index.ts                    # Entry point, registers all components
├── store.ts                    # State types + helpers (existing)
├── hostBridge.ts               # Shared host bridge wrapper
├── ProgressApp.ts              # Root: message routing + layout (~300 lines)
├── components/
│   ├── PromptOverlay.ts        # Approval/retry overlay (existing, ~200 lines)
│   ├── StreamTabs.ts           # Tab bar with filter/sort (~250 lines)
│   ├── StreamHeader.ts         # Active stream header + toolbar (~200 lines)
│   ├── RunSelector.ts          # Run dropdown for workflow (~150 lines)
│   ├── InstructionPanel.ts     # Agent instruction display (~80 lines)
│   ├── TodoList.ts             # Todo items for tool-use (~120 lines)
│   ├── FileList.ts             # Output files with round headers (~200 lines)
│   ├── TaskGroupList.ts        # Task group rendering (~180 lines)
│   ├── LogList.ts              # Log message rendering (~250 lines)
│   ├── UsagePanel.ts           # Token usage statistics (~100 lines)
│   ├── FollowUpInput.ts        # Follow-up text input (~150 lines)
│   ├── QueuedFollowUps.ts      # Queued follow-up display (~80 lines)
│   └── index.ts                # Barrel export for components
└── formatters/
    ├── logFormatter.ts         # Log entry HTML generation (~300 lines)
    ├── markdownRenderer.ts     # Markdown → HTML (~100 lines)
    ├── timestampUtils.ts       # Time formatting (~50 lines)
    └── index.ts                # Barrel export
```

**Estimated Total: ~2,300 lines** (replacing ~10,000 lines in modules/)

##### Decision 2: External CSS Strategy

**Approach: Disable Shadow DOM, Use External Stylesheets**

Components use `createRenderRoot() { return this; }` to render to light DOM, allowing external CSS to style component internals.

**CSS Status - NO CHANGES NEEDED:**

| Metric          | Value                          | Action                  |
| --------------- | ------------------------------ | ----------------------- |
| Total CSS Lines | 2,559                          | ✅ Keep as-is           |
| Files           | 30 (progressView) + 1 (common) | ✅ Keep as-is           |
| Architecture    | BEM-inspired, modular          | ✅ Compatible with Lit  |
| Theme Variables | 55+ (VS Code tokens)           | ✅ Cascade to light DOM |
| vscode-elements | `::part()` selectors           | ✅ Still work           |

**Loading (unchanged):**

```
index.html
├── common.css      (global variables, utilities, animations)
├── index.css       (@imports 30 component CSS files)
└── codicon.css     (VS Code icons)
```

**Why no CSS changes:**

- Light DOM components use same class names as legacy code
- CSS selectors (`.stream-tab`, `.todo-item`, etc.) match Lit output
- Theme variables cascade normally without Shadow DOM barrier
- vscode-elements `::part()` selectors unaffected

```typescript
// Base pattern for all components
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('stream-tabs')
export class StreamTabs extends LitElement {
  // Render to light DOM - external CSS applies
  createRenderRoot() {
    return this;
  }

  @property({ type: Array }) streams: StreamTabInfo[] = [];
  @property({ type: String }) activeStream: string | null = null;

  render() {
    return html`
      <div class="stream-tabs-container">
        <!-- Uses existing styles/tabs.css classes -->
        ${this.streams.map(
          (stream) => html`
            <div
              class="stream-tab ${
                stream.name === this.activeStream ? 'is-active' : ''
              }"
              @click=${() => this.handleStreamClick(stream.name)}
            >
              <span class="tab-title">${stream.label}</span>
              <span class="tab-status is-${stream.status}"></span>
            </div>
          `,
        )}
      </div>
    `;
  }
}
```

**Benefits:**

- Existing CSS files work without modification
- VS Code theme variables cascade naturally
- vscode-elements styling applies correctly
- No style duplication between components

##### Decision 3: State Management

**Approach: Props Down, Events Up**

Root `ProgressApp` owns all state. Child components receive data via properties and emit events for user actions.

```typescript
// ProgressApp.ts - owns state, passes to children
@customElement('progress-app')
export class ProgressApp extends LitElement {
  @state() private state: ProgressState = createInitialState();

  render() {
    const streamState = this.getActiveStreamState();
    return html`
      <stream-tabs
        .streams=${this.state.streams}
        .activeStream=${this.state.activeStreamId}
        .filter=${this.state.streamFilter}
        @stream-select=${this.handleStreamSelect}
        @filter-change=${this.handleFilterChange}
      ></stream-tabs>

      <todo-list
        .todos=${streamState?.todos ?? []}
        .visible=${this.isToolUseAgent()}
      ></todo-list>
    `;
  }

  private handleStreamSelect(e: CustomEvent<{ streamId: string }>) {
    postMessage(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, {
      stream: e.detail.streamId,
    });
  }
}
```

**No Global Store Needed:** The existing `store.ts` provides types and helpers. State lives in `ProgressApp.@state()` properties.

---

#### Component Specifications

##### 1. ProgressApp.ts (Root Component)

**Responsibilities:**

- Message handling (30+ message types from backend)
- Global state management via `@state()` decorators
- Layout orchestration (what shows when)
- Event bubbling from child components → backend commands

**Replaces:**

- `modules/messageHandlers.js` (1,268 lines) - message dispatch
- `modules/domHandlers.js` - orchestration
- `modules/progressViewState.js` - client state

**Key Methods:**

```typescript
// Message routing
private handleMessage(raw: unknown) {
  const handlers: Record<string, (msg: unknown) => void> = {
    [PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS]: this.handleUpdateStreams,
    [PROGRESS_VIEW_COMMANDS.APPEND_LOG]: this.handleAppendLog,
    // ... 28 more handlers
  };
  handlers[message.command]?.(raw);
}

// Derived state
private getActiveStreamState(): StreamState | null {
  return this.state.activeStreamId
    ? this.state.streamStates.get(this.state.activeStreamId) ?? null
    : null;
}

private isToolUseAgent(): boolean {
  const info = this.state.streams.find(
    (s) => s.name === this.state.activeStreamId,
  );
  return info?.agentCategory === AGENT_CATEGORY.TOOL_USE;
}
```

##### 2. StreamTabs.ts

**Responsibilities:**

- Render stream tab bar with status indicators
- Filter/sort controls
- Tab selection events
- Stream deletion (via delete button)

**Replaces:** `modules/uiManagers/StreamTabs.js` (234 lines)

**Props:**

```typescript
@property({ type: Array }) streams: StreamTabInfo[] = [];
@property({ type: String }) activeStream: string | null = null;
@property({ type: String }) filter: StreamFilter = 'all';
@property({ type: String }) sort: StreamSort = 'time';
```

**Events:**

```typescript
// Emitted on tab click
@event stream-select: { streamId: string }
// Emitted on filter button click
@event filter-change: { filter: StreamFilter }
// Emitted on sort button click
@event sort-change: { sort: StreamSort }
// Emitted on delete button click
@event stream-delete: { streamId: string }
```

**Template Structure:**

```html
<div class="stream-tabs-toolbar">
  <div class="filter-buttons"><!-- all/workflow/toolUse --></div>
  <div class="sort-buttons"><!-- time/agent/inputFile --></div>
</div>
<div class="stream-tabs">
  <!-- .stream-tab for each stream -->
  <!-- Each has: .tab-status, .tab-title, .agent-category, .tab-delete -->
</div>
```

##### 3. StreamHeader.ts

**Responsibilities:**

- Display active stream name and status
- Toolbar buttons (Stop, Run New, Resume, Diff, etc.)
- Button enable/disable based on stream status and agent category

**Replaces:**

- `modules/uiManagers/Status.js` (~150 lines)
- `modules/uiManagers/Toolbar.js` (~200 lines)

**Props:**

```typescript
@property({ type: Object }) stream: StreamTabInfo | null = null;
@property({ type: String }) status: StreamStatus = 'ready';
@property({ type: Boolean }) isWorkflow = false;
```

**Events:**

```typescript
@event command: { command: string, stream: string }
// Emitted for: stop, run-new, resume, diff, clean, pack, restore, open-storage
```

##### 4. RunSelector.ts

**Responsibilities:**

- Dropdown to switch between runs (workflow agents only)
- Format run labels with timestamps
- Track selected vs active run

**Replaces:** `modules/uiManagers/RunSelector.js` (281 lines)

**Props:**

```typescript
@property({ type: Object }) runs: Map<string, RunInfo> = new Map();
@property({ type: String }) activeRunId: string | null = null;
@property({ type: String }) selectedRunId: string | null = null;
@property({ type: Boolean }) visible = false;
```

**Events:**

```typescript
@event run-select: { runId: string }
```

##### 5. TodoList.ts

**Responsibilities:**

- Render todo items with status icons (pending/in-progress/completed)
- Spinning icon for in-progress items
- Show `activeForm` text when in-progress, `content` otherwise

**Replaces:** `modules/uiManagers/TodoList.js` (153 lines)

**Props:**

```typescript
@property({ type: Array }) todos: TodoItem[] = [];
@property({ type: Boolean }) visible = false;
```

**Template:**

```html
<vscode-collapsible
  title="Tasks"
  ?hidden="${!this.visible"
  ||
  this.todos.length=""
  =""
  ="0}"
>
  <div class="todo-list">
    ${this.todos.map(todo => html`
    <div class="todo-item todo-item--${todo.status}">
      <i
        class="codicon codicon-${this.getIcon(todo.status)} ${todo.status === 'in_progress' ? 'spin' : ''}"
      ></i>
      <span
        >${todo.status === 'in_progress' ? todo.activeForm : todo.content}</span
      >
    </div>
    `)}
  </div>
</vscode-collapsible>
```

##### 6. FileList.ts

**Responsibilities:**

- Render output files grouped by round (workflow) or flat (tool-use)
- File action buttons (compare, accept, merge, diff, preview)
- Diff stats display (+added/-removed)

**Replaces:** `modules/uiManagers/FileList.js` (229 lines)

**Props:**

```typescript
@property({ type: Object }) filesByRound: Map<number, OutputFileInfo[]> = new Map();
@property({ type: Boolean }) showRoundHeaders = true;
@property({ type: Boolean }) visible = false;
```

**Events:**

```typescript
@event file-action: { action: string, file: string, base?: string }
// Actions: open, compare, accept, merge, diff, preview
```

##### 7. TaskGroupList.ts

**Responsibilities:**

- Render task groups as collapsible headers
- Status icons (running spinner, completed check, error)
- Duration display for completed groups
- Nested group support (root vs nested styling)

**Replaces:**

- `modules/formatters/taskGroupFormatter.js` (105 lines)
- `modules/formatters/taskGroupLevel.js` (~50 lines)
- `modules/taskManagers.js` (TaskGroupDomManager portion)

**Props:**

```typescript
@property({ type: Array }) groups: TaskGroup[] = [];
@property({ type: String }) activeRunId: string | null = null;
```

##### 8. LogList.ts

**Responsibilities:**

- Render log messages with appropriate formatting
- Collapsible details for long content
- Markdown rendering for text content
- Code block syntax highlighting
- Tool execution banners

**Replaces:**

- `modules/formatters/baseLogFormatter.js` (130 lines)
- `modules/formatters/logFormatters/*.js` (5 files, ~600 lines)
- `modules/taskManagers.js` (LogEntryManager portion)

**Props:**

```typescript
@property({ type: Array }) logs: LogMessageData[] = [];
@property({ type: Object }) taskGroups: Map<string, TaskGroup> = new Map();
```

**Formatting Utilities:**
Log formatting logic moves to `formatters/logFormatter.ts`:

```typescript
export function formatLogEntry(log: LogMessageData): TemplateResult {
  switch (log.messageType) {
    case 'tool_call':
      return formatToolCall(log);
    case 'banner':
      return formatBanner(log);
    case 'markdown':
      return formatMarkdown(log);
    default:
      return formatPlainText(log);
  }
}
```

##### 9. InstructionPanel.ts

**Responsibilities:**

- Display agent instruction text
- Collapsible container

**Replaces:** `modules/uiManagers/InstructionPanel.js` (~80 lines)

**Props:**

```typescript
@property({ type: String }) instruction: string | null = null;
@property({ type: Boolean }) visible = false;
```

##### 10. UsagePanel.ts

**Responsibilities:**

- Display token usage (input/output tokens, cost)
- Context window utilization bar

**Replaces:** `modules/usageManagers.js` portion

**Props:**

```typescript
@property({ type: Object }) usage: TokenUsageStats | null = null;
@property({ type: Object }) contextState: ContextState | null = null;
@property({ type: Boolean }) visible = false;
```

##### 11. FollowUpInput.ts

**Responsibilities:**

- Text input for follow-up messages
- Send/Polish/YOLO buttons
- Keyboard shortcuts (Ctrl+Enter to send)

**Replaces:**

- `modules/uiManagers/FollowUpInputManager.js` (~100 lines)
- `modules/uiManagers/FollowupSectionManager.js` (~150 lines)

**Props:**

```typescript
@property({ type: String }) streamId: string | null = null;
@property({ type: Boolean }) bypassActive = false;
@property({ type: Boolean }) visible = false;
```

**Events:**

```typescript
@event send-followup: { stream: string, text: string }
@event polish-followup: { stream: string, text: string }
@event toggle-bypass: { stream: string }
```

##### 12. QueuedFollowUps.ts

**Responsibilities:**

- Display queued follow-up messages
- Simple list rendering

**Replaces:** `modules/uiManagers/QueuedFollowUps.js` (~80 lines)

**Props:**

```typescript
@property({ type: Array }) messages: string[] = [];
@property({ type: Boolean }) visible = false;
```

##### 13. PromptOverlay.ts (Existing)

**Status:** Already implemented and working. Keep as-is.

**Responsibilities:**

- Modal overlay for approval/retry/proposal prompts
- Tool edit approval with diff preview buttons
- Bash command approval
- Retry request with error display
- Agent proposal with setup option

---

#### Legacy Module → Component Mapping

| Legacy Module                          | New Component(s)           | Notes                            |
| -------------------------------------- | -------------------------- | -------------------------------- |
| `constants.js`                         | (delete)                   | Use `@common/webview/commands`   |
| `domHandlers.js`                       | `ProgressApp.ts`           | Orchestration moves to root      |
| `messageHandlers.js`                   | `ProgressApp.ts`           | Message routing in root          |
| `progressViewState.js`                 | `store.ts` + `@state()`    | Already migrated                 |
| `taskManagers.js`                      | `TaskGroupList`, `LogList` | Split by concern                 |
| `utils.js`                             | (inline or delete)         | Most utils not needed with Lit   |
| `uiManagers/StreamTabs.js`             | `StreamTabs.ts`            | Direct mapping                   |
| `uiManagers/Status.js`                 | `StreamHeader.ts`          | Merged with toolbar              |
| `uiManagers/Toolbar.js`                | `StreamHeader.ts`          | Merged with status               |
| `uiManagers/RunSelector.js`            | `RunSelector.ts`           | Direct mapping                   |
| `uiManagers/TodoList.js`               | `TodoList.ts`              | Direct mapping                   |
| `uiManagers/FileList.js`               | `FileList.ts`              | Direct mapping                   |
| `uiManagers/InstructionPanel.js`       | `InstructionPanel.ts`      | Direct mapping                   |
| `uiManagers/FollowUpInputManager.js`   | `FollowUpInput.ts`         | Merged with section manager      |
| `uiManagers/FollowupSectionManager.js` | `FollowUpInput.ts`         | Merged                           |
| `uiManagers/QueuedFollowUps.js`        | `QueuedFollowUps.ts`       | Direct mapping                   |
| `uiManagers/Placeholder.js`            | (inline in ProgressApp)    | Simple conditional               |
| `uiManagers/ApprovalRequests.js`       | `PromptOverlay.ts`         | Already migrated                 |
| `uiManagers/BashApprovalRequests.js`   | `PromptOverlay.ts`         | Already migrated                 |
| `uiManagers/RetryRequests.js`          | `PromptOverlay.ts`         | Already migrated                 |
| `uiManagers/WorkflowProposals.js`      | `PromptOverlay.ts`         | Already migrated                 |
| `uiManagers/BaseUIRequestManager.js`   | (delete)                   | Not needed with Lit              |
| `uiManagers/EventsManager.js`          | (delete)                   | Lit handles events declaratively |
| `formatters/*.js`                      | `formatters/`              | TypeScript port                  |
| `handlers/themeHandlers.js`            | (delete)                   | CSS variables work automatically |

---

#### Implementation Sequence

**Phase 2A: Core Shell (Week 1)**

1. **Refactor ProgressApp.ts** - Clean up placeholder code
   - Keep all message handlers (already working)
   - Remove inline styles, use `createRenderRoot()`
   - Add proper type imports
   - Emit events instead of direct `postMessage` in render methods

2. **Create StreamTabs.ts** - First extracted component
   - Move tab rendering from ProgressApp
   - Implement filter/sort controls
   - Wire events back to ProgressApp

3. **Create StreamHeader.ts** - Header + toolbar
   - Extract from ProgressApp render
   - Consolidate status + toolbar logic

**Phase 2B: Content Components (Week 1-2)**

4. **Create TodoList.ts** - Simple list component
5. **Create FileList.ts** - File list with actions
6. **Create InstructionPanel.ts** - Instruction display
7. **Create RunSelector.ts** - Run dropdown
8. **Create UsagePanel.ts** - Usage statistics
9. **Create QueuedFollowUps.ts** - Follow-up queue
10. **Create FollowUpInput.ts** - Input with buttons

**Phase 2C: Complex Components (Week 2)**

11. **Create TaskGroupList.ts** - Task group rendering
12. **Create LogList.ts** - Log message rendering
13. **Port formatters/** - TypeScript log formatters

**Phase 2D: Cleanup (Week 2-3)**

14. **Delete legacy modules/** - Remove all `.js` files
15. **Update tests** - Ensure all functionality works
16. **Performance testing** - Verify no regressions

---

#### Testing Strategy

**Unit Tests:**

- Each component should have a `.test.ts` file
- Test rendering output for different props
- Test event emission for user interactions
- Mock VS Code API for postMessage tests

**Integration Tests:**

- Full message flow tests (backend → ProgressApp → child component)
- State synchronization tests
- Filter/sort behavior tests

**Manual Testing Checklist:**

- [ ] Stream switching works correctly
- [ ] Filter/sort updates UI and persists
- [ ] Run selector switches displayed data
- [ ] All toolbar buttons function
- [ ] Approval overlays show/dismiss correctly
- [ ] Follow-up input sends messages
- [ ] File actions open/compare files
- [ ] Log entries render with proper formatting
- [ ] Todo items show correct status icons
- [ ] Task groups expand/collapse
- [ ] Usage statistics display correctly
- [ ] Theme changes apply without reload

---

#### M2 Deliverables

| Metric                   | Before (Legacy) | After (Lit)              |
| ------------------------ | --------------- | ------------------------ |
| Frontend files           | 40 JS files     | ~15 TS files             |
| Frontend lines           | ~10,000         | ~2,300                   |
| Type coverage            | 0% (JSDoc only) | 100%                     |
| `isToolUse` conditionals | 18              | 0 (component separation) |
| State tracking locations | 7               | 1 (`@state()`)           |
| Approval handlers        | 8 (4 pairs)     | 1 (`PromptOverlay`)      |
| DOM null checks          | ~50             | 0 (reactive)             |

**Files Deleted:**

```
src/progressView/modules/          # Entire directory (40 files)
```

**Files Created:**

```
src/progressView/frontend/
├── ProgressApp.ts                 # Refactored root
├── components/
│   ├── StreamTabs.ts
│   ├── StreamHeader.ts
│   ├── RunSelector.ts
│   ├── TodoList.ts
│   ├── FileList.ts
│   ├── TaskGroupList.ts
│   ├── LogList.ts
│   ├── InstructionPanel.ts
│   ├── UsagePanel.ts
│   ├── FollowUpInput.ts
│   ├── QueuedFollowUps.ts
│   ├── PromptOverlay.ts           # Already exists
│   └── index.ts
└── formatters/
    ├── logFormatter.ts
    ├── markdownRenderer.ts
    ├── timestampUtils.ts
    └── index.ts
```

---

#### Example: Complete Component Implementation

`src/progressView/frontend/components/TodoList.ts`:

```typescript
import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import type { TodoItem } from '@shared/schemas';
import { TODO_STATUS } from '@common/constants/todoStatus';

const STATUS_ICONS: Record<string, string> = {
  [TODO_STATUS.PENDING]: 'circle-outline',
  [TODO_STATUS.IN_PROGRESS]: 'loading',
  [TODO_STATUS.COMPLETED]: 'pass-filled',
};

@customElement('todo-list')
export class TodoList extends LitElement {
  // Render to light DOM for external CSS
  createRenderRoot() {
    return this;
  }

  @property({ type: Array }) todos: TodoItem[] = [];
  @property({ type: Boolean }) visible = false;

  render() {
    if (!this.visible || this.todos.length === 0) {
      return nothing;
    }

    return html`
      <vscode-collapsible title="Tasks" open>
        <div class="todo-list">
          ${this.todos.map((todo) => this.renderTodoItem(todo))}
        </div>
      </vscode-collapsible>
    `;
  }

  private renderTodoItem(todo: TodoItem) {
    const isInProgress = todo.status === TODO_STATUS.IN_PROGRESS;
    const icon = STATUS_ICONS[todo.status] ?? STATUS_ICONS[TODO_STATUS.PENDING];

    const classes = {
      'todo-item': true,
      'todo-item--pending': todo.status === TODO_STATUS.PENDING,
      'todo-item--in-progress': isInProgress,
      'todo-item--completed': todo.status === TODO_STATUS.COMPLETED,
    };

    const iconClasses = {
      codicon: true,
      [`codicon-${icon}`]: true,
      'todo-item__icon': true,
      spin: isInProgress,
    };

    return html`
      <div class=${classMap(classes)}>
        <i class=${classMap(iconClasses)}></i>
        <span class="todo-item__content">
          ${isInProgress ? todo.activeForm : todo.content}
        </span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'todo-list': TodoList;
  }
}
```

**Usage in ProgressApp:**

```typescript
render() {
  const streamState = this.getActiveStreamState();
  const isToolUse = this.isToolUseAgent();

  return html`
    <todo-list
      .todos=${streamState?.todos ?? []}
      .visible=${isToolUse}
    ></todo-list>
  `;
}
```

---

#### Why This Architecture

| Legacy Pain Point                   | Lit Solution                                   |
| ----------------------------------- | ---------------------------------------------- |
| `if (container)` null checks        | Reactive rendering - no DOM queries needed     |
| Fragment batching (53 lines)        | `${items.map(i => html\`...\`)}`               |
| Manual `classList.add/remove`       | `class=${classMap({ active: this.isActive })}` |
| 8 duplicate approval handlers       | Single `<prompt-overlay>` component            |
| 18 `isToolUse` conditionals         | Component-level separation (props-based)       |
| 7 "active" state locations          | Single `@state()` in ProgressApp               |
| Manual event wiring                 | Declarative `@click=${this.handler}`           |
| Template cloning + DOM manipulation | Lit templates with automatic diffing           |
| JSDoc type hints (~367 lines)       | Full TypeScript types                          |

---

#### Risks and Mitigations

**Risk: Visual regression from CSS changes**

- Mitigation: Use `createRenderRoot() { return this; }` to preserve external CSS behavior
- Mitigation: Manual visual testing checklist before merge

**Risk: Message handler breakage**

- Mitigation: Keep existing handler implementations, just refactor structure
- Mitigation: Message schemas already validated (from M1)

**Risk: Performance regression with many log entries**

- Mitigation: Lit's efficient diffing handles large lists well
- Mitigation: Future optimization: virtual scrolling (non-goal for M2)

**Risk: vscode-elements compatibility**

- Mitigation: Light DOM rendering ensures vscode-elements work unchanged
- Mitigation: Test each component with vscode-elements early
