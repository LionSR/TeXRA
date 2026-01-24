# PRD: ProgressView Modernization

## Overview

Modernize ProgressView from vanilla JavaScript to Lit + TypeScript with shared Zod schemas.

## Problem Statement

1. **No Type Safety Across Process Boundary**
   - EventBus has Zod schemas, but webview messages are untyped
   - `commands.js` / `commands.ts` duplicated (300 lines each)
   - Frontend uses JSDoc (~367 lines) instead of real types

2. **Overengineered State Management**
   - 7 places track "active" state
   - TaskGroup means "run" for Workflow, "turn" for ToolUse (semantic overloading)
   - 6 band-aid workarounds scattered across codebase

3. **Maintenance Burden**
   - `messageHandlers.js`: 1268-line switch statement
   - 14+ conditional checks for `isToolUse` vs `isWorkflow`

## Goals

**Milestone 1 (shippable alone):**
- End-to-end type safety via shared Zod schemas — delivers 80% of maintenance benefit

**Milestone 2:**
- Simplified state by separating Workflow and Conversation data models
- Maintainable UI with Lit components

## Non-Goals

- Changing EventBus architecture
- Virtual scrolling (future optimization)
- Adding new features

---

## Architecture

### Data Flow

```
Agent Execution
       ↓
EventBus (unchanged)
       ↓
WebviewUpdater + IPC Protocol (shared schemas)
       ↓
postMessage (validated)
       ↓
Webview Frontend (Lit + TypeScript + Zod)
```

### Shared Schemas (src/shared/)

| Schema | Purpose |
|--------|---------|
| `StreamSchema` | Stream metadata (id, label, agentCategory, status) |
| `WorkflowRunSchema` | Run with tasks, outputs, usage |
| `WorkflowTaskSchema` | Individual task in a run |
| `ConversationTurnSchema` | Chat turn with optional tool calls |
| `ToolCallSchema` | Tool invocation details |
| `OutputFileSchema` | File location and status |
| `TokenUsageSchema` | Input/output/cache tokens |
| `PromptSchema` | Retry, approval, proposal dialogs |

Key principle: browser-compatible only (no Node.js APIs in `src/shared/`).

### Key Schema Examples

```typescript
// Workflow vs Conversation - the core separation
export const WorkflowRunSchema = z.object({
  id: z.string(),
  instruction: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'error']),
  tasks: z.array(WorkflowTaskSchema),
  outputs: z.array(OutputFileSchema),
  usage: TokenUsageSchema.optional(),
});

export const ConversationTurnSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  timestamp: z.number(),
});

// Aggregate schemas for IPC payloads
export const WorkflowStreamDataSchema = z.object({
  activeRunId: z.string().nullable(),
  runs: z.array(WorkflowRunSchema),
});

export const ConversationStreamDataSchema = z.object({
  turns: z.array(ConversationTurnSchema),
  executionId: z.string().nullable(),
});
```

### IPC Protocol

**9 messages** (down from 20+):

| Message | Direction | Purpose |
|---------|-----------|---------|
| `sync/full` | → webview | Full state on connect/stream switch |
| `sync/stream` | → webview | Incremental update (batched) |
| `workflow/task-append` | → webview | New task added |
| `workflow/task-update` | → webview | Task status changed |
| `conversation/turn-append` | → webview | New turn added |
| `conversation/turn-update` | → webview | Turn content growing (streaming) |
| `stream/status` | → webview | Stream lifecycle change |
| `ui/prompt` | → webview | Show retry/approval/proposal |
| `ui/prompt-resolved` | → webview | Dismiss prompt |

**6 messages from webview:**
- `ready`, `stream/action`, `agent/action`, `file/action`, `ui/respond`, `settings/toggle-bypass`

### EventBus → IPC Mapping

Most EventBus events batch into `sync/stream`:

| EventBus Event | IPC Message |
|----------------|-------------|
| `setActiveStream` | `sync/full` |
| `addTaskGroup` | `workflow/task-append` or `conversation/turn-append` |
| `updateTaskGroup` | `workflow/task-update` or `conversation/turn-update` |
| `addOutputFiles`, `updateStreamUsage`, `updateTodos` | `sync/stream` (batched) |
| `showRetryRequest` | `ui/prompt` (kind: retry) |

---

## Frontend State

```typescript
// Single source of truth for webview
interface State {
  activeStreamId: string | null;
  streams: Map<string, Stream>;
  workflowData: Map<string, WorkflowStreamData>;
  conversationData: Map<string, ConversationStreamData>;
  activePrompt: Prompt | null;
}
```

Message handling: If `task-update` arrives before `task-append`, drop it. Full sync recovers on next stream switch.

---

## Component Separation

The current code has **14+ `isToolUse` conditionals**. The codebase documents this as a design problem.

### Semantic Differences

| Concept | Workflow | ToolUse |
|---------|----------|---------|
| TaskGroup meaning | "Run" (switchable) | "Turn" (append-only) |
| Group hierarchy | Root + nested children | Single level |
| File grouping | By round (r1, r2, r3...) | Flat list |
| User interaction | Run selector | Follow-up input |
| Toolbar | RUN_NEW, RESUME, DIFF... | STOP, RESTORE only |

### Component Hierarchy

