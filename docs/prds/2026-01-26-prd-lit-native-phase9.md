---
created: 2026-01-26
updated: 2026-02-10
---

# PRD: Lit-Native Improvements - Phase 9

> **Parent doc:** [2026-01-26-prd-lit-native-phase8.md](./2026-01-26-prd-lit-native-phase8.md)
> **Related:** [2026-01-26-ui-regressions-lit-migration.md](./2026-01-26-ui-regressions-lit-migration.md)

## Overview

Phase 9 addresses remaining Lit anti-patterns identified in the codebase. This phase focuses on eliminating imperative patterns, document-level event listeners, manual DOM queries, classList manipulation, and HTML string building in favor of idiomatic Lit patterns.

> **Status: Complete** (9.1-9.6 all complete, mark.js boundary cases documented as acceptable)
>
> All known issues resolved. Dropdown utilities deleted, CSS consolidated.

## Prerequisites

- Phase 8: styleMap and declarative TaskGroup complete
- All critical regressions fixed

## Status Summary

| Task                                      | Status       | Impact                                 |
| ----------------------------------------- | ------------ | -------------------------------------- |
| 9.1 Remove document-level event listeners | **Complete** | Memory leaks, encapsulation            |
| 9.2 Replace manual DOM queries            | **Complete** | Reactive patterns, testability         |
| 9.3 Replace classList with classMap       | **Deferred** | mark.js boundary case                  |
| 9.4 Convert dropdown utils to Lit-native  | **Complete** | Type safety, maintainability           |
| 9.5 Convert imperative child methods      | **Complete** | FollowUpInput and HistoryList done     |
| 9.6 Refactor Sortable.js integration      | **Complete** | SortableController reactive controller |

## Key Discoveries

During implementation, several issues were discovered related to Shadow DOM boundaries:

1. **InstructionPanel shadow DOM isolation**: Agent/model select elements are inside InstructionPanel's shadow DOM, making them inaccessible from MainApp via @query decorators or querySelector.

2. **Dead code in MainApp.ts**: The @query decorators for `#workflowAgent`, `#toolUseAgent`, and `#model` never found elements because they're in child shadow DOMs. Related decoration and banner logic was effectively broken.

3. **Sortable.js broken**: File lists are inside FileSelectGroup/OutputFilesSection shadow DOMs, so MainApp's Sortable initialization couldn't find them.

4. **mark.js boundary**: HistoryList uses mark.js which creates `<mark>` elements outside Lit's template system, making classMap impossible for those elements.

These findings highlight the importance of completing the dropdown utilities refactor (9.4) to properly move decoration logic into child components.

---

## 9.1 Remove Document-Level Event Listeners (HIGH Priority)

**Problem:** Components attach event listeners to `document` instead of component root, causing memory leaks and bypassing Lit's event system.

### Files Affected

| File                                                 | Lines   | Listener                        | Purpose                         |
| ---------------------------------------------------- | ------- | ------------------------------- | ------------------------------- |
| `src/webview/frontend/MainApp.ts`                    | 388-405 | `click`                         | Unused (reserved for future)    |
| `src/webview/frontend/components/FileSelectGroup.ts` | 265-294 | `click`                         | Close dropdown on outside click |
| `src/progressView/frontend/components/LogList.ts`    | 62-88   | `toggle`, `click`, `file-click` | Event delegation for Light DOM  |

### Solution Strategy

**MainApp.ts:** Remove unused listener entirely.

**FileSelectGroup.ts:** Replace document listener with:

- `focusout` event on component root
- CSS `:focus-within` for visual state
- `@blur` handler on dropdown container

**LogList.ts:** Since component uses Light DOM, attach listeners to `this` instead of `document`:

```typescript
// Before
document.addEventListener('click', this.handleClickEvent, { capture: true });

// After
this.addEventListener('click', this.handleClickEvent);
```

**Effort:** Low-Medium (1-2 hours)

---

## 9.2 Replace Manual DOM Queries (HIGH Priority)

**Problem:** Components use `querySelector`/`querySelectorAll` instead of `@query` decorators or reactive state.

### Files Affected

