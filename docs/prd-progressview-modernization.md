# PRD: ProgressView Modernization

## Overview

This document outlines the modernization of TeXRA's ProgressView component, transitioning from vanilla JavaScript to a type-safe Lit + TypeScript architecture with shared Zod schemas.

## Problem Statement

### Current Pain Points

1. **No Type Safety Across Process Boundary**
   - EventBus has Zod schemas, but webview messages are untyped
   - `commands.js` and `commands.ts` are duplicated (300 lines each)
   - Frontend uses JSDoc comments (~367 lines) instead of real types

2. **Overengineered Run/Stream State Management**
   - 7 places track "active" state with significant overlap
   - Semantic overloading: TaskGroup means "run" for Workflow, "turn" for ToolUse
   - 6 band-aid workarounds scattered across codebase
   - `resolveActiveRunId()` expensive fallback chain called ~30 times

3. **Performance Bottlenecks**
   - Full DOM rebuild on stream switch (500+ messages)
   - No virtual scrolling for large conversations
   - No memoization for Markdown/KaTeX rendering
   - Event listeners on every element (no delegation)

4. **Maintenance Burden**
   - `messageHandlers.js`: 1268-line switch statement
   - `taskManagers.js`: 544 lines of DOM manipulation
   - 14+ conditional checks for `isToolUse` vs `isWorkflow`

## Goals

1. **End-to-end type safety** via shared Zod schemas
2. **Simplified state management** by separating Workflow and Conversation concerns
3. **Improved performance** with virtual scrolling and Lit's efficient rendering
4. **Maintainable architecture** with component-based design

## Non-Goals

- Changing the EventBus architecture (it works well)
- Modifying agent execution logic
- Adding new features (pure refactor)

---

## Architecture

### Current Event Flow

```
Agent Execution
       ↓
EventBus (Zod schemas ✅)
       ↓
ProgressEventHandler (TypeScript ✅)
       ↓
WebviewUpdater (partial types ⚠️)
       ↓
postMessage (untyped ❌)
       ↓
Webview Frontend (JSDoc, vanilla JS ❌)
```

### Proposed Event Flow

```
Agent Execution
       ↓
EventBus (unchanged)
       ↓
ProgressEventHandler (unchanged)
       ↓
WebviewUpdater + IPC Protocol (shared schemas ✅)
       ↓
postMessage (validated ✅)
       ↓
Webview Frontend (Lit + TypeScript + Zod ✅)
```

### Directory Structure

```
src/
├── shared/                          # NEW: Shared between extension & webview
│   ├── schemas/
│   │   ├── stream.ts                # Stream, StreamStatus, StreamMetadata
│   │   ├── workflow.ts              # WorkflowRun, WorkflowTask
│   │   ├── conversation.ts          # ConversationTurn, ToolCall
│   │   ├── log.ts                   # LogEntry, LogLevel
│   │   ├── files.ts                 # OutputFile, FileInfo
│   │   ├── usage.ts                 # TokenUsage, ContextState
│   │   └── index.ts
│   ├── ipc/
│   │   ├── toWebview.ts             # Extension → Webview messages
│   │   ├── fromWebview.ts           # Webview → Extension messages
│   │   └── index.ts
│   └── index.ts
│
├── progressView/
│   ├── ProgressViewProvider.ts      # Unchanged
│   ├── state/
│   │   └── ProgressViewState.ts     # Simplified
│   ├── events/
│   │   └── ProgressEventHandler.ts  # Unchanged (uses IPC for output)
│   ├── managers/
│   │   └── WebviewUpdater.ts        # Updated to use IPC protocol
│   └── frontend/                    # NEW: Lit + TypeScript
│       ├── components/
│       │   ├── ProgressApp.ts       # Root component
│       │   ├── StreamTabs.ts        # Stream tab bar
│       │   ├── WorkflowView.ts      # Workflow agent UI
│       │   ├── ConversationView.ts  # ToolUse agent UI
│       │   └── shared/
│       │       ├── VirtualList.ts   # Virtual scrolling
│       │       ├── LogEntry.ts      # Log message component
│       │       ├── FileList.ts      # Output files
│       │       └── StatusBar.ts     # Status indicator
│       ├── state/
│       │   └── store.ts             # Single state store
│       ├── ipc/
│       │   └── handler.ts           # Message handler
│       └── index.ts                 # Entry point
│
├── eventBus/                        # UNCHANGED
│   ├── ProgressEventBus.ts
│   ├── schemas.ts
│   └── types.ts
```

---

## Shared Schemas

### Stream Schema

