---
created: 2026-01-24
updated: 2026-02-10
---

# PRD: ProgressView Modernization - Phase 3

> **Parent doc:** [2026-01-24-prd-progressview-modernization.md](./2026-01-24-prd-progressview-modernization.md)

## Phase 3 Status Summary

| Sub-Phase  | Scope                      | Status         | Notes                                  |
| ---------- | -------------------------- | -------------- | -------------------------------------- |
| **3a**     | JS → TS shared utilities   | ✅ Complete    | 7 utils + 2 state managers             |
| **3b-1**   | UI parity/stabilization    | ✅ Complete    | Regressions fixed, handlers done       |
| **3b-1.5** | CSS pilot (TodoList)       | ✅ Complete    | Shadow DOM pattern validated           |
| **3b-1.6** | CSS batch migration        | ✅ Complete    | 11 components to Shadow DOM            |
| **3b-2**   | Utility conversion         | 🟡 In Progress | 1 JS import remains (themeHandlers.js) |
| **3b-3**   | Formatter → TemplateResult | 🔶 Bridge      | Using renderToElement() bridge pattern |

**Note:** Phase 3c (other webview migrations) has been moved to **[Phase 4](./2026-01-25-prd-progressview-phase4.md)**.

---

## Phase 1 & 2 Completed (2026-01-25)

### What Was Done

- **Schema consolidation**: All types in `src/shared/schemas/` using Zod v4 patterns
- **Lit component architecture**: `ProgressApp`, `FileList`, `FollowUpInput`, `StreamTabs`, etc.
- **State management**: Using Lit's native `@state()` decorator (deleted unused `createStore.ts`)
- **Message validation**: All handlers validate with Zod schemas before processing
- **Nested record helper**: `updateNestedRounds<T>()` centralizes `Record<runId, Record<round, T[]>>` updates
- **Component boundaries**: Child components emit complete payloads (e.g., `FollowupSection.getFormData()`)
- **JSDoc cleanup**: Removed redundant `@param {type}` annotations from all formatters (TS types are the documentation)
- **Lifecycle cleanup**: Added `disconnectedCallback()` to `FollowUpInput` for timer and recording manager disposal
- **Event handler types**: Shared `events.ts` module with typed event creators (`ProgressEvents`) used by both dispatch and handler sides
- **CSS flex layout fixes**: Custom elements (`log-list`, `task-group-list`, `stream-tabs`) need explicit `display: flex`
- **Regression fixes**: Duplicate content on tab click, leftover content on filter switch, placeholder display
- **Message handler edge cases**: Pending log updates Map, auto-expand thinking/scratchpad, stream-scoped prompt filtering
- **Native Lit patterns**: StreamTabs uses `.value` binding on radio group instead of manual DOM sync
- **KaTeX rendering**: Proper CSS import and class targeting for math rendering
- **Missing message handlers**: Added DELETE_STREAM, DELETE_ALL, UPDATE_USAGE handlers
- **Message handler registry**: Replaced 27-case switch with `MESSAGE_HANDLERS` registry pattern
- **Type safety**: Added `VSCodeValueElement` type for safer web component casting
- **DiffResult schemas**: Added Zod schemas for latexdiff operations in `@shared/schemas`
- **Component refactoring**: Moved `yoloActive` prop from FollowUpInput to StreamHeader
- **Formatter simplification**: Cleaner rendering patterns in log formatters
- **Discriminated union StreamState**: `ToolUseStreamState | WorkflowStreamState` with type guards (`isToolUseState()`, `isWorkflowState()`) in `src/shared/schemas/streamState.ts`
- **DRY helper functions**: `buildCopyButton()` and `buildDetailsSummary()` in `htmlBuilders.ts` reduce code duplication across formatters
- **CSS migration progress**: 11 components migrated to Shadow DOM with native Lit `static styles` (only LogList/TaskGroupList remain on Light DOM pending Phase 3b-3)

### Directory Architecture: `common/` vs `shared/`

During the migration, two utility directories coexist:

| Directory             | Context               | Language   | Used By               | Purpose                                                         |
| --------------------- | --------------------- | ---------- | --------------------- | --------------------------------------------------------------- |
| `src/common/modules/` | Webview (browser)     | JavaScript | Legacy JS webviews    | Original utilities (`domUtils.js`, `ToggleStateStore.js`, etc.) |
| `src/common/webview/` | Extension host (Node) | TypeScript | All webview providers | Backend base classes, commands                                  |
| `src/shared/utils/`   | Both                  | TypeScript | Lit webviews          | Modern TS versions of browser utilities                         |
| `src/shared/state/`   | Both                  | TypeScript | Lit webviews          | State management classes                                        |
| `src/shared/schemas/` | Both                  | TypeScript | All code              | Zod schemas, shared types                                       |

**Why duplication exists:**

- `shared/utils/dom.ts` duplicates `common/modules/domUtils.js`
- `shared/state/ToggleStateStore.ts` duplicates `common/modules/ToggleStateStore.js`

This is intentional during migration. ProgressView imports from `@shared/`, while HistoryView/MemoryView/ProfileView/MainView still import from `@common/modules/*.js`.

**Cleanup plan:**

- Phase 3c: When each legacy webview migrates to Lit, switch its imports to `@shared/`
- After all webviews migrated: Delete `common/modules/*.js` files

**Rule:** New webview code should only import from `@shared/`, never from `@common/modules/`.

### Patterns Established

1. **State ownership**: Components own their form state; parents receive via events
2. **No DOM querying across boundaries**: Use refs within component, events across components
3. **Single `setStreamState` call**: All state updates in one place, no sequential band-aids
4. **Helper functions for complex updates**: Extract reusable logic (e.g., `updateNestedRounds`)
5. **Always clear before render**: Full re-renders must clear container first to prevent duplicates
6. **Stream switch = clear**: Changing active stream or filtering to empty category must clear log content
7. **Pending updates for race conditions**: Handle UPDATE_LOG arriving before APPEND_LOG via Map storage
8. **VS Code radio groups**: Use `.value` binding on `vscode-radio-group`, not `.checked` on individual radios; read `group.value` in change handler
9. **Handler registry pattern**: Use `Record<string, MessageHandler>` instead of switch statements for message routing; enables type inference and easier testing
10. **Discriminated union for mode-specific state**: Use `kind` discriminator with type guards (`isToolUseState()`, `isWorkflowState()`) to enable type-safe mode-specific state access
11. **DRY template helpers**: Extract repeated Lit template patterns into reusable functions with options objects (e.g., `buildCopyButton()`, `buildDetailsSummary()`)