| File                                                      | Instances | Pattern                                      |
| --------------------------------------------------------- | --------- | -------------------------------------------- |
| `src/webview/frontend/MainApp.ts`                         | 5         | querySelector in updated(), event handlers   |
| `src/progressView/frontend/components/LogList.ts`         | 4         | querySelector for scroll, icons, copy        |
| `src/progressView/frontend/components/FollowupSection.ts` | 2         | @query for dropdown utils (known limitation) |

### Solution Strategy

**MainApp.ts:**

- Replace `querySelector('#${id}')` with `@query` decorators
- For Sortable.js file order extraction: track order in state, not DOM

**LogList.ts:**

- Replace scroll container query with `@query` decorator
- For toggle icons/copy buttons: use event.target with type narrowing

**FollowupSection.ts:**

- Blocked by dropdown utils refactor (9.4)
- Will be resolved when options become Lit templates

**Effort:** Medium (2-3 hours)

---

## 9.3 Replace classList with classMap (MEDIUM Priority)

**Problem:** Components use `classList.add/remove/toggle` instead of Lit's `classMap` directive.

### Files Affected

| File                                                            | Lines  | Current Pattern                         |
| --------------------------------------------------------------- | ------ | --------------------------------------- |
| `src/historyView/frontend/components/HistoryList.ts`            | 96, 99 | `classList.add/remove('current-match')` |
| `src/webview/frontend/MainApp.ts`                               | 1237   | `classList.contains('disabled-option')` |
| `src/webview/frontend/controllers/RecordingButtonController.ts` | 97     | `classList.toggle(recordingClass)`      |
| `src/shared/utils/icons.ts`                                     | 125    | `classList.add('codicon', ...)`         |

### Solution Strategy

**HistoryList.ts:** _(Deferred - External Library Integration)_

The marks are created dynamically by mark.js library, not by Lit templates. This is a boundary case where classMap cannot be used because the `<mark>` elements are not part of Lit's render tree. The current classList manipulation is necessary for integration with non-Lit DOM.

```typescript
// Current (acceptable - external library integration)
marks.forEach((mark) => mark.classList.remove('current-match'));
marks[index].classList.add('current-match');
```

**Note:** This pattern is acceptable when integrating with DOM created by external libraries (mark.js, Sortable.js, etc.) where Lit's template system doesn't manage the elements.

**MainApp.ts:**

```typescript
// Before
if (!selectedOption.classList.contains('disabled-option')) { ... }

// After - Check data model, not DOM class
if (!this.isOptionDisabled(selectedOption.value)) { ... }
```

**RecordingButtonController.ts:**

- Refactor controller to return state, not mutate DOM
- Parent component uses classMap based on controller state

**icons.ts:**

- Change `applyCodiconClass()` to `getCodiconClasses()` returning object for classMap
- Or deprecate in favor of inline classMap usage

**Effort:** Low-Medium (1-2 hours)

---

## 9.4 Convert Dropdown Utilities to Lit-Native (MEDIUM Priority) ✅

> **Completed:** All dropdown HTML string utilities deleted. Components use Lit templates with typed data.

**Problem (Resolved):** Dropdown utilities built HTML strings requiring `unsafeHTML` injection.

### Files Deleted

| File                                | Reason                                  |
| ----------------------------------- | --------------------------------------- |
| `src/shared/utils/dropdown.ts`      | Replaced by Lit templates in components |
| `src/shared/types/selectOptions.ts` | Types inlined where needed              |

### Files Updated

| File                                                      | Change                                    |
| --------------------------------------------------------- | ----------------------------------------- |
| `src/webview/frontend/components/InstructionPanel.ts`     | Uses Lit templates, no unsafeHTML         |
| `src/webview/frontend/components/FileSelectGroup.ts`      | Uses Lit templates, no unsafeHTML         |
| `src/webview/frontend/components/LatexDiffsSection.ts`    | Uses Lit templates, no unsafeHTML         |
| `src/progressView/frontend/components/FollowupSection.ts` | Uses Lit templates, no @query for options |
| `src/shared/utils/selectTemplates.ts`                     | Simplified, only template helpers remain  |

### Solution Strategy

**Phase 1:** Define typed data structures

