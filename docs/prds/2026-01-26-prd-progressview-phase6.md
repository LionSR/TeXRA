---
created: 2026-01-26
updated: 2026-02-10
---

# PRD: ProgressView Modernization - Phase 6

> **Parent doc:** [2026-01-24-prd-progressview-modernization.md](./2026-01-24-prd-progressview-modernization.md)
> **Prior phase:** [2026-01-25-prd-progressview-phase5.md](./2026-01-25-prd-progressview-phase5.md)

## Overview

Phase 6 addresses remaining technical debt from the Lit migration. Phase 5 completed all critical regressions and Zod validation; Phase 6 focuses on component extraction, performance optimization, and architectural cleanup.

## Prerequisites

- Phase 5: All regressions fixed, Zod validation complete ✅
- MainApp functional but monolithic (~2,900 lines) ✅
- Formatters using Lit templates with bridge pattern ✅

## Status Summary

> **Overall Phase 6 Completion: 100%**
>
> - ✅ Component extraction complete (5 components extracted)
> - ✅ `.map()` → `repeat()` migration complete (5 files)
> - ✅ Derived state memoization complete (willUpdate pattern with @state)
> - ✅ MainApp integration complete (all 5 components integrated)
> - ✅ MainApp.ts reduced from 2,924 to 2,087 lines (837 lines, 29% reduction)
> - ✅ State types and configs extracted to store.ts
> - ✅ Legacy JS modules deleted (7 files, replaced by TypeScript equivalents)
> - ✅ Inline arrow functions: only 2 remain (both necessary `repeat()` callbacks)
> - ⬜ TaskGroupDomManager refactor (deferred - audio concern still embedded)
>
> **Verified 2026-01-26** via code inspection.
>
> **Next:** [Phase 7](./2026-01-26-prd-mainview-phase7.md) - Zod-native types & MainApp decomposition
> **Then:** [Phase 8](./2026-01-26-prd-lit-native-phase8.md) - Lit-native improvements (styleMap, virtualizer, context)

| Task                             | Status            | Impact                                                                  |
| -------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| Extract FileSelectGroup          | ✅ Complete       | Component created in `src/webview/frontend/components/`                 |
| Extract BannerGroup components   | ✅ Complete       | Component created with all 5 banner types                               |
| Extract LatexDiffsSection        | ✅ Complete       | Component created with all controls                                     |
| Extract InstructionPanel         | ✅ Complete       | Component with session toggle, instruction input, agent/model selectors |
| Extract OutputFilesSection       | ✅ Complete       | Component with collapsible file list and actions                        |
| Integrate FileSelectGroup        | ✅ Complete       | Replaced renderFileSelect() calls for input/ref/aux/media files         |
| Integrate BannerGroup            | ✅ Complete       | Replaced renderBanners() in MainApp                                     |
| Integrate LatexDiffsSection      | ✅ Complete       | Replaced renderLatexdiffsSection() in MainApp                           |
| Integrate InstructionPanel       | ✅ Complete       | Replaced instruction box section in MainApp                             |
| Integrate OutputFilesSection     | ✅ Complete       | Replaced output files section in MainApp                                |
| Create events.ts                 | ✅ Complete       | MainViewEvents factory for typed event dispatch                         |
| Delete unused methods            | ✅ Complete       | Removed renderFileSelect, renderFileList, renderAutoExtractMenu, etc.   |
| Extract store.ts                 | ✅ Complete       | State types, defaults, FILE_SELECT_CONFIGS, command mappings            |
| Data-driven file selectors       | ✅ Complete       | FILE_SELECT_CONFIGS + repeat() replaces 4 inline configs                |
| Convert 37 inline arrows         | ✅ Complete       | Only 2 remain (necessary `repeat()` callbacks)                          |
| Formatters → TemplateResult      | ✅ Done (Phase 5) | Bridge pattern is intentional for Light DOM                             |
| renderLogs incremental updates   | 🟡 Hybrid         | appendLog/updateLog incremental; full rebuild on stream switch only     |
| TaskGroupDomManager refactor     | ⬜ Deferred       | Low priority - separation of concerns                                   |
| Replace .map() with repeat()     | ✅ Complete       | RunSelector, FileList, StreamHeader, PromptOverlay, StreamTabs          |
| Add guard() / @state memoization | ✅ Complete       | ToolUseStreamContent, WorkflowStreamContent use @state pattern          |
| Delete legacy JS modules         | ✅ Complete       | Removed 5 JS files superseded by TypeScript equivalents                 |

---

## 6.0 Legacy JS Module Cleanup

**Status: ✅ Complete**

Removed legacy JavaScript modules that were superseded by the Lit migration. These files were dead code - generated URIs but never loaded in any webview.

### Deleted Files

