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

**Primary (Milestone 1):**
1. **End-to-end type safety** via shared Zod schemas — this alone delivers 80% of maintenance benefit

**Secondary (Milestone 2):**
2. **Simplified state management** by separating Workflow and Conversation data models
3. **Maintainable UI** with Lit component-based design

## Non-Goals

- Changing the EventBus architecture (it works well)
- Modifying agent execution logic
- Adding new features (pure refactor)
- Virtual scrolling (future optimization)
- Boiling the ocean — Milestone 1 is shippable alone

---

## Persisted Data & Schema Migration

### Current Persisted Data Keys

Data stored in VS Code's `workspaceState`:

| Key | Current Format | New Format | Migration |
|-----|----------------|------------|-----------|
| `texra.streamTabs` | `StreamTabInfo[]` | `Stream[]` | Rename fields |
| `texra.taskGroups` | `TaskGroup[]` (overloaded) | Split to `WorkflowRun[]` + `ConversationTurn[]` | **Complex** |
| `texra.outputFiles` | `Record<stream, Record<run, files>>` | Embedded in `WorkflowRun.outputs` | Flatten |
| `texra.missingOutputs` | `Record<stream, Record<run, paths>>` | Embedded in `WorkflowRun` | Flatten |
| `texra.runInstructions` | `Record<stream, Record<run, string>>` | Embedded in `WorkflowRun.instruction` | Flatten |
| `texra.activeRunIds` | `Record<stream, runId>` | `workflowData[stream].activeRunId` | Move |
| `texra.activeStreamTab` | `string` | `activeStreamId: string` | Rename |
| `texra.taskStates` | `Record<stream, TaskState>` | Embedded in `Stream.taskState` | Move |
| `texra.executionIds` | `Record<stream, ExecutionId>` | `conversationData[stream].executionId` | Move |
| `texra.usageStats` | `Record<stream, Record<run, Usage>>` | Embedded in `WorkflowRun.usage` | Flatten |
| `texra.streamSortOrder` | `string` | `string` (unchanged) | None |
| `texra.streamAgentFilter` | `string` | `string` (unchanged) | None |

### Migration Strategy: Union + Transform at Entry Point

Following the project's Zod conventions (see CLAUDE.md), we handle legacy formats at the **entry point only**:

```typescript
// src/shared/schemas/persistence/streamTabs.ts
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────
// Canonical format (new) - what the app uses internally
// ─────────────────────────────────────────────────────────────
export const StreamSchema = z.object({
  id: z.string(),
  label: z.string(),
  agentCategory: z.enum(['workflow', 'toolUse']),
  agentName: z.string(),
  status: StreamStatusSchema,
  isRemote: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Stream = z.infer<typeof StreamSchema>;

// ─────────────────────────────────────────────────────────────
// Legacy format - what might be in persisted storage
// ─────────────────────────────────────────────────────────────
const LegacyStreamTabInfoSchema = z.object({
  id: z.string(),
  displayName: z.string(),            // renamed to 'label'
  agentType: z.string().optional(),   // renamed to 'agentName'
  category: z.string().optional(),    // renamed to 'agentCategory'
  // ... other legacy fields
}).transform((legacy): Stream => ({
  id: legacy.id,
  label: legacy.displayName,
  agentCategory: (legacy.category as 'workflow' | 'toolUse') ?? 'workflow',
  agentName: legacy.agentType ?? 'unknown',
  status: 'idle',
  isRemote: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}));

// ─────────────────────────────────────────────────────────────
// Entry schema - tries new format first, falls back to legacy
// ─────────────────────────────────────────────────────────────
export const StreamEntrySchema = z.union([
  StreamSchema,           // Try new format first
  LegacyStreamTabInfoSchema,  // Fall back to legacy + transform
]);

// For arrays
export const StreamListEntrySchema = z.array(StreamEntrySchema);
```

### Complex Migration: TaskGroups → Workflow/Conversation

The most complex migration is splitting `TaskGroup[]` into separate data models:

```typescript
// src/shared/schemas/persistence/taskGroups.ts

// Legacy TaskGroup (overloaded for both agent types)
const LegacyTaskGroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.string(),
  parentGroupId: z.string().nullable(),
  streamId: z.string(),
  startTime: z.number().optional(),
  endTime: z.number().optional(),
  // ... other fields
});

// Migration function - called once at load time
export function migrateTaskGroups(
  legacyGroups: z.infer<typeof LegacyTaskGroupSchema>[],
  streams: Stream[],
): {
  workflowData: Map<string, { activeRunId: string | null; runs: WorkflowRun[] }>;
  conversationData: Map<string, { turns: ConversationTurn[]; executionId: string | null }>;
} {
  const workflowData = new Map();
  const conversationData = new Map();

  for (const stream of streams) {
    const streamGroups = legacyGroups.filter(g => g.streamId === stream.id);

    if (stream.agentCategory === 'workflow') {
      // Root groups (parentGroupId === null) become WorkflowRuns
      const runs = streamGroups
        .filter(g => g.parentGroupId === null)
        .map(g => migrateToWorkflowRun(g, streamGroups));

      workflowData.set(stream.id, {
        activeRunId: runs[runs.length - 1]?.id ?? null,
        runs,
      });
    } else {
      // All groups become ConversationTurns (append-only)
      const turns = streamGroups.map(migrateToConversationTurn);

      conversationData.set(stream.id, {
        turns,
        executionId: null, // loaded separately
      });
    }
  }

  return { workflowData, conversationData };
}

function migrateToWorkflowRun(
  rootGroup: LegacyTaskGroup,
  allGroups: LegacyTaskGroup[],
): WorkflowRun {
  const children = allGroups.filter(g => g.parentGroupId === rootGroup.id);

  return {
    id: rootGroup.id,
    instruction: '', // loaded separately from runInstructions
    status: mapStatus(rootGroup.status),
    tasks: children.map(c => ({
      id: c.id,
      label: c.label,
      status: mapStatus(c.status),
      startTime: c.startTime,
      endTime: c.endTime,
    })),
    outputs: [], // loaded separately from outputFiles
    usage: undefined, // loaded separately from usageStats
    startTime: rootGroup.startTime ?? Date.now(),
    endTime: rootGroup.endTime,
  };
}
```

