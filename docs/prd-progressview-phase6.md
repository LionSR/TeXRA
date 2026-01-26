# PRD: ProgressView Modernization - Phase 6

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Prior phase:** [prd-progressview-phase5.md](./prd-progressview-phase5.md)

## Overview

Phase 6 addresses remaining technical debt from the Lit migration. Phase 5 completed all critical regressions and Zod validation; Phase 6 focuses on component extraction, performance optimization, and architectural cleanup.

## Prerequisites

- Phase 5: All regressions fixed, Zod validation complete ✅
- MainApp functional but monolithic (~2,900 lines) ✅
- Formatters using Lit templates with bridge pattern ✅

## Status Summary

| Task                           | Status            | Impact                                                                   |
| ------------------------------ | ----------------- | ------------------------------------------------------------------------ |
| Extract FileSelectGroup        | ✅ Done           | -300 lines from MainApp                                                  |
| Extract BannerGroup components | ✅ Done           | -150 lines from MainApp                                                  |
| Extract LatexDiffsSection      | ✅ Done           | -200 lines from MainApp                                                  |
| Convert 37 inline arrows       | ✅ Done           | Performance                                                              |
| Formatters → TemplateResult    | ✅ Done (Phase 5) | Bridge pattern is intentional for Light DOM; open to future improvements |
| renderLogs incremental updates | 🟡 Hybrid         | appendLog/updateLog incremental; full rebuild on stream switch only      |
| TaskGroupDomManager refactor   | ✅ Done           | Separation of concerns                                                   |
| Replace .map() with repeat()   | ✅ Done           | Keyed list updates in RunSelector, FileList, StreamHeader, PromptOverlay |
| Add guard() memoization        | ✅ Done           | ToolUseStreamContent, WorkflowStreamContent caching                      |

---

## 6.1 Monolithic Component Extraction

**Problem:** `MainApp.ts` is **~2,900 lines** — far exceeding maintainable component size (~500 lines recommended).

**Analysis by section:**

| Section                  | Lines     | Description                    |
| ------------------------ | --------- | ------------------------------ |
| File selection rendering | 1700-2345 | Repetitive file list templates |
| Banner components        | 2347-2508 | API key, agent config, etc.    |
| LaTeXDiffs section       | 2547-2736 | Diff configuration panel       |
| Message handler switch   | 297-400+  | 58-case switch statement       |
| Event handlers           | 450-700   | Click, input, form handlers    |
| State management         | 100-296   | @state properties              |

**Target Structure:**

```
src/webview/frontend/
├── MainApp.ts                    # Root: message routing, orchestration (~500 lines)
├── store.ts                      # State types, schemas
├── constants.ts                  # Commands, element IDs
├── events.ts                     # Typed event factories
├── handlers/
│   └── messageHandlers.ts        # Registry-based message handling with Zod validation
└── components/
    ├── FileSelector/
    │   ├── FileSelector.ts       # Container with drag-drop
    │   ├── FileSelectGroup.ts    # Categorized file lists
    │   └── FileItem.ts           # Single file with remove button
    ├── BannerGroup/
    │   ├── ApiKeyBanner.ts       # API key missing warning
    │   ├── AgentConfigBanner.ts  # Agent configuration notice
    │   └── WarningBanner.ts      # Generic warning component
    ├── InstructionPanel/
    │   ├── InstructionPanel.ts   # Instruction input + recording
    │   └── RecordingButton.ts    # Audio recording UI
    ├── AgentSelector.ts          # Agent + model dropdowns
    ├── ActionButtons.ts          # Run, Polish, etc.
    └── LatexDiffsSection.ts      # Diff configuration panel
```

**Extraction priority:**

1. **FileSelectGroup.ts** (~300 lines) - Most repetitive, used 5x in template
2. **BannerGroup.ts** (~150 lines) - Simple extraction, clear boundaries
3. **LatexDiffsSection.ts** (~200 lines) - Self-contained feature
4. **messageHandlers.ts** (~200 lines) - Registry pattern with Zod

---

## 6.2 Inline Arrow Functions (37 instances)

