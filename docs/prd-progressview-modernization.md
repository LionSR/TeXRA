# PRD: ProgressView Modernization

**Depends on**: [Webview Shared Infrastructure](./prd-webview-shared-infrastructure.md)

## Overview

Modernize ProgressView from vanilla JavaScript to Lit + TypeScript. This is the highest-complexity webview (1,526-line handler, 67+ modules) and serves as the pilot for the shared infrastructure.

## Problem Statement

### 1. No Type Safety Across Process Boundary

- EventBus has Zod schemas, but webview messages are untyped
- `commands.js` / `commands.ts` duplicated (300 lines each)
- Frontend uses JSDoc (~367 lines) instead of real types

### 2. Overengineered State Management

- 7 places track "active" state (see Appendix)
- TaskGroup means "run" for Workflow, "turn" for ToolUse (semantic overloading)
- 6 band-aid workarounds scattered across codebase

### 3. Maintenance Burden

- `messageHandlers.js`: 1268-line switch statement
- 18 `isToolUse` references (10 actual branching conditionals, 8 derived variables)

### 4. Imperative DOM Patterns

- Fragment batching: 53 lines of manual `createDocumentFragment()` + nested loops (lines 632-684)
- DOM queries during render: `if (container)` checks while building UI
- 8 nearly-identical approval handlers (tool edit, bash, retry, proposal) with show/resolve pairs

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

## ProgressView-Specific Schemas

Extends base schemas from `src/shared/schemas/ipc.ts`.

```typescript
// src/shared/schemas/progress.ts

// Stream metadata
export const StreamSchema = z.object({
  id: z.string(),
  label: z.string(),
  agentCategory: z.enum(['workflow', 'toolUse']),
  status: z.enum(['idle', 'running', 'completed', 'error']),
});

// Workflow mode - hierarchical runs
export const WorkflowRunSchema = z.object({
  id: z.string(),
  instruction: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'error']),
  tasks: z.array(WorkflowTaskSchema),
  outputs: z.array(OutputFileSchema),
  usage: TokenUsageSchema.optional(),
});

// ToolUse mode - flat conversation turns
export const ConversationTurnSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  timestamp: z.number(),
});
```

### IPC Protocol

**9 messages to webview** (down from 20+):

| Message | Purpose |
|---------|---------|
| `sync/full` | Full state on connect/stream switch |
| `sync/stream` | Incremental update (batched) |
| `workflow/task-append` | New task added |
| `workflow/task-update` | Task status changed |
| `conversation/turn-append` | New turn added |
| `conversation/turn-update` | Turn content growing (streaming) |
| `stream/status` | Stream lifecycle change |
| `ui/prompt` | Show retry/approval/proposal |
| `ui/prompt-resolved` | Dismiss prompt |

**6 messages from webview:**

- `ready`, `stream/action`, `agent/action`, `file/action`, `ui/respond`, `settings/toggle-bypass`

---

## Component Architecture

### Semantic Differences Requiring Separation

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
  ├── <stream-tabs>                    # Uses <texra-tabs>
  │
  ├── <workflow-view>                  # when agentCategory === 'workflow'
  │   ├── <run-selector>
  │   ├── <instruction-panel>
  │   ├── <workflow-task-list>
  │   │   └── <workflow-task>          # Collapsible, hierarchical
  │   ├── <file-list showRoundHeaders>
  │   └── <workflow-toolbar>           # Uses <texra-toolbar>
  │
  ├── <conversation-view>              # when agentCategory === 'toolUse'
  │   ├── <todo-list>
  │   ├── <conversation-turn-list>
  │   │   └── <conversation-turn>
  │   │       └── <tool-call>
  │   ├── <file-list>
  │   ├── <followup-input>
  │   └── <conversation-toolbar>
  │
  └── <prompt-overlay>                 # Uses <texra-modal>