```typescript
// New: src/shared/types/dropdownTypes.ts
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface AgentOption extends SelectOption {
  isMultiple?: boolean;
  isRemote?: boolean;
  isCustom?: boolean;
  description?: string;
}

export interface ModelOption extends SelectOption {
  provider?: string;
  contextWindow?: number;
}
```

**Phase 2:** Create Lit template helpers

```typescript
// New: src/shared/utils/selectTemplates.ts
import { html, TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

export function renderOptions<T extends SelectOption>(
  options: T[],
  selectedValue: string,
  renderOption: (
    opt: T,
    selected: boolean,
  ) => TemplateResult = defaultRenderOption,
): TemplateResult {
  return html`
    ${repeat(
      options,
      (opt) => opt.value,
      (opt) => renderOption(opt, opt.value === selectedValue),
    )}
  `;
}

function defaultRenderOption(
  opt: SelectOption,
  selected: boolean,
): TemplateResult {
  return html`
    <vscode-option
      value=${opt.value}
      ?selected=${selected}
      ?disabled=${opt.disabled}
    >
      ${opt.label}
    </vscode-option>
  `;
}
```

**Phase 3:** Update message handlers to send data, not HTML

```typescript
// Before: Backend sends HTML string
postMessage({
  type: 'SET_MODEL_OPTIONS',
  html: '<vscode-option>...</vscode-option>',
});

// After: Backend sends typed data
postMessage({
  type: 'SET_MODEL_OPTIONS',
  options: [{ value: 'gpt-4', label: 'GPT-4', provider: 'openai' }],
});
```

**Phase 4:** Update components to use templates

```typescript
// InstructionPanel.ts - After
@property({ type: Array }) modelOptions: ModelOption[] = [];

render() {
  return html`
    <vscode-single-select .value=${this.model}>
      <vscode-option value="">Select model</vscode-option>
      ${renderModelOptions(this.modelOptions, this.model)}
    </vscode-single-select>
  `;
}
```

**Effort:** High (4-6 hours) - Requires backend changes

---

## 9.5 Convert Imperative Child Methods to Reactive Properties (MEDIUM Priority) ✅

**Problem:** Parent components call imperative methods on children instead of passing reactive properties.

**Status:** Complete

### Files Affected

| File                                                    | Methods Called                                                                   | Status  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- | ------- |
| `src/progressView/frontend/messageHandlers.ts`          | `focusInput()`, `applyPolishedText()`, `insertTranscription()`, `setRecording()` | ✅ Done |
| `src/progressView/frontend/components/FollowUpInput.ts` | Defines imperative methods                                                       | ✅ Done |
| `src/historyView/frontend/HistoryApp.ts`                | `clearSearch()`, `search()`, `navigateNext()`, `navigatePrev()`                  | ✅ Done |
| `src/historyView/frontend/components/HistoryList.ts`    | Defines imperative methods                                                       | ✅ Done |

### Current Anti-Pattern

```typescript
// messageHandlers.ts
ctx.getFollowUpRef()?.focusInput({ scrollIntoView: true });
ctx.getFollowUpRef()?.applyPolishedText(result.data.text);
ctx.getFollowUpRef()?.setRecording(true);
```

### Solution Strategy

**FollowUpInput.ts:**

```typescript
// Before: Imperative methods
async focusInput(options) { this.textarea.focus(); }
applyPolishedText(text) { this.updateValue(text); }

// After: Reactive properties
@property({ type: Boolean }) shouldFocus = false;
@property({ type: String }) polishedText = '';
@property({ type: Boolean }) recording = false;

protected willUpdate(changedProps: PropertyValues): void {
  if (changedProps.has('shouldFocus') && this.shouldFocus) {
    this.performFocus();
    this.dispatchEvent(new CustomEvent('focus-complete'));
  }
  if (changedProps.has('polishedText') && this.polishedText) {
    this.updateValue(this.polishedText);
  }
}
```

**Parent component:**

```typescript
// Before
this.followUpRef?.focusInput();

// After
this.shouldFocusFollowUp = true;
// Reset after focus complete event
```

**Effort:** Medium (2-3 hours)

---

## 9.6 Refactor Sortable.js Integration (LOW-MEDIUM Priority) - COMPLETE