### Technical Debt Remaining

**Mixed State (Lit components using non-Lit patterns):**

| Priority | Issue                         | Location                          | Resolution Phase | Notes                                             |
| -------- | ----------------------------- | --------------------------------- | ---------------- | ------------------------------------------------- |
| High     | JS utility imports            | `FollowUpInput.ts`                | Phase 3b-2       | `textareaUtils.js`, `RecordingButtonManager.js`   |
| High     | Formatters return HTMLElement | `formatters/*.ts` (6 files)       | Phase 3b-3       | Convert to `TemplateResult` for Lit rendering     |
| High     | `LogList` uses innerHTML      | `components/LogList.ts`           | Phase 3b-3       | Integrate formatters into Lit reactive rendering  |
| High     | `TaskGroupDomManager` manual  | `managers/TaskGroupDomManager.ts` | Phase 3b-3       | Convert to Lit component or integrate into parent |
| Medium   | `htmlBuilders.ts` strings     | `formatters/htmlBuilders.ts`      | Phase 3b-3       | Convert to Lit template functions                 |
| Medium   | `templates.ts` cloning        | `frontend/templates.ts`           | Phase 3b-3       | Delete after formatters converted                 |

**Other Technical Debt:**

| Priority | Issue               | Location          | Notes                                        |
| -------- | ------------------- | ----------------- | -------------------------------------------- |
| High     | UI regressions      | Various           | Ongoing testing required (Phase 3b-1)        |
| Medium   | Inline param types  | `formatters/*.ts` | Extract interfaces for complex param objects |
| Low      | TodoList repeat key | `TodoList.ts`     | Use unique ID instead of `content-status`    |

### Remaining JS Codebase Analysis (2026-01-25)

**Total JS lines to migrate:** ~5,682 lines across 4 categories

| Category               | Files | Lines  | Priority | Notes                                  |
| ---------------------- | ----- | ------ | -------- | -------------------------------------- |
| `common/modules/`      | 17    | ~1,872 | High     | Shared utilities imported by TS code   |
| `webview/modules/`     | 20+   | ~2,259 | Medium   | MainView - most complex after Progress |
| `profileView/modules/` | 6     | ~636   | Low      | Static settings display                |
| `historyView/modules/` | 7     | ~610   | Low      | Simple list/search UI                  |
| `memoryView/modules/`  | 5     | ~305   | Low      | Simple toggle state UI                 |

### Duplicate Constant Files to Delete

Several JS constant files are duplicates of TypeScript sources or will be superseded during migration:

| File                               | Lines | Duplicate Of                    | Delete When                       |
| ---------------------------------- | ----- | ------------------------------- | --------------------------------- |
| `common/webview/commands.js`       | 298   | `common/webview/commands.ts`    | **Immediate** - TS version exists |
| `common/webview/themeHandlers.js`  | 35    | N/A                             | **Quick win** - 15 min to migrate |
| `historyView/modules/constants.js` | 37    | Will be `frontend/constants.ts` | Phase 3c - HistoryView migration  |
| `profileView/modules/constants.js` | 41    | Will be `frontend/constants.ts` | Phase 3c - ProfileView migration  |
| `memoryView/modules/constants.js`  | 24    | Will be `frontend/constants.ts` | Phase 3c - MemoryView migration   |
| `webview/modules/constants.js`     | 162   | Will be `frontend/constants.ts` | Phase 3c - MainView migration     |

**Pattern:** Each view's `modules/constants.js` contains:

1. Re-export of view commands from `@common/webview/commands.js`
2. View-specific `ELEMENT_IDS`, `CLASS_NAMES`, `LABELS`

**After migration:** Each view will have `frontend/constants.ts` (like ProgressView already has) that:

1. Imports from `@common/webview/commands.ts` (TypeScript)
2. Defines view-specific constants with proper types

**Total duplicate lines to delete:** ~612 lines

### Outstanding Cleanup Tasks

| File                              | Action        | Effort | Notes                                   |
| --------------------------------- | ------------- | ------ | --------------------------------------- |
| `common/webview/commands.js`      | DELETE        | 1 min  | TS version exists, identical content    |
| `common/webview/themeHandlers.js` | Migrate to TS | 15 min | 35 lines, imported by ProgressApp.ts:12 |

---

## Phase 3 Overview

Phase 3 is divided into three sub-phases with clear dependencies:

```
Phase 3a: Shared JS → TS Migration (prerequisite for 3b)
    ↓
Phase 3b: ProgressView Stabilization (parallel with 3a)
    ↓
Phase 3c: Other Webview Migration (depends on 3a)
```

### Phase 3a vs 3c: Key Distinction

- **Phase 3a** migrates **shared utilities** (`common/modules/*.js`) that are imported by multiple webviews
- **Phase 3c** migrates **view-specific modules** (`webview/modules/*.js`, etc.) that are replaced by Lit components

Phase 3a enables type-safe imports; Phase 3c rewrites UI.

---

## Phase 3a: Migrate JS Utilities to Shared TypeScript

**Problem**: ProgressView TypeScript imports from `@common/modules/*.js` files. This creates a mixed JS/TS codebase with no type safety at boundaries.

### Completed Migrations (2026-01-25)

**Utilities migrated to `src/shared/utils/`:**

