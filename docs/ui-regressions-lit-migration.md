# UI Regressions from Lit Migration

This document catalogs UI regressions introduced when CSS files were deleted during the Lit component migration. The main issue is that **Shadow DOM components don't inherit Light DOM styles from `styles.ts`**, so styles must be explicitly included in each component.

**Migration Approach**: All fixes should use Lit-native inline styles (`static styles = css\`...\``) rather than external CSS files.

## Critical Regressions

### 1. InstructionPanel - Agent/Model Dropdown Width (HIGH IMPACT)

**Location**: `src/webview/frontend/components/InstructionPanel.ts`

**Problem**: Agent and model selection dropdowns have no width constraints, causing them to shrink/expand unpredictably.

**Deleted CSS** (`footer.css`):

```css
.agent-select-controls,
.agent-select-dropdowns {
  min-width: 10rem;
  max-width: 14rem;
}

.model-selection-footer .select-group select,
.model-selection-footer .select-group vscode-single-select {
  min-width: 6rem;
  max-width: 10rem;
}
```

**Current (broken)**:

```css
.agent-select-controls {
  flex: 1;
  min-width: 0; /* ← No width constraints */
}

.agent-select-dropdowns {
  position: relative;
  width: 100%; /* ← No min/max width */
}
```

**Fix**: Add width constraints to InstructionPanel.ts static styles.

---

### 2. InstructionPanel - Codicon Hover Color (MEDIUM IMPACT)

**Problem**: Clickable codicons don't change color on hover.

**Deleted CSS** (`base.css`):

```css
.codicon.clickable:hover {
  color: var(--button-hover-background);
}
```

**Current (broken)**:

```css
.clickable:hover {
  color: var(--vscode-foreground); /* ← Different color */
}
```

**Fix**: Add `.codicon.clickable:hover` rule with correct color.

---

### 3. vscode-option Styling in Shadow DOM (MEDIUM IMPACT)

**Location**: `src/webview/frontend/components/InstructionPanel.ts`

**Problem**: `vscode-option` styles in `styles.ts` don't pierce Shadow DOM boundary.

**Missing styles** (from `base.css`):

```css
vscode-option.disabled-option,
vscode-option.disabled-model,
vscode-option.disabled-agent,
vscode-option[data-requires-key='true'] {
  color: var(--color-text-secondary);
  opacity: var(--opacity-subtle);
  font-style: italic;
}

vscode-option {
  font-family: var(--vscode-font-family);
}

vscode-option[data-tool-use='true'] {
  font-style: italic;
}
```

**Fix**: Add vscode-option styles to InstructionPanel.ts static styles.

---

### 4. FileSelectGroup - Missing Optional Label Styles (MEDIUM IMPACT)

**Location**: `src/webview/frontend/components/FileSelectGroup.ts`

**Missing styles** (from `file-selection.css`):

```css
.optional-label {
  color: var(--text-color);
  font-weight: normal;
  font-size: var(--font-size);
  white-space: nowrap;
  min-width: calc(var(--width-button-min) * 2);
  display: flex;
  align-items: center;
  height: var(--height-control);
}

.file-select:has(.optional-label) {
  margin-bottom: var(--spacing-tiny);
}

.file-select[data-expanded='true'] .optional-label {
  color: var(--vscode-foreground);
}

.file-select-header > vscode-toolbar-button {
  opacity: 1;
  flex-shrink: 0;
}

.file-select-label-group vscode-textfield {
  flex: 1;
  min-width: 0;
  margin: 0;
}
```

---

### 5. HistoryView - Search and Config Styling (MEDIUM IMPACT)

**Location**: `src/historyView/frontend/styles.ts`

**Missing/Changed styles** (from `historyView/styles/index.css`):

| Class               | Issue                                                    |
| ------------------- | -------------------------------------------------------- |
| `.search-nav-btn`   | Missing `min-width`, `height`, `padding: 0`, `font-size` |
| `.search-input`     | Missing `padding: var(--spacing-medium)`, `font-size`    |
| `.search-container` | Spacing reduced (gap/margin-bottom)                      |
| `.history-details`  | Grid changed from `100px 1fr` to `max-content 1fr`       |
| `.config-key`       | min-width reduced from ~152px to 80px                    |
| `.config-section`   | Background changed (lost visual distinction)             |

---

### 6. ProgressView - Missing Light DOM Styles (HIGH IMPACT)

**Location**: Dynamic HTML in `src/progressView/frontend/formatters/`

**Problem**: These classes are used in dynamically-generated HTML but not defined anywhere:

```css
/* MISSING - used in dataFormatters.ts */
.file-list-content {
  /* styles needed */
}
.file-list-details {
  /* styles needed */
}
.xml-link-container {
  /* styles needed */
}
.document-tag {
  /* styles needed */
}

/* PARTIALLY DEFINED - only scoped to .latexdiff-content in latexdiff.css */
.detail-item {
  /* needs global scope */
}
.file-link {
  /* needs global scope */
}
```

**Affected files**:

- `src/progressView/frontend/formatters/logFormatters/dataFormatters.ts`
- `src/progressView/frontend/formatters/logFormatters/toolFormatters.ts`

---

## Summary of Missing CSS by Component

### InstructionPanel.ts (add to static styles)

```css
/* Agent/Model dropdown width constraints */
.agent-select-controls,
.agent-select-dropdowns {
  min-width: 10rem;
  max-width: 14rem;
}

.select-group vscode-single-select {
  min-width: 6rem;
  max-width: 10rem;
}

/* Codicon spacing and hover */
.select-group .codicon {
  margin-right: var(--spacing-small);
  color: var(--text-color);
  vertical-align: text-bottom;
}

.codicon.clickable:hover {
  color: var(--button-hover-background);
}

/* vscode-option styling */
vscode-option.disabled-option,
vscode-option.disabled-model,
vscode-option.disabled-agent,
vscode-option[data-requires-key='true'] {
  color: var(--color-text-secondary);
  opacity: var(--opacity-subtle);
  font-style: italic;
}

vscode-option {
  font-family: var(--vscode-font-family);
}

vscode-option[data-tool-use='true'] {
  font-style: italic;
}
```

### FileSelectGroup.ts (add to static styles)

```css
.optional-label {
  color: var(--text-color);
  font-weight: normal;
  font-size: var(--font-size);
  white-space: nowrap;
  min-width: calc(var(--width-button-min) * 2);
  display: flex;
  align-items: center;
  height: var(--height-control);
}

.file-select:has(.optional-label) {
  margin-bottom: var(--spacing-tiny);
}

.file-select[data-expanded='true'] .optional-label {
  color: var(--vscode-foreground);
}

.file-select-header > vscode-toolbar-button {
  opacity: 1;
  flex-shrink: 0;
}

.file-select-label-group vscode-textfield {
  flex: 1;
  min-width: 0;
  margin: 0;
}
```

