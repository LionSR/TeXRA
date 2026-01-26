# PRD: ProgressView Modernization - Phase 6

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Prior phase:** [prd-progressview-phase5.md](./prd-progressview-phase5.md)

## Overview

Phase 6 addresses remaining technical debt from the Lit migration. Phase 5 completed all critical regressions and Zod validation; Phase 6 focuses on component extraction, performance optimization, and architectural cleanup.

## Prerequisites

- Phase 5: All regressions fixed, Zod validation complete ✅
- MainApp functional but monolithic (~2,900 lines) ✅
- Formatters using bridge pattern (HTML strings) ✅

## Status Summary

| Task | Status | Impact |
|------|--------|--------|
| Extract FileSelectGroup | ⬜ Not Started | -300 lines from MainApp |
| Extract BannerGroup components | ⬜ Not Started | -150 lines from MainApp |
| Extract LatexDiffsSection | ⬜ Not Started | -200 lines from MainApp |
| Convert 37 inline arrows | ⬜ Not Started | Performance |
| Formatters → TemplateResult | ⬜ Not Started | Shadow DOM enablement |
| renderLogs incremental updates | ⬜ Not Started | Performance for large logs |
| TaskGroupDomManager refactor | ⬜ Not Started | Separation of concerns |

---

## 6.1 Monolithic Component Extraction

**Problem:** `MainApp.ts` is **~2,900 lines** — far exceeding maintainable component size (~500 lines recommended).

**Analysis by section:**

| Section | Lines | Description |
|---------|-------|-------------|
| File selection rendering | 1700-2345 | Repetitive file list templates |
| Banner components | 2347-2508 | API key, agent config, etc. |
| LaTeXDiffs section | 2547-2736 | Diff configuration panel |
| Message handler switch | 297-400+ | 58-case switch statement |
| Event handlers | 450-700 | Click, input, form handlers |
| State management | 100-296 | @state properties |

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

**Problem:** Formatters in `src/progressView/frontend/formatters/` return HTML strings, forcing Light DOM usage.

**Current pattern:**

```typescript
// formatters/taskLog.ts - returns string
export function formatTaskLog(log: LogEntry): string {
  return `<div class="task-log">${escapeHtml(log.text)}</div>`;
}

// Used in LogList.ts via innerHTML
container.innerHTML = formatTaskLog(log);
```

**Target pattern:**

```typescript
// formatters/taskLog.ts - returns TemplateResult
import { html, TemplateResult } from 'lit';

export function formatTaskLog(log: LogEntry): TemplateResult {
  return html`<div class="task-log">${log.text}</div>`;
}

// Used in LogList.ts via render()
render(formatTaskLog(log), container);
```

**Migration scope:**

| Formatter File | Functions |
|----------------|-----------|
| `taskLog.ts` | 3 |
| `toolUseLog.ts` | 5 |
| `streamHeader.ts` | 2 |
| `agentLog.ts` | 4 |
| `litTemplates.ts` | 8 |
| Others (10 files) | ~20 |

**Benefits:**

- Shadow DOM encapsulation possible
- No manual HTML escaping needed (Lit auto-escapes)
- Better performance via Lit's diffing
- Type-safe template composition

---

## 6.5 renderLogs Incremental Updates

**Problem:** `LogList.ts:131-207` clears and rebuilds entire DOM on every update.

**Current (O(n) rebuild):**

```typescript
renderLogs(logs: LogEntry[]): void {
  container.innerHTML = '';  // ❌ Clear everything
  this.groupManager.clear();
  this.logManager.clear();

  for (const log of logs) {
    // Rebuild from scratch
  }
}
```

**Target (O(1) append for new logs):**

```typescript
renderLogs(logs: LogEntry[]): void {
  const existingCount = this.logManager.size;
  const newLogs = logs.slice(existingCount);  // Only new logs

  for (const log of newLogs) {
    this.appendLog(log);  // Incremental append
  }
}

// Full rebuild only when switching streams
switchStream(streamId: string): void {
  this.clearAll();
  this.renderLogs(this.getLogsForStream(streamId));
}
```

**Performance impact:**

| Scenario | Current | After |
|----------|---------|-------|
| Append 1 log to 100 logs | Rebuild 101 | Append 1 |
| Append 10 logs to 1000 logs | Rebuild 1010 | Append 10 |
| Switch streams | Rebuild N | Rebuild N (same) |

**Implementation steps:**

1. Track rendered log count per stream
2. Implement `appendLog()` for single log insertion
3. Implement `updateLog()` for in-place updates
4. Keep full rebuild for stream switches only

---

## 6.6 Architectural Debt (ProgressView)

### A1. TaskGroupDomManager Coupling (HIGH)

**Location:** `src/progressView/frontend/managers/TaskGroupDomManager.ts`

**Problem:** TaskGroupDomManager mixes several unrelated concerns:

| Concern | Lines | Coupling Issue |
|---------|-------|----------------|
| DOM element management | 74-165 | Core responsibility |
| Toggle state persistence | 45-72 | Should be in state manager |
| Audio notifications | `playSystemSound()` | Should be dedicated service |
| Traversal/hierarchy logic | 180-220 | Could be separate utility |

**Recommendation:** Extract concerns into focused modules:

```
managers/
├── TaskGroupDomManager.ts    # DOM operations only
├── TaskGroupStateManager.ts  # Toggle persistence
├── AudioNotificationService.ts # System sounds
└── utils/taskGroupTraversal.ts # Hierarchy navigation
```

### A2. Light DOM in ProgressView (MEDIUM)

**Location:** `ProgressApp.ts`, `LogList.ts`, `TaskGroupList.ts`

**Problem:** These components use Light DOM (`createRenderRoot() { return this; }`), breaking style encapsulation.

**Why it exists:** Streaming log architecture requires direct DOM manipulation that conflicts with Shadow DOM boundaries.

**Fix:** Refactor formatters to return `TemplateResult` instead of HTML strings, enabling Shadow DOM throughout. (See 6.4)

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
2. Implement incremental log rendering
3. Add computed getters for derived state

### Step 4: Architecture (6.4, 6.6)

1. Migrate formatters to TemplateResult
2. Refactor TaskGroupDomManager
3. Enable Shadow DOM where possible

---

## Success Metrics

| Metric | Before | After |
|--------|--------|-------|
| MainApp.ts lines | 2,900 | ~500 |
| Extracted components | 0 | 6+ |
| Inline arrow functions | 37 | 0 |
| Formatters returning TemplateResult | 0 | 42 |
| Shadow DOM components | 60% | 100% |

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