```typescript
// src/shared/schemas/stream.ts
import { z } from 'zod';

export const StreamStatusSchema = z.enum([
  'idle',
  'running',
  'completed',
  'error',
  'paused',
]);

export const AgentCategorySchema = z.enum(['workflow', 'toolUse']);

export const StreamSchema = z.object({
  id: z.string(),
  label: z.string(),
  agentCategory: AgentCategorySchema,
  status: StreamStatusSchema,
  isRemote: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Stream = z.infer<typeof StreamSchema>;
export type StreamStatus = z.infer<typeof StreamStatusSchema>;
export type AgentCategory = z.infer<typeof AgentCategorySchema>;
```

### Workflow Schema (replaces TaskGroup for workflow agents)

```typescript
// src/shared/schemas/workflow.ts
import { z } from 'zod';

export const WorkflowTaskSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'error']),
  startTime: z.number().optional(),
  endTime: z.number().optional(),
});

export const WorkflowRunSchema = z.object({
  id: z.string(),
  instruction: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'error']),
  tasks: z.array(WorkflowTaskSchema),
  outputs: z.array(OutputFileSchema),
  usage: TokenUsageSchema.optional(),
  startTime: z.number(),
  endTime: z.number().optional(),
});

export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export type WorkflowTask = z.infer<typeof WorkflowTaskSchema>;
```

### Conversation Schema (replaces TaskGroup for toolUse agents)

```typescript
// src/shared/schemas/conversation.ts
import { z } from 'zod';

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
  output: z.string().optional(),
  status: z.enum(['pending', 'running', 'completed', 'error']),
});

export const ConversationTurnSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  timestamp: z.number(),
});

export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
```

---

## IPC Protocol

### Extension → Webview Messages

```typescript
// src/shared/ipc/toWebview.ts
import { z } from 'zod';
import { StreamSchema, WorkflowRunSchema, ConversationTurnSchema } from '../schemas';

export const ToWebviewSchema = z.discriminatedUnion('type', [
  // Stream Management
  z.object({
    type: z.literal('stream/list'),
    streams: z.array(StreamSchema),
    activeStreamId: z.string().nullable(),
  }),
  z.object({
    type: z.literal('stream/status'),
    streamId: z.string(),
    status: StreamStatusSchema,
  }),
  z.object({
    type: z.literal('stream/deleted'),
    streamId: z.string(),
  }),

  // Workflow Agent Messages
  z.object({
    type: z.literal('workflow/run-added'),
    streamId: z.string(),
    run: WorkflowRunSchema,
  }),
  z.object({
    type: z.literal('workflow/run-updated'),
    streamId: z.string(),
    runId: z.string(),
    updates: WorkflowRunSchema.partial(),
  }),
  z.object({
    type: z.literal('workflow/task-updated'),
    streamId: z.string(),
    runId: z.string(),
    taskId: z.string(),
    updates: WorkflowTaskSchema.partial(),
  }),

  // Conversation Agent Messages
  z.object({
    type: z.literal('conversation/turn-added'),
    streamId: z.string(),
    turn: ConversationTurnSchema,
  }),
  z.object({
    type: z.literal('conversation/turn-updated'),
    streamId: z.string(),
    turnId: z.string(),
    updates: ConversationTurnSchema.partial(),
  }),
  z.object({
    type: z.literal('conversation/tool-updated'),
    streamId: z.string(),
    turnId: z.string(),
    toolId: z.string(),
    updates: ToolCallSchema.partial(),
  }),

  // Files
  z.object({
    type: z.literal('files/updated'),
    streamId: z.string(),
    runId: z.string().optional(),  // Only for workflow
    files: z.array(OutputFileSchema),
  }),
  z.object({
    type: z.literal('files/missing'),
    streamId: z.string(),
    runId: z.string().optional(),
    missing: z.array(z.string()),
  }),

  // Usage
  z.object({
    type: z.literal('usage/updated'),
    streamId: z.string(),
    runId: z.string().optional(),
    usage: TokenUsageSchema,
  }),
  z.object({
    type: z.literal('context/updated'),
    streamId: z.string(),
    context: ContextStateSchema,
  }),

  // Todos
  z.object({
    type: z.literal('todos/updated'),
    streamId: z.string(),
    todos: z.array(TodoItemSchema),
  }),

  // UI Prompts
  z.object({
    type: z.literal('ui/retry-request'),
    streamId: z.string(),
    prompt: RetryRequestSchema,
  }),
  z.object({
    type: z.literal('ui/retry-resolved'),
    streamId: z.string(),
  }),
  z.object({
    type: z.literal('ui/approval-request'),
    request: ApprovalRequestSchema,
  }),
  z.object({
    type: z.literal('ui/approval-resolved'),
    requestId: z.string(),
  }),
  z.object({
    type: z.literal('ui/proposal'),
    proposal: AgentProposalSchema,
  }),
  z.object({
    type: z.literal('ui/proposal-resolved'),
    proposalId: z.string(),
  }),

  // Settings
  z.object({
    type: z.literal('settings/theme'),
    theme: z.enum(['light', 'dark', 'high-contrast']),
  }),
  z.object({
    type: z.literal('settings/bypass-approval'),
    streamId: z.string(),
    enabled: z.boolean(),
  }),
]);

export type ToWebview = z.infer<typeof ToWebviewSchema>;
```