### historyView/frontend/styles.ts (fix existing styles)

```css
.search-nav-btn {
  min-width: var(--height-button);
  height: var(--height-button);
  padding: 0;
  font-size: var(--font-size);
}

.search-input {
  flex: 1;
  padding: var(--spacing-medium);
  font-size: var(--font-size);
}

.search-container {
  display: flex;
  align-items: center;
  margin-bottom: var(--spacing-xlarge);
  gap: var(--spacing-medium);
  width: 100%;
}

.history-details {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: var(--spacing-small);
  margin-top: var(--spacing-medium);
}

.config-key {
  font-weight: 500;
  color: var(--vscode-editorInfo-foreground);
  min-width: calc(
    var(--width-button-min) + var(--spacing-xlarge) + var(--spacing-xlarge)
  );
}

.config-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-small);
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  padding: var(--spacing-medium);
  border-radius: var(--border-radius);
  margin: var(--spacing-medium) 0;
}
```

### FollowUpInput.ts (update static styles)

```css
.follow-up-actions,
vscode-toolbar-container.follow-up-actions {
  display: flex;
  flex-direction: column !important; /* ADD !important */
  align-items: center;
  gap: var(--spacing-small);
}
```

### OutputFilesSection.ts (update static styles)

```css
.optional-label {
  color: var(--text-color);
  font-weight: normal;
  font-size: var(--font-size);
  white-space: nowrap;
  min-width: calc(var(--width-button-min) * 2); /* ADD */
  display: flex; /* ADD */
  align-items: center; /* ADD */
  height: var(--height-control); /* ADD */
}
```

### LatexDiffsSection.ts (add to static styles)

```css
#commit::part(listbox) {
  max-height: var(--height-large);
}
```

### historyView/frontend/styles.ts (restore deleted styles)

```css
/* Search container - restore spacing */
.search-container {
  margin-bottom: var(--spacing-xlarge);
  width: 100%;
}

/* Search input - restore padding and font */
.search-input {
  flex: 1;
  padding: var(--spacing-medium);
  font-size: var(--font-size);
}

/* Search nav buttons - restore sizing */
.search-nav-btn {
  min-width: var(--height-button);
  height: var(--height-button);
  padding: 0;
  font-size: var(--font-size);
}

/* Match count - fix alignment */
.match-count {
  min-width: calc(var(--height-button) * 2);
  text-align: center; /* Not right */
}

/* Mark highlighting - use original colors */
mark {
  background-color: var(
    --vscode-editor-findMatchHighlightBackground,
    #ffef0b80
  );
  padding: 0;
  border-radius: var(--border-radius-small);
}

mark.current-match {
  background-color: var(--vscode-editor-findMatchBackground, #ff8b0088);
  outline: var(--border-thin) solid var(--vscode-focusBorder);
}

/* History item spacing */
.history-item {
  margin-bottom: var(--spacing-medium);
}

.history-timestamp {
  margin-bottom: var(--spacing-small);
}

/* History details - restore grid */
.history-details {
  grid-template-columns: 100px 1fr;
  margin-top: var(--spacing-medium);
}

/* History label/value - restore colors and padding */
.history-label {
  font-weight: bold;
  color: var(--vscode-editor-foreground);
}

.history-value {
  color: var(--vscode-editor-foreground);
  padding: var(--spacing-small) 0;
}

/* Config section - restore spacing and background */
.config-section {
  gap: var(--spacing-small);
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  padding: var(--spacing-medium);
  margin: var(--spacing-medium) 0;
}

.config-item {
  gap: var(--spacing-medium);
  align-items: baseline;
}

.config-key {
  min-width: calc(
    var(--width-button-min) + var(--spacing-xlarge) + var(--spacing-xlarge)
  );
}

/* Badge - use design tokens */
.badge {
  padding: var(--spacing-tiny) var(--spacing-small);
  border-radius: var(--border-radius);
  font-size: var(--font-size-sm);
}

.agent-category-badge .codicon {
  font-size: var(--font-size-sm);
}
```

### profileView/frontend/styles.ts (add missing color)

```css
.option-title {
  font-weight: 600;
  color: var(--vscode-foreground); /* ADD */
}
```

### progressView/styles/groups.css (restore design tokens)

```css
.log-group-header {
  padding: var(--spacing-tiny) var(--spacing-medium); /* Not 1px */
  margin: var(--spacing-tiny) 0; /* Not 1px */
}
```

### progressView Light DOM Formatters

**Problem**: Formatters in `src/progressView/frontend/formatters/` generate raw HTML strings that get inserted into Light DOM. These need styling but can't use Shadow DOM encapsulation.

**Lit-native solution**: Convert formatters to Lit components that render with Shadow DOM.

**Interim fix** (add to `src/progressView/styles/logs.css` for Light DOM content):

```css
/* File list styles - used in Light DOM formatters */
.file-list-content {
  list-style: none;
  margin: 0;
  padding: 0;
}

.file-list-content .file-var {
  color: var(--color-text-secondary);
  opacity: 0.8;
  font-size: 0.9em;
  margin-left: var(--spacing-tiny);
}

.file-list-content .file-source {
  color: var(--color-text-secondary);
  opacity: 0.6;
  font-size: 0.85em;
  font-style: italic;
}

.xml-link-container {
  margin-top: var(--spacing-small);
  padding-top: var(--spacing-small);
  border-top: var(--border-thin) solid var(--vscode-widget-border);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-small);
}

.xml-link-container .codicon {
  opacity: var(--opacity-subtle);
}

.xml-link-container .document-tag {
  color: var(--color-text-secondary);
  opacity: 0.8;
  font-style: italic;
}

.xml-link-container .xml-fix-hint {
  flex-basis: 100%;
  margin-top: var(--spacing-tiny);
  color: var(--color-text-secondary);
  font-size: 0.9em;
  display: flex;
  align-items: center;
  gap: var(--spacing-tiny);
}

.xml-link-container .xml-fix-hint .codicon {
  opacity: 1;
  color: var(--color-text-link);
}

.xml-link-container .xml-fix-hint strong {
  color: var(--color-text-link);
}

/* Global scope for these (remove .latexdiff-content prefix) */
.detail-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-small);
}

.file-link {
  color: var(--color-text-link);
  cursor: pointer;
}

.file-link:hover {
  text-decoration: underline;
}
```

