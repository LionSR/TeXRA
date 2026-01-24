# PRD: ProgressView Modernization

## Overview

Rewrite ProgressView in Lit + TypeScript with type-safe IPC via relocated Zod schemas. Use ProgressView as the proving ground, then migrate other webviews.

## Problem Statement

| Problem | Evidence |
|---------|----------|
| No type safety across IPC | Frontend uses JSDoc (~367 lines), messages unvalidated |
| Duplicate code | `commands.js`/`commands.ts` (298 lines each) |
| State tracking sprawl | 7 places track "active" state |
| Semantic overloading | TaskGroup means "run" for Workflow, "turn" for ToolUse |
| Imperative DOM | 1268-line switch, 53-line fragment batching, 8 duplicate handlers |
| isToolUse conditionals | 18 references (10 branching, 8 derived) |

### All Webviews

| Webview | Handler Lines | JS Modules | Type Safety |
|---------|---------------|------------|-------------|
| **ProgressView** | 1,526 | 67+ | None |
| **MainView** | 461 | 80+ | Partial |
| **MemoryView** | 278 | 7 | None |
| **ProfileView** | 211 | 7 | None |
| **HistoryView** | 160 | 7 | None |

## Goals

- **Phase 1**: ProgressView — schema relocation + Lit UI
- **Phase 2**: Extract shared infrastructure (proven patterns)
- **Phase 3**: Migrate remaining webviews

## Non-Goals

- Adding features during migration
- Changing EventBus architecture
- Virtual scrolling

---

## Schema Relocation (Single Source of Truth)

**60+ Zod schemas exist.** Move to `src/shared/schemas/`, no re-exports.

### Target Structure

```
src/shared/schemas/
├── identifiers.ts    # StreamTabIdSchema, ExecutionIdSchema
├── stream.ts         # StreamStatusSchema, StreamTabInfoSchema
├── taskGroup.ts      # TaskGroupSchema, TaskGroupStatusSchema
├── log.ts            # LogMessageDataSchema, MessageTypeSchema
├── usage.ts          # TokenUsageStatsSchema
├── output.ts         # OutputFileInfoSchema, FileLocationSchema
├── prompts.ts        # ToolEditApprovalPromptSchema, etc.
├── todo.ts           # TodoItemSchema
├── errors.ts         # ProviderErrorSchema
├── commands.ts       # All command constants
└── index.ts          # Barrel export
```

### Relocation Table

| Current Location | Schemas | New Location |
|------------------|---------|--------------|
| `src/eventBus/schemas.ts` | `TodoItemSchema`, `AddTaskGroupPayloadSchema` | `todo.ts`, `taskGroup.ts` |
| `src/eventBus/types.ts` | `ToolEditApprovalPromptSchema`, `BashApprovalPromptSchema` | `prompts.ts` |
| `src/logger/LogTypes.ts` | `TaskGroupSchema`, `LogMessageDataSchema` | `taskGroup.ts`, `log.ts` |
| `src/agent/types/UsageTypes.ts` | `TokenUsageStatsSchema` | `usage.ts` |
| `src/agent/types/IdentifierTypes.ts` | `StreamTabIdSchema`, `ExecutionIdSchema` | `identifiers.ts` |
| `src/agent/output/types.ts` | `OutputFileInfoSchema`, `FileLineageSchema` | `output.ts` |
| `src/common/constants/streamStatus.ts` | `StreamStatusSchema`, `TaskGroupStatusSchema` | `stream.ts` |
| `src/common/errors/schemas.ts` | `ProviderErrorSchema` | `errors.ts` |
| `src/utils/files/taskRunStorage.ts` | `FileLocationSchema` (extract from Node.js file) | `output.ts` |

### Duplicates to Delete

| Location 1 | Location 2 | Consolidate To |
|------------|------------|----------------|
| `src/common/webview/commands.ts` | `src/progressView/modules/commands.js` | `commands.ts` |
| `src/common/constants/streamStatus.ts` | `src/progressView/modules/constants/streamStatus.js` | `stream.ts` |

---

## Phase 1: ProgressView

### M1: Type-Safe IPC

1. Create `src/shared/schemas/` with relocated schemas
2. Update all imports to `@shared/schemas` (no re-exports)
3. Add validation in `ProgressViewMessageHandler.ts`
4. Delete duplicate JS files

**Deliverable**: Typed messages, 600+ lines deleted, no UI changes.

### M2: Lit UI

1. `npm install lit`
2. Add webpack entry for `src/progressView/frontend/`
3. Create store with single source of truth
4. Build components (see hierarchy below)
5. Delete `src/progressView/modules/` (67+ files)

