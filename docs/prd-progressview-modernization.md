# PRD: ProgressView Modernization

## Overview

Add type safety to ProgressView by relocating existing Zod schemas to a browser-compatible location. Optionally rewrite the UI in Lit if type safety alone doesn't solve the maintenance burden.

## Problem Statement

1. **No Type Safety Across Process Boundary**
   - EventBus has Zod schemas, but webview receives untyped messages
   - Frontend uses JSDoc (~367 lines) instead of real types

2. **Overengineered State Management**
   - 7 places track "active" state
   - TaskGroup means "run" for Workflow, "turn" for ToolUse (semantic overloading)
   - 6 band-aid workarounds scattered across codebase

3. **Maintenance Burden**
   - `messageHandlers.js`: 1268-line switch statement
   - 18 `isToolUse` references (10 branching conditionals, 8 derived)

4. **Imperative DOM Patterns**
   - 53 lines of manual fragment batching
   - 8 nearly-identical approval handlers

## Goals

**Milestone 1**: Type-safe IPC via schema relocation — delivers 80% of benefit

**Milestone 2** (only if M1 insufficient): Lit UI rewrite

## Non-Goals

- Shared component library (premature)
- Modernizing other webviews (they're small, leave them alone)
- Adding features

---

## Existing Schemas (Relocation, Not Creation)

**60+ Zod schemas already exist.** The work is relocation, not invention.

### Browser-Ready (No Changes Needed)

| Location | Schemas | Purpose |
|----------|---------|---------|
| `src/eventBus/schemas.ts` | `TaskGroupSchema`, `TodoItemSchema`, `AddTaskGroupPayloadSchema`, etc. | Event payloads |
| `src/eventBus/types.ts` | `ToolEditApprovalPromptSchema`, `RetryRequestPromptSchema`, etc. | Prompt types |
| `src/logger/LogTypes.ts` | `TaskGroupSchema`, `LogMessageDataSchema` | Log entries |
| `src/logger/messageTypes.ts` | `MessageTypeSchema`, `LogLevelSchema` | Enums |
| `src/agent/types/UsageTypes.ts` | `TokenUsageStatsSchema`, `ExtendedTokenUsageStatsSchema` | Token counts |
| `src/agent/types/IdentifierTypes.ts` | `StreamTabIdSchema`, `ExecutionIdSchema` | Identifiers |
| `src/common/constants/streamStatus.ts` | `StreamStatusSchema`, `TaskGroupStatusSchema` | Status enums |
| `src/common/errors/schemas.ts` | `ProviderErrorSchema`, `RetryErrorInfoSchema` | Error types |
| `src/progressView/types.ts` | `StreamTabInfoSchema`, `InstructionMetadataSchema` | UI state |

### Requires Extraction

| File | Issue | Solution |
|------|-------|----------|
| `src/utils/files/taskRunStorage.ts` | Mixes schemas with Node.js utilities (`path`, `fs`) | Extract `FileLocationSchema` to separate file |

### Already Duplicated (Delete One)

| Backend | Frontend | Action |
|---------|----------|--------|
| `src/common/webview/commands.ts` | `src/progressView/modules/commands.js` | Delete JS, import from TS |
| `src/common/constants/streamStatus.ts` | `src/progressView/modules/constants/streamStatus.js` | Delete JS, import from TS |

---

## Architecture

### Current Flow (Untyped)

```
EventBus (typed) → WebviewUpdater → postMessage (untyped) → Frontend JS (untyped)
```

### After M1 (Typed)

```
EventBus (typed) → WebviewUpdater (typed) → postMessage (validated) → Frontend (typed)
```

No new IPC protocol. Same messages, now validated.

---

## Milestone 1: Type Safety

### Step 1: Extract FileLocationSchema

Create `src/utils/files/FileLocationSchemas.ts` with schema definitions only:

```typescript
// Extract from taskRunStorage.ts (lines 34-72)
export const WorkspaceFileLocationSchema = z.object({...});
export const RunStorageFileLocationSchema = z.object({...});
export const ExternalFileLocationSchema = z.object({...});
export const FileLocationSchema = z.discriminatedUnion('kind', [...]);
```

Update `taskRunStorage.ts` to import from new file.

### Step 2: Create Schema Re-Export

Create `src/progressView/schemas.ts`:

```typescript
// Re-export existing schemas for browser use
// NO NEW SCHEMAS - just imports

// Identifiers
export { StreamTabIdSchema, ExecutionIdSchema } from '@agent/types/IdentifierTypes';

// Status
export { StreamStatusSchema, TaskGroupStatusSchema } from '@common/constants/streamStatus';

// Task Groups
export { TaskGroupSchema } from '@logger/LogTypes';
export { AddTaskGroupPayloadSchema, UpdateTaskGroupPayloadSchema } from '@eventBus/schemas';

// Usage
export { TokenUsageStatsSchema } from '@agent/types/UsageTypes';

// Errors
export { ProviderErrorSchema, RetryErrorInfoSchema } from '@common/errors/schemas';

// Prompts
export {
  ToolEditApprovalPromptSchema,
  BashApprovalPromptSchema,
  RetryRequestPromptSchema,
} from '@eventBus/types';

// Output Files
export { OutputFileInfoSchema } from '@agent/output/types';

// Todos
export { TodoItemSchema, UpdateTodosPayloadSchema } from '@eventBus/schemas';
```

### Step 3: Validate in Message Handler

Update `ProgressViewMessageHandler.ts`:

```typescript
import { AddTaskGroupPayloadSchema } from './schemas';

// In handleMessage:
case 'addTaskGroup': {
  const result = AddTaskGroupPayloadSchema.safeParse(message.payload);
  if (!result.success) {
    console.error('Invalid addTaskGroup payload', result.error);
    return;
  }
  this.state.taskGroups.addGroup(result.data);
}
```

### Step 4: Delete Duplicates

```
DELETE: src/progressView/modules/commands.js (298 lines)
DELETE: src/progressView/modules/constants/streamStatus.js
```

### Deliverable

- All messages validated with existing schemas
- 600+ duplicate lines deleted
- Frontend receives typed data
- No UI changes, no new dependencies

---

## Milestone 2: Lit UI (Only If Needed)

**Evaluate after M1 ships.** If the 1268-line switch statement and 18 isToolUse conditionals are still painful, proceed.

### Approach

1. Add `lit` dependency
2. Create single `<progress-app>` component (~500 lines)
3. Extract child components only when a file exceeds 300 lines
4. No shared component library

### Component Extraction Order

Start monolithic, extract as needed:

```
Week 1: <progress-app> (everything in one file)
        ↓
Week 2: Extract <stream-tabs> (if tabs logic > 100 lines)
        Extract <prompt-overlay> (if prompt handling > 100 lines)
        ↓
Week 3: Extract <workflow-view> and <conversation-view>
        (only if isToolUse conditionals are still a problem)
```

### Escape Hatch

If M2 fails: revert `index.html`, keep `modules/`. M1 type safety remains.

---

## What We're NOT Doing

| Temptation | Why Not |
|------------|---------|
| Shared component library | Build when needed twice, not before |
| Modernize HistoryView (160 lines) | Works fine, maintenance cost ≈ 0 |
| Modernize ProfileView (211 lines) | Works fine, maintenance cost ≈ 0 |
| Modernize MemoryView (278 lines) | Works fine, maintenance cost ≈ 0 |
| Redesign IPC protocol | Same messages, just validated |
| Design tokens | VS Code already provides `--vscode-*` |
| Webpack multi-entry for 5 views | Need it for 1 view, build for 1 |

---

## Risks

### High: Breaking Existing Behavior

Schema validation may reject messages that currently "work" due to loose typing.

**Mitigation**: Use `safeParse`, log failures, don't crash. Fix upstream.

### Medium: FileLocationSchema Extraction

Separating schemas from utilities may break imports.

**Mitigation**: Re-export from original file for backward compatibility.

### Low: M2 Scope Creep

Tendency to build component library during UI rewrite.

**Mitigation**: Hard rule — no file in `src/shared/` until something is used by 2+ webviews.

---

## Success Metrics

### After M1

| Metric | Current | After |
|--------|---------|-------|
| Typed messages | 0% | 100% |
| Duplicate schema code | 600+ lines | 0 |
| New code written | - | ~50 lines (re-exports) |

### After M2 (if done)

| Metric | Current | After |
|--------|---------|-------|
| `isToolUse` conditionals | 18 | 0 |
| State tracking locations | 7 | 1 |
| Frontend lines | ~3700 | ~2000 |

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

### Band-Aid Workarounds

1. `resolveActiveRunId()` - Iterates 4+ maps (called 9+ times per message)
2. `lastRenderedStream` - Detecting stream switches via render state
3. `_clearAgentCategoryState()` - Manual state wipe on category change
4. `RunScopedMap` resolver closure - Hidden `activeStream` dependency
5. `_pendingActiveId` - Buffer for UI selection before backend confirms
6. 18 `isToolUse` references - Conditional logic everywhere