**Problem:** MainApp.ts contains **37 inline arrow functions** in templates, creating new function instances on every render.

**Examples (lines 1700-2345):**

```typescript
// ❌ Anti-pattern - repeated in file selection loops
@click=${() => this.handleRemoveFile(listId, file)}
@click=${() => this.handleOpenFile(file)}
@click=${() => this.handlePreviewFile(file)}
```

**Fix:** Extract to class methods with data attributes:

```typescript
// ✓ Stable reference
private handleFileAction = (e: Event) => {
  const target = e.currentTarget as HTMLElement;
  const action = target.dataset.action;
  const listId = target.dataset.listId;
  const filePath = target.dataset.filePath;

  switch (action) {
    case 'remove': this.handleRemoveFile(listId!, filePath!); break;
    case 'open': this.handleOpenFile(filePath!); break;
    case 'preview': this.handlePreviewFile(filePath!); break;
  }
};

// In template
<button
  @click=${this.handleFileAction}
  data-action="remove"
  data-list-id=${listId}
  data-file-path=${file.path}
>
```

---

## 6.2b Lit Directive & Native Feature Improvements

**Status: ✅ Memoization complete | Open to Ideas**

We actively welcome more native Lit approaches where they're more suitable. The current codebase uses some Lit features but there may be better patterns we haven't discovered yet.

### Currently Used Directives

| Directive     | Files | Notes                   |
| ------------- | ----- | ----------------------- |
| `repeat()`    | 5     | Keyed list iteration    |
| `when()`      | 5     | Conditional rendering   |
| `classMap()`  | 6     | Dynamic CSS classes     |
| `ifDefined()` | 4     | Optional attributes     |
| `live()`      | 2     | Form input preservation |
| `ref()`       | 3     | Element references      |

### Not Yet Used (Explore These)

| Directive                          | Stability        | Potential Use Case                                 |
| ---------------------------------- | ---------------- | -------------------------------------------------- |
| `guard()`                          | ⭐⭐⭐ Excellent | Memoize expensive template sections                |
| `cache()`                          | ⭐⭐⭐ Excellent | Preserve DOM when toggling visibility              |
| `until()`                          | ⭐⭐⭐ Excellent | Async data loading with placeholders               |
| `keyed()`                          | ⭐⭐ Good        | Force re-render on identity change                 |
| `templateContent()`                | ⭐⭐ Good        | Reuse `<template>` elements                        |
| `asyncAppend()` / `asyncReplace()` | ⭐ Niche         | Streaming content (rarely needed with async/await) |

**Recommendation:** Start with `guard()` - it can replace ~10 private cache variables and ~30 lines of `willUpdate()` boilerplate in `ToolUseStreamContent.ts` (lines 65-98) and `WorkflowStreamContent.ts` (lines 79-108). See concrete before/after examples below.

### Known Opportunities

**Replace `.map()` with `repeat()`:**

| File               | Line     | Current  | Suggested                                          |
| ------------------ | -------- | -------- | -------------------------------------------------- |
| `RunSelector.ts`   | 47       | `.map()` | `repeat(sortedRuns, r => r.id, ...)`               |
| `FileList.ts`      | 205, 215 | `.map()` | `repeat(files, f => f.location.absolutePath, ...)` |
| `StreamHeader.ts`  | 344      | `.map()` | `repeat(buttons, b => b.id, ...)`                  |
| `PromptOverlay.ts` | 478, 516 | `.map()` | `repeat(fileLists, f => f.label, ...)`             |
| `StreamTabs.ts`    | 290, 303 | `.map()` | `repeat(FILTER_BUTTONS, b => b.id, ...)`           |

**Replace manual caching with `guard()` (or a single cached pass):**

| File                       | Variables                                    | Lines  |
| -------------------------- | -------------------------------------------- | ------ |
| `ToolUseStreamContent.ts`  | Cached prompt state computed once per update | 65-98  |
| `WorkflowStreamContent.ts` | Cached run values computed once per update   | 79-108 |

**Current pattern (manual memoization):**