| JS Original             | TS Replacement               | Status  |
| ----------------------- | ---------------------------- | ------- |
| `htmlEncoding.js`       | `@shared/utils/html.ts`      | ✅ Done |
| `iconConstants.js`      | `@shared/utils/icons.ts`     | ✅ Done |
| `pathUtils.js`          | `@shared/utils/path.ts`      | ✅ Done |
| `stringUtils.js`        | `@shared/utils/string.ts`    | ✅ Done |
| `clipboardUtils.js`     | `@shared/utils/clipboard.ts` | ✅ Done |
| `domUtils.js` (partial) | `@shared/utils/dom.ts`       | ✅ Done |

**State managers migrated to `src/shared/state/`:**

| JS Original           | TS Replacement                         | Status  |
| --------------------- | -------------------------------------- | ------- |
| `ToggleStateStore.js` | `@shared/state/ToggleStateStore.ts`    | ✅ Done |
| `webviewState.js`     | `@shared/state/WebviewStateManager.ts` | ✅ Done |

**Migration stats:** JS imports reduced from 18 → 7 (61% reduction)

### Remaining JS Utilities (Require Architectural Changes)

**Key Finding**: All remaining JS utilities are **only imported by ProgressView**. They cannot be simply converted to TypeScript - they require Lit pattern replacement.

| JS File                     | Usages | Resolution                                                       |
| --------------------------- | ------ | ---------------------------------------------------------------- |
| `templateUtils.js`          | 4      | Replace `createFromTemplate()` with Lit `html` (Phase 3b-3)      |
| `dropdownUtils.js`          | 1      | Keep as local util; refactor when FollowupSection uses Lit fully |
| `textareaUtils.js`          | 1      | Keep as local util; VS Code textarea upgrade helper              |
| `RecordingButtonManager.js` | 1      | Convert to Lit reactive controller (Phase 3b-2)                  |

### Review Checklist (Verify Nothing Missed)

Before considering Phase 3a complete, verify:

- [x] **No JS imports in Lit components** (except the 4 deferred above) ✅ Verified 2026-01-25
- [x] **All shared utilities have proper types** (no `any`, proper function signatures) ✅ Verified 2026-01-25
- [x] **Index files updated** (`src/shared/utils/index.ts`, `src/shared/state/index.ts`) ✅ Verified 2026-01-25
- [x] **Build compiles without errors** (`npm run compile`) ✅ Verified 2026-01-25
- [ ] **Original JS files deleted** (Phase 3c - after other webviews migrate)

**Status of JS files in `src/common/modules/`:**

```
# ProgressView migrated to TS versions in src/shared/
# BUT original JS files still needed by other webviews until Phase 3c

htmlEncoding.js      # ⏳ Delete in Phase 3c - used by HistoryView, MemoryView, ProfileView
iconConstants.js     # ⏳ Delete in Phase 3c - used by HistoryView, MainView, domUtils.js
pathUtils.js         # ⏳ Delete in Phase 3c - has test file, referenced in BaseViewContentProvider
stringUtils.js       # ⏳ Delete in Phase 3c - used by MemoryView, MainView
clipboardUtils.js    # ⏳ Delete in Phase 3c - referenced in BaseViewContentProvider
ToggleStateStore.js  # ⏳ Delete in Phase 3c - used by HistoryView
webviewState.js      # ⏳ Delete in Phase 3c - used by HistoryView, MemoryView, ProfileView, MainView
domUtils.js          # ⏳ Delete in Phase 3c - used by other views
templateUtils.js     # ⏳ Delete in Phase 3b-3 - used by ProgressView formatters only
dropdownUtils.js     # ⏳ Delete in Phase 3c - used by FollowupSection, MainView
textareaUtils.js     # ⏳ Delete in Phase 3b-2 - used by FollowUpInput only
RecordingButtonManager.js  # ⏳ Delete in Phase 3b-2 - used by FollowUpInput only
```

**Key insight:** Phase 3a created **parallel TypeScript implementations** in `src/shared/`. The original JS files in `src/common/modules/` remain for legacy webviews. ProgressView now imports from `@shared/utils/*` and `@shared/state/*`; other webviews still import from `@common/modules/*.js`.

### Migration Strategy

**Immediate (shared utilities):**

- `clipboardUtils.js` → `@shared/utils/clipboard.ts`
- `ToggleStateStore.js` → `@shared/state/ToggleStateStore.ts`
- `webviewState.js` → `@shared/state/WebviewStateManager.ts`

**Deferred (ProgressView-specific, replace with Lit patterns):**

- `templateUtils.js` - Replace `createFromTemplate()` with Lit `html` templates
- `domUtils.js` - Most functions become unnecessary with Lit; migrate `getRadioChangeValue`/`setRadioGroupValue` if needed
- `dropdownUtils.js` - Keep as local util or inline into component
- `textareaUtils.js` - Keep as local util or inline into component

**Phase 3c (when MainView migrates):**

- `RecordingButtonManager.js` → `@shared/components/RecordingButton.ts`

### Type Definitions Needed

```typescript
// src/shared/utils/html.ts
export function encodeHtml(value: unknown): string;
export function decodeHtml(value: unknown): string;
export function encodeListForHtml(
  values: unknown[],
  separator?: string,
): string;

// src/shared/utils/dom.ts
export function getRadioChangeValue(
  event: Event,
  radioGroup: HTMLElement | null,
): string;
export function setRadioGroupValue(
  radioGroup: HTMLElement,
  value: string,
  selector?: string,
): void;
export function setElementDisabled(element: Element, disabled: boolean): void;
export function waitForElement(
  selector: string,
  options?: { timeout?: number },
): {
  promise: Promise<Element | null>;
  dispose: () => void;
};

// src/shared/state/ToggleStateStore.ts
export class ToggleStateStore {
  constructor(storageKey: string);
  get(id: string): boolean;
  set(id: string, value: boolean): void;
  toggle(id: string): boolean;
}
```

### What NOT to Migrate

View-specific JS modules will be **replaced** (not migrated) by Lit components:

- `src/webview/modules/*.js` → Replaced by MainView Lit components
- `src/historyView/modules/*.js` → Replaced by HistoryView Lit components
- `src/memoryView/modules/*.js` → Replaced by MemoryView Lit components
- `src/profileView/modules/*.js` → Replaced by ProfileView Lit components