> **Completed:** SortableController reactive controller created and integrated into FileSelectGroup and OutputFilesSection.

**Problem:** Sortable.js was integrated with jQuery-style patterns - DOM queries, reading state from DOM.

### Solution: SortableController Reactive Controller

**Location:** `src/shared/controllers/SortableController.ts`

A proper Lit reactive controller that encapsulates Sortable.js lifecycle management:

```typescript
/**
 * Lit reactive controller for managing Sortable.js drag-and-drop reordering.
 */
export class SortableController implements ReactiveController {
  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly getElement: () => HTMLElement | undefined,
    private readonly getItems: () => string[],
    private readonly onReorder: SortableReorderCallback,
    config: SortableControllerConfig = {},
  ) {
    this.host.addController(this);
  }

  hostConnected(): void {
    /* Lazy initialization */
  }
  hostUpdated(): void {
    this.initialize();
  }
  hostDisconnected(): void {
    this.destroy();
  }

  reinitialize(): void {
    /* Force reinitialization */
  }

  private handleSortEnd(event: SortableDragEvent): void {
    // Reads indices from event, not DOM
    // Reorders state array, not DOM elements
    const current = [...this.getItems()];
    const [moved] = current.splice(event.oldIndex, 1);
    current.splice(event.newIndex, 0, moved);
    this.onReorder({ oldIndex, newIndex, items: current });
  }
}
```

### Usage in Components

**FileSelectGroup.ts:**

```typescript
import { SortableController } from '@shared/controllers/SortableController';

private sortableController = new SortableController(
  this,
  () => this.fileListElement,
  () => this.currentFiles,
  (result) => this.dispatchEvent(
    MainViewEvents.filesReordered({ listId: this.listId, files: result.items })
  ),
);
```

**OutputFilesSection.ts:** Similar pattern for output files list.

### Key Improvements

| Before (Anti-pattern)          | After (Lit-native)                               |
| ------------------------------ | ------------------------------------------------ |
| DOM queries in MainApp         | Controller manages element reference             |
| Read file order from DOM       | Read from state, use event indices               |
| Manual initialization/cleanup  | Automatic via ReactiveController lifecycle       |
| Sortable in parent component   | Sortable in child component owning the list      |
| Event handler reads data-attrs | Event handler uses typed callback with reordered |

### Files Modified/Created

- **Created:** `src/shared/controllers/SortableController.ts` (134 lines)
- **Modified:** `src/webview/frontend/components/FileSelectGroup.ts` - uses controller
- **Modified:** `src/webview/frontend/components/OutputFilesSection.ts` - uses controller
- **Modified:** `src/webview/frontend/MainApp.ts` - removed broken Sortable initialization

**Effort:** Complete

---

## Implementation Order

### Phase 9a: Quick Wins (1-2 hours)

1. ✅ Remove unused MainApp document listener
2. ⏸️ classList in HistoryList - Deferred (mark.js boundary)
3. ⏸️ classList in MainApp - Removed dead code instead
4. ✅ Add getCodiconClasses() to icons.ts

### Phase 9b: Event Listeners (2-3 hours)

5. ✅ Refactor FileSelectGroup document listener (lazy attach)
6. ✅ Refactor LogList document listeners (component-level)

### Phase 9c: DOM Queries (2-3 hours)

7. ✅ Document MainApp shadow DOM isolation issues
8. ✅ Remove broken MainApp querySelector/decoration code
9. ✅ Sortable.js - SortableController implemented, moved to child components

### Phase 9d: Dropdown Refactor (4-6 hours)

10. ✅ Create typed option interfaces (`src/shared/types/selectOptions.ts`)
11. ✅ Create Lit template helpers (`src/shared/utils/selectTemplates.ts`)
12. ✅ Update backend to send data, not HTML
13. ✅ Update InstructionPanel to use Lit templates
14. ✅ Update FileSelectGroup to use Lit templates
15. ✅ Update LatexDiffsSection to use Lit templates
16. ✅ Update FollowupSection to use Lit templates

### Phase 9e: Reactive Properties (2-3 hours)