| File                                           | Replacement                                           |
| ---------------------------------------------- | ----------------------------------------------------- |
| `src/common/modules/BaseDomHandler.js`         | Lit component lifecycle                               |
| `src/common/modules/domUtils.js`               | `src/shared/utils/dom.ts`                             |
| `src/common/modules/iconConstants.js`          | `src/shared/utils/icons.ts`                           |
| `src/common/modules/RecordingButtonManager.js` | `src/shared/controllers/RecordingButtonController.ts` |
| `src/common/modules/templateUtils.js`          | Lit templates                                         |
| `src/common/modules/files/baseFileUtils.d.ts`  | Orphaned type declaration                             |
| `src/types/common-modules.d.ts`                | Orphaned type declarations                            |

### Also Updated

- `src/common/webview/BaseViewContentProvider.ts` - Removed URI generation for deleted modules

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

**Current Structure (implemented):**

```
src/webview/frontend/
├── MainApp.ts                    # Root: message routing, orchestration (~2,313 lines)
├── constants.ts                  # Session types, element IDs, file types
├── events.ts                     # MainViewEvents factory for typed event dispatch
├── pasteHandler.ts               # Image paste handling
├── styles.ts                     # MainView-specific styles
└── components/
    ├── index.ts                  # Barrel export for all components
    ├── FileSelectGroup.ts        # File selection with dropdown, multi-file list, checkboxes (~500 lines)
    ├── BannerGroup.ts            # API key, agent config, dependency, login banners (~350 lines)
    ├── LatexDiffsSection.ts      # Diff configuration panel (~320 lines)
    ├── InstructionPanel.ts       # Session toggle, instruction textarea, agent/model selectors (~500 lines)
    └── OutputFilesSection.ts     # Collapsible output files list (~250 lines)
```

**Remaining opportunities (deferred):**

- Message handler registry extraction (~200 lines potential)
- Data-driven file selector configs (reduce 4 repetitive configs)

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

**Status: ✅ Substantially Complete**

Directive usage has been expanded with `repeat()` migration complete and memoization patterns simplified.

### Currently Used Directives

| Directive     | Files  | Notes                                               |
| ------------- | ------ | --------------------------------------------------- |
| `repeat()`    | 10+ ✅ | Keyed list iteration - expanded from 5 to 10+ files |
| `when()`      | 6      | Conditional rendering                               |
| `classMap()`  | 8      | Dynamic CSS classes                                 |
| `ifDefined()` | 4      | Optional attributes                                 |
| `live()`      | 2      | Form input preservation                             |
| `ref()`       | 3      | Element references                                  |

### Completed: `.map()` → `repeat()` Migration

All list rendering now uses `repeat()` for keyed updates:

| File               | Status      | Key Function                          |
| ------------------ | ----------- | ------------------------------------- |
| `RunSelector.ts`   | ✅ Complete | `run => run.id`                       |
| `FileList.ts`      | ✅ Complete | `file => file.location?.absolutePath` |
| `StreamHeader.ts`  | ✅ Complete | `btn => btn.id`                       |
| `PromptOverlay.ts` | ✅ Complete | `label`, `file`, `action` keys        |
| `StreamTabs.ts`    | ✅ Complete | `btn.id` for filters/sorts            |

### Completed: Memoization Pattern

Instead of `guard()` directive (which is better for template fragments), we use the cleaner `@state()` + `willUpdate()` pattern for derived property values:

```typescript
// ToolUseStreamContent.ts - clean @state pattern
@state() private filteredPrompts: PromptState[] = [];
@state() private runGroups: RunGroup[] = [];

protected willUpdate(changedProperties: PropertyValues<this>): void {
  if (changedProperties.has('prompts') || changedProperties.has('streamInfo')) {
    this.filteredPrompts = this.computeFilteredPrompts();
  }
  if (changedProperties.has('state')) {
    this.runGroups = getRunGroups(this.state?.taskGroups ?? []);
  }
}
```

**Why `@state()` pattern over `guard()`:**

- `guard()` is designed for memoizing template fragments, not property values passed to child components
- `@state()` makes derived values reactive and inspectable in DevTools
- `willUpdate()` provides clear dependency tracking
- Simpler mental model - no need to understand directive internals

### Future Exploration (Nice-to-Have)

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

### A1. TaskGroupDomManager Coupling (HIGH) - ⬜ DEFERRED

**Location:** `src/progressView/frontend/managers/TaskGroupDomManager.ts`

**Problem:** TaskGroupDomManager mixes several unrelated concerns:

| Concern                   | Lines                               | Coupling Issue              |
| ------------------------- | ----------------------------------- | --------------------------- |
| DOM element management    | 74-165                              | Core responsibility         |
| Toggle state persistence  | 45-72                               | Should be in state manager  |
| Audio notifications       | `playSystemSound()` (lines 224-245) | Should be dedicated service |
| Traversal/hierarchy logic | 180-220                             | Could be separate utility   |

**Verified 2026-01-26:** Audio playback (`playSystemSound()` with `AudioContext`) is still embedded in this class (line 194 calls it when run completes).

**Recommendation:** Extract concerns into focused modules:

```
managers/
├── TaskGroupDomManager.ts    # DOM operations only
├── TaskGroupStateManager.ts  # Toggle persistence
├── AudioNotificationService.ts # System sounds
└── utils/taskGroupTraversal.ts # Hierarchy navigation
```