---

## Phase 3b: ProgressView Stabilization & Native Conversion

**Prerequisite:** Phase 2 migration complete (Lit components exist)

**Goals:**

1. Achieve full UI/UX parity with legacy JavaScript implementation
2. Convert "mixed state" patterns to fully native Lit solutions

### Known Issue Categories

| Category            | Examples                             | Approach                                             |
| ------------------- | ------------------------------------ | ---------------------------------------------------- |
| Layout/Sizing       | Scrollbar, overflow, flex layout     | CSS fixes for custom elements                        |
| State Transitions   | Stream switching, filter changes     | Clear-before-render patterns                         |
| Data Ordering       | Updates arriving before creates      | Pending updates Map                                  |
| Component Lifecycle | Event listeners not cleaned up       | `disconnectedCallback()` cleanup                     |
| vscode-elements     | Radio buttons, dropdowns not syncing | Use `.value` binding on group, not individual radios |
| Visual Regressions  | Colors, spacing, icons different     | CSS specificity, class name matching                 |

### Mixed State Patterns to Convert

ProgressView currently has Lit components that bypass reactive rendering. These should be converted to fully native Lit patterns:

| Pattern                | Current (Mixed)                                          | Target (Native Lit)                                     | Files Affected                         |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------- |
| **Textarea utilities** | `awaitTextareaUpgrade()`, `insertTextAtCursor()` from JS | Use `@query` + `updateComplete`, Lit `live()` directive | `FollowUpInput.ts`                     |
| **Recording manager**  | `RecordingButtonManager.js` class                        | Convert to Lit reactive controller or child component   | `FollowUpInput.ts`                     |
| **Log formatters**     | Return `HTMLElement` via `document.createElement()`      | Return `TemplateResult` via `html\`...\``               | 6 formatter files                      |
| **Task group DOM**     | `TaskGroupDomManager` with manual DOM ops                | Integrate into `TaskGroupList` Lit component            | `TaskGroupDomManager.ts`               |
| **Log entry manager**  | `LogEntryManager` with `innerHTML`                       | Integrate into `LogList` Lit component                  | `LogList.ts`, `TaskGroupDomManager.ts` |
| **Template cloning**   | `createFromTemplate()` from JS                           | Use Lit templates directly                              | `templates.ts`, formatters             |
| **HTML builders**      | String concatenation → `innerHTML`                       | Template literals with `html\`...\``                    | `htmlBuilders.ts`                      |
| **External CSS**       | Light DOM + external `.css` files                        | Shadow DOM + `static styles = css\`...\``               | 10 components (see below)              |

### CSS Migration to Native Lit Pattern

**Current state:** All components except `PromptOverlay` use Light DOM (`createRenderRoot() { return this; }`) with external CSS files. `PromptOverlay` already demonstrates the native Lit pattern with Shadow DOM and `static styles`.

**Existing infrastructure:** `src/shared/styles/litStyles.ts` provides design tokens and utilities for Shadow DOM components.

#### Components That Can Migrate NOW

These components use pure Lit templates with no `innerHTML` or formatter HTMLElement dependencies:

| Component             | CSS File                | Status  | Notes                                 |
| --------------------- | ----------------------- | ------- | ------------------------------------- |
| `PromptOverlay.ts`    | (inline)                | ✅ Done | Already used Shadow DOM               |
| `TodoList.ts`         | `todo-list.css`         | ✅ Done | Pilot migration                       |
| `FileList.ts`         | `file-list.css`         | ✅ Done | Uses `vscode-collapsible`             |
| `StreamTabs.ts`       | `tabs.css`              | ✅ Done | Tab animations, status indicators     |
| `QueuedFollowUps.ts`  | `queued-follow-ups.css` | ✅ Done | Uses `vscode-collapsible`             |
| `FollowupSection.ts`  | `followup-section.css`  | ✅ Done | VS Code form components               |
| `InstructionPanel.ts` | `instruction-panel.css` | ✅ Done | VS Code toolbar, textarea             |
| `FollowUpInput.ts`    | `follow-up-input.css`   | ✅ Done | Recording manager works in Shadow DOM |
| `UsagePanel.ts`       | (minimal)               | ✅ Done | First non-pilot migration             |
| `RunSelector.ts`      | (minimal)               | ✅ Done | Uses `vscode-single-select`           |
| `StreamHeader.ts`     | (in logs.css)           | ✅ Done | Status indicator, toolbar             |

**Key pattern:** Design tokens from `tokens.css` inherit into Shadow DOM via `:root` CSS variables - no need to import `designTokens`. Components only need `codiconStyles` + component-specific CSS.

#### Components That Must Wait (Phase 3b-3)

| Component          | Blocker                                         |
| ------------------ | ----------------------------------------------- |
| `LogList.ts`       | Uses `innerHTML`, formatters return HTMLElement |
| `TaskGroupList.ts` | Depends on `TaskGroupDomManager` manual DOM     |

#### CSS Files That Must Remain Global

These files style dynamically generated HTML from formatters or are shared across contexts:

| CSS File                 | Reason                                                 |
| ------------------------ | ------------------------------------------------------ |
| `base.css`               | Page-level layout (body, progress-app, main-container) |
| `utilities.css`          | Shared utility classes                                 |
| `buttons.css`            | Shared button styles across components                 |
| `markdown.css`           | Styles dynamic markdown content from formatters        |
| `code-block.css`         | Styles dynamic code blocks from htmlBuilders.js        |
| `scratchpad.css`         | Styles tool-use banners from formatters                |
| `approval-requests.css`  | Styles dynamic approval UI                             |
| `retry-requests.css`     | Styles dynamic retry UI                                |
| `workflow-proposals.css` | Styles dynamic proposal UI                             |
| `requests-shared.css`    | Base styles for all request types                      |
| `groups.css`             | Shared log group styling                               |
| `logs.css`               | Mixed: some rules for LogList, some global             |
| `context-management.css` | Styles formatter output                                |
| `statistics.css`         | Styles formatter output                                |
| `latexdiff.css`          | Styles formatter output                                |
| `native-status.css`      | Styles dynamic status lines                            |
| `user-message.css`       | Styles user message rendering                          |
| `placeholder.css`        | Shared placeholder styling                             |