### State Loader with Migration

```typescript
// src/progressView/state/StateLoader.ts
import { workspaceSM, WorkspaceStateKey } from '@common/state/stateManager';
import { StreamListEntrySchema, migrateTaskGroups } from '@shared/schemas/persistence';

export async function loadPersistedState(): Promise<ProgressState> {
  // 1. Load streams (with legacy migration)
  const rawStreams = workspaceSM.get(WorkspaceStateKey.STREAM_TABS, []);
  const streamsResult = StreamListEntrySchema.safeParse(rawStreams);

  if (!streamsResult.success) {
    console.warn('Failed to parse streams, starting fresh:', streamsResult.error);
    return createEmptyState();
  }
  const streams = streamsResult.data;

  // 2. Load and migrate task groups
  const rawTaskGroups = workspaceSM.get(WorkspaceStateKey.TASK_GROUPS, []);
  const { workflowData, conversationData } = migrateTaskGroups(rawTaskGroups, streams);

  // 3. Load run-scoped data and merge into workflow runs
  const rawInstructions = workspaceSM.get(WorkspaceStateKey.RUN_INSTRUCTIONS, {});
  const rawOutputFiles = workspaceSM.get(WorkspaceStateKey.OUTPUT_FILES, {});
  const rawUsageStats = workspaceSM.get(WorkspaceStateKey.USAGE_STATS, {});

  mergeRunScopedData(workflowData, { rawInstructions, rawOutputFiles, rawUsageStats });

  // 4. Load execution IDs for conversation data
  const rawExecutionIds = workspaceSM.get(WorkspaceStateKey.EXECUTION_IDS, {});
  mergeExecutionIds(conversationData, rawExecutionIds);

  // 5. Load active stream
  const activeStreamId = workspaceSM.get(WorkspaceStateKey.ACTIVE_STREAM_TAB, null);

  return {
    activeStreamId,
    streams: new Map(streams.map(s => [s.id, s])),
    workflowData,
    conversationData,
  };
}
```

### Migration Strategy: Keep It Simple

**Don't over-engineer persistence migration.** This is ephemeral UI state, not a database.

```typescript
// At load time - try new format, fall back to legacy, or start fresh
function loadState(): ProgressState {
  // Try new consolidated format first
  const newFormat = workspaceSM.get('texra.progressState');
  if (newFormat) {
    const result = ProgressStateSchema.safeParse(newFormat);
    if (result.success) return result.data;
  }

  // Try legacy format (one-time migration)
  const legacyStreams = workspaceSM.get(WorkspaceStateKey.STREAM_TABS);
  if (legacyStreams) {
    const migrated = migrateLegacyState();
    // Clear old keys after successful migration
    clearLegacyKeys();
    return migrated;
  }

  // Start fresh
  return createEmptyState();
}
```