```typescript
// ToolUseStreamContent.ts:65-98 - 8 private variables for manual caching
private _cachedFilteredPrompts: PromptState[] = [];
private _cachedRunGroups: RunGroup[] = [];
private _prevStreamId: string | null = null;
private _prevPrompts: PromptState[] | null = null;
private _prevTaskGroups: TaskGroup[] | null = null;

willUpdate(changedProperties: PropertyValues): void {
  if (changedProperties.has('prompts') || changedProperties.has('streamId')) {
    if (this._prevPrompts !== this.prompts || this._prevStreamId !== streamId) {
      this._cachedFilteredPrompts = this.computeFilteredPrompts();
      this._prevPrompts = this.prompts;
      this._prevStreamId = streamId ?? null;
    }
  }
  // ... similar for _cachedRunGroups
}
```

**With `guard()` (native Lit memoization):**

```typescript
// No private cache variables needed
import { guard } from 'lit/directives/guard.js';

render(): TemplateResult {
  return html`
    <prompt-overlay
      .prompt=${guard(
        [this.prompts, this.streamId],
        () => this.computeFilteredPrompts().at(0) ?? null
      )}
    ></prompt-overlay>

    <stream-header
      .runs=${guard(
        [this.state?.taskGroups],
        () => getRunGroups(this.state?.taskGroups ?? [])
      )}
    ></stream-header>
  `;
}
```

**Benefits:** Removes ~30 lines of manual cache management per file, eliminates `willUpdate()` boilerplate, and uses Lit's built-in dependency tracking.

### Areas Open for Native Lit Exploration

1. **LogList streaming** - Currently uses imperative `appendChild()`. Could `asyncAppend()` or Lit's streaming render work better?

2. **TaskGroup hierarchy** - Currently managed by `TaskGroupDomManager`. Could nested Lit components with `@property` propagation be cleaner?

3. **State management** - Currently uses `WebviewStateManager`. Could Lit's `@state()` with context protocol (`@lit/context`) simplify cross-component state?

4. **Form handling** - Currently manual event listeners. Could `@lit-labs/forms` or native `live()` directive improve this?

5. **Virtualization** - For very large log lists. Could `@lit-labs/virtualizer` help?

**If you know a more native Lit pattern for any of these, please suggest it!**

---

## 6.3 Suggested Computed Getters

Some derived state is computed repeatedly. Use Lit's reactive getters:

**Current:**

```typescript
// Computed in render() multiple times
const isToolUse = this.agentConfig?.category === 'toolUse';
```

**Preferred:**

```typescript
@state() private agentConfig: AgentConfig | null = null;

private get isToolUse(): boolean {
  return this.agentConfig?.category === 'toolUse';
}
```

---

## 6.4 Formatter → TemplateResult Migration

**Status: ✅ COMPLETE (Phase 5)**

All 14 formatters now use Lit `html` templates internally and return `HTMLElement` via the `renderToElement()` bridge pattern. Zero string concatenation remains.

**Current pattern (intentional):**

```typescript
// formatters/toolFormatters.ts - uses Lit templates, returns HTMLElement
export function formatToolUse(data: unknown, ...): HTMLElement | null {
  const template = html`
    <details class=${classMap({ 'banner-details': true, ... })}>
      ${buildDetailsSummary({ iconClass, label: titleText, ... })}
      <div class="banner-content">${contentTemplate}</div>
    </details>
  `;
  return renderToElement(template);  // Bridge to HTMLElement
}

// litTemplates.ts - bridge function
export function renderToElement(template: TemplateResult): HTMLElement | null {
  const container = document.createElement('div');
  render(template, container);
  return container.firstElementChild as HTMLElement | null;
}
```

**Why bridge pattern is intentional:**

- LogList uses Light DOM for streaming append pattern
- CSS must apply to logs (not isolated in Shadow DOM)
- Supports imperative `appendChild()` for incremental updates
- Performance for 100+ messages with mixed append/update patterns

**Future consideration:** If Shadow DOM becomes desirable, formatters could return `TemplateResult` directly with minimal changes since they already use Lit templates internally.