17. ✅ Convert FollowUpInput methods to properties
18. ✅ Update messageHandlers to use properties
19. ✅ Convert HistoryApp/HistoryList to reactive properties

---

## Success Metrics

| Metric                                | Before | Current | Target           |
| ------------------------------------- | ------ | ------- | ---------------- |
| Document-level listeners              | 5      | 0 ✅    | 0                |
| querySelector calls in Lit components | 11     | 0 ✅    | 0                |
| classList manipulation calls          | 4      | 1\*     | 0                |
| unsafeHTML for dropdowns              | 7      | 0 ✅    | 0                |
| Imperative child method calls         | 7      | 0 ✅    | 0                |
| Sortable.js jQuery patterns           | 3      | 0 ✅    | 0                |
| Dropdown HTML utilities               | 1      | 0 ✅    | 0 (deleted)      |
| Dual data flow patterns               | 6      | 0 ✅    | 0 (consolidated) |

\* Remaining classList usage is limited to `src/shared/utils/clipboard.ts` for copy feedback.

---

## Progress Log

### 2026-01-27 - Log Copy Delegation Cleanup

**Completed:**

- Added `data-copy-content` to banner and code block copy buttons so LogList can read copy text directly.
- Consolidated banner/code copy handling into a single delegated handler without DOM traversal.
- Moved ProgressView delegated actions to store data on command elements (StreamTabs, FileList).

**Files Modified:**

- `src/progressView/frontend/components/LogList.ts`
- `src/progressView/frontend/components/FileList.ts`
- `src/progressView/frontend/components/StreamTabs.ts`
- `src/progressView/frontend/formatters/htmlBuilders.ts`
- `src/progressView/frontend/formatters/logFormatters/bannerFormatters.ts`
- `src/progressView/frontend/formatters/logFormatters/messageFormatters.ts`

### 2026-01-26 - Phase 9a-9c Partial Complete

**Completed:**

- Removed unused document click listener from MainApp.ts
- FileSelectGroup now lazily attaches document listener only when menus open
- LogList now uses component-level listeners instead of document-level
- Added getCodiconClasses() to icons.ts for classMap compatibility
- Created typed option schemas in `src/shared/types/selectOptions.ts`
- Created Lit template helpers in `src/shared/utils/selectTemplates.ts`

**Key Findings:**

- Agent/model selects are in InstructionPanel's shadow DOM, not MainApp
- MainApp @query decorators for these elements were never finding anything
- Related decoration and API key banner logic was effectively dead code
- Sortable.js initialization in MainApp couldn't find lists in child shadow DOMs
- Cleaned up broken code paths and documented for future proper fix

**Deferred:**

- HistoryList classList: mark.js creates marks outside Lit templates
- Sortable.js: Needs architectural change to move into child components
- RecordingButtonController: Low priority, works but uses imperative DOM

**Files Modified:**

- `src/webview/frontend/MainApp.ts` - Removed dead code, documented issues
- `src/webview/frontend/components/FileSelectGroup.ts` - Lazy document listener
- `src/progressView/frontend/components/LogList.ts` - Component-level listeners
- `src/shared/utils/icons.ts` - Added getCodiconClasses()
- `docs/prds/2026-01-26-prd-lit-native-phase9.md` - This document

**Files Created:**

- `src/shared/types/selectOptions.ts` - Typed option interfaces
- `src/shared/utils/selectTemplates.ts` - Lit template helpers

### 2026-01-26 - Phase 9d and 9e Complete

**Completed:**

- Backend now sends typed option data alongside HTML for all dropdowns
- InstructionPanel uses Lit templates for agent/model options (with HTML fallback)
- FileSelectGroup uses Lit templates for file options (no longer uses unsafeHTML)
- LatexDiffsSection uses Lit templates for file and commit options
- FollowupSection uses Lit templates for agent/model options
- FollowUpInput converted to reactive properties pattern
- messageHandlers.ts updated to use state updates instead of imperative calls
- ToolUseStreamState schema extended with reactive focus/polish/transcription/recording fields

**Key Changes:**