**Principles:**
1. **New format first** - Check consolidated key
2. **One-time legacy migration** - Convert old keys once, then delete them
3. **Fail fast** - If parse fails, start fresh (users don't care about progress history)
4. **No version numbers** - If format changes again, just clear and start fresh

### Consolidated Storage Keys

After migration, reduce from 12 keys to 4:

| Old Keys | New Key | Notes |
|----------|---------|-------|
| `streamTabs`, `activeStreamTab`, `taskStates` | `texra.streams` | Stream metadata |
| `taskGroups`, `runInstructions`, `outputFiles`, `missingOutputs`, `usageStats`, `activeRunIds` | `texra.workflowData` | All workflow data |
| `executionIds` | `texra.conversationData` | All conversation data |
| `streamSortOrder`, `streamAgentFilter` | `texra.uiPreferences` | UI state |

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
│       │   ├── FileList.ts          # Output files
│       │   ├── UsageDisplay.ts      # Token usage
│       │   └── PromptOverlay.ts     # Modal dialogs
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

### Supporting Schemas (used by Workflow/Conversation)

```typescript
// src/shared/schemas/files.ts
import { z } from 'zod';

export const FileLocationSchema = z.object({
  absolutePath: z.string(),
  relativePath: z.string(),
});

export const OutputFileSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  location: FileLocationSchema,
  round: z.int().optional(),  // Zod v4: z.int() for integers
  status: z.enum(['pending', 'created', 'modified', 'error']).prefault('pending'),
});

export type OutputFile = z.infer<typeof OutputFileSchema>;
```

```typescript
// src/shared/schemas/usage.ts
import { z } from 'zod';

export const TokenUsageSchema = z.object({
  inputTokens: z.int(),
  outputTokens: z.int(),
  cacheReadTokens: z.int().prefault(0),
  cacheWriteTokens: z.int().prefault(0),
  totalCost: z.number().optional(),
});

export const ContextStateSchema = z.object({
  usedTokens: z.int(),
  maxTokens: z.int(),
  percentUsed: z.number(),
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type ContextState = z.infer<typeof ContextStateSchema>;
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

### Aggregate Schemas (for IPC payloads)

```typescript
// src/shared/schemas/aggregates.ts
import { z } from 'zod';

// Per-stream workflow data (used in sync messages)
export const WorkflowStreamDataSchema = z.object({
  activeRunId: z.string().nullable(),
  runs: z.array(WorkflowRunSchema),
  todos: z.array(TodoItemSchema).prefault([]),
});

// Per-stream conversation data (used in sync messages)
export const ConversationStreamDataSchema = z.object({
  turns: z.array(ConversationTurnSchema),
  executionId: z.string().nullable(),
  todos: z.array(TodoItemSchema).prefault([]),
});

// Todo items (shared by both agent types)
export const TodoItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

export type WorkflowStreamData = z.infer<typeof WorkflowStreamDataSchema>;
export type ConversationStreamData = z.infer<typeof ConversationStreamDataSchema>;
export type TodoItem = z.infer<typeof TodoItemSchema>;
```

### UI Prompt Schemas (for modal dialogs)

```typescript
// src/shared/schemas/prompts.ts
import { z } from 'zod';

// Retry prompt (shown on API errors)
export const RetryPromptSchema = z.object({
  kind: z.literal('retry'),
  streamId: z.string(),
  errorMessage: z.string(),
  attemptCount: z.int(),
  availableModels: z.array(z.string()).prefault([]),
});

// Approval prompt (for tool edits requiring confirmation)
export const ApprovalPromptSchema = z.object({
  kind: z.literal('approval'),
  requestId: z.string(),
  toolName: z.string(),
  filePath: z.string(),
  diff: z.string().optional(),
  description: z.string(),
});

// Proposal prompt (for workflow/agent suggestions)
export const ProposalPromptSchema = z.discriminatedUnion('agentCategory', [
  z.object({
    agentCategory: z.literal('workflow'),
    proposalId: z.string(),
    title: z.string(),
    description: z.string(),
    inputFiles: z.array(z.string()),
    referenceFiles: z.array(z.string()),
  }),
  z.object({
    agentCategory: z.literal('toolUse'),
    proposalId: z.string(),
    title: z.string(),
    description: z.string(),
    // No file fields for toolUse
  }),
]);

export const PromptSchema = z.discriminatedUnion('kind', [
  RetryPromptSchema,
  ApprovalPromptSchema,
  ProposalPromptSchema,
]);

export type RetryPrompt = z.infer<typeof RetryPromptSchema>;
export type ApprovalPrompt = z.infer<typeof ApprovalPromptSchema>;
export type ProposalPrompt = z.infer<typeof ProposalPromptSchema>;
export type Prompt = z.infer<typeof PromptSchema>;
```

---

## IPC Protocol

**Design principle: Prefer fewer, coarser messages over many fine-grained ones.**

This isn't a distributed system. The webview lives in the same process. Don't over-engineer.

### Extension → Webview Messages

```typescript
// src/shared/ipc/toWebview.ts
import { z } from 'zod';

export const ToWebviewSchema = z.discriminatedUnion('type', [
  // ─────────────────────────────────────────────────────────
  // SYNC MESSAGES (coarse-grained state updates)
  // ─────────────────────────────────────────────────────────

  // Full state sync (on connect, stream switch)
  z.object({
    type: z.literal('sync/full'),
    streams: z.array(StreamSchema),
    activeStreamId: z.string().nullable(),
    workflowData: z.record(z.string(), WorkflowStreamDataSchema).optional(),
    conversationData: z.record(z.string(), ConversationStreamDataSchema).optional(),
  }),

  // Incremental sync for active stream
  z.object({
    type: z.literal('sync/stream'),
    streamId: z.string(),
    stream: StreamSchema.partial(),  // Only changed fields
    workflowData: WorkflowStreamDataSchema.optional(),
    conversationData: ConversationStreamDataSchema.optional(),
  }),

  // ─────────────────────────────────────────────────────────
  // APPEND MESSAGES (new items during execution)
  // ─────────────────────────────────────────────────────────

  z.object({
    type: z.literal('workflow/task-append'),
    streamId: z.string(),
    runId: z.string(),
    task: WorkflowTaskSchema,
  }),

  z.object({
    type: z.literal('conversation/turn-append'),
    streamId: z.string(),
    turn: ConversationTurnSchema,
  }),

  // ─────────────────────────────────────────────────────────
  // UPDATE MESSAGES (streaming changes to existing items)
  // ─────────────────────────────────────────────────────────

  z.object({
    type: z.literal('workflow/task-update'),
    streamId: z.string(),
    runId: z.string(),
    taskId: z.string(),
    updates: WorkflowTaskSchema.partial(),  // Only changed fields
  }),

  z.object({
    type: z.literal('conversation/turn-update'),
    streamId: z.string(),
    turnId: z.string(),
    updates: ConversationTurnSchema.partial(),  // e.g., content growing
  }),

  z.object({
    type: z.literal('stream/status'),
    streamId: z.string(),
    status: StreamStatusSchema,
  }),

  // ─────────────────────────────────────────────────────────
  // UI PROMPTS (require user interaction)
  // ─────────────────────────────────────────────────────────

  z.object({
    type: z.literal('ui/prompt'),
    prompt: PromptSchema,  // See UI Prompt Schemas section above
  }),

  z.object({
    type: z.literal('ui/prompt-resolved'),
    promptId: z.string(),
  }),

  // ─────────────────────────────────────────────────────────
  // SETTINGS
  // ─────────────────────────────────────────────────────────

  z.object({
    type: z.literal('settings/update'),
    theme: z.enum(['light', 'dark', 'high-contrast']).optional(),
    bypassApproval: z.boolean().optional(),
  }),
]);

export type ToWebview = z.infer<typeof ToWebviewSchema>;
```

**Message count: 9** (down from 20+)

### Webview → Extension Messages

```typescript
// src/shared/ipc/fromWebview.ts
import { z } from 'zod';

export const FromWebviewSchema = z.discriminatedUnion('type', [
  // Lifecycle
  z.object({ type: z.literal('ready') }),

  // Stream actions
  z.object({
    type: z.literal('stream/action'),
    action: z.enum(['switch', 'stop', 'delete', 'delete-all']),
    streamId: z.string().optional(),
  }),

  // Agent actions
  z.object({
    type: z.literal('agent/action'),
    action: z.enum(['select-run', 'new-run', 'send-followup']),
    streamId: z.string(),
    runId: z.string().optional(),
    content: z.string().optional(),
  }),

  // File actions
  z.object({
    type: z.literal('file/action'),
    action: z.enum(['open', 'compare', 'accept']),
    path: z.string(),
    comparePath: z.string().optional(),
  }),

  // UI responses
  z.object({
    type: z.literal('ui/respond'),
    promptId: z.string(),
    response: z.union([
      z.object({ kind: z.literal('retry'), action: z.enum(['retry', 'cancel', 'change-model']), newModel: z.string().optional() }),
      z.object({ kind: z.literal('approval'), approved: z.boolean() }),
      z.object({ kind: z.literal('proposal'), accepted: z.boolean() }),
    ]),
  }),

  // Settings
  z.object({
    type: z.literal('settings/toggle-bypass'),
  }),
]);

export type FromWebview = z.infer<typeof FromWebviewSchema>;
```

**Message count: 6** (down from 15+)

---

## EventBus → IPC Mapping

The EventBus remains unchanged. WebviewUpdater batches/translates EventBus payloads to IPC messages.

**Key insight**: Most fine-grained EventBus events become embedded in coarse-grained IPC messages. The webview doesn't need separate messages for files, usage, todos—they're part of the stream data.

| EventBus Event | IPC Message | Notes |
|----------------|-------------|-------|
| `setActiveStream` | `sync/full` | Full state sync on stream switch |
| `updateStreamStatus` | `stream/status` | Single stream status change |
| `addTaskGroup` | `workflow/task-append` or `conversation/turn-append` | Based on agentCategory |
| `updateTaskGroup` | `workflow/task-update` or `conversation/turn-update` | Based on agentCategory |
| `addLogMessage` | Embedded in task/turn | Logs become `content` field in task/turn |
| `addOutputFiles` | `sync/stream` | Files embedded in `WorkflowStreamData.runs[].outputs` |
| `updateMissingOutputs` | `sync/stream` | Missing files embedded in run data |
| `updateStreamUsage` | `sync/stream` | Usage embedded in `WorkflowStreamData.runs[].usage` |
| `updateContextState` | `sync/stream` | Context embedded in stream data |
| `updateTodos` | `sync/stream` | Todos embedded in `workflowData.todos` or `conversationData.todos` |
| `showRetryRequest` | `ui/prompt` (kind: retry) | |
| `resolveRetryRequest` | `ui/prompt-resolved` | |
| `showToolEditApprovalPrompt` | `ui/prompt` (kind: approval) | |
| `showAgentProposal` | `ui/prompt` (kind: proposal) | |

**Batching strategy**: WebviewUpdater debounces rapid EventBus events (e.g., during streaming) and sends a single `sync/stream` with all accumulated changes. This reduces message overhead without losing data.

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
  │   ├── <task-list>
  │   │   └── <workflow-task> (multiple)
  │   ├── <file-list>
  │   └── <usage-display>
  │
  ├── <conversation-view> (when agentCategory === 'toolUse')
  │   ├── <turn-list>
  │   │   └── <conversation-turn> (multiple)
  │   │       └── <tool-call> (if present)
  │   ├── <file-list>
  │   ├── <followup-input>
  │   └── <usage-display>
  │
  └── <prompt-overlay> (modal for retry/approval/proposal)
```

**Note**: Virtual scrolling deferred to future optimization. Initial implementation uses simple lists.

### Component Separation: Workflow vs ToolUse

The current code has **12+ locations** with `isToolUse` conditionals. The codebase itself documents this as a design problem:

```javascript
// messageHandlers.js lines 21-37
/**
 * ARCHITECTURAL NOTE: Task Groups have different semantics per agent category
 * - Workflow agents: Each group is a distinct "run" (user switches between runs)
 * - ToolUse agents: Each group is a conversation "turn" (append-only history)
 *
 * This semantic mismatch requires special handling throughout...
 * A cleaner design would separate these concepts:
 * - WorkflowRunManager for workflow agents
 * - ConversationTurnManager for toolUse agents
 */
```

#### Current uiManagers Breakdown

| Category | Files | Lit Strategy |
|----------|-------|--------------|
| **Workflow-only** | FollowupSectionManager | `<workflow-followup-section>` |
| **ToolUse-only** | ApprovalRequests, FollowUpInputManager, QueuedFollowUps, TodoList | Separate components |
| **Shared** | FileList, Status, StreamTabs, Toolbar, Placeholder, RetryRequests | Shared components with props |
| **Confused** | WorkflowProposals | **Split before migrating** |

#### Band-Aid Patterns to Eliminate

| Pattern | Current Location | Lit Solution |
|---------|------------------|--------------|
| `activeAgentCategory === 'toolUse'` | messageHandlers.js (14+ places) | Polymorphic `<workflow-view>` vs `<conversation-view>` |
| `group.parentGroupId` filtering | taskManagers.js | Only exists in `<workflow-task>` |
| `showRoundHeaders` toggle | FileList.js | Prop on `<file-list showRoundHeaders>` |
| `showRun(groupId)` for filtering | taskManagers.js | Not needed in `<conversation-view>` |
| `runSelector.setDisplayEnabled(!isToolAgent)` | messageHandlers.js | No `<run-selector>` in conversation view |
| `followUpInput.setContainerVisibility(isToolAgent)` | messageHandlers.js | Only in `<conversation-view>` |

#### Semantic Differences

| Concept | Workflow | ToolUse |
|---------|----------|---------|
| **TaskGroup meaning** | "Run" (switchable, one visible at a time) | "Turn" (append-only history, all visible) |
| **Group hierarchy** | Root + nested children | Single level only |
| **Instruction display** | Side panel (InstructionPanel) | Inline as user message |
| **File grouping** | By round (r1, r2, r3...) | Flat list |
| **User interaction** | Run selector dropdown | Follow-up input textarea |
| **Toolbar buttons** | RUN_NEW, RESUME, DIFF, PACK, CLEAN | STOP, RESTORE only |
| **Collapse behavior** | Toggle state persisted | No collapsing |

#### Component-Level Separation

**`<workflow-view>` owns:**
```
├── <run-selector>           # Switch between runs
├── <instruction-panel>      # Shows run instruction
├── <workflow-task-list>
│   └── <workflow-task>      # Collapsible, hierarchical
│       └── <workflow-task>  # Nested children
├── <file-list showRoundHeaders>
├── <workflow-followup-section>  # Chat/workflow/merge modes
└── <workflow-toolbar>       # RUN_NEW, RESUME, DIFF, etc.
```

**`<conversation-view>` owns:**
```
├── <todo-list>              # Task progress
├── <conversation-turn-list>
│   └── <conversation-turn>  # Always visible, no hierarchy
│       └── <tool-call>      # Inline tool results
├── <file-list>              # No round headers
├── <followup-input>         # Textarea + YOLO toggle
├── <queued-followups>       # Pending messages
└── <conversation-toolbar>   # STOP, RESTORE only
```

**Shared components (prop-driven):**
```
<file-list>           # showRoundHeaders?: boolean
<stream-tabs>         # Pure display, decorators from data
<status-indicator>    # Status enum → icon/text
<prompt-overlay>      # retry/approval/proposal modals
<placeholder>         # Empty state
```

#### WorkflowProposals Refactoring

`WorkflowProposals.js` is the only "confused" component—split before migrating:

```typescript
// Current: mixed conditionals
const isToolUse = request.agentCategory === 'toolUse';
categoryBadge.textContent = isToolUse ? 'Tool-Use' : 'Workflow';
// ... file fields only for workflow

// After: separate components
<workflow-proposal .proposal=${p}>    // Has file fields
<tooluse-proposal .proposal=${p}>     // No file fields, different badge
```

Or use discriminated union in schema:
```typescript
const ProposalSchema = z.discriminatedUnion('agentCategory', [
  z.object({ agentCategory: z.literal('workflow'), inputFiles: ..., referenceFiles: ... }),
  z.object({ agentCategory: z.literal('toolUse') }),  // No file fields
]);
```

### State Store

```typescript
// src/progressView/frontend/state/store.ts
import { ToWebview, ToWebviewSchema, FromWebview } from '@shared/ipc';
import type { Stream, WorkflowRun, ConversationTurn } from '@shared/schemas';

interface State {
  activeStreamId: string | null;
  streams: Map<string, Stream>;
  workflowData: Map<string, { activeRunId: string | null; runs: WorkflowRun[] }>;
  conversationData: Map<string, { turns: ConversationTurn[] }>;
  activePrompt: Prompt | null;
}

// Pending updates for entities that don't exist yet (out-of-order messages)
type PendingUpdate = {
  type: 'workflow/task-update';
  streamId: string;
  runId: string;
  taskId: string;
  updates: Partial<WorkflowTask>;
} | {
  type: 'conversation/turn-update';
  streamId: string;
  turnId: string;
  updates: Partial<ConversationTurn>;
};

class ProgressStore {
  private state: State = {
    activeStreamId: null,
    streams: new Map(),
    workflowData: new Map(),
    conversationData: new Map(),
    activePrompt: null,
  };

  // Queue updates for entities that arrive before their append message
  private pendingUpdates: PendingUpdate[] = [];

  private listeners = new Set<() => void>();
  private vscode = acquireVsCodeApi();

  // ─────────────────────────────────────────────────────────
  // Receive from extension
  // ─────────────────────────────────────────────────────────

  handleMessage(raw: unknown) {
    const result = ToWebviewSchema.safeParse(raw);
    if (!result.success) {
      console.warn('Invalid message:', result.error);
      return;
    }

    const msg = result.data;
    switch (msg.type) {
      case 'sync/full':
        this.state.streams = new Map(msg.streams.map(s => [s.id, s]));
        this.state.activeStreamId = msg.activeStreamId;
        if (msg.workflowData) this.state.workflowData = new Map(Object.entries(msg.workflowData));
        if (msg.conversationData) this.state.conversationData = new Map(Object.entries(msg.conversationData));
        break;

      case 'sync/stream':
        // Incremental update for single stream
        break;

      case 'workflow/task-append':
        this.appendWorkflowTask(msg.streamId, msg.runId, msg.task);
        this.applyPendingUpdates('workflow', msg.task.id);  // Apply queued updates
        break;

      case 'conversation/turn-append':
        this.appendConversationTurn(msg.streamId, msg.turn);
        this.applyPendingUpdates('conversation', msg.turn.id);  // Apply queued updates
        break;

      case 'workflow/task-update':
        if (!this.updateWorkflowTask(msg.streamId, msg.runId, msg.taskId, msg.updates)) {
          // Entity doesn't exist yet - queue for later
          this.pendingUpdates.push(msg);
        }
        break;

      case 'conversation/turn-update':
        if (!this.updateConversationTurn(msg.streamId, msg.turnId, msg.updates)) {
          // Entity doesn't exist yet - queue for later
          this.pendingUpdates.push(msg);
        }
        break;

      case 'stream/status':
        this.updateStreamStatus(msg.streamId, msg.status);
        break;

      case 'ui/prompt':
        this.state.activePrompt = msg.prompt;
        break;

      case 'ui/prompt-resolved':
        this.state.activePrompt = null;
        break;
    }
    this.notify();
  }

  // ─────────────────────────────────────────────────────────
  // Send to extension
  // ─────────────────────────────────────────────────────────

  send(message: FromWebview) {
    this.vscode.postMessage(message);
  }

  // ─────────────────────────────────────────────────────────
  // Out-of-order message handling
  // ─────────────────────────────────────────────────────────

  /** Apply queued updates when an entity is finally appended */
  private applyPendingUpdates(type: 'workflow' | 'conversation', entityId: string) {
    const toApply = this.pendingUpdates.filter(u => {
      if (type === 'workflow' && u.type === 'workflow/task-update') {
        return u.taskId === entityId;
      }
      if (type === 'conversation' && u.type === 'conversation/turn-update') {
        return u.turnId === entityId;
      }
      return false;
    });

    for (const update of toApply) {
      if (update.type === 'workflow/task-update') {
        this.updateWorkflowTask(update.streamId, update.runId, update.taskId, update.updates);
      } else {
        this.updateConversationTurn(update.streamId, update.turnId, update.updates);
      }
    }

    // Remove applied updates from queue
    this.pendingUpdates = this.pendingUpdates.filter(u => !toApply.includes(u));
  }

  /** Returns false if entity doesn't exist (caller should queue) */
  private updateWorkflowTask(
    streamId: string, runId: string, taskId: string, updates: Partial<WorkflowTask>
  ): boolean {
    const data = this.state.workflowData.get(streamId);
    const run = data?.runs.find(r => r.id === runId);
    const task = run?.tasks.find(t => t.id === taskId);
    if (!task) return false;
    Object.assign(task, updates);
    return true;
  }

  /** Returns false if entity doesn't exist (caller should queue) */
  private updateConversationTurn(
    streamId: string, turnId: string, updates: Partial<ConversationTurn>
  ): boolean {
    const data = this.state.conversationData.get(streamId);
    const turn = data?.turns.find(t => t.id === turnId);
    if (!turn) return false;
    Object.assign(turn, updates);
    return true;
  }

  // ─────────────────────────────────────────────────────────
  // Accessors (components read from these)
  // ─────────────────────────────────────────────────────────

  get activeStream(): Stream | undefined {
    return this.state.activeStreamId ? this.state.streams.get(this.state.activeStreamId) : undefined;
  }

  getWorkflowData(streamId: string) { return this.state.workflowData.get(streamId); }
  getConversationData(streamId: string) { return this.state.conversationData.get(streamId); }

  // ─────────────────────────────────────────────────────────
  // Subscription
  // ─────────────────────────────────────────────────────────

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach(fn => fn());
  }
}

export const store = new ProgressStore();

// Wire up on load
window.addEventListener('message', (e) => store.handleMessage(e.data));
store.send({ type: 'ready' });
```

### Example Component

```typescript
// src/progressView/frontend/components/WorkflowView.ts
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { store } from '../state/store.js';
import type { WorkflowRun } from '@shared/schemas';

@customElement('workflow-view')
export class WorkflowView extends LitElement {
  @property() streamId!: string;
  @state() private activeRunId: string | null = null;
  @state() private runs: WorkflowRun[] = [];

  private unsubscribe?: () => void;

  static styles = css`
    :host { display: flex; flex-direction: column; height: 100%; }
    .run-content { flex: 1; overflow-y: auto; }
    .task-list { display: flex; flex-direction: column; gap: 8px; }
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
    const data = store.getWorkflowData(this.streamId);
    if (data) {
      this.activeRunId = data.activeRunId;
      this.runs = data.runs;
    }
  }

  private get activeRun(): WorkflowRun | undefined {
    return this.runs.find(r => r.id === this.activeRunId);
  }

  render() {
    if (!this.activeRun) {
      return html`<p>No run selected</p>`;
    }

    return html`
      <run-selector
        .runs=${this.runs}
        .activeRunId=${this.activeRunId}
        @run-selected=${this.handleRunChange}
      ></run-selector>

      <div class="run-content">
        <instruction-panel .text=${this.activeRun.instruction}></instruction-panel>

        <div class="task-list">
          ${repeat(
            this.activeRun.tasks,
            (task) => task.id,
            (task) => html`<workflow-task .task=${task}></workflow-task>`
          )}
        </div>

        <file-list .files=${this.activeRun.outputs}></file-list>
        <usage-display .usage=${this.activeRun.usage}></usage-display>
      </div>
    `;
  }

  private handleRunChange(e: CustomEvent<string>) {
    store.send({ type: 'agent/action', action: 'select-run', streamId: this.streamId, runId: e.detail });
  }
}
```

---

## Rendering Pattern Migration

The current codebase uses three distinct rendering patterns. Each maps to a Lit equivalent:

### Pattern 1: HTML String Builders → Lit Templates

**Current** (`htmlBuilders.js`):
```javascript
export function buildToolUseSection(label, content) {
  return `
  <div class="tool-use-section">
    <div class="tool-use-subsection">
      <span class="tool-use-sublabel">${label}</span>
      ${content}
    </div>
  </div>
`;
}