**Completed scope (14 formatters):**

| Formatter File                   | Functions | Status           |
| -------------------------------- | --------- | ---------------- |
| `bannerFormatters.ts`            | 2         | ✅ Lit templates |
| `messageFormatters.ts`           | 4         | ✅ Lit templates |
| `toolFormatters.ts`              | 2         | ✅ Lit templates |
| `dataFormatters.ts`              | 4         | ✅ Lit templates |
| `contextManagementFormatters.ts` | 1         | ✅ Lit templates |
| `taskGroupFormatter.ts`          | 1         | ✅ Lit templates |

---

## 6.5 renderLogs Incremental Updates

**Status: 🟡 HYBRID (Partially Complete)**

Incremental updates already work for append/update operations. Full rebuild only occurs on stream switch.

**Current state:**

| Method          | Pattern                        | Performance | Status            |
| --------------- | ------------------------------ | ----------- | ----------------- |
| `appendLog()`   | Incremental append             | O(1)        | ✅ Complete       |
| `updateLog()`   | Single element replace         | O(1)        | ✅ Complete       |
| `addGroup()`    | Incremental insert             | O(m)        | ✅ Complete       |
| `updateGroup()` | Micro-updates (icon, duration) | O(1)        | ✅ Complete       |
| `renderLogs()`  | Full rebuild                   | O(n log n)  | ❌ Still rebuilds |

**Typical flow (mostly incremental):**

```
APPEND_LOG event → appendLog()        [✅ incremental, O(1)]
UPDATE_LOG event → updateLog()        [✅ incremental, O(1)]
UPDATE_LOGS event → renderLogs()      [❌ full rebuild, rare]
SWITCH_STREAM → renderLogs()          [❌ full rebuild, expected]
```

**Why this is acceptable:**

- Most messages arrive via `APPEND_LOG` (streaming) - already incremental
- `UPDATE_LOGS` full re-sync is rare (only on reconnect or explicit refresh)
- Stream switch full rebuild is expected behavior
- `LogEntryManager` caches elements in `Map<id, HTMLElement>` for fast lookups

**Remaining opportunity (if needed):**

```typescript
// Could add diff logic to renderLogs for incremental re-sync
renderLogs(logs: LogEntry[]): void {
  const prevIds = new Set(this.logManager.getIds());
  const nextIds = new Set(logs.map(l => l.id));

  // Only remove/add changed entries instead of full rebuild
  for (const id of prevIds) {
    if (!nextIds.has(id)) this.logManager.remove(id);
  }
  for (const log of logs) {
    if (!prevIds.has(log.id)) this.appendLog(log);
  }
}
```

**Assessment:** Current hybrid approach is appropriate for the streaming use case. Full incremental `renderLogs` is a nice-to-have optimization, not critical.

---

## 6.6 Architectural Debt (ProgressView)

### A1. TaskGroupDomManager Coupling (HIGH)

**Location:** `src/progressView/frontend/managers/TaskGroupDomManager.ts`

**Problem:** TaskGroupDomManager mixes several unrelated concerns:

| Concern                   | Lines               | Coupling Issue              |
| ------------------------- | ------------------- | --------------------------- |
| DOM element management    | 74-165              | Core responsibility         |
| Toggle state persistence  | 45-72               | Should be in state manager  |
| Audio notifications       | `playSystemSound()` | Should be dedicated service |
| Traversal/hierarchy logic | 180-220             | Could be separate utility   |

**Recommendation:** Extract concerns into focused modules:

```
managers/
├── TaskGroupDomManager.ts    # DOM operations only
├── TaskGroupStateManager.ts  # Toggle persistence
├── services/AudioNotificationService.ts # System sounds
└── utils/taskGroupTraversal.ts # Hierarchy navigation

**Status:** ✅ Implemented (TaskGroupDomManager now delegates toggle state, audio, and traversal concerns).
```

### A2. Light DOM in ProgressView (MEDIUM)

**Location:** `ProgressApp.ts`, `LogList.ts`, `TaskGroupList.ts`