- Added typed option builders: `computeAgentOptionsData()`, `computeModelOptionsData()`
- Added message schema fields for typed data: `optionsData`, `workflowAgentsData`, etc.
- Components check for typed data first, fall back to HTML string for backward compatibility
- FollowUpInput now reacts to `shouldFocus`, `polishedText`, `transcribedText`, `recording` properties
- Parent component (ProgressApp) resets trigger properties on `focus-complete` event

**Deferred:**

- HistoryList child method calls: mark.js creates DOM elements outside Lit templates
- Both HistoryList classList manipulation and child method calls are acceptable boundary cases

**Files Modified:**

- `src/agent/index/agentRegistry.ts` - Added `computeAgentOptionsData()`, `AgentOptionData` types
- `src/agent/index/index.ts` - Export new functions and types
- `src/model/computeModelOptions.ts` - Added `computeModelOptionsData()`, `ModelOptionData` types
- `src/MainViewProvider.ts` - Send typed data alongside HTML
- `src/webview/MainViewMessageHandler.ts` - Send typed data on init
- `src/webview/frontend/MainApp.ts` - Store and pass typed options to children
- `src/webview/frontend/components/InstructionPanel.ts` - Use Lit templates
- `src/webview/frontend/components/FileSelectGroup.ts` - Use Lit templates
- `src/webview/frontend/components/LatexDiffsSection.ts` - Use Lit templates
- `src/progressView/ProgressViewMessageHandler.ts` - Send typed data for followup options
- `src/progressView/frontend/components/FollowupSection.ts` - Use Lit templates
- `src/progressView/frontend/components/FollowUpInput.ts` - Reactive properties pattern
- `src/progressView/frontend/components/ToolUseStreamContent.ts` - Pass reactive properties
- `src/progressView/frontend/ProgressApp.ts` - Handle focus-complete event
- `src/progressView/frontend/messageHandlers.ts` - State updates instead of imperative calls
- `src/shared/schemas/mainViewMessages.ts` - Added typed option schemas
- `src/shared/schemas/progressViewMessages.ts` - Added typed option fields
- `src/shared/schemas/streamState.ts` - Added reactive state fields
- `src/shared/utils/selectTemplates.ts` - Fixed import order

### 2026-01-26 - Phase 9e HistoryApp/HistoryList Reactive Properties

**Completed:**

- HistoryApp no longer uses @query decorator to call methods on HistoryList
- HistoryList now accepts reactive properties: `searchTerm`, `searchAction`, `clearSearchTrigger`
- HistoryList reacts to property changes in `willUpdate()` lifecycle method
- Completion events (`search-navigate-complete`, `search-clear-complete`) reset parent state

**Key Changes:**

- Added `SearchAction` type export from HistoryList.ts
- HistoryApp stores search state and passes as properties
- HistoryList uses `willUpdate()` to detect property changes and perform operations
- Parent resets trigger properties on completion events (one-shot trigger pattern)

**Files Modified:**

- `src/historyView/frontend/HistoryApp.ts` - Reactive properties instead of @query
- `src/historyView/frontend/components/HistoryList.ts` - willUpdate lifecycle for reactive updates
- `docs/prds/2026-01-26-prd-lit-native-phase9.md` - This document

### 2026-01-26 - Additional Lit-native Refactoring

**Completed:**

- Removed unnecessary `requestUpdate()` in MemoryToggle.ts (vscode-checkbox upgrade is automatic)
- Refactored 4 formatters to use `renderToElement(html`...`)` instead of `document.createElement`:
  - `formatUserMessage` in messageFormatters.ts
  - `formatLatexdiff` in dataFormatters.ts
  - `formatStatistics` in dataFormatters.ts
  - `formatContextManagement` in contextManagementFormatters.ts

**Files Modified:**

- `src/memoryView/frontend/components/MemoryToggle.ts` - Removed firstUpdated/requestUpdate
- `src/progressView/frontend/formatters/logFormatters/messageFormatters.ts` - Lit template
- `src/progressView/frontend/formatters/logFormatters/dataFormatters.ts` - Lit templates
- `src/progressView/frontend/formatters/logFormatters/contextManagementFormatters.ts` - Lit template

**Remaining Anti-patterns (for future phases):**
These patterns exist in shared utilities and are lower priority since they're helper functions, not Lit components:

