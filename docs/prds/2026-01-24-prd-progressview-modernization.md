---
created: 2026-01-24
updated: 2026-04-30
---

# PRD: ProgressView Modernization

## Overview

Rewrite ProgressView in Lit + TypeScript with type-safe IPC via relocated Zod schemas. Use ProgressView as the proving ground, then migrate other webviews.

## Problem Statement

### 1. No Type Safety Across Process Boundary

- EventBus has Zod schemas, but webview receives untyped messages
- Frontend uses JSDoc (~367 lines) instead of real types
- `commands.js` / `commands.ts` duplicated (298 lines each)

### 2. Overengineered State Management

- 7 places track "active" state (see Appendix in Phase 1)
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

---

## Goals & Phases

| Phase       | Scope                                        | Status         | Doc                                                                              |
| ----------- | -------------------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| **Phase 1** | ProgressView — schema relocation + Lit UI    | ✅ Complete    | [2026-01-24-prd-progressview-phase1.md](./2026-01-24-prd-progressview-phase1.md) |
| **Phase 2** | Extract shared infrastructure                | ✅ Complete    | [2026-01-24-prd-progressview-phase2.md](./2026-01-24-prd-progressview-phase2.md) |
| **Phase 3** | ProgressView stabilization + native Lit      | ✅ Complete    | [2026-01-24-prd-progressview-phase3.md](./2026-01-24-prd-progressview-phase3.md) |
| **Phase 4** | Migrate other webviews (History/Profile/etc) | ✅ Complete    | [2026-01-25-prd-progressview-phase4.md](./2026-01-25-prd-progressview-phase4.md) |
| **Phase 5** | Regression fixes + Zod validation            | ✅ 99%         | [2026-01-25-prd-progressview-phase5.md](./2026-01-25-prd-progressview-phase5.md) |
| **Phase 6** | Component extraction + performance           | ✅ Complete    | [2026-01-26-prd-progressview-phase6.md](./2026-01-26-prd-progressview-phase6.md) |
| **Phase 7** | Zod-native types & MainApp decomposition     | ⬜ Not Started | [2026-01-26-prd-mainview-phase7.md](./2026-01-26-prd-mainview-phase7.md)         |
| **Phase 8** | Lit-native improvements                      | ⬜ Not Started | [2026-01-26-prd-lit-native-phase8.md](./2026-01-26-prd-lit-native-phase8.md)     |
| **Phase 9** | Task group state, UI, and persistence        | ⬜ Not Started | [2026-01-26-prd-taskgroup-phase9.md](./2026-01-26-prd-taskgroup-phase9.md)       |

\*Phase 4 webview migrations complete, but MainView requires Phase 5 refactoring (see below).

### Phase 3 Status Detail

| Sub-Phase | Scope                      | Status                         |
| --------- | -------------------------- | ------------------------------ |
| 3a        | JS → TS shared utilities   | ✅ Complete                    |
| 3b-1      | UI parity/stabilization    | ✅ Complete                    |
| 3b-1.5/6  | CSS Shadow DOM migration   | ✅ Complete (11/13 components) |
| 3b-2      | Utility conversion         | 🟡 In Progress (1 JS left)     |
| 3b-3      | Formatter → TemplateResult | 🔶 Bridge pattern in use       |

### Phase 4 Status Detail (2026-01-25)

| Webview         | Status      | Shadow DOM | Zod Validation | Legacy JS  |
| --------------- | ----------- | ---------- | -------------- | ---------- |
| **MemoryView**  | ✅ Complete | ✅         | ✅             | ✅ Deleted |
| **HistoryView** | ✅ Complete | ✅         | ✅             | ✅ Deleted |
| **ProfileView** | ✅ Complete | ✅         | ✅             | ✅ Deleted |
| **MainView**    | ✅ Migrated | ✅         | ❌ **Missing** | ✅ Deleted |

**Note:** MainView requires Phase 5 work:

- 2,737-line monolithic component needs extraction
- 58 message types lack Zod validation
- No shared message contract with backend

### Phase 5: MainView Refactoring (New)

| Task                              | Status | Impact                       |
| --------------------------------- | ------ | ---------------------------- |
| Extract FileSelectGroup component | ⬜     | -300 lines from MainApp      |
| Extract BannerGroup components    | ⬜     | -150 lines from MainApp      |
| Extract LatexDiffsSection         | ⬜     | -200 lines from MainApp      |
| Create shared message schemas     | ⬜     | Type-safe frontend ↔ backend |
| Add Zod validation to MainApp     | ⬜     | Security + type safety       |
| Convert 37 inline arrows          | ⬜     | Performance                  |
| Delete duplicate debug handler    | ⬜     | Code cleanup                 |

---

## Non-Goals