```
<progress-app>
  ├── <stream-tabs>
  │
  ├── <workflow-view>              # when agentCategory === 'workflow'
  │   ├── <run-selector>
  │   ├── <instruction-panel>
  │   ├── <workflow-task-list>
  │   │   └── <workflow-task>      # Collapsible, hierarchical
  │   ├── <file-list showRoundHeaders>
  │   └── <workflow-toolbar>
  │
  ├── <conversation-view>          # when agentCategory === 'toolUse'
  │   ├── <todo-list>
  │   ├── <conversation-turn-list>
  │   │   └── <conversation-turn>
  │   │       └── <tool-call>
  │   ├── <file-list>
  │   ├── <followup-input>
  │   └── <conversation-toolbar>
  │
  └── <prompt-overlay>
```

### Band-Aids Eliminated

| Pattern | Current | After |
|---------|---------|-------|
| `activeAgentCategory === 'toolUse'` | 14+ places | 0 (separate components) |
| `group.parentGroupId` filtering | taskManagers.js | Only in `<workflow-task>` |
| `showRun(groupId)` | taskManagers.js | Not needed in conversation |
| `resolveActiveRunId()` fallback | 30 calls | Single store |

---

## Persistence Migration

### Current Keys (12) → New Keys (4)

| Old Keys | New Key |
|----------|---------|
| `streamTabs`, `activeStreamTab`, `taskStates` | `texra.streams` |
| `taskGroups`, `runInstructions`, `outputFiles`, `usageStats`, `activeRunIds` | `texra.workflowData` |
| `executionIds` | `texra.conversationData` |
| `streamSortOrder`, `streamAgentFilter` | `texra.uiPreferences` |

### Migration Strategy

```typescript
function loadState(): ProgressState {
  // Try new format first
  const newFormat = workspaceSM.get('texra.progressState');
  if (newFormat) {
    const result = ProgressStateSchema.safeParse(newFormat);
    if (result.success) return result.data;
  }

  // Try legacy format (one-time migration)
  const legacyStreams = workspaceSM.get('texra.streamTabs');
  if (legacyStreams) {
    const migrated = migrateLegacyState();
    clearLegacyKeys();
    return migrated;
  }

  // Start fresh
  return createEmptyState();
}
```

**Principle**: If migration fails, start fresh. Users don't care about progress history.

---

## Migration Plan

### Milestone 1: Type Safety (3-4 days)

**Shippable alone. Stop here and still win.**

1. Create `src/shared/schemas/` with Zod schemas
2. Delete duplicates: `commands.js`, `streamStatus.js`
3. Update `WebviewUpdater.ts` to use IPC schemas

**Test**: Extension works, messages typed correctly.

### Milestone 2: Lit UI (1-2 weeks)

**Only after Milestone 1 is stable.**

1. Add webpack entry for webview bundle
2. Create minimal Lit shell (`<progress-app>`)
3. Wire up store + message handler
4. Build components one at a time:
   - `StreamTabs.ts`
   - `WorkflowView.ts`
   - `ConversationView.ts`
   - `PromptOverlay.ts`
5. Delete `src/progressView/modules/` after everything works

### Escape Hatch

If Milestone 2 fails: revert `index.html`, keep `modules/`. Schemas from M1 remain valuable.

---

## Build Configuration

**tsconfig.json** (if not already set):
```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "useDefineForClassFields": false
  }
}
```

**webpack.config.js**: Add second entry for webview with `target: 'web'`. Both configs share `@shared` alias. Webview bundle must not use Node.js APIs.

---

## Risks

### High: Persistence Migration

12 storage keys → 4. The `migrateTaskGroups()` function must handle edge cases (orphaned groups, corrupted timestamps). **Mitigation**: Test on real data. If migration fails, start fresh.

### Medium: Message Ordering

If `task-update` arrives before `task-append`, drop the update. Full sync on next stream switch recovers state.

### Low: Lit Bundle Size

~5KB gzipped. Acceptable.

---

## Deletion List

**Milestone 1:**
```
src/common/webview/commands.js
src/common/constants/streamStatus.js
```

**Milestone 2:**
```
src/progressView/modules/  (entire directory)
```

---

## Success Metrics

### After M1

| Metric | Current | After |
|--------|---------|-------|
| Backend→Webview type safety | 0% | 100% |
| Duplicate code | 600+ lines | 0 |

### After M2

| Metric | Current | After |
|--------|---------|-------|
| Frontend type coverage | ~20% | 100% |
| Lines of code (frontend) | ~3700 | ~2000 |
| `isToolUse` conditionals | 14+ | 0 |
| State tracking locations | 7 | 1 |

---

## References

- [GitLens](https://github.com/gitkraken/vscode-gitlens) - Lit-based VS Code extension
- [VSCode Elements](https://github.com/vscode-elements/elements) - Lit component library (already a dependency)
- [Lit VSCode Tutorial](https://rodydavis.com/posts/lit-vscode-extension)

---

## Appendix: Current Issues

### Seven Places Track "Active" State

| Location | Tracks |
|----------|--------|
| Backend `_activeStream` | Current stream |
| Backend `StreamSessionState.activeRunId` | Per-stream run |
| Frontend `state.activeStream` | Current stream |
| Frontend `state.lastRenderedStream` | Last rendered |
| Frontend `state.activeRunIds` | Per-stream run |
| Frontend `runSelector._pendingActiveId` | UI selection |
| Frontend `streamStatuses` | Lifecycle |

**Solution**: Single `store.ts` with `activeStreamId` and agent-specific data maps.

### Band-Aid Workarounds

1. `resolveActiveRunId()` - Expensive fallback iterating multiple maps
2. `lastRenderedStream` - Detecting stream switches via render state
3. `_clearAgentCategoryState()` - Wiping state on category change
4. `RunScopedMap` resolver closure - Implicit activeStream dependency
5. 14+ `isToolUse` checks - Conditional logic everywhere

**Solution**: Clean separation of Workflow and Conversation data models.