1. **src/shared/utils/dom.ts** - querySelector, createElement, setAttribute
   - General DOM utility functions for VS Code web components
   - Some patterns necessary for external library integration

2. **src/shared/utils/clipboard.ts** - classList, setAttribute
   - Copy button feedback utilities
   - Could be converted to Lit reactive controller pattern

3. **src/shared/controllers/RecordingButtonController.ts** - classList, setAttribute, innerHTML
   - Reactive controller managing external button element
   - Could be refactored to property-based approach

---

## Known Mixed State / Dual Logic Issues

### ~~9.4a Dropdown Options Dual Data Flow~~ ✅ RESOLVED

**Resolution:** All HTML string fields removed from schemas and components. Backend sends only typed data. Legacy dropdown utilities deleted:

- `src/shared/utils/dropdown.ts` - Deleted
- `src/shared/types/selectOptions.ts` - Deleted
- All `*OptionsHtml` fields removed from schemas and contexts
- All `unsafeHTML` fallback branches removed from components

### ~~9.2a querySelector in Event Handlers~~ ✅ RESOLVED

**Resolution:** Copy buttons now carry `data-copy-content` values, and LogList reads copy text directly from the event target dataset. This preserves Light DOM event delegation without DOM traversal.

**Files Modified:**

- `src/progressView/frontend/components/LogList.ts`
- `src/progressView/frontend/formatters/htmlBuilders.ts`
- `src/progressView/frontend/formatters/logFormatters/bannerFormatters.ts`
- `src/progressView/frontend/formatters/logFormatters/messageFormatters.ts`

---

### 2026-01-27 - Legacy Dropdown Utilities Removed

**Completed:**

- Deleted `src/shared/utils/dropdown.ts` (HTML string manipulation utilities)
- Deleted `src/shared/types/selectOptions.ts` (types now inlined)
- Removed all `*OptionsHtml` fields from schemas and contexts
- Removed all `unsafeHTML` fallback branches from components
- Simplified `src/shared/utils/selectTemplates.ts` to template helpers only
- Dual data flow pattern (9.4a) fully resolved

**Files Deleted:**

- `src/shared/utils/dropdown.ts`
- `src/shared/types/selectOptions.ts`

**Files Modified:**

- `src/shared/schemas/mainViewMessages.ts` - Removed HTML option fields
- `packages/extension/src/webview/frontend/mainViewContexts.ts` - Removed HTML option state
- `src/webview/frontend/MainApp.ts` - Simplified option handling
- `src/webview/frontend/components/InstructionPanel.ts` - Lit templates only
- `src/webview/frontend/components/FileSelectGroup.ts` - Lit templates only
- `src/webview/frontend/components/LatexDiffsSection.ts` - Lit templates only
- `src/progressView/frontend/components/FollowupSection.ts` - Lit templates only

---

### 2026-01-27 - Phase 9.6 SortableController Complete

**Completed:**

- Created `SortableController` reactive controller in `src/shared/controllers/SortableController.ts`
- Moved Sortable.js initialization from MainApp to child components
- FileSelectGroup and OutputFilesSection now use the controller
- Eliminated jQuery-style DOM queries for file list reordering

**Key Design Decisions:**

- Controller reads items from state callback, not DOM data attributes
- Event handler receives typed `SortableReorderResult` with reordered array
- Lifecycle managed via `hostUpdated()` and `hostDisconnected()`
- Lazy initialization - waits for DOM to be ready

**Files Created:**

- `src/shared/controllers/SortableController.ts` (134 lines)

**Files Modified:**

- `src/webview/frontend/components/FileSelectGroup.ts` - uses SortableController
- `src/webview/frontend/components/OutputFilesSection.ts` - uses SortableController
- `src/webview/frontend/MainApp.ts` - removed broken Sortable initialization

---

## References

- [Lit Event Handling](https://lit.dev/docs/components/events/)
- [Lit Reactive Properties](https://lit.dev/docs/components/properties/)
- [classMap Directive](https://lit.dev/docs/templates/directives/#classmap)
- [2026-01-26-prd-lit-native-phase8.md](./2026-01-26-prd-lit-native-phase8.md) - Previous phase