#### Migration Pattern

```typescript
// Before: Light DOM + external CSS
@customElement('todo-list')
export class TodoList extends LitElement {
  protected createRenderRoot(): HTMLElement {
    return this; // Light DOM
  }
}

// After: Shadow DOM + native CSS
import { designTokens } from '@shared/styles/litStyles';
import { codiconStyles } from '@shared/styles/codiconStyles';

@customElement('todo-list')
export class TodoList extends LitElement {
  static styles = [
    designTokens,
    codiconStyles,
    css`
      /* Paste todo-list.css content here */
      .todo-collapsible { ... }
    `,
  ];
  // No createRenderRoot override = Shadow DOM (Lit default)
}
```

#### Phased CSS Migration

**Phase 3b-1.5: Pilot Migration (1 component)**

- Migrate `TodoList.ts` to Shadow DOM + native CSS
- Verify VS Code elements (`vscode-collapsible`) work in Shadow DOM
- Verify design tokens inherit correctly
- If successful, proceed to batch migration

**Phase 3b-1.6: Batch Migration (9 components)**

- Migrate remaining components: FileList, StreamTabs, QueuedFollowUps, FollowupSection, InstructionPanel, FollowUpInput, UsagePanel, RunSelector, StreamHeader
- Delete migrated CSS files from `styles/` directory
- Update `index.css` to remove deleted imports

**Phase 3b-3: LogList Migration (after formatters converted)**

- Convert formatters to return `TemplateResult`
- Migrate LogList to Shadow DOM
- Migrate remaining shared CSS or keep global

### Conversion Strategy

**Phase 3b-1: Stabilization (current)**

- Fix remaining UI regressions
- Keep mixed patterns working

**Phase 3b-2: After Phase 3a (shared utils migrated)**

- Convert `textareaUtils.js` → `@shared/utils/textarea.ts` with proper types
- Convert `RecordingButtonManager.js` → Lit reactive controller

**Phase 3b-3: After Phase 3c (other webviews done)**

- Convert formatters from `HTMLElement` → `TemplateResult`
- Refactor `LogList` to use Lit rendering instead of `innerHTML`
- Refactor `TaskGroupDomManager` into proper Lit component
- Delete `templates.ts` and `htmlBuilders.ts` string-based builders

### Formatter Conversion Example

**Current (returns HTMLElement):**

```typescript
// formatters/logFormatters/bannerFormatters.ts
export function formatBannerContent(
  payload: NormalizedPayload,
  title: string,
  id: string,
): HTMLElement | null {
  const details = document.createElement('details');
  details.className = 'banner-details';
  details.innerHTML = `<summary>...</summary><div>...</div>`;
  return details;
}
```

**Target (returns TemplateResult):**

```typescript
// formatters/logFormatters/bannerFormatters.ts
import { html, TemplateResult } from 'lit';

export function formatBannerContent(
  payload: NormalizedPayload,
  title: string,
  id: string,
): TemplateResult | null {
  return html`
    <details class="banner-details" data-log-id=${id}>
      <summary class="details-summary">
        <span class="toggle-icon codicon codicon-chevron-right"></span>
        <span class="banner-title">${title}</span>
      </summary>
      <div class="banner-content">${payload.text}</div>
    </details>
  `;
}
```

**Benefits:**

- Type-safe templates (no string concatenation)
- Lit's efficient DOM diffing
- Declarative event binding (`@click=${handler}`)
- No manual `innerHTML` security risks

### Testing Approach

**Manual Testing Checklist:**

| Area            | Test Cases                                                   |
| --------------- | ------------------------------------------------------------ |
| Stream Tabs     | Select, delete, filter (workflow/toolUse), sort              |
| Log Display     | Append, update, scroll, expand/collapse details              |
| Task Groups     | Render, collapse/expand, duration display                    |
| Prompts         | Show tool-edit, bash, retry, proposal; approve/reject        |
| Follow-up Input | Type, send, record, polish                                   |
| File List       | Render by round, actions (compare, accept, preview)          |
| Todo List       | Status icons (pending/in-progress/completed), spin animation |
| Usage Panel     | Token counts, cost display, context state                    |
| Empty States    | Placeholder when no streams, no logs, no files               |
| Theme Changes   | Light/dark/high-contrast switching                           |

**Regression Discovery:**

1. Use ProgressView in real TeXRA workflows
2. Compare behavior side-by-side with legacy implementation (if possible)
3. Document any discrepancies as GitHub issues
4. Track fixes in this PRD

### Recent Fixes (2026-01-25)

| Issue                                  | Root Cause                                                    | Fix                                                                         |
| -------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Radio button not immediately selecting | Using `?checked` attribute binding + manual sync              | Use `.value` binding on `vscode-radio-group`, read `group.value` in handler |
| Clear all button style changed         | Was `vscode-button`, should be toolbar button                 | Changed to `vscode-toolbar-button` with `icon="close-all"`                  |
| Leftover content on empty filter       | Log list not cleared when switching to filter with no streams | Added clear logic in `handleFilterChange`                                   |
| KaTeX showing both rendered + MathML   | `.katex-mathml` not hidden due to CSS selector                | Added `markdown-content` class to banner content                            |
| KaTeX only showing MathML              | `katex.min.css` not loaded                                    | Added `import 'katex/dist/katex.min.css'` to index.ts                       |
| Context % position wrong               | Order swapped in UsagePanel                                   | Fixed element order in template                                             |
| `LogListState` type error              | Interface didn't satisfy `Record<string, unknown>` constraint | Changed to type with explicit index signature                               |
| 27-case switch unmaintainable          | Large switch in `handleMessage` hard to maintain              | Replace with `MESSAGE_HANDLERS` registry pattern                            |
| Unsafe web component casting           | `as HTMLElement & { value }` scattered throughout             | Added `VSCodeValueElement` type in store.ts                                 |