### Webview → Extension Messages

```typescript
// src/shared/ipc/fromWebview.ts
import { z } from 'zod';

export const FromWebviewSchema = z.discriminatedUnion('type', [
  // Lifecycle
  z.object({ type: z.literal('ready') }),

  // Stream Actions
  z.object({
    type: z.literal('stream/switch'),
    streamId: z.string(),
  }),
  z.object({
    type: z.literal('stream/stop'),
    streamId: z.string(),
  }),
  z.object({
    type: z.literal('stream/delete'),
    streamId: z.string(),
  }),
  z.object({
    type: z.literal('stream/delete-all'),
  }),

  // Workflow Actions
  z.object({
    type: z.literal('workflow/run-selected'),
    streamId: z.string(),
    runId: z.string(),
  }),
  z.object({
    type: z.literal('workflow/new-run'),
    streamId: z.string(),
    instruction: z.string(),
  }),

  // Conversation Actions
  z.object({
    type: z.literal('conversation/send-followup'),
    streamId: z.string(),
    content: z.string(),
  }),

  // File Actions
  z.object({
    type: z.literal('file/open'),
    path: z.string(),
  }),
  z.object({
    type: z.literal('file/compare'),
    original: z.string(),
    revised: z.string(),
  }),
  z.object({
    type: z.literal('file/accept'),
    path: z.string(),
  }),

  // UI Responses
  z.object({
    type: z.literal('retry/respond'),
    streamId: z.string(),
    action: z.enum(['retry', 'cancel', 'change-model']),
    newModel: z.string().optional(),
  }),
  z.object({
    type: z.literal('approval/respond'),
    requestId: z.string(),
    approved: z.boolean(),
  }),
  z.object({
    type: z.literal('proposal/respond'),
    proposalId: z.string(),
    accepted: z.boolean(),
  }),

  // Settings
  z.object({
    type: z.literal('settings/toggle-bypass'),
    streamId: z.string(),
  }),
]);

export type FromWebview = z.infer<typeof FromWebviewSchema>;
```

---

## EventBus → IPC Mapping

The EventBus remains unchanged. WebviewUpdater translates EventBus payloads to IPC messages:

| EventBus Event | IPC Message | Notes |
|----------------|-------------|-------|
| `setActiveStream` | `stream/list` | Full stream list refresh |
| `updateStreamStatus` | `stream/status` | Single stream update |
| `addTaskGroup` | `workflow/run-added` or `conversation/turn-added` | Based on agentCategory |
| `updateTaskGroup` | `workflow/task-updated` or `conversation/tool-updated` | Based on agentCategory |
| `addLogMessage` | Embedded in turn/task | Logs become part of data model |
| `addOutputFiles` | `files/updated` | |
| `updateMissingOutputs` | `files/missing` | |
| `updateStreamUsage` | `usage/updated` | |
| `updateContextState` | `context/updated` | |
| `updateTodos` | `todos/updated` | |
| `showRetryRequest` | `ui/retry-request` | |
| `resolveRetryRequest` | `ui/retry-resolved` | |
| `showToolEditApprovalPrompt` | `ui/approval-request` | |
| `showAgentProposal` | `ui/proposal` | |

---

## Frontend Architecture

### Component Hierarchy

```
<progress-app>
  ├── <stream-tabs>
  │   └── <stream-tab> (multiple)
  │
  ├── <workflow-view> (when agentCategory === 'workflow')
  │   ├── <run-selector>
  │   ├── <instruction-panel>
  │   ├── <virtual-list>
  │   │   └── <workflow-task> (multiple)
  │   ├── <file-list>
  │   └── <usage-display>
  │
  └── <conversation-view> (when agentCategory === 'toolUse')
      ├── <virtual-list>
      │   └── <conversation-turn> (multiple)
      │       └── <tool-call> (if present)
      ├── <file-list>
      ├── <followup-input>
      └── <usage-display>
```

### State Store

