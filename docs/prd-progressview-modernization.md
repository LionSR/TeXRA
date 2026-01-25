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

| Phase       | Scope                                        | Status         | Doc                                                        |
| ----------- | -------------------------------------------- | -------------- | ---------------------------------------------------------- |
| **Phase 1** | ProgressView — schema relocation + Lit UI    | ✅ Complete    | [prd-progressview-phase1.md](./prd-progressview-phase1.md) |
| **Phase 2** | Extract shared infrastructure                | ✅ Complete    | [prd-progressview-phase2.md](./prd-progressview-phase2.md) |
| **Phase 3** | ProgressView stabilization + native Lit      | 🟡 In Progress | [prd-progressview-phase3.md](./prd-progressview-phase3.md) |
| **Phase 4** | Migrate other webviews (History/Profile/etc) | ⬜ Not Started | [prd-progressview-phase4.md](./prd-progressview-phase4.md) |

### Phase 3 Status Detail

| Sub-Phase | Scope                      | Status                         |
| --------- | -------------------------- | ------------------------------ |
| 3a        | JS → TS shared utilities   | ✅ Complete                    |
| 3b-1      | UI parity/stabilization    | ✅ Complete                    |
| 3b-1.5/6  | CSS Shadow DOM migration   | ✅ Complete (11/13 components) |
| 3b-2      | Utility conversion         | ⬜ Not Started                 |
| 3b-3      | Formatter → TemplateResult | ⬜ Not Started                 |

---

## Non-Goals

- Adding new features during migration
- Changing EventBus architecture
- Virtual scrolling (future optimization)
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

**See [Phase 2 Anti-Patterns](./prd-progressview-phase2.md#anti-patterns-to-avoid) for detailed analysis and Lit solutions.**

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