// Usage: element.innerHTML = buildToolUseSection('Input:', inputHtml);
```

**Lit equivalent**:
```typescript
// Inside component render() method
private renderToolUseSection(label: string, content: TemplateResult) {
  return html`
    <div class="tool-use-section">
      <div class="tool-use-subsection">
        <span class="tool-use-sublabel">${label}</span>
        ${content}
      </div>
    </div>
  `;
}

// Usage: ${this.renderToolUseSection('Input:', this.renderInput())}
```

**Key difference**: Lit's `html` tagged template returns a `TemplateResult`, not a string. Lit diffs these efficiently. Never use `innerHTML` in Lit components.

### Pattern 2: Template Cloning → Component Composition

**Current** (`FileList.js`):
```javascript
_renderFileItem(template, parent, file) {
  const clone = template.content.cloneNode(true);
  const fileItem = clone.querySelector('.file-item');
  fileItem.dataset.file = file.location.absolutePath;
  // ... more querySelector + manual property setting
  parent.appendChild(clone);
}
```

**Lit equivalent**:
```typescript
// file-item.ts - standalone component
@customElement('file-item')
export class FileItem extends LitElement {
  @property({ type: Object }) file!: OutputFile;

  render() {
    return html`
      <div class="file-item" data-file=${this.file.location.absolutePath}>
        <span class="file-path" title=${this.file.location.relativePath}>
          ${this.file.displayName}
        </span>
        ${this.renderButtons()}
      </div>
    `;
  }
}