**Problem:** These components use Light DOM (`createRenderRoot() { return this; }`), breaking style encapsulation.

**Why it exists:** Streaming log architecture requires direct DOM manipulation that conflicts with Shadow DOM boundaries.

**Status:** Formatters now use Lit templates with bridge pattern (see 6.4). Light DOM is intentional for the streaming append pattern. Shadow DOM migration is possible but not currently needed.

---

## 6.7 Known Bugs (From Phase 5 Code Review)

### HIGH Severity

#### 6.7.1 State Never Persists When saveState Called While Blocked

**Location:** `MainApp.ts:948-992`

**Problem:** In `handleRestoreState`, `saveState()` is called while `saveBlockCount > 0`, so the restored state is never persisted.

**Fix:** Move `saveState()` call after the finally block that calls `unblockSave()`.

### MEDIUM Severity

#### 6.7.2 Active Flags Stored as Truthy String Arrays

**Location:** `MainApp.ts:506-510`

**Problem:** `${listId}Active` flags stored as `['true']` or `['false']` arrays instead of booleans. Since `['false']` is truthy, downstream checks fail.

**Fix:** Store as proper boolean values.

#### 6.7.3 Visibility State Not Saved After Removing Last File

**Location:** `MainApp.ts:outputFilesActive assignment`

**Problem:** When last file is removed, visibility flags updated after `saveState()` already called.

**Fix:** Call `saveState()` after updating visibility flags.

#### 6.7.4 Send Correct fileType Casing for Multi-File Picker

**Location:** `MainApp.ts:1205-1209`

**Problem:** Webview sends lowercase `inputFiles`/`outputFiles` but handler expects `InputFiles`/`OutputFiles`.

**Fix:** Map to expected casing.

#### 6.7.5 Preserve Forced API-Key Banner When Model Lacks Key

**Location:** `MainApp.ts:1345-1347`

**Problem:** Banner hidden on model change even when extension explicitly asked to show it.

**Fix:** Track `forced` state before auto-hiding.

---

## Implementation Plan

### Step 1: Bug Fixes (6.7.1-6.7.5)

Fix known bugs before refactoring to establish stable baseline.

### Step 2: Component Extraction (6.1)

1. Extract `FileSelectGroup.ts` component
2. Extract `BannerGroup.ts` components
3. Extract `LatexDiffsSection.ts` component
4. Update MainApp imports

### Step 3: Performance Optimization (6.2, 6.5)

1. Extract 37 inline arrows to class methods
2. Replace `.map()` with `repeat()` for keyed list updates
3. Add `guard()` memoization where beneficial
4. Add computed getters for derived state

### Step 4: Architecture (6.6)

1. Refactor TaskGroupDomManager concerns
2. Consider Shadow DOM if style encapsulation needed (formatters already Lit-ready)

---

## Success Metrics

| Metric                           | Before  | Current   | Target              |
| -------------------------------- | ------- | --------- | ------------------- |
| MainApp.ts lines                 | 2,900   | 2,900     | ~500                |
| Extracted components             | 0       | 0         | 6+                  |
| Inline arrow functions           | 37      | 37        | 0                   |
| Formatters using Lit templates   | 0       | 14 ✅     | 14 (complete)       |
| `.map()` → `repeat()` migrations | 0       | 4         | 8+                  |
| Incremental log updates          | partial | hybrid ✅ | hybrid (acceptable) |

---

## Risks

### Medium: Component Interdependencies

MainApp has complex state shared across file selection, agent config, and execution.

**Mitigation:**

- Extract leaf components first (FileItem, banners)
- Use events to communicate back to MainApp
- Keep shared state in MainApp until extraction stabilizes

### Low: Regression During Extraction

Breaking existing functionality while extracting components.

**Mitigation:**

- Extract one component at a time
- Manual testing after each extraction
- Keep original code commented until verified

---

## References

- [Phase 5 PRD](./prd-progressview-phase5.md) - Completed regression fixes
- [Lit Documentation](https://lit.dev/)
- [ProgressView patterns](./prd-progressview-phase3.md) - Reference implementation