```typescript
// src/progressView/frontend/state/store.ts
import { z } from 'zod';

const StoreSchema = z.object({
  // Active state
  activeStreamId: z.string().nullable(),

  // Stream metadata
  streams: z.map(z.string(), StreamSchema),

  // Agent-specific data (separated, not overloaded)
  workflowData: z.map(z.string(), z.object({
    activeRunId: z.string().nullable(),
    runs: z.array(WorkflowRunSchema),
  })),
  conversationData: z.map(z.string(), z.object({
    turns: z.array(ConversationTurnSchema),
  })),

  // UI state
  pendingApprovals: z.map(z.string(), ApprovalRequestSchema),
  pendingRetries: z.map(z.string(), RetryRequestSchema),
});

type Store = z.infer<typeof StoreSchema>;

class ProgressStore {
  private state: Store = { /* initial */ };
  private listeners = new Set<() => void>();

  // Type-safe updates
  dispatch(message: ToWebview) {
    switch (message.type) {
      case 'stream/list':
        this.state.streams = new Map(message.streams.map(s => [s.id, s]));
        this.state.activeStreamId = message.activeStreamId;
        break;
      case 'workflow/run-added':
        // ...
        break;
      // All cases handled with full type inference
    }
    this.notify();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach(fn => fn());
  }
}

export const store = new ProgressStore();
```

### Example Component

```typescript
// src/progressView/frontend/components/WorkflowView.ts
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { store } from '../state/store.js';
import type { WorkflowRun } from '@shared/schemas';

@customElement('workflow-view')
export class WorkflowView extends LitElement {
  @property() streamId!: string;
  @state() private activeRunId: string | null = null;
  @state() private runs: WorkflowRun[] = [];

  static styles = css`
    :host { display: flex; flex-direction: column; height: 100%; }
    .run-content { flex: 1; overflow: hidden; }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.unsubscribe = store.subscribe(() => this.updateFromStore());
    this.updateFromStore();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribe?.();
  }

  private updateFromStore() {
    const data = store.state.workflowData.get(this.streamId);
    if (data) {
      this.activeRunId = data.activeRunId;
      this.runs = data.runs;
    }
  }

  private get activeRun(): WorkflowRun | undefined {
    return this.runs.find(r => r.id === this.activeRunId);
  }

  render() {
    return html`
      <run-selector
        .runs=${this.runs}
        .activeRunId=${this.activeRunId}
        @change=${this.handleRunChange}
      ></run-selector>

      <div class="run-content">
        ${this.activeRun ? html`
          <instruction-panel .instruction=${this.activeRun.instruction}></instruction-panel>
          <virtual-list
            .items=${this.activeRun.tasks}
            .renderItem=${(task) => html`<workflow-task .task=${task}></workflow-task>`}
          ></virtual-list>
          <file-list .files=${this.activeRun.outputs}></file-list>
          <usage-display .usage=${this.activeRun.usage}></usage-display>
        ` : html`<p>No run selected</p>`}
      </div>
    `;
  }

  private handleRunChange(e: CustomEvent<string>) {
    sendToExtension({ type: 'workflow/run-selected', streamId: this.streamId, runId: e.detail });
  }
}
```

---

## Build Configuration

### Webpack Changes

```javascript
// webpack.config.js
const webviewConfig = {
  target: 'web',
  entry: {
    progressView: './src/progressView/frontend/index.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist/webview'),
    filename: '[name].js',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
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
  externals: {
    // Don't bundle vscode-elements, load from CDN
  },
};