### Stabilization Deliverables

**Phase 3b-1: UI Parity**

| Item                          | Status         |
| ----------------------------- | -------------- |
| All layout issues resolved    | 🟡 In Progress |
| All data flow issues resolved | ✅ Done        |
| All vscode-element issues     | ✅ Done        |
| Visual parity achieved        | 🟡 In Progress |
| Full manual test pass         | ⬜ Not Started |

**Phase 3b-1.5: CSS Pilot Migration**

| Item                                       | Status  |
| ------------------------------------------ | ------- |
| Migrate `TodoList.ts` to Shadow DOM        | ✅ Done |
| Verify VS Code elements work in Shadow DOM | ✅ Done |
| Verify design tokens inherit correctly     | ✅ Done |
| Delete `todo-list.css` after migration     | ✅ Done |

**Phase 3b-1.6: CSS Batch Migration (after pilot succeeds)** ✅ Complete

| Item                                                           | Status  |
| -------------------------------------------------------------- | ------- |
| Migrate `FileList.ts` to Shadow DOM                            | ✅ Done |
| Migrate `StreamHeader.ts` to Shadow DOM                        | ✅ Done |
| Migrate `QueuedFollowUps.ts` + delete `queued-follow-ups.css`  | ✅ Done |
| Migrate `FollowUpInput.ts` + delete `follow-up-input.css`      | ✅ Done |
| Migrate `InstructionPanel.ts` + delete `instruction-panel.css` | ✅ Done |
| Migrate `StreamTabs.ts` + delete `tabs.css`                    | ✅ Done |
| Migrate `FollowupSection.ts` + delete `followup-section.css`   | ✅ Done |
| Migrate `UsagePanel.ts`, `RunSelector.ts`                      | ✅ Done |
| Update `index.css` to remove deleted imports                   | ✅ Done |

**Note:** `LogList.ts` and `TaskGroupList.ts` remain on Light DOM - blocked by Phase 3b-3 (formatter conversion). These components use document-level event listeners and external DOM managers that generate content with external CSS classes.

**Phase 3b-2: Utility Conversion (after 3a)**

| Item                                 | Status         |
| ------------------------------------ | -------------- |
| `textareaUtils.js` → TypeScript      | ⬜ Not Started |
| `RecordingButtonManager` → Lit       | ⬜ Not Started |
| Remove JS imports from FollowUpInput | ⬜ Not Started |

**Phase 3b-3: Formatter Conversion (after 3c)**

| Item                                                   | Status         |
| ------------------------------------------------------ | -------------- |
| Banner formatters → TemplateResult                     | ⬜ Not Started |
| Tool formatters → TemplateResult                       | ⬜ Not Started |
| Message formatters → TemplateResult                    | ⬜ Not Started |
| Data formatters → TemplateResult                       | ⬜ Not Started |
| `LogList` uses Lit rendering                           | ⬜ Not Started |
| `TaskGroupDomManager` integrated to Lit                | ⬜ Not Started |
| Delete `templates.ts`                                  | ⬜ Not Started |
| Delete string-based `htmlBuilders.ts`                  | ⬜ Not Started |
| Migrate `LogList.ts` to Shadow DOM                     | ⬜ Not Started |
| Consolidate remaining CSS (logs.css, groups.css, etc.) | ⬜ Not Started |

---

## Phase 3c: Other Webview Migrations → MOVED TO PHASE 4

> **See [2026-01-25-prd-progressview-phase4.md](./2026-01-25-prd-progressview-phase4.md) for other webview migrations (MemoryView, HistoryView, ProfileView, MainView).**

---

## Phase 3 Success Metrics

### Phase 3a (JS → TS Migration) ✅ Complete

| Metric                          | Before | Current | Target |
| ------------------------------- | ------ | ------- | ------ |
| TS files in `src/shared/utils/` | 0      | 7       | 7 ✅   |
| TS files in `src/shared/state/` | 0      | 2       | 2 ✅   |
| JS imports in ProgressView      | 18     | 7       | 0      |
| Pure-function utils migrated    | 0      | 7       | 7 ✅   |
| State managers migrated         | 0      | 2       | 2 ✅   |

\*The 7 remaining JS imports are from 4 files: `templateUtils.js` (4 formatters), `textareaUtils.js`, `RecordingButtonManager.js`, `dropdownUtils.js`. These require Lit pattern replacement in Phase 3b.

### Phase 3b (ProgressView Stabilization & Native Conversion)

**3b-1: UI Parity** ✅ Complete

| Metric                          | Before | After   |
| ------------------------------- | ------ | ------- |
| Known UI regressions            | 10+    | 0 ✅    |
| Manual test checklist pass rate | 0%     | ~95% ✅ |

**3b-1.5/1.6: CSS Migration to Native Lit** ✅ Complete

| Metric                                 | Before | Current | Target |
| -------------------------------------- | ------ | ------- | ------ |
| Components using Shadow DOM            | 1      | 11      | 13\*   |
| External CSS files                     | 26     | 18      | 16\*   |
| CSS files deleted (component-specific) | 0      | 8       | 10\*   |
| Components with `static styles`        | 1      | 11      | 13\*   |

\*Target 13 includes LogList and TaskGroupList which are blocked until Phase 3b-3 (formatter conversion).

**3b-2: Utility Conversion** 🟡 In Progress

| Metric                                | Before | Current | Target |
| ------------------------------------- | ------ | ------- | ------ |
| JS imports in ProgressView components | 3+     | 1       | 0      |
| `RecordingButtonManager` as JS class  | 1      | 0 ✅    | 0      |

**Remaining:** `themeHandlers.js` import in `ProgressApp.ts:12` (~15 min to convert to TS)

**3b-3: Formatter Conversion** 🔶 Bridge Pattern