---

### 7. Inconsistent `.optional-label` Across Components (MEDIUM IMPACT)

**Problem**: Different components have different implementations of `.optional-label`:

| Component          | Status                                                  |
| ------------------ | ------------------------------------------------------- |
| LatexDiffsSection  | ✓ Complete (has min-width, display: flex, height)       |
| OutputFilesSection | ✗ Incomplete (missing min-width, display: flex, height) |
| FileSelectGroup    | ✗ Missing entirely                                      |

**Deleted CSS** (`file-selection.css`):

```css
.optional-label {
  color: var(--text-color);
  font-weight: normal;
  font-size: var(--font-size);
  white-space: nowrap;
  min-width: calc(var(--width-button-min) * 2);
  display: flex;
  align-items: center;
  height: var(--height-control);
}
```

**OutputFilesSection (incomplete)**:

```css
.optional-label {
  color: var(--text-color);
  font-weight: normal;
  font-size: var(--font-size);
  white-space: nowrap;
  /* MISSING: min-width, display, align-items, height */
}
```

---

### 8. FollowUpInput - Actions Flex Direction (HIGH IMPACT)

**Location**: `src/progressView/frontend/components/FollowUpInput.ts`

**Problem**: Follow-up action buttons may not stack vertically.

**Deleted CSS** (`follow-up-input.css`):

```css
.follow-up-actions,
vscode-toolbar-container.follow-up-actions {
  display: flex;
  flex-direction: column !important;
  align-items: center;
  gap: var(--spacing-small);
}
```

**Current (broken)**:

```css
.follow-up-actions {
  display: flex;
  flex-direction: column; /* Missing !important */
  align-items: center;
  gap: var(--spacing-small);
}
/* Missing vscode-toolbar-container.follow-up-actions selector */
```

**Fix**: Add `!important` and the `vscode-toolbar-container` selector variant.

---

### 9. Light DOM File List Styles (HIGH IMPACT)

**Location**: `src/progressView/frontend/formatters/` (generates Light DOM HTML)

**Problem**: File lists rendered by formatters have no styling. These are NOT in Shadow DOM components - they're generated as HTML strings inserted into the page.

**Missing classes** (from `file-list.css`):

```css
.file-list-content .file-var {
  color: var(--color-text-secondary);
  opacity: 0.8;
  font-size: 0.9em;
  margin-left: var(--spacing-tiny);
}

.file-list-content .file-source {
  color: var(--color-text-secondary);
  opacity: 0.6;
  font-size: 0.85em;
  font-style: italic;
}

.xml-link-container {
  margin-top: var(--spacing-small);
  padding-top: var(--spacing-small);
  border-top: var(--border-thin) solid var(--vscode-widget-border);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-small);
}

.xml-link-container .codicon {
  opacity: var(--opacity-subtle);
}

.xml-link-container .document-tag {
  color: var(--color-text-secondary);
  opacity: 0.8;
  font-style: italic;
}

.xml-link-container .xml-fix-hint {
  flex-basis: 100%;
  margin-top: var(--spacing-tiny);
  color: var(--color-text-secondary);
  font-size: 0.9em;
  display: flex;
  align-items: center;
  gap: var(--spacing-tiny);
}

.xml-link-container .xml-fix-hint .codicon {
  opacity: 1;
  color: var(--color-text-link);
}

.xml-link-container .xml-fix-hint strong {
  color: var(--color-text-link);
}
```

**Affected formatters**:

- `htmlBuilders.ts:buildFileListRender()` - uses `.file-var`, `.file-source`
- `dataFormatters.ts:formatFileList()` - uses `.file-list-content`
- `dataFormatters.ts:formatMissingOutputs()` - uses `.xml-link-container`, `.document-tag`
- `toolFormatters.ts` - uses `.file-source`

**Fix options**:

1. Convert formatters to Lit components with Shadow DOM (preferred for Lit-native)
2. Add styles to `src/progressView/styles/logs.css` (for Light DOM content that can't be componentized)

---

### 10. select-group Codicon Styling (MEDIUM IMPACT)

**Location**: Multiple components

**Missing** (from `base.css`):

```css
.select-group .codicon {
  margin-right: var(--spacing-small);
  color: var(--text-color);
  vertical-align: text-bottom;
}
```

This affects icon spacing and alignment next to dropdowns in InstructionPanel.

---

---

### 11. HistoryView - Extensive Regressions (HIGH IMPACT)

**Location**: `src/historyView/frontend/styles.ts`

Multiple regressions from deleted `historyView/styles/index.css`:

| Class                   | Issue                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| `.search-container`     | `margin-bottom` reduced from `xlarge` to `medium`; missing `width: 100%` |
| `.search-input`         | Missing `padding: var(--spacing-medium)` and `font-size`                 |
| `.search-nav-btn`       | Missing `min-width`, `height`, `padding: 0`, `font-size`                 |
| `.match-count`          | Changed from `text-align: center` to `right`; hardcoded `40px`           |
| `mark`                  | Different fallback colors; added padding; hardcoded `border-radius: 2px` |
| `mark.current-match`    | Different fallback colors and outline                                    |
| `.history-item`         | Missing `margin-bottom`                                                  |
| `.history-timestamp`    | Missing `margin-bottom`                                                  |
| `.history-details`      | Grid changed from `100px 1fr` to `max-content 1fr`; reduced margins      |
| `.history-label`        | Missing explicit `color`; changed `bold` to `600`                        |
| `.history-value`        | Missing `padding` and explicit `color`                                   |
| `.button-clear`         | Missing `margin-bottom` and `padding`                                    |
| `.config-section`       | Gap reduced; different background; reduced padding; lost bottom margin   |
| `.config-item`          | Reduced gap; missing `align-items: baseline`                             |
| `.config-key`           | Hardcoded `80px` instead of calc; increased font-weight                  |
| `.agent-category-badge` | Reduced gap; hardcoded icon font-size                                    |
| `.category-*`           | Lost RGB fallback colors                                                 |
| `.history-none`         | Changed from `color`+`italic` to just `opacity`                          |

**Hardcoded values breaking design tokens**: 6+ instances (40px, 2px, 80px, 12px, 11px)

---

### 12. ProfileView - Option Title Color (LOW IMPACT)

**Location**: `src/profileView/frontend/styles.ts`

**Missing**:

```css
.option-title {
  color: var(--vscode-foreground); /* Missing - relies on inheritance */
}
```

---

### 13. TaskGroupList - Spacing Regression (MEDIUM IMPACT)

**Location**: `src/progressView/styles/groups.css`

**Changed** (commit 596dfc40):

```css
/* Before - using design tokens */
.log-group-header {
  padding: var(--spacing-tiny) var(--spacing-medium); /* 2px 8px */
  margin: var(--spacing-tiny) 0;
}

/* After - hardcoded 1px */
.log-group-header {
  padding: 1px var(--spacing-medium); /* 1px 8px - off design grid */
  margin: 1px 0;
}
```

**Impact**: Hardcoded `1px` breaks 2px design grid consistency.

---

### 14. RunSelector - Missing Listbox Part Styling (MEDIUM IMPACT)

**Location**: `src/progressView/frontend/components/RunSelector.ts`

**Problem**: The `vscode-single-select` listbox dropdown has no height constraint, allowing it to overflow the viewport with many runs.

**Missing** (should match other dropdowns like LatexDiffsSection):

```css
vscode-single-select::part(listbox) {
  max-height: var(--height-large);
}
```

**Inconsistency**: LatexDiffsSection has `#commit::part(listbox) { max-height: var(--height-large); }` but RunSelector has no equivalent.

---

### 15. ProgressView buttons.css - Missing Button Classes (HIGH IMPACT)

**Location**: `src/progressView/styles/buttons.css`

**Problem**: Five button classes are used in components but not defined in buttons.css:

| Missing Class     | Used In         |
| ----------------- | --------------- |
| `.resume-button`  | StreamHeader.ts |
| `.clean-button`   | StreamHeader.ts |
| `.diff-button`    | Log entries     |
| `.restore-button` | Log entries     |
| `.storage-button` | Log entries     |

**Note**: These buttons work because they use `vscode-button` which has its own styling, but custom positioning/sizing may be missing.

---

### 16. ProgressView scratchpad.css - Missing Banner Content Variants (MEDIUM IMPACT)

**Location**: `src/progressView/styles/scratchpad.css`

**Problem**: The following BEM modifier classes are referenced but not defined:

```css
/* MISSING */
.banner-content--thinking {
}
.banner-content--scratchpad {
}
.banner-content--model {
}
```

**Context**: The base `.banner-content` exists in banners.css, but variant modifiers for different banner types are undefined.

---

### 17. ProgressView utilities.css - Animation Duplication (LOW IMPACT)

**Location**: `src/progressView/styles/utilities.css` vs component static styles

**Problem**: `@keyframes pulse-scale` is defined in multiple places:

- `src/progressView/frontend/components/StreamTabs.ts` (inline)
- `src/progressView/frontend/components/StreamHeader.ts` (inline)
- Should be in `utilities.css` or a shared style module

**Impact**: Animation definitions duplicated ~40 lines across components instead of sharing.

**Fix**: Move animation to `utilities.css` or create shared `statusIndicatorStyles` module (see Consolidation Plan).

---

### 18. ProgressView logs.css - Orphaned Selectors (LOW IMPACT)

**Location**: `src/progressView/styles/logs.css`

**Problem**: Contains selectors for elements that are now Shadow DOM components:

```css
/* Orphaned - follow-up-input is now a Shadow DOM component */
follow-up-input {
}
.follow-up-input-container {
}

/* Orphaned - followup-section is now a Shadow DOM component */
followup-section {
}
```

**Impact**: Dead CSS code. Shadow DOM components have their own styles and don't inherit from logs.css.

**Fix**: Remove orphaned selectors (cleanup).

---

### 19. ProgressView - Completely Orphaned CSS Files (HIGH IMPACT - CLEANUP)

**Location**: `src/progressView/styles/`

**Problem**: Four CSS files are completely orphaned after `PromptOverlay.ts` was migrated to Lit-native styles:

| File                     | BEM Classes                                                                      | Replaced By                                                                            |
| ------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `approval-requests.css`  | `.approval-request__path`, `.approval-request__diff-*`, etc.                     | `PromptOverlay.ts` inline styles (`.file-path`, `.diff-info`, etc.)                    |
| `retry-requests.css`     | `.retry-request__operation`, `.retry-request__error`, etc.                       | `PromptOverlay.ts` inline styles                                                       |
| `workflow-proposals.css` | `.workflow-proposal__agent`, `.workflow-proposal__instruction`, etc.             | `PromptOverlay.ts` inline styles                                                       |
| `requests-shared.css`    | `.approval-requests`, `.retry-requests`, `__header`, `__list`, `__actions`, etc. | `PromptOverlay.ts` inline styles (`.prompt-card`, `.prompt-header`, `.prompt-actions`) |

**Evidence**: Grep for `class="approval-request`, `class="retry-request`, `class="workflow-proposal` returns **no matches** in the entire codebase.

**Fix**:

1. Remove these 4 files entirely
2. Remove their `@import` statements from `src/progressView/styles/index.css`

**Estimated cleanup**: ~280 lines of dead CSS code.

---

## Components with NO Regressions (Successfully Migrated)

The following components were verified to have complete style migrations:

- **StreamTabs** (`src/progressView/frontend/components/StreamTabs.ts`) - All tab, status, delete button styles preserved
- **TodoList** (`src/progressView/frontend/components/TodoList.ts`) - All todo item styles preserved
- **QueuedFollowUps** (`src/progressView/frontend/components/QueuedFollowUps.ts`) - All queued item styles preserved
- **FollowupSection** (`src/progressView/frontend/components/FollowupSection.ts`) - All 21 style rules migrated
- **InstructionPanel (progress)** (`src/progressView/frontend/components/InstructionPanel.ts`) - Visibility pattern correctly adapted to `:host([visible])`
- **FileList** (`src/progressView/frontend/components/FileList.ts`) - `.files-collapsible` styles preserved in Shadow DOM
- **MemoryView components** - All styles migrated correctly to component-level
- **BannerGroup** - All banner styles migrated
- **StreamHeader** - All header, status, button styles complete
- **UsagePanel** - All usage/stats styles complete
- **MainApp** - Container styles properly in `mainViewStyles`
- **LogList** - Light DOM with proper `logs.css` styling
- **LogView (logger)** - Successfully refactored to modular CSS
- **PromptOverlay** - All overlay/modal styles complete
- **markdown.css** - Complete markdown styling preserved

---

## Cross-Component Inconsistencies

The following patterns are implemented differently across components, breaking visual consistency:

### 1. `.optional-label` - 3 Different Implementations

| Component              | Implementation                                                      |
| ---------------------- | ------------------------------------------------------------------- |
| **LatexDiffsSection**  | Complete: `min-width`, `display: flex`, `align-items`, `height`     |
| **OutputFilesSection** | Incomplete: Only `color`, `font-weight`, `font-size`, `white-space` |
| **FileSelectGroup**    | Missing entirely                                                    |

### 2. Badge Styling - Hardcoded vs Tokens

| Location                  | Implementation                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| **historyView/styles.ts** | `padding: 2px 6px; border-radius: 10px; font-size: 11px` (hardcoded)                           |
| **common.css**            | `padding: var(--spacing-small) var(--spacing-medium); font-size: var(--font-size-sm)` (tokens) |

### 3. Codicon Icon Sizing

| Location                              | Implementation                                                          |
| ------------------------------------- | ----------------------------------------------------------------------- |
| **historyView .agent-category-badge** | `font-size: 12px` (hardcoded)                                           |
| **Other components**                  | `font-size: var(--font-size-sm)` or `var(--font-size-icon-sm)` (tokens) |

### 4. Spacing Values - Design Grid Breaks

| Location                         | Value                | Should Be                        |
| -------------------------------- | -------------------- | -------------------------------- |
| **groups.css .log-group-header** | `1px` padding/margin | `var(--spacing-tiny)` (2px)      |
| **historyView .match-count**     | `40px` min-width     | `calc(var(--height-button) * 2)` |
| **historyView .config-key**      | `80px` min-width     | `calc(...)` with tokens          |
| **historyView mark**             | `2px` border-radius  | `var(--border-radius-small)`     |

### 5. `designTokens` Import - Inconsistent Pattern

| Pattern                         | Components                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Imports designTokens**        | HistoryItem, HistoryList, SearchBar, AgentsTable, ApiAccessSection, ProfileInfo, SignInPrompt                                            |
| **Relies on :root inheritance** | FileList, FollowUpInput, FollowupSection, InstructionPanel, QueuedFollowUps, RunSelector, StreamHeader, StreamTabs, TodoList, UsagePanel |

The comment "Design tokens from tokens.css are inherited into Shadow DOM via :root" is used, but explicit imports are more reliable.

### 6. Dropdown Styles - Duplicated in Multiple Places

| Location                  | Notes                                  |
| ------------------------- | -------------------------------------- |
| **FileSelectGroup.ts**    | Component-specific dropdown styles     |
| **styles.ts (mainView)**  | Shared dropdown styles                 |
| **approval-requests.css** | Different `.diff-dropdown-menu` styles |
| **RunSelector.ts**        | Missing `::part(listbox)` max-height   |

**Inconsistency**: LatexDiffsSection constrains dropdown height with `::part(listbox) { max-height: var(--height-large); }` but RunSelector has no equivalent constraint.

### 7. Status Indicator Animation

| Location         | Animation                                           |
| ---------------- | --------------------------------------------------- |
| **StreamTabs**   | `@keyframes pulse-scale` defined inline             |
| **StreamHeader** | `@keyframes pulse-scale` defined inline             |
| **groups.css**   | Uses `@keyframes spin` from common.css              |
| **common.css**   | `@keyframes pulse-scale`, `@keyframes spin` defined |

Duplicate keyframe definitions in components instead of importing from shared styles.

### 8. Collapsible Part Styling

| Component           | `::part(header)` Background                                  |
| ------------------- | ------------------------------------------------------------ |
| **TodoList**        | `var(--vscode-sideBarSectionHeader-background, transparent)` |
| **FileList**        | `var(--vscode-sideBarSectionHeader-background, transparent)` |
| **FollowupSection** | `var(--vscode-sideBarSectionHeader-background, transparent)` |
| **QueuedFollowUps** | `transparent` (simpler)                                      |

Mostly consistent but QueuedFollowUps differs slightly.

---

## Root Cause

The migration to Lit Web Components used **Shadow DOM**, which provides style encapsulation. However:

1. Styles in `styles.ts` (Light DOM) don't pierce Shadow DOM boundaries
2. Each component needs its own complete set of styles
3. Some formatters generate Light DOM HTML that expects global CSS classes

---

## Mixed Shadow/Light DOM Analysis

### Current Architecture

The codebase has three patterns for rendering:

| Pattern                     | Components                                                       | Styling                                          |
| --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| **Shadow DOM** (Lit-native) | Most components (PromptOverlay, TodoList, FileList, etc.)        | `static styles = css\`...\``                     |
| **Light DOM** (intentional) | LogList, WorkflowStreamContent, ToolUseStreamContent             | External CSS files                               |
| **`unsafeHTML` injection**  | InstructionPanel, FileSelectGroup, LatexDiffsSection, formatters | Mixed - Shadow DOM component + Light DOM content |

### Light DOM Components (Intentional)

These components use `createRenderRoot() { return this; }` by design:

| Component                  | Reason                                                           |
| -------------------------- | ---------------------------------------------------------------- |
| `LogList.ts`               | Imperative DOM manipulation, renders to container                |
| `WorkflowStreamContent.ts` | `display: contents` pass-through for nested Light DOM formatters |
| `ToolUseStreamContent.ts`  | `display: contents` pass-through for nested Light DOM formatters |

**Note**: These are correctly documented with comments explaining the Light DOM choice.

### `unsafeHTML` Usage (Style Boundary Breaks)

Components injecting HTML strings into Shadow DOM:

| File                   | What's Injected                      | Style Source                                             |
| ---------------------- | ------------------------------------ | -------------------------------------------------------- |
| `InstructionPanel.ts`  | `<vscode-option>` elements           | Should inherit from vscode-elements                      |
| `FileSelectGroup.ts`   | `<vscode-option>` elements           | Should inherit from vscode-elements                      |
| `LatexDiffsSection.ts` | `<vscode-option>` elements           | Should inherit from vscode-elements                      |
| `bannerFormatters.ts`  | Markdown-rendered HTML               | External `markdown.css` (works - parent is Light DOM)    |
| `htmlBuilders.ts`      | Syntax-highlighted `<span>` elements | External `hljs-vscode.css` (works - parent is Light DOM) |

**Assessment**: The dropdown option injection is acceptable since `vscode-option` elements are styled by the vscode-elements library. The formatter injections work correctly because they render into Light DOM parents (LogList).

### CSS Files: Keep vs Delete

**DELETE (Orphaned)**:

- `approval-requests.css` - Replaced by `PromptOverlay.ts`
- `retry-requests.css` - Replaced by `PromptOverlay.ts`
- `workflow-proposals.css` - Replaced by `PromptOverlay.ts`
- `requests-shared.css` - Replaced by `PromptOverlay.ts`
- `native-status.css` - No formatter generates `.native-status-line` (verify before deleting)

**KEEP (Light DOM formatters)**:

- `base.css` - Stream content containers, body styles
- `groups.css` - Task group, log group styling
- `logs.css` - Log lines, messages, timestamps (remove orphaned selectors)
- `markdown.css` - Markdown rendering
- `code-block.css` - Code block styling
- `hljs-vscode.css` - Syntax highlighting
- `latexdiff.css` - LaTeXdiff styling
- `statistics.css` - Statistics details
- `context-management.css` - Context management details
- `scratchpad.css` - Scratchpad/banner content
- `user-message.css` - User message styling
- `utilities.css` - Utility classes
- `buttons.css` - Button styling
- `native-status.css` - Native status styling
- `placeholder.css` - Placeholder styling

### Future Migration Candidates

#### Phase 1 - Easy (Already Lit-based, just move styles inline)

| CSS File                 | Lines | Component              | Notes                        |
| ------------------------ | ----- | ---------------------- | ---------------------------- |
| `user-message.css`       | ~40   | `<user-message>`       | Already returns Lit template |
| `statistics.css`         | ~10   | `<statistics-panel>`   | Already returns Lit template |
| `latexdiff.css`          | ~15   | `<latexdiff-results>`  | Already returns Lit template |
| `context-management.css` | ~30   | `<context-management>` | Already returns Lit template |
| `placeholder.css`        | ~20   | `<log-placeholder>`    | Simple HTML string → Lit     |
| `buttons.css`            | ~50   | Inline in toolbar      | Move to component styles     |

#### Phase 2 - Medium (Requires component extraction)

| CSS File         | Lines | Approach                                                       |
| ---------------- | ----- | -------------------------------------------------------------- |
| `code-block.css` | ~80   | Extract `<code-block>` component, keep hljs integration        |
| `scratchpad.css` | ~150  | Split into `<error-box>`, `<tool-use-output>`, `<inline-diff>` |

#### Must Keep as External CSS (Architectural blockers)

| CSS File          | Reason                                                                            |
| ----------------- | --------------------------------------------------------------------------------- |
| `base.css`        | Foundational layout for `progress-app`, `vscode-split-layout`                     |
| `groups.css`      | Blocked by imperative `TaskGroupDomManager`                                       |
| `logs.css`        | Complex layout rules, split incrementally as components mature                    |
| `utilities.css`   | Shared utilities (`.truncate`, `.pre-wrap`, status states) across many components |
| `markdown.css`    | Styles external markdown renderer HTML (can't control structure)                  |
| `hljs-vscode.css` | Styles external highlight.js token classes (can't control structure)              |

#### Likely Orphaned (Verify & Delete)

| CSS File            | Issue                                                |
| ------------------- | ---------------------------------------------------- |
| `native-status.css` | No formatter generates `.native-status-line` classes |

**Migration approach for Phase 1:**

1. The formatters already return `TemplateResult` via `renderToElement(html\`...\`)`
2. Extract the template into a proper Lit component class
3. Move CSS from external file to `static styles = css\`...\``
4. Update formatter to return `<component-name>` instead of raw HTML
5. Delete the external CSS file and its `@import`

---

## Recommendations (Lit-Native Approach)

1. **Fix Shadow DOM components** by adding missing styles to their `static styles = css\`...\`` blocks
2. **Create shared Lit style modules** that can be imported by multiple components (see Consolidation Plan below)
3. **Convert Light DOM formatters to Lit components** where feasible:
   - `formatFileList()` → `<file-list-display>` component
   - `renderXmlLink()` → `<xml-link-display>` component
4. **For Light DOM content that can't be componentized**, add styles to the appropriate CSS file in `src/progressView/styles/` (these are loaded globally in the webview)
5. **Use CSS custom properties** for theming that works across Shadow DOM boundaries

---

## Consolidation Plan: Shared Style Modules

### Goal

Same visual elements should use the same styles everywhere. Create shared Lit CSS modules that components import, eliminating duplication and ensuring consistency.

### Proposed Shared Style Modules

#### 1. `src/shared/styles/selectStyles.ts` - Dropdown/Select Styling

```typescript
import { css } from 'lit';

export const selectStyles = css`
  /* Select group layout */
  .select-group {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
  }

  .select-group .codicon {
    margin-right: var(--spacing-small);
    color: var(--text-color);
    vertical-align: text-bottom;
  }

  .select-group vscode-single-select {
    flex: 1;
    min-width: 6rem;
    max-width: 10rem;
  }

  /* vscode-option states */
  vscode-option {
    font-family: var(--vscode-font-family);
  }

  vscode-option.disabled-option,
  vscode-option.disabled-model,
  vscode-option.disabled-agent,
  vscode-option[data-requires-key='true'] {
    color: var(--color-text-secondary);
    opacity: var(--opacity-subtle);
    font-style: italic;
  }

  vscode-option[data-tool-use='true'] {
    font-style: italic;
  }
`;
```

**Used by**: InstructionPanel (main), InstructionPanel (progress), FollowupSection

---

#### 2. `src/shared/styles/optionalLabelStyles.ts` - Optional/Toggle Labels

```typescript
import { css } from 'lit';

export const optionalLabelStyles = css`
  .optional-label {
    color: var(--text-color);
    font-weight: normal;
    font-size: var(--font-size);
    white-space: nowrap;
    min-width: calc(var(--width-button-min) * 2);
    display: flex;
    align-items: center;
    height: var(--height-control);
  }

  .toggle-icon {
    cursor: pointer;
    user-select: none;
    margin: 0;
    position: relative;
    padding: 0 var(--spacing-tiny);
    color: var(--text-color);
    display: flex;
    align-items: center;
    height: var(--height-control);
  }

  [data-expanded='true'] .optional-label,
  [data-expanded='true'] .toggle-icon {
    color: var(--vscode-foreground);
  }
`;
```

**Used by**: FileSelectGroup, LatexDiffsSection, OutputFilesSection

---

#### 3. `src/shared/styles/badgeStyles.ts` - Badge Styling

```typescript
import { css } from 'lit';

export const badgeStyles = css`
  .badge {
    display: inline-block;
    padding: var(--spacing-tiny) var(--spacing-small);
    border-radius: var(--border-radius);
    font-size: var(--font-size-sm);
    font-weight: 500;
  }

  .badge--small {
    padding: var(--spacing-tiny) var(--spacing-small);
    border-radius: var(--border-radius-small);
  }

  /* Category badges */
  .category-badge,
  .agent-category-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-small);
  }

  .agent-category-badge .codicon {
    font-size: var(--font-size-sm);
  }

  .category-workflow {
    background-color: var(
      --vscode-editorInfo-background,
      rgba(0, 127, 212, 0.15)
    );
    color: var(--vscode-editorInfo-foreground, #3794ff);
  }

  .category-tool-use {
    background-color: var(
      --vscode-editorWarning-background,
      rgba(255, 204, 0, 0.15)
    );
    color: var(--vscode-editorWarning-foreground, #cca700);
  }

  /* Visibility badges */
  .visibility-badge.public {
    background: var(--vscode-testing-iconPassed);
    color: var(--vscode-button-foreground);
  }

  .visibility-badge.custom {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  /* Tier badges */
  .tier-badge {
    text-transform: uppercase;
    font-weight: 600;
  }

  .tier-badge.free {
    background: var(--vscode-inputValidation-warningBackground);
    color: var(--vscode-inputValidation-warningForeground);
  }

  .tier-badge.max {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .tier-badge.ultra {
    background: linear-gradient(
      135deg,
      var(--vscode-textLink-foreground) 0%,
      var(--vscode-textLink-activeForeground) 100%
    );
    color: var(--vscode-button-foreground);
  }
`;
```

**Used by**: HistoryItem, AgentsTable, ProfileInfo

---

#### 4. `src/shared/styles/dropdownStyles.ts` - Dropdown Menu Styling

```typescript
import { css } from 'lit';

export const dropdownStyles = css`
  .dropdown-container {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .dropdown-container vscode-toolbar-button {
    flex-shrink: 0;
  }

  .dropdown-menu {
    position: absolute;
    top: calc(100% + var(--spacing-tiny));
    z-index: 100;
    display: block;
    background-color: var(--vscode-menu-background);
    color: var(--vscode-menu-foreground);
    border: 1px solid var(--vscode-menu-border);
    border-radius: var(--border-radius);
    min-width: 160px;
  }

  .dropdown-menu:not([show]) {
    display: none;
  }

  .dropdown-menu-content {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: var(--spacing-tiny);
  }

  .dropdown-menu vscode-checkbox {
    display: flex;
    align-items: center;
    height: 20px;
    padding: var(--spacing-tiny);
    font-size: var(--font-size-sm);
  }

  .dropdown-menu vscode-checkbox:hover {
    background: var(--vscode-list-hoverBackground);
  }

  /* Chevron rotation */
  vscode-toolbar-button[aria-expanded='true'] .codicon-chevron-down {
    transform: rotate(180deg);
  }
`;
```

**Used by**: FileSelectGroup, LatexDiffsSection, mainViewStyles

---

#### 5. `src/shared/styles/statusIndicatorStyles.ts` - Status Indicators & Animations

```typescript
import { css } from 'lit';

export const statusIndicatorStyles = css`
  .status-indicator,
  .tab-status {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
    background-color: var(--vscode-descriptionForeground);
    opacity: var(--opacity-subtle);
    transition: all 0.3s ease;
  }

  .status-indicator.is-running,
  .tab-status.is-running {
    background-color: var(--color-success);
    box-shadow: 0 0 4px var(--color-success);
    opacity: 1;
    animation: pulse-scale 2s infinite;
  }

  .status-indicator.is-stopped,
  .tab-status.is-stopped {
    background-color: var(--vscode-descriptionForeground);
    opacity: var(--opacity-subtle);
  }

  .status-indicator.is-error,
  .tab-status.is-error {
    background-color: var(--color-error);
    box-shadow: 0 0 4px var(--color-error);
    opacity: 1;
  }

  .status-indicator.is-waiting,
  .status-indicator.is-resuming,
  .tab-status.is-waiting,
  .tab-status.is-resuming {
    background-color: var(--vscode-textLink-foreground);
    box-shadow: 0 0 4px var(--vscode-textLink-foreground);
    opacity: 1;
    animation: pulse-scale 3s infinite;
  }

  .status-indicator.is-resuming,
  .tab-status.is-resuming {
    animation-duration: 1.5s;
  }

  @keyframes pulse-scale {
    0%,
    100% {
      transform: scale(1);
      opacity: 1;
    }
    50% {
      transform: scale(1.15);
      opacity: 0.8;
    }
  }
`;
```

**Used by**: StreamTabs, StreamHeader, groups.css (via import)

---

#### 6. `src/shared/styles/collapsibleStyles.ts` - Collapsible Sections

```typescript
import { css } from 'lit';

export const collapsibleStyles = css`
  .collapsible,
  .files-collapsible,
  .todo-collapsible,
  .followup-collapsible,
  .queued-follow-ups-collapsible {
    margin: 0;
  }

  .collapsible::part(header),
  .files-collapsible::part(header),
  .todo-collapsible::part(header),
  .followup-collapsible::part(header) {
    padding: var(--spacing-tiny) var(--spacing-medium);
    background-color: var(
      --vscode-sideBarSectionHeader-background,
      transparent
    );
    color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground));
  }

  .collapsible::part(body),
  .files-collapsible::part(body),
  .todo-collapsible::part(body) {
    padding: 0 var(--spacing-small) var(--spacing-tiny);
  }
`;
```

**Used by**: TodoList, FileList, FollowupSection, QueuedFollowUps

---

#### 7. `src/shared/styles/searchStyles.ts` - Search UI Styling

```typescript
import { css } from 'lit';

export const searchStyles = css`
  .search-container {
    display: flex;
    align-items: center;
    margin-bottom: var(--spacing-xlarge);
    gap: var(--spacing-medium);
    width: 100%;
  }

  .search-input {
    flex: 1;
    padding: var(--spacing-medium);
    font-size: var(--font-size);
  }

  .search-controls {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
  }

  .search-nav-btn {
    min-width: var(--height-button);
    height: var(--height-button);
    padding: 0;
    font-size: var(--font-size);
  }

  .match-count {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    min-width: calc(var(--height-button) * 2);
    text-align: center;
  }

  /* Search highlighting */
  mark {
    background-color: var(
      --vscode-editor-findMatchHighlightBackground,
      #ffef0b80
    );
    color: var(--vscode-editor-findMatchHighlightForeground, inherit);
    padding: 0;
    border-radius: var(--border-radius-small);
  }

  mark.current-match {
    background-color: var(--vscode-editor-findMatchBackground, #ff8b0088);
    outline: var(--border-thin) solid var(--vscode-focusBorder);
  }
`;
```

**Used by**: SearchBar (historyView)

---

### Migration Steps

1. **Create shared style modules** in `src/shared/styles/`
2. **Update components** to import from shared modules:

   ```typescript
   import { selectStyles } from '@shared/styles/selectStyles';
   import { badgeStyles } from '@shared/styles/badgeStyles';

   static styles = [
     designTokens,
     selectStyles,
     badgeStyles,
     css`/* component-specific styles */`
   ];
   ```

3. **Remove duplicated CSS** from individual components
4. **Update barrel export** in `src/shared/styles/index.ts`
5. **Verify visual consistency** across all views

### Priority Order

1. **selectStyles** - Most impactful (InstructionPanel dropdown issues)
2. **optionalLabelStyles** - 3 components with different implementations
3. **badgeStyles** - Used across history/profile views
4. **statusIndicatorStyles** - Duplicated animations
5. **dropdownStyles** - Duplicated in 3 places
6. **collapsibleStyles** - Minor inconsistencies
7. **searchStyles** - HistoryView specific but good for consistency

---

## CSS File Audit Summary

### By View

| View               | External CSS          | Status                                         |
| ------------------ | --------------------- | ---------------------------------------------- |
| **progressView**   | 20 files              | 4 orphaned, 16 needed for Light DOM formatters |
| **historyView**    | 0 files               | Fully Lit-native (styles in `styles.ts`)       |
| **memoryView**     | 0 files               | Fully Lit-native (styles in `styles.ts`)       |
| **profileView**    | 0 files               | Fully Lit-native (styles in `styles.ts`)       |
| **webview (main)** | 0 files               | Fully Lit-native (component static styles)     |
| **common**         | 1 file (`common.css`) | Needed for document-level styles               |
| **shared**         | 1 file (`tokens.css`) | Design tokens, mirrored in `litStyles.ts`      |

### progressView CSS Files Detail

**DELETE (Orphaned)**:

```
src/progressView/styles/approval-requests.css    (~50 lines)
src/progressView/styles/retry-requests.css       (~80 lines)
src/progressView/styles/workflow-proposals.css   (~150 lines)
src/progressView/styles/requests-shared.css      (~140 lines)
src/progressView/styles/native-status.css        (~30 lines) - verify first
```

Total: ~450 lines of dead CSS

**KEEP (Light DOM Formatters)**:

```
base.css              - Stream containers, body reset (keep)
groups.css            - Task group, log group (keep - imperative DOM)
logs.css              - Log lines, messages (keep - has orphaned selectors to clean)
utilities.css         - Utility classes (keep - shared across components)
markdown.css          - Markdown rendering (keep - external renderer)
hljs-vscode.css       - Syntax highlighting (keep - external highlight.js)
index.css             - Main import file (keep)
```

**MIGRATE TO LIT-NATIVE (Phase 1 - Easy)**:

```
user-message.css      - Already Lit-based → <user-message>
statistics.css        - Already Lit-based → <statistics-panel>
latexdiff.css         - Already Lit-based → <latexdiff-results>
context-management.css - Already Lit-based → <context-management>
placeholder.css       - HTML string → <log-placeholder>
buttons.css           - Move to toolbar component styles
```

**MIGRATE TO LIT-NATIVE (Phase 2 - Medium)**:

```
code-block.css        - Extract → <code-block>
scratchpad.css        - Split → <error-box>, <tool-use-output>, <inline-diff>
```

### Shared Style Architecture

```
tokens.css (CSS custom properties)
     ↓
:root variables available everywhere
     ↓
     ├── common.css (document-level: body, vscode-*, [hidden])
     │        ↓
     │   Loaded by BaseViewContentProvider for all webviews
     │
     └── litStyles.ts (designTokens CSSResult)
              ↓
         Imported by Shadow DOM components
```

This dual approach is intentional:

- **tokens.css** defines variables in `:root` for Light DOM
- **litStyles.ts** exports same tokens as `CSSResult` for Shadow DOM
- **common.css** has global rules (body, vscode-\* elements) that can't go in Shadow DOM
- **commonViewStyles.ts** mirrors component-specific classes for Shadow DOM

---

## Lit-Native Improvements (Phase 8 Opportunities)

> See [prd-lit-native-phase8.md](./prd-lit-native-phase8.md) for full implementation plan.

### Summary of Opportunities (Verified 2026-01-26)

| Category                              | Priority | Impact                       | Files Affected       |
| ------------------------------------- | -------- | ---------------------------- | -------------------- |
| **styleMap directive**                | HIGH     | Low effort, high consistency | 6+ files             |
| **@lit-labs/virtualizer**             | HIGH     | Performance for large lists  | LogList.ts           |
| **TaskGroupDomManager → Declarative** | CRITICAL | Architecture cleanup         | 1 file               |
| **@lit/context for state**            | MEDIUM   | Eliminate prop drilling      | MainApp, ProgressApp |
| **Light DOM → Shadow DOM**            | MEDIUM   | Better encapsulation         | 3 files              |

### Missing Directive Usage

| Directive     | Status   | Opportunity                            |
| ------------- | -------- | -------------------------------------- |
| `styleMap`    | NOT USED | 6+ locations with inline style strings |
| `cache`       | NOT USED | Expensive conditional templates        |
| `asyncAppend` | NOT USED | Streaming content (LogList)            |
| `until`       | NOT USED | Async data loading states              |
| `keyed`       | NOT USED | Force re-render by identity            |

### Files Using Inline Style Strings (Should Use styleMap)

- `src/webview/frontend/components/FileSelectGroup.ts:627`
- `src/webview/frontend/components/OutputFilesSection.ts:232`
- `src/webview/frontend/components/LatexDiffsSection.ts:264`
- `src/webview/frontend/components/InstructionPanel.ts:339,347,359`
- `src/progressView/frontend/formatters/logFormatters/messageFormatters.ts:134`
- `src/progressView/frontend/formatters/logFormatters/contextManagementFormatters.ts:153`

### Prop Drilling Patterns (Context Candidates)

**MainApp → FileSelectGroup** (11+ props + events):

```typescript
// Current - lots of props
<file-select-group
  .config=${config}
  .selectedValue=${...}
  .options=${...}
  .listVisible=${...}
  .files=${...}
  .checkboxValues=${...}
  .isToolUse=${...}
></file-select-group>
```

**ProgressApp → Stream Content** (7+ props + events):

```typescript
<tool-use-stream-content
  .state=${streamState}
  .streamInfo=${activeStream}
  .prompts=${this.prompts}
  ...
></tool-use-stream-content>
```

### Imperative DOM Patterns (Should Be Declarative)

**TaskGroupDomManager.ts** (most critical):

- `document.createDocumentFragment()` + `appendChild()` loops
- Manual `insertBefore()` for header insertion
- Manual tree traversal with fragment building

**LogList.ts**:

- `container.innerHTML = ''` for destructive clear
- Manual fragment appending with `appendChild()`
- Manual document-level event listeners