module.exports = [extensionConfig, webviewConfig];
```

### Dependencies

```json
{
  "dependencies": {
    "lit": "^3.1.0"
  }
}
```

Note: `zod` is already a dependency. `@vscode-elements/elements` is already a dependency (Lit-based).

---

## Migration Plan

### Phase 1: Shared Schemas & IPC Protocol (Week 1)

1. Create `src/shared/schemas/` with all Zod schemas
2. Create `src/shared/ipc/` with ToWebview and FromWebview schemas
3. Update `WebviewUpdater.ts` to use IPC types (backward compatible)
4. Delete `commands.js` (keep `commands.ts` temporarily for gradual migration)

**Deliverable**: Type-safe message sending from extension, no frontend changes yet.

### Phase 2: Webpack Webview Bundling (Week 1)

1. Add webview entry to `webpack.config.js`
2. Create `src/progressView/frontend/index.ts` entry point
3. Create basic `ProgressApp.ts` Lit component
4. Update `index.html` to load bundled JS instead of import maps

**Deliverable**: Webview loads Lit app, displays placeholder.

### Phase 3: Core Components (Week 2)

1. Implement `store.ts` with Zod-validated state
2. Implement `StreamTabs.ts` component
3. Implement `VirtualList.ts` for performance
4. Implement message handler with `ToWebviewSchema.safeParse()`

**Deliverable**: Stream tabs work, virtual scrolling foundation.

### Phase 4: Workflow & Conversation Views (Week 2-3)

1. Implement `WorkflowView.ts` with run selector
2. Implement `ConversationView.ts` with append-only turns
3. Migrate log rendering to components
4. Implement file list, usage display

**Deliverable**: Both agent types render correctly.

### Phase 5: UI Prompts & Polish (Week 3)

1. Implement approval request component
2. Implement retry request component
3. Implement proposal component
4. Add keyboard navigation, accessibility

**Deliverable**: Full feature parity.

### Phase 6: Cleanup (Week 4)

1. Delete all `src/progressView/modules/*.js` files
2. Delete `commands.ts` (now fully replaced by IPC)
3. Delete duplicate `.js` files (`streamStatus.js`, etc.)
4. Remove import maps from `index.html`
5. Update documentation

**Deliverable**: Clean codebase, no legacy code.

---

## Deletion List

### Files to Delete

```
src/common/webview/commands.js              # 300 lines (duplicate)
src/common/constants/streamStatus.js        # duplicate
src/progressView/modules/messageHandlers.js # 1268 lines → components
src/progressView/modules/taskManagers.js    # 544 lines → components
src/progressView/modules/progressViewState.js # → store.ts
src/progressView/modules/domHandlers.js     # → Lit handles DOM
src/progressView/modules/formatters.js      # → component methods
src/progressView/modules/utils.js           # → shared utils
src/progressView/modules/constants.js       # → shared schemas
src/progressView/modules/usageManagers.js   # → UsageDisplay component
src/progressView/modules/uiManagers/*.js    # All 14 files → Lit components
src/progressView/modules/handlers/*.js      # → component methods
src/progressView/modules/formatters/*.js    # → component methods
```

### Code Patterns to Remove

- `lastRenderedStream` hack (stream switch detection)
- `resolveActiveRunId()` fallback chain
- `_clearAgentCategoryState()` category switch workaround
- `RunScopedMap` with resolver closure
- 14+ `isToolUse` / `isWorkflow` conditionals
- ~367 lines of JSDoc type comments

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Type coverage (frontend) | ~20% (JSDoc) | 100% (TypeScript) |
| Lines of code (progressView frontend) | ~3700 | ~2400 (-35%) |
| Duplicate code | 600+ lines | 0 |
| DOM nodes for 500 messages | 500+ | ~50 (virtual) |
| Time to switch stream (500 msgs) | ~800ms | <100ms |
| Message handler complexity | 1268-line switch | ~200-line dispatcher |

---

## References

- [GitLens](https://github.com/gitkraken/vscode-gitlens) - Large Lit-based VS Code extension
- [VSCode Elements](https://github.com/vscode-elements/elements) - Lit component library (already a dependency)
- [Lit VSCode Extension Tutorial](https://rodydavis.com/posts/lit-vscode-extension) - Setup guide
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview) - Official docs

---

## Appendix: Current Architecture Issues

### Issue 1: Seven Places Track "Active" State

| Location | Tracks | Persisted |
|----------|--------|-----------|
| Backend `_activeStream` | Current stream | No |
| Backend `StreamSessionState.activeRunId` | Per-stream run | Yes |
| Frontend `state.activeStream` | Current stream | No |
| Frontend `state.lastRenderedStream` | Last rendered | No |
| Frontend `state.activeRunIds` | Per-stream run | No |
| Frontend `runSelector._pendingActiveId` | UI selection | No |
| Frontend `streamStatuses` | Lifecycle | No |

**Solution**: Single `store.ts` with `activeStreamId` and agent-specific data maps.

### Issue 2: TaskGroup Semantic Overloading

```javascript
// Current: Same structure, different meanings
if (agentCategory === 'workflow') {
  // TaskGroup = "run" (user switches between runs)
} else {
  // TaskGroup = "turn" (append-only history)
}
```

**Solution**: Separate `WorkflowRun` and `ConversationTurn` schemas.

### Issue 3: Band-Aid Workarounds

1. `resolveActiveRunId()` - Expensive fallback iterating multiple maps
2. `lastRenderedStream` - Detecting stream switches via render state
3. `_clearAgentCategoryState()` - Wiping state on category change
4. `RunScopedMap` resolver closure - Implicit activeStream dependency
5. Pending instruction coordination - Waiting for run to claim instruction
6. 14+ `isToolUse` checks - Conditional logic everywhere

**Solution**: Clean separation of Workflow and Conversation data models eliminates all workarounds.