**Current State (2026-01-25):** Formatters use Lit templates internally but convert to HTMLElement via `renderToElement()` bridge function. This allows Lit template authoring benefits while maintaining backward compatibility with LogList's appendChild pattern.

| Metric                             | Before | Current | Target |
| ---------------------------------- | ------ | ------- | ------ |
| Formatters returning `HTMLElement` | 15+    | 14      | 0      |
| Using Lit templates internally     | 0      | 14 ✅   | 14     |
| Manual `innerHTML` assignments     | 10+    | 2       | 0      |
| `document.createElement()` calls   | 30+    | 2       | 0      |

**Bridge function:** `src/progressView/frontend/formatters/litTemplates.ts:28-33`

**To complete Phase 3b-3:**

1. Remove `renderToElement()` calls from formatters (return `TemplateResult` directly)
2. Update `LogList.renderLogs()` to use Lit's `render()` instead of `appendChild()`
3. Migrate LogList/TaskGroupList to Shadow DOM
4. Delete `renderToElement()` bridge function

---

## Phase 3 Risks

### High: ProgressView UI Regressions (Phase 3b)

Unknown regressions may exist that only surface during real-world usage.

**Mitigation:**

- Systematic manual testing against legacy implementation
- User feedback collection
- Quick iteration on discovered issues
- Consider keeping legacy JS as reference (not deployed) until confident

### Medium: Nested Record Complexity

The `Record<string, Record<string, T[]>>` pattern for run/round data is error-prone.

**Mitigation**: Use `updateNestedRounds` helper. Consider flattening to `Map<CompositeKey, T[]>` if pattern keeps causing issues.

---

## Anti-Patterns to Avoid

These were fixed in Phase 1 & 2; don't reintroduce them:

1. **DOM queries for cross-component state** - Parent should not `document.getElementById()` into child
2. **Multiple sequential `setStreamState` calls** - Consolidate into single call with helper functions
3. **`@ts-nocheck` on new files** - Use proper types or `@ts-expect-error` with comments
4. **Manual DOM manipulation in Lit components** - Either use Lit properly or don't extend `LitElement`
5. **Unused abstractions** - Don't add `createStore.ts`-style helpers unless actually used
6. **Importing JS from TS** - After Phase 3a, all shared utilities must be TypeScript; no `from '*.js'` imports

---

---

## Advanced Lit Native Compliance (Deep-Dive Analysis 2026-01-25)

This section documents findings from a comprehensive 8-dimension analysis of Lit Native compliance across the codebase.

### Compliance Summary

| Category                | Score | Blockers                                     |
| ----------------------- | ----- | -------------------------------------------- |
| **Event Handling**      | 85%   | 42 inline arrows, weak types                 |
| **Reactive Properties** | 95%   | Minor caching opportunities                  |
| **Rendering**           | 70%   | LogList/TaskGroupDomManager DOM manipulation |
| **Lifecycle**           | 98%   | None (excellent cleanup)                     |
| **CSS/Styling**         | 90%   | 4 undefined tokens, global CSS imports       |
| **State Management**    | 85%   | pendingLogUpdates, no TTL                    |
| **Message Handling**    | 75%   | MainApp unvalidated, inconsistent patterns   |
| **Type Safety**         | 80%   | Event types, Record<string, unknown>         |

**Overall: ~85% Lit Native**

### High Priority Issues

#### 1. Inline Arrow Functions in Templates (Performance)

**42 inline arrow functions** create new function instances on every render cycle, causing unnecessary re-renders when passed as props.

| File                                                | Count | Severity         |
| --------------------------------------------------- | ----- | ---------------- |
| `webview/frontend/MainApp.ts`                       | 37    | HIGH (in lists)  |
| `historyView/frontend/components/HistoryItem.ts`    | 3     | HIGH (in repeat) |
| `profileView/frontend/components/AgentsTable.ts`    | 1     | HIGH (in repeat) |
| `progressView/frontend/components/PromptOverlay.ts` | 1     | MEDIUM           |

**Anti-pattern:**

```typescript
@click=${() => this.handleRemoveFile(listId, file)}  // ❌ New function each render
```

**Fix:**

```typescript
// Define as class method with stable reference
private handleRemoveFileClick = (e: Event) => {
  const target = e.currentTarget as HTMLElement;
  const listId = target.dataset.listId;
  const file = target.dataset.file;
  this.handleRemoveFile(listId, file);
};

// In template - use data attributes for context
@click=${this.handleRemoveFileClick}  // ✓ Stable reference
data-list-id=${listId}
data-file=${file}
```

#### 2. Direct DOM Manipulation (Core Anti-Pattern)

| File                                                    | Lines             | Operations                                              |
| ------------------------------------------------------- | ----------------- | ------------------------------------------------------- |
| `progressView/frontend/components/LogList.ts`           | 121, 185-202, 254 | `innerHTML`, `appendChild`, `prepend`                   |
| `progressView/frontend/managers/TaskGroupDomManager.ts` | 74-165            | `createDocumentFragment`, `appendChild`, `insertBefore` |
| `progressView/frontend/formatters/litTemplates.ts`      | 29, 45-49         | `document.createElement`, `appendChild` loop            |
| `shared/controllers/RecordingButtonController.ts`       | 89-92             | `innerHTML`, `appendChild`                              |

**Note:** This is necessary for streaming log architecture but violates Lit declarative principles.

#### 3. Light DOM Usage (Style Encapsulation Broken)

| Component       | File:Line                                           | Impact                |
| --------------- | --------------------------------------------------- | --------------------- |
| `ProgressApp`   | `progressView/frontend/ProgressApp.ts:108-110`      | Root component        |
| `LogList`       | `progressView/frontend/components/LogList.ts:68-70` | High-volume rendering |
| `TaskGroupList` | Inherits from LogList                               | Inherits anti-pattern |

```typescript
// Anti-pattern
override createRenderRoot(): HTMLElement {
  return this;  // ❌ Light DOM - no style encapsulation
}
```

#### 4. Undefined CSS Design Tokens