**Status:** Deferred - low priority, functionality works correctly.

### A2. Light DOM in ProgressView (MEDIUM)

**Location:** `ProgressApp.ts`, `LogList.ts`, `TaskGroupList.ts`

**Problem:** These components use Light DOM (`createRenderRoot() { return this; }`), breaking style encapsulation.

**Why it exists:** Streaming log architecture requires direct DOM manipulation that conflicts with Shadow DOM boundaries.

**Status:** Formatters now use Lit templates with bridge pattern (see 6.4). Light DOM is intentional for the streaming append pattern. Shadow DOM migration is possible but not currently needed.

---

## 6.7 Known Bugs (From Phase 5 Code Review) - ✅ ALL FIXED

> **Verified 2026-01-26** - All bugs have been addressed in the codebase.

### HIGH Severity

#### 6.7.1 State Never Persists When saveState Called While Blocked ✅

**Location:** `MainApp.ts:469-482`

**Status:** FIXED - Proper `blockSave()`/`unblockSave()` pattern with try-finally in `handleRestoreState()`.

### MEDIUM Severity

#### 6.7.2 Active Flags Stored as Truthy String Arrays ✅

**Location:** `MainApp.ts:1067`

**Status:** FIXED - `restoreFileArrays()` uses `Boolean(visible)` to safely convert truthy/falsy values.

#### 6.7.3 Visibility State Not Saved After Removing Last File ✅

**Location:** `MainApp.ts:479-522`

**Status:** FIXED - `saveState()` properly collects all necessary fields with correct ordering.

#### 6.7.4 Send Correct fileType Casing for Multi-File Picker ✅

**Location:** `MainApp.ts:1061-1068`

**Status:** FIXED - `Array.isArray()` check with proper defaults.

#### 6.7.5 Preserve Forced API-Key Banner When Model Lacks Key ✅

**Location:** `MainApp.ts`

**Status:** FIXED - State validation guards applied.

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

> **Verified 2026-01-26** via code inspection

| Metric                           | Before  | Current           | Target                                                                                    |
| -------------------------------- | ------- | ----------------- | ----------------------------------------------------------------------------------------- |
| MainApp.ts lines                 | 2,900   | 2,087 ✅          | ~500 (continued extraction possible)                                                      |
| Extracted components             | 0       | 5 ✅              | 5 (FileSelectGroup, BannerGroup, LatexDiffsSection, InstructionPanel, OutputFilesSection) |
| Integrated components            | 0       | 5 ✅              | All 5 integrated in MainApp.ts                                                            |
| Events/types infrastructure      | 0       | 1 ✅              | events.ts + store.ts complete                                                             |
| Inline arrow functions           | 37      | 2 ✅              | 2 (necessary `repeat()` callbacks)                                                        |
| Formatters using Lit templates   | 0       | 14 ✅             | 14 (complete)                                                                             |
| `.map()` → `repeat()` migrations | 0       | 12+ ✅            | 12+ (RunSelector, FileList x3, StreamHeader, PromptOverlay x4, StreamTabs x3)             |
| Derived state memoization        | manual  | @state pattern ✅ | (complete in ToolUseStreamContent, WorkflowStreamContent)                                 |
| Incremental log updates          | partial | hybrid ✅         | hybrid (acceptable)                                                                       |
| Legacy JS modules                | 7       | 0 ✅              | 0 (all deleted)                                                                           |
| Known bugs (6.7.x)               | 5       | 0 ✅              | 0 (all fixed)                                                                             |

### Components Created

| Component               | Location                           | Purpose                                                  | Integrated |
| ----------------------- | ---------------------------------- | -------------------------------------------------------- | ---------- |
| `FileSelectGroup.ts`    | `src/webview/frontend/components/` | File selection with menus                                | ✅         |
| `BannerGroup.ts`        | `src/webview/frontend/components/` | All 5 banner types                                       | ✅         |
| `LatexDiffsSection.ts`  | `src/webview/frontend/components/` | LaTeXDiff controls                                       | ✅         |
| `InstructionPanel.ts`   | `src/webview/frontend/components/` | Session toggle, instruction input, agent/model selectors | ✅         |
| `OutputFilesSection.ts` | `src/webview/frontend/components/` | Collapsible output files list                            | ✅         |
| `events.ts`             | `src/webview/frontend/`            | MainViewEvents factory                                   | ✅         |
| `store.ts`              | `src/webview/frontend/`            | State types, FILE_SELECT_CONFIGS                         | ✅         |
| `index.ts`              | `src/webview/frontend/components/` | Barrel export                                            | ✅         |

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

- [Phase 5 PRD](./2026-01-25-prd-progressview-phase5.md) - Completed regression fixes
- [Lit Documentation](https://lit.dev/)
- [ProgressView patterns](./2026-01-24-prd-progressview-phase3.md) - Reference implementation
- [ProgressViewState.ts](../../src/controllers/progressView/backend/ProgressViewState.ts) - Zod schema pattern reference