```

### Band-Aids Eliminated

| Pattern | Current | After |
|---------|---------|-------|
| `activeAgentCategory === 'toolUse'` | 18 refs (10 branch) | 0 (separate components) |
| `group.parentGroupId` filtering | taskManagers.js | Only in `<workflow-task>` |
| `showRun(groupId)` | taskManagers.js | Not needed in conversation |
| `resolveActiveRunId()` fallback | 9+ explicit calls | Single store |
| Fragment batching | 53 lines manual DOM | Lit `map()` directive |
| DOM existence checks | `if (container)` etc | Reactive state |
| Approval handler duplication | 8 show/resolve pairs | Single `<prompt-overlay>` |

---

## Frontend State

```typescript
// Single source of truth for webview
interface ProgressState {
  activeStreamId: string | null;
  streams: Map<string, Stream>;
  workflowData: Map<string, WorkflowStreamData>;
  conversationData: Map<string, ConversationStreamData>;
  activePrompt: Prompt | null;
}
```

Message handling: If `task-update` arrives before `task-append`, drop it. Full sync recovers on next stream switch.

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
  const newFormat = workspaceSM.get('texra.progressState');
  if (newFormat) {
    const result = ProgressStateSchema.safeParse(newFormat);
    if (result.success) return result.data;
  }

  const legacyStreams = workspaceSM.get('texra.streamTabs');
  if (legacyStreams) {
    const migrated = migrateLegacyState();
    clearLegacyKeys();
    return migrated;
  }

  return createEmptyState();
}
```

**Principle**: If migration fails, start fresh. Users don't care about progress history.

---

## Migration Plan

### Milestone 1: Type Safety

**Prerequisite**: Shared infrastructure from Phase 0.

1. Add ProgressView schemas to `src/shared/schemas/progress.ts`
2. Wire up validation in `ProgressViewMessageHandler.ts`
3. Delete duplicates: `commands.js`, `streamStatus.js`

**Test**: Extension works, messages typed correctly.

### Milestone 2: Lit UI

**Only after Milestone 1 is stable.**

1. Create `src/progressView/frontend/` directory
2. Create minimal Lit shell (`<progress-app>`)
3. Wire up store + message handler
4. Build components incrementally:
   - `StreamTabs.ts` (uses `<texra-tabs>`)
   - `WorkflowView.ts` + children
   - `ConversationView.ts` + children
   - `PromptOverlay.ts` (uses `<texra-modal>`)
5. Delete `src/progressView/modules/` after everything works

### Escape Hatch

If Milestone 2 fails: revert `index.html`, keep `modules/`. Schemas from M1 remain valuable.

---

## Deletion List

**Milestone 1:**

```
src/common/webview/commands.js
src/common/constants/streamStatus.js
```

**Milestone 2:**

```
src/progressView/modules/  (entire directory - 67+ files)
```

---

## Risks

### High: Persistence Migration

12 storage keys → 4. **Mitigation**: Test on real data. If migration fails, start fresh.

### Medium: Message Ordering

If `task-update` arrives before `task-append`, drop it. Full sync on next stream switch recovers.

### Low: Component Complexity

Workflow vs Conversation separation is significant refactor. **Mitigation**: Separate components mean isolated testing.

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
| `isToolUse` conditionals | 18 | 0 |
| State tracking locations | 7 | 1 |
| Manual DOM assembly lines | 53+ | 0 |
| Duplicate approval handlers | 8 | 1 |

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

1. `resolveActiveRunId()` - Expensive fallback iterating 4+ maps (called 9+ times per message)
2. `lastRenderedStream` - Detecting stream switches via render state comparison
3. `_clearAgentCategoryState()` - Manual state wipe when switching workflow↔tooluse
4. `RunScopedMap` resolver closure - Hidden `activeStream` dependency through injected function
5. `_pendingActiveId` - Buffer for UI selection before backend confirms
6. 18 `isToolUse` references - 10 branching conditionals + 8 derived variables

**Solution**: Clean separation of Workflow and Conversation data models.

### Imperative DOM Patterns (Lit Eliminates)

1. **Fragment batching** (messageHandlers.js:632-684)
   - 53 lines: `createDocumentFragment()` → nested loops → `appendChild()`
   - Lit equivalent: `html\`${items.map(i => html\`<div>${i}</div>\`)}\``

2. **DOM queries during render**
   - Pattern: `const container = document.getElementById(...); if (container) { ... }`
   - Lit equivalent: Reactive `@property` automatically triggers re-render

3. **Approval handler duplication**
   - 8 nearly-identical handlers: `showToolEditApproval`, `resolveToolEditApproval`, `showBashApproval`, `resolveBashApproval`, etc.
   - Lit equivalent: Single `<prompt-overlay kind="tool-edit">` component with typed props

4. **Manual class toggling**
   - Pattern: `element.classList.add/remove/toggle('active', 'hidden', ...)`
   - Lit equivalent: `class=${classMap({ active: this.isActive, hidden: this.isHidden })}`