- Adding new features during migration
- Changing EventBus architecture
- Virtual scrolling (incremental updates in Phase 5, virtual scrolling deferred)
- CLI or web app support (but architecture doesn't preclude it)

## Anti-Patterns to Eliminate

The legacy codebase has accumulated sequential band-aid workarounds. **These must not be replicated:**

| Pattern                 | Example                        | Problem                               |
| ----------------------- | ------------------------------ | ------------------------------------- |
| Render-state comparison | `lastRenderedStream`           | Duplicates state for change detection |
| Pending ID buffers      | `_pendingActiveId`             | Two sources of truth, race conditions |
| Resolver side effects   | `resolveActiveRunId()` mutates | Unexpected mutation in "getter"       |
| Manual state wipes      | `_clearAgentCategoryState()`   | Shotgun surgery on mode switch        |
| Global mutable maps     | `pendingLogUpdates`            | Memory leaks, race conditions         |
| Scattered conditionals  | 18× `isToolUse` checks         | Logic spread across 1000+ lines       |
| Save-blocking counters  | `blockSave()/unblockSave()`    | Easy to leak, manual batching         |

**See [Phase 2 Anti-Patterns](./2026-01-24-prd-progressview-phase2.md#anti-patterns-to-avoid) for detailed analysis and Lit solutions.**

---

## Eliminated Abstractions (Zod-First Architecture Wins)

The migration to Zod schemas as the single source of truth eliminated **~200 lines** of redundant code. These abstractions existed because the old architecture lacked schema-first validation:

### Data Flow: Before vs After

```
BEFORE (5 layers):
  logMessage → normalizeStructuredContent() → NormalizedPayload
            → normalizeFileListEntries() → NormalizedFileEntry[]
            → buildFileListRender() → HTML

AFTER (2 layers):
  logMessage.data → FileListEntrySchema.safeParse()
                  → buildFileListRender() (inline field computation) → HTML
```

### Removed Abstractions

| Abstraction                        | What It Did                         | Why Redundant                                        |
| ---------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| `NormalizedPayload`                | Wrapped `text` + `data` fields      | Direct access to `logMessage.data/text` is clearer   |
| `normalizeStructuredContent()`     | Parsed JSON from text field         | Backend now uses `data` field for structured content |
| `tryParseJson()`                   | Legacy text-as-JSON fallback        | Dead code path - backend sends proper `data`         |
| `NormalizedFileEntry`              | Pre-computed `fileName`, `filePath` | Computed inline at render time                       |
| `normalizeFileListData()`          | FileListEntry → NormalizedFileEntry | Schema validation + inline computation               |
| `normalizeMissingOutputsPayload()` | Hand-rolled object extraction       | `MissingOutputsPayloadSchema.safeParse()`            |
| `normalizeToolUseLog()`            | Nested field extraction             | `ToolUseLogSchema.safeParse()` + focused normalizer  |
| `ensureLatexdiffArray()`           | Type guard wrapper                  | Inline `Array.isArray()`                             |
| `extractTrimmedContent()`          | Wrapper around `.trim()`            | Inline `text.trim()`                                 |
| Local `WebSearchPayload` type      | Duplicate type definition           | Import from `@shared/schemas`                        |
| `MAX_HEIGHT` constant              | Unused height value (400)           | Never imported or referenced                         |
| `AGENT_PROPOSAL_ACTIONS` constant  | `['approve', 'reject', 'setup']`    | Actions used inline, not via constant                |
| `AGENT_PROPOSAL_CATEGORIES` const  | `{ WORKFLOW, TOOL_USE }`            | Categories defined in agent schemas                  |
| `sortStreams()` export             | Exported but internal-only          | Made private (only used by `getFilteredStreams`)     |

### Key Insight

**Zod schemas eliminate the need for separate "normalizer" layers.** When the schema is the source of truth:

- Validation returns typed data directly
- `.prefault()` / `.default()` handle missing fields
- `.transform()` handles computed fields when needed
- Formatters receive validated, typed data - no intermediate types needed

This is a fundamental architectural advantage that will compound as more webviews migrate.

---

## Shared Message Contracts (Frontend ↔ Backend)

A critical architectural principle: **frontend and backend must share message type definitions**.

### Current Problem

Message types are implicitly defined in both places:

```
Backend (MainViewMessageHandler.ts)  → sends { command: 'SET_MODEL_OPTIONS', options: string }
Frontend (MainApp.ts)                → expects { command: string, options?: unknown }
                                       ↑ No validation, type casting only
```

This leads to:

- Runtime errors when message shapes change
- No compile-time guarantees
- Duplicate type definitions
- Security vulnerabilities (untrusted data from webview)

### Target Architecture

```
src/shared/schemas/
├── commands.ts                    # Command constants (single source)
├── progressViewMessages.ts        # ProgressView message schemas ✅
├── mainViewMessages.ts            # MainView message schemas (Phase 5)
├── historyViewMessages.ts         # HistoryView message schemas ✅
├── profileViewMessages.ts         # ProfileView message schemas ✅
└── memoryViewMessages.ts          # MemoryView message schemas ✅
```

### Message Contract Pattern

```typescript
// src/shared/schemas/mainViewMessages.ts
import { z } from 'zod';

// 1. Define schema (single source of truth)
export const SetModelOptionsSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS),
  options: z.string(),
});

// 2. Derive types
export type SetModelOptionsMessage = z.infer<typeof SetModelOptionsSchema>;

// 3. Union of all messages
export const MainViewMessageSchema = z.discriminatedUnion('command', [
  SetModelOptionsSchema,
  UpdateFilesSchema,
  SetAgentConfigSchema,
  // ... all 58 message types
]);

export type MainViewMessage = z.infer<typeof MainViewMessageSchema>;
```

**Backend usage:**

```typescript
// MainViewMessageHandler.ts
import { SetModelOptionsMessage } from '@shared/schemas/mainViewMessages';

private sendModelOptions(options: string): void {
  const message: SetModelOptionsMessage = {
    command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
    options,
  };
  this.postMessage(message);  // Type-checked at compile time
}
```

**Frontend usage:**

```typescript
// MainApp.ts handlers
import { MainViewMessageSchema } from '@shared/schemas/mainViewMessages';

private handleMessage(event: MessageEvent): void {
  const result = MainViewMessageSchema.safeParse(event.data);
  if (!result.success) {
    console.warn('Invalid message:', result.error);
    return;
  }
  // result.data is now fully typed MainViewMessage
  const handler = MESSAGE_HANDLERS[result.data.command];
  if (handler) handler(result.data, this.context);
}
```

### Benefits

1. **Compile-time safety**: Backend send types must match frontend receive types
2. **Runtime validation**: Zod catches malformed messages early
3. **Single source of truth**: No duplicate type definitions
4. **Documentation**: Schemas serve as API documentation
5. **Refactoring confidence**: Change schema, see all affected code

### Migration Status

| Webview      | Shared Schemas | Backend Uses | Frontend Validates |
| ------------ | -------------- | ------------ | ------------------ |
| ProgressView | ✅             | ✅           | ✅                 |
| MemoryView   | ✅             | ✅           | ✅                 |
| HistoryView  | ✅             | ✅           | ✅                 |
| ProfileView  | ✅             | ✅           | ✅                 |
| **MainView** | ❌             | ❌           | ❌                 |

**MainView is the only remaining webview without shared message contracts.**

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

---

## Success Metrics

### After Phase 1 (ProgressView)

| Metric                   | Current    | After M1 | After M2 |
| ------------------------ | ---------- | -------- | -------- |
| Typed messages           | 0%         | 100%     | 100%     |
| Duplicate schema code    | 600+ lines | 0        | 0        |
| `isToolUse` conditionals | 18         | 18       | 0        |
| State tracking locations | 7          | 7        | 1        |
| Frontend lines           | ~3,700     | ~3,700   | ~2,300   |
| Approval handlers        | 8          | 8        | 1        |
| Files in modules/        | 67+        | 67+      | 0        |

### After All Phases

| Metric                       | Current | After  |
| ---------------------------- | ------- | ------ |
| Total webview JS files       | 168+    | ~40    |
| Type coverage (all webviews) | ~10%    | 100%   |
| Lit components               | 0       | ~50    |
| Total lines (all frontends)  | ~6,000  | ~3,000 |

---

## Risks

### High: Breaking Existing Behavior

Schema validation may reject messages that currently "work" due to loose typing.

**Mitigation**: Use `safeParse`, log failures, don't crash. Fix upstream data issues.

### High: ProgressView Complexity

1,526-line handler is the hardest migration. If this fails, other webviews are at risk.

**Mitigation**: M1 (type safety) is independently valuable. Escape hatch preserves M1 if M2 fails.

### Medium: Shared Component Scope Creep

Tendency to over-extract into shared library.

**Mitigation**: Hard rule — nothing in `src/shared/components/` until used by 2+ webviews.

### Low: Bundle Size

Lit adds ~5KB gzipped per webview.

**Mitigation**: Acceptable tradeoff for maintainability. Modern VS Code handles this fine.

---

## References

- [Lit Documentation](https://lit.dev/)
- [Lit Reactive Controllers](https://lit.dev/docs/composition/controllers/)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [GitLens](https://github.com/gitkraken/vscode-gitlens) - Production Lit webviews in VS Code
- [Zod Documentation](https://zod.dev/)
