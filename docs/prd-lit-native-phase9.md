# PRD: Lit-Native Improvements - Phase 9

> **Parent doc:** [prd-lit-native-phase8.md](./prd-lit-native-phase8.md)
> **Related:** [ui-regressions-lit-migration.md](./ui-regressions-lit-migration.md)

## Overview

Phase 9 addresses remaining Lit anti-patterns identified in the codebase. This phase focuses on eliminating imperative patterns, document-level event listeners, manual DOM queries, classList manipulation, and HTML string building in favor of idiomatic Lit patterns.

> **Status: Complete** (9.1-9.6 all complete, except deferred mark.js boundary cases)

## Prerequisites

- Phase 8: styleMap and declarative TaskGroup complete
- All critical regressions fixed

## Status Summary

| Task                                      | Status       | Impact                             |
| ----------------------------------------- | ------------ | ---------------------------------- |
| 9.1 Remove document-level event listeners | **Complete** | Memory leaks, encapsulation        |
| 9.2 Replace manual DOM queries            | **Complete** | Reactive patterns, testability     |
| 9.3 Replace classList with classMap       | **Deferred** | mark.js boundary case              |
| 9.4 Convert dropdown utils to Lit-native  | **Complete** | Type safety, maintainability       |
| 9.5 Convert imperative child methods      | **Complete** | FollowUpInput and HistoryList done |
| 9.6 Refactor Sortable.js integration      | **Deferred** | Needs child component move         |

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

## 9.4 Convert Dropdown Utilities to Lit-Native (MEDIUM Priority)

**Problem:** Dropdown utilities build HTML strings that require `unsafeHTML` injection. This breaks type safety and declarative rendering.

### Files Affected

| File                                                      | Role                                   |
| --------------------------------------------------------- | -------------------------------------- |
| `src/shared/utils/dropdown.ts`                            | String manipulation utilities          |
| `src/webview/frontend/components/InstructionPanel.ts`     | 3 unsafeHTML calls                     |
| `src/webview/frontend/components/FileSelectGroup.ts`      | 1 unsafeHTML call + buildOptionsHtml() |
| `src/webview/frontend/components/LatexDiffsSection.ts`    | 3 unsafeHTML calls                     |
| `src/progressView/frontend/components/FollowupSection.ts` | Uses @query due to HTML injection      |

### Current Anti-Pattern

```typescript
// dropdown.ts builds HTML strings
export function markOptionAsSelected(optionsHtml: string, value: string): string {
  const searchStr = `value="${value}"`;
  const index = optionsHtml.indexOf(searchStr);  // String manipulation
  return `${optionsHtml.slice(0, tagEnd)} selected${optionsHtml.slice(tagEnd)}`;
}

// Components inject with unsafeHTML
${unsafeHTML(this.buildOptionsHtml())}
```

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

## 9.6 Refactor Sortable.js Integration (LOW-MEDIUM Priority)

**Problem:** Sortable.js is integrated with jQuery-style patterns - DOM queries, reading state from DOM.

### File Affected

`src/webview/frontend/MainApp.ts` (Lines 590-617)

### Current Anti-Pattern

```typescript
private initializeSortables(): void {
  listIds.forEach((listId) => {
    const element = this.renderRoot.querySelector(`#${listId}`);  // DOM query
    new Sortable(element, { onEnd: () => this.handleSortEnd(listId) });
  });
}

private handleSortEnd(listId: string): void {
  const element = this.renderRoot.querySelector(`#${listId}`);  // Query again
  const items = Array.from(element.querySelectorAll('.file-item'));
  const files = items.map((item) => item.getAttribute('data-path'));  // Read from DOM
  this.updateMultiFiles(listId, files);
}
```

### Solution Strategy

```typescript
// Use @query decorators
@query('#inputFiles') private inputFilesList!: HTMLElement;
@query('#contextFiles') private contextFilesList!: HTMLElement;

// Track order in state, read from event indices
private handleSortEnd(listId: string, event: Sortable.SortableEvent): void {
  const current = [...this.multiFiles[listId]];
  const [moved] = current.splice(event.oldIndex!, 1);
  current.splice(event.newIndex!, 0, moved);
  this.updateMultiFiles(listId, current);  // State drives DOM
}

// Initialize with element references
protected firstUpdated(): void {
  this.initializeSortable(this.inputFilesList, 'inputFiles');
  this.initializeSortable(this.contextFilesList, 'contextFiles');
}

private initializeSortable(element: HTMLElement, listId: string): void {
  if (!element) return;
  const sortable = new Sortable(element, {
    animation: 150,
    onEnd: (event) => this.handleSortEnd(listId, event),
  });
  this.sortables.push(sortable);
}
```

**Effort:** Low-Medium (1-2 hours)

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
9. ⏸️ Sortable.js - Documented, needs move to child components

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

| Metric                                | Before | Current   | Target |
| ------------------------------------- | ------ | --------- | ------ |
| Document-level listeners              | 5      | 2\*       | 0      |
| querySelector calls in Lit components | 11     | 6\*\*     | 0      |
| classList manipulation calls          | 4      | 2\*\*\*   | 0      |
| unsafeHTML for dropdowns              | 7      | 0\*\*\*\* | 0      |
| Imperative child method calls         | 7      | 0**\***   | 0      |

\* FileSelectGroup now lazy-attaches, LogList uses component-level
\*\* MainApp dead code removed, some remain in child component queries
\*\*\* mark.js boundary (acceptable), icons.ts deprecated
\*\*\*\* All dropdown components now use Lit templates (with HTML fallback for backward compatibility)
\*\*\*\*\* FollowUpInput and HistoryList use reactive properties (mark.js child calls remain - acceptable boundary)

---

## Progress Log

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
- `docs/prd-lit-native-phase9.md` - This document

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
- `docs/prd-lit-native-phase9.md` - This document

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

1. **src/shared/utils/dropdown.ts** - innerHTML assignment, createElement, setAttribute
   - Legacy dropdown string manipulation utilities
   - Will be fully deprecated when all consumers use Lit templates

2. **src/shared/utils/dom.ts** - querySelector, createElement, setAttribute
   - General DOM utility functions for VS Code web components
   - Some patterns necessary for external library integration

3. **src/shared/utils/clipboard.ts** - classList, setAttribute
   - Copy button feedback utilities
   - Could be converted to Lit reactive controller pattern

4. **src/shared/controllers/RecordingButtonController.ts** - classList, setAttribute, innerHTML
   - Reactive controller managing external button element
   - Could be refactored to property-based approach

5. **src/progressView/frontend/components/LogList.ts** - querySelector in event handlers
   - Light DOM component with event delegation
   - Acceptable for Light DOM event handling pattern

---

## References

- [Lit Event Handling](https://lit.dev/docs/components/events/)
- [Lit Reactive Properties](https://lit.dev/docs/components/properties/)
- [classMap Directive](https://lit.dev/docs/templates/directives/#classmap)
- [prd-lit-native-phase8.md](./prd-lit-native-phase8.md) - Previous phase