// file-list.ts - parent component
render() {
  return html`
    ${repeat(
      this.files,
      (file) => file.id,
      (file) => html`<file-item .file=${file}></file-item>`
    )}
  `;
}
```

**Key difference**: No manual DOM manipulation. Pass data down via properties (`.file=${file}`), Lit handles the rest.

### Pattern 3: DOM Element Cache → Reactive State

**Current** (`taskManagers.js`):
```javascript
export class TaskGroupDomManager {
  constructor() {
    this.groupElements = new Map();  // Manual cache
    this.toggleListeners = new Map();
  }

  _registerGroupElement(group, element) {
    progressViewState.taskGroups.set(group.id, group);
    this.groupElements.set(group.id, element);
  }

  updateGroupStatus(groupId, status) {
    const element = this.groupElements.get(groupId);
    if (!element) return;
    element.querySelector('.status').textContent = status;
  }
}
```

**Lit equivalent**:
```typescript
@customElement('workflow-task')
export class WorkflowTask extends LitElement {
  @property({ type: Object }) task!: WorkflowTask;

  // No cache needed - Lit tracks by key in parent's repeat()
  render() {
    return html`
      <details class="log-group" ?open=${!this.task.collapsed}>
        <summary>${this.task.label}</summary>
        <span class="status">${this.task.status}</span>
        ${this.renderContent()}
      </details>
    `;
  }
}
```

**Key difference**: No element cache. Update the data in the store → Lit re-renders affected components. The `repeat()` directive with keys ensures efficient updates.

### Pattern 4: Event Delegation → Declarative Handlers

**Current** (`domHandlers.js`):
```javascript
// Single listener on container, check data-* attributes
document.getElementById('log-content').addEventListener('click', (e) => {
  const target = e.target.closest('[data-command]');
  if (!target) return;

  const command = target.dataset.command;
  const file = target.dataset.file;
  vscode.postMessage({ type: command, file });
});
```

**Lit equivalent**:
```typescript
// Declarative in template
render() {
  return html`
    <span
      class="file-link"
      @click=${() => this.openFile(this.file.path)}
    >
      ${this.file.name}
    </span>
  `;
}