**Component Hierarchy**:

```
<progress-app>
  ├── <stream-tabs>
  ├── <workflow-view>        # agentCategory === 'workflow'
  │   ├── <run-selector>
  │   ├── <task-list>
  │   └── <file-list>
  ├── <conversation-view>    # agentCategory === 'toolUse'
  │   ├── <turn-list>
  │   ├── <file-list>
  │   └── <followup-input>
  └── <prompt-overlay>       # Unified approval/retry/proposal
```

**Build Order**:

| Step | Component | Eliminates |
|------|-----------|------------|
| 1 | `<progress-app>` + `<stream-tabs>` | Entry point, tab code |
| 2 | `<prompt-overlay>` | 8 duplicate handlers |
| 3 | `<workflow-view>` | Half of isToolUse checks |
| 4 | `<conversation-view>` | Other half |
| 5 | Child components | Fragment batching |

**Deliverable**: ~3,700 lines → ~1,550 lines, 67+ files deleted.

---

## Phase 2: Extract Shared Infrastructure

After ProgressView stable, extract to `src/shared/`:

| Extract | From | To |
|---------|------|-----|
| Base Lit app class | `ProgressApp.ts` | `BaseWebviewApp.ts` |
| Common components | `<prompt-overlay>`, etc. | `components/` |
| Store pattern | `store.ts` | `createStore.ts` |
| Design tokens | CSS variables | `styles/tokens.css` |

**Rule**: Nothing in `src/shared/components/` until used by 2+ webviews.

---

## Phase 3: Migrate Other Webviews

| Order | Webview | Effort | Rationale |
|-------|---------|--------|-----------|
| 1 | HistoryView | 2-3 days | Simplest (160 lines) |
| 2 | ProfileView | 2-3 days | Static display |
| 3 | MemoryView | 3-4 days | Toggle state |
| 4 | MainView | 1-2 weeks | Most complex |

---

## Build Configuration

**webpack.config.js** (add webview entries):

```javascript
const webviewConfigs = [
  'progressView', 'webview', 'historyView', 'profileView', 'memoryView'
].map(name => ({
  name,
  entry: `./src/${name}/frontend/index.ts`,
  output: { path: path.resolve(__dirname, `dist/${name}`), filename: 'bundle.js' },
  target: 'web',
  // ... aliases, ts-loader
}));
```

**tsconfig.json**:

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "useDefineForClassFields": false,
    "paths": { "@shared/*": ["src/shared/*"] }
  }
}
```

---

## Risks

| Risk | Mitigation |
|------|------------|
| Schema validation breaks loose data | Use `safeParse`, log failures, fix upstream |
| ProgressView complexity | M1 is independently valuable; escape hatch |
| Shared component scope creep | Hard rule: 2+ webviews before extraction |

---

## Success Metrics

### After Phase 1

| Metric | Current | After M1 | After M2 |
|--------|---------|----------|----------|
| Typed messages | 0% | 100% | 100% |
| isToolUse conditionals | 18 | 18 | 0 |
| State locations | 7 | 7 | 1 |
| Frontend lines | ~3,700 | ~3,700 | ~1,550 |
| Files in modules/ | 67+ | 67+ | 0 |

### After Phase 3

| Metric | Current | After |
|--------|---------|-------|
| Total webview JS files | 168+ | ~40 |
| Type coverage | ~10% | 100% |
| Total frontend lines | ~6,000 | ~3,000 |

---

## Timeline

| Phase | Duration |
|-------|----------|
| **Phase 1 M1**: Schema relocation | 3-4 days |
| **Phase 1 M2**: Lit UI | 1-2 weeks |
| **Phase 2**: Shared infra | 2-3 days |
| **Phase 3**: Other webviews | 2-3 weeks |
| **Total** | 5-7 weeks |

---

## Appendix: Current Pain Points

### 7 Places Track "Active" State

- Backend: `_activeStream`, `StreamSessionState.activeRunId`
- Frontend: `state.activeStream`, `state.lastRenderedStream`, `state.activeRunIds`, `runSelector._pendingActiveId`, `streamStatuses`

### Band-Aids

1. `resolveActiveRunId()` - iterates 4+ maps per message
2. `lastRenderedStream` - render state comparison
3. `_clearAgentCategoryState()` - manual wipe on category change
4. `_pendingActiveId` - UI selection buffer

### 8 Duplicate Approval Handlers

`showToolEditApproval`, `resolveToolEditApproval`, `showBashApproval`, `resolveBashApproval`, `showRetryRequest`, `resolveRetryRequest`, `showWorkflowProposal`, `resolveWorkflowProposal`