| Token             | Used In                  | Missing From   |
| ----------------- | ------------------------ | -------------- |
| `--color-added`   | `PromptOverlay.ts:269`   | `litStyles.ts` |
| `--color-removed` | `PromptOverlay.ts:273`   | `litStyles.ts` |
| `--height-medium` | `commonViewStyles.ts:47` | `litStyles.ts` |
| `--height-max`    | `commonViewStyles.ts:53` | `litStyles.ts` |

#### 5. Global Mutable State (Memory/Lifecycle Risk)

| Variable                | File:Line                | Risk                     |
| ----------------------- | ------------------------ | ------------------------ |
| `pendingLogUpdates` Map | `messageHandlers.ts:68`  | No TTL, orphaned entries |
| `markdownCache` Map     | `markdownRenderer.ts:18` | Bounded but persists     |

**Issue with pendingLogUpdates:**

- Buffers UPDATE_LOG messages arriving before APPEND_LOG
- No timeout/TTL mechanism for orphaned entries
- Not persisted across webview reloads

**Recommended fix:**

```typescript
// Add TTL to prevent memory leaks
const PENDING_LOG_TTL_MS = 30_000;

interface PendingEntry<T> {
  data: T;
  timestamp: number;
}

// Cleanup stale entries periodically
function cleanupStalePendingLogs(): void {
  const now = Date.now();
  for (const [key, entry] of pendingLogUpdates) {
    if (now - entry.timestamp > PENDING_LOG_TTL_MS) {
      pendingLogUpdates.delete(key);
    }
  }
}
```

### Medium Priority Issues

#### 6. Weak Event Handler Types

| File                     | Issue                                 |
| ------------------------ | ------------------------------------- |
| `LogList.ts:300, 321`    | Uses `Event` instead of specific type |
| `SearchBar.ts:28`        | Uses `Event` instead of `InputEvent`  |
| `RunSelector.ts:59`      | Uses `Event` instead of `ChangeEvent` |
| `FollowupSection.ts:320` | `CustomEvent` without type parameter  |

**Fix:**

```typescript
// Anti-pattern
private handleChange = (event: Event): void => { ... }

// Preferred
private handleChange = (event: Event & { target: HTMLInputElement }): void => { ... }
```

#### 7. Global CSS Imports (Potential Leak)

| File                               | Import                     | Risk         |
| ---------------------------------- | -------------------------- | ------------ |
| `progressView/frontend/index.ts:2` | `katex/dist/katex.min.css` | Global scope |
| `progressView/frontend/index.ts:5` | `../styles/index.css`      | Global scope |

Components may depend on global styles bleeding through instead of encapsulated styles.

#### 8. querySelector for State Reading

| File:Line                        | Usage                                        |
| -------------------------------- | -------------------------------------------- |
| `LogList.ts:268`                 | `querySelector('#group-content-${groupId}')` |
| `TaskGroupDomManager.ts:201-212` | Multiple querySelector calls                 |
| `MainApp.ts:623-641`             | querySelector for Sortable init              |

**Should use `@query` decorator** with `updateComplete` awaited.

### Low Priority Issues

#### 9. Duplicate Animation Definitions

- `StreamHeader.ts:261-271` duplicates `pulse-scale` from shared `animationStyles`

#### 10. Hardcoded CSS Values

| File                      | Value               | Should Be |
| ------------------------- | ------------------- | --------- |
| `InstructionPanel.ts:79`  | `max-height: 12rem` | Token     |
| `FollowUpInput.ts:60, 66` | `min-height: 106px` | Token     |

#### 11. Record<string, unknown> Overuse

State interfaces extend `Record<string, unknown>` which is too permissive:

```typescript
// Anti-pattern
interface ProgressViewPreferences extends Record<string, unknown> { ... }

// Preferred
interface ProgressViewPreferences {
  expandedTaskGroups: boolean;
  // ... explicit fields only
}
```

### Well-Implemented Patterns (No Action Needed)

| Aspect                        | Status              | Notes                                              |
| ----------------------------- | ------------------- | -------------------------------------------------- |
| **Lifecycle cleanup**         | ✅ Excellent        | All listeners removed in `disconnectedCallback()`  |
| **Custom event factories**    | ✅ Consistent       | `bubbles: true, composed: true` everywhere         |
| **@property/@state usage**    | ✅ Correct          | Proper separation of concerns                      |
| **Computed property caching** | ✅ Excellent        | `willUpdate()` with reference tracking             |
| **Lit directives**            | ✅ Good             | `repeat()`, `classMap()`, `when()`, `nothing` used |
| **Zod schema validation**     | ✅ (except MainApp) | All validated views use `safeParse()`              |
| **ReactiveController**        | ✅ Proper           | `RecordingButtonController` correctly implemented  |
| **WebviewStateManager**       | ✅ Consistent       | Used across all views for persistence              |
| **Immutable state updates**   | ✅ Correct          | Proper spread patterns throughout                  |

---

## Recommended Fix Order

### Week 1: Quick Wins

1. **Define missing CSS tokens** in `litStyles.ts` (~15 min)
2. **Convert `themeHandlers.js`** → TypeScript (~15 min)
3. **Add TTL to `pendingLogUpdates`** Map (~30 min)
4. **Delete duplicate `pulse-scale`** animation (~5 min)

### Week 2: Event Handler Refactoring

1. **Extract inline arrows** to class methods in MainApp.ts (37 functions)
2. **Add proper event types** (Event → InputEvent, ChangeEvent, etc.)
3. **Replace querySelector** with @query decorators where possible

### Week 3: Architectural Improvements

1. **Add request/response correlation** for GET\_\* commands
2. **Refactor LogList/TaskGroupDomManager** streaming architecture
3. **Migrate ProgressApp/LogList** to Shadow DOM (blocked by formatters)

---

## References

- [Lit Documentation](https://lit.dev/)
- [Lit Reactive Controllers](https://lit.dev/docs/composition/controllers/)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [GitLens](https://github.com/gitkraken/vscode-gitlens) - Production Lit webviews in VS Code
- [Zod Documentation](https://zod.dev/)