private openFile(path: string) {
  store.send({ type: 'file/action', action: 'open', path });
}
```

**Key difference**: Event handlers are declared inline. No data-* attribute inspection. Type-safe because `this.file.path` is typed.

### Pattern 5: Formatters with Side Effects → Pure Render Functions

**Current** (`markdownRenderer.js`):
```javascript
export function renderMarkdown(text, container) {
  const html = marked.parse(text);
  container.innerHTML = html;
  // Side effect: modifies DOM
  highlightCodeBlocks(container);
  addCopyButtons(container);
}
```

**Lit equivalent**:
```typescript
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { marked } from 'marked';

// Pure function - no side effects
function renderMarkdown(text: string): TemplateResult {
  const html = marked.parse(text);
  return unsafeHTML(html);
}

// In component
render() {
  return html`
    <div class="markdown-content">
      ${renderMarkdown(this.content)}
    </div>
  `;
}
```

**Note**: `unsafeHTML` is needed for pre-rendered HTML (markdown output). For code highlighting, consider a Lit directive or post-render callback in `updated()`.

### Migration Checklist per File

| Current File | Migration Target | Pattern |
|--------------|------------------|---------|
| `htmlBuilders.js` | Inline in components | 1 (templates) |
| `FileList.js` | `<file-list>` + `<file-item>` | 2 (composition) |
| `taskManagers.js` | `<workflow-task>` | 3 (reactive) |
| `domHandlers.js` | Delete (handlers in components) | 4 (declarative) |
| `markdownRenderer.js` | `renderMarkdown()` util + directive | 5 (pure functions) |
| `formatters/*.js` | Keep as pure functions, call from `render()` | 5 |
| `uiManagers/*.js` | One component per manager | 2 + 3 |

---

## Build Configuration

### TypeScript Configuration

Lit decorators require these `tsconfig.json` settings:

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,      // Required for @customElement, @property
    "useDefineForClassFields": false,    // Required for Lit property initialization
    // ... existing settings
  }
}
```

**Note**: If the project already uses decorators elsewhere, these may already be set. Verify before adding.

### Webpack Changes

The `@shared` alias must work in **both** contexts (extension host and webview). The key is that webview code runs in a browser sandbox—no Node.js APIs.

```javascript
// webpack.config.js
const path = require('path');

// Shared alias configuration
const sharedAlias = {
  '@shared': path.resolve(__dirname, 'src/shared'),
};

// Extension host (Node.js context)
const extensionConfig = {
  target: 'node',
  entry: './src/extension.ts',
  output: { path: path.resolve(__dirname, 'dist'), filename: 'extension.js' },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: sharedAlias,  // Same alias
  },
  externals: { vscode: 'commonjs vscode' },
  // ... other settings
};

// Webview (browser context - NO Node.js APIs)
const webviewConfig = {
  target: 'web',  // Critical: browser target
  entry: {
    progressView: './src/progressView/frontend/index.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist/webview'),
    filename: '[name].js',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: sharedAlias,  // Same alias - shares schemas
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
  // IMPORTANT: Don't externalize anything - bundle everything for browser
};

module.exports = [extensionConfig, webviewConfig];
```

**Sandbox constraints**: The `src/shared/` schemas must not import any Node.js modules (fs, path, etc.). Zod is browser-compatible. If a schema needs Node.js APIs, it belongs in `src/` not `src/shared/`.

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

**Two milestones. First one is shippable alone.**

The type safety from shared schemas delivers 80% of the maintenance benefit. The Lit UI refactor is polish. Ship schemas first, validate, then decide if the UI rewrite is worth it.

---

### Milestone 1: Type Safety (3-4 days)

**This milestone is independently valuable.** You can stop here and still win.

#### 1.1 Create shared schemas

```bash
src/shared/schemas/stream.ts
src/shared/schemas/workflow.ts
src/shared/schemas/conversation.ts
src/shared/ipc/index.ts
```

Import schemas in backend code. Replace ad-hoc interfaces with `z.infer<>` types. The frontend keeps using JSDoc for now—but backend→webview messages are now validated.

**Test**: Extension works, `npm run lint` passes, schemas compile.

#### 1.2 Delete duplicates

```bash
rm src/common/webview/commands.js    # Use commands.ts
rm src/common/constants/streamStatus.js  # Use streamStatus.ts
```

**Test**: Extension works. This is safe—just removing dead code.

#### 1.3 Update WebviewUpdater to use IPC schemas

`WebviewUpdater.ts` starts using `ToWebviewSchema` types. Messages are validated before sending. Frontend still receives same shape—no breaking changes yet.

**Test**: Run agent, check messages are typed correctly.

**Milestone 1 complete.** Ship it. See if anything breaks in production.

---

### Milestone 2: Lit UI (1-2 weeks)

**Only start this after Milestone 1 is stable.**

#### 2.1 Webpack + Lit shell

```bash
# Add webpack entry for webview
webpack.config.js  # Add webviewConfig

# Minimal Lit app
src/progressView/frontend/index.ts
src/progressView/frontend/components/ProgressApp.ts
```

**Test**: Bundle builds, webview loads "Hello World".

#### 2.2 Wire up store + message handler

```bash
src/progressView/frontend/state/store.ts
src/progressView/frontend/ipc/handler.ts
```

**Test**: Messages flow, `console.log` shows data in store.

#### 2.3 Build components (one at a time)

Each component must work before starting the next:

1. `StreamTabs.ts` - Switch streams
2. `WorkflowView.ts` - Runs, tasks, files
3. `ConversationView.ts` - Turns, tool calls
4. `PromptOverlay.ts` - Retry, approval, proposal

#### 2.4 Delete old code

Only after everything works:

```bash
rm -rf src/progressView/modules/
```

---

### Escape Hatch

If Milestone 2 goes badly:
1. Revert `index.html` to use import maps
2. Keep `modules/` around (don't delete until proven)

The schemas from Milestone 1 remain valuable regardless.

---

## Risks

### High Risk: Persistence Migration (12 → 4 keys)

The `migrateTaskGroups()` function must handle every edge case that accumulated in production:
- Streams with no runs
- Runs with no tasks
- Orphaned task groups (parent deleted, children remain)
- Mixed agent categories in same stream (shouldn't happen, but might)
- Corrupted timestamps (null, undefined, 0)

**Mitigation:**
1. Test migration on **real persisted data**, not just fixtures
2. Export anonymized workspace state from 5+ users before implementing
3. Add defensive `.catch()` and `.default()` in Zod schemas
4. If migration fails, start fresh (users don't care about progress history)

### Medium Risk: IPC Message Ordering

During streaming, messages arrive rapidly. If `task-update` arrives before `task-append`, the update targets a non-existent task.

**Mitigation:**
- Backend sends `append` before any `update` for same entity
- Frontend queues updates for unknown IDs, applies when entity appears
- Or simpler: just drop updates for unknown IDs (they'll get full sync on next stream switch)

### Low Risk: Lit Bundle Size

Lit adds ~5KB gzipped. Acceptable for a panel that loads once per session.

---

## Deletion List

### Milestone 1: Delete Immediately

```
src/common/webview/commands.js         # 300 lines (duplicate of commands.ts)
src/common/constants/streamStatus.js   # duplicate of streamStatus.ts
```

### Milestone 2: Delete After Lit Migration

```
src/progressView/modules/messageHandlers.js   # 1268 lines → store.ts
src/progressView/modules/taskManagers.js      # 544 lines → components
src/progressView/modules/progressViewState.js # → store.ts
src/progressView/modules/domHandlers.js       # → Lit handles DOM
src/progressView/modules/formatters.js        # → component methods
src/progressView/modules/utils.js             # → shared utils
src/progressView/modules/constants.js         # → shared schemas
src/progressView/modules/usageManagers.js     # → UsageDisplay component
src/progressView/modules/uiManagers/*.js      # 14 files → Lit components
src/progressView/modules/handlers/*.js        # → component methods
src/progressView/modules/formatters/*.js      # → component methods
```

### Code Patterns Eliminated (Milestone 2)

- `lastRenderedStream` hack
- `resolveActiveRunId()` fallback chain
- `_clearAgentCategoryState()` workaround
- `RunScopedMap` with resolver closure
- 14+ `isToolUse` / `isWorkflow` conditionals
- ~367 lines of JSDoc type comments

---

## Success Metrics

### After Milestone 1 (Type Safety)

| Metric | Current | After M1 |
|--------|---------|----------|
| Backend→Webview type safety | 0% | 100% |
| Duplicate code | 600+ lines | 0 |
| Shared schemas | 0 | 6 files |

**You can stop here.** This alone makes the codebase significantly more maintainable.

### After Milestone 2 (Lit UI)

| Metric | Current | After M2 |
|--------|---------|----------|
| Frontend type coverage | ~20% (JSDoc) | 100% (TypeScript) |
| Lines of code (frontend) | ~3700 | ~2000 (-45%) |
| Message handler complexity | 1268-line switch | ~150-line dispatcher |
| State tracking locations | 7 | 1 (store.ts) |
| `isToolUse` conditionals | 14+ | 0 (separate components) |
| JSDoc comments | ~367 lines | 0 |

**Future optimization** (not in scope):
- Virtual scrolling for large conversations
- Memoized markdown rendering

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
