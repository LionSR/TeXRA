# PRD: ProgressView Modernization - Phase 5

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)

## Overview

Phase 5 addresses technical debt accumulated during the MainView Lit migration. While MainView is functionally complete, it requires refactoring for long-term maintainability, security, and performance.

## Prerequisites

- Phase 4: MainView migrated to Lit ✅
- Phase 3b: ProgressView patterns established ✅
- Shared infrastructure in `src/shared/` ✅

## Status Summary

### Critical Issues (Fix Immediately)

| ID      | View        | Issue                            | Status         |
| ------- | ----------- | -------------------------------- | -------------- |
| R1      | MainView    | Missing `SET_SELECTED_AGENT`     | ⬜ Not Started |
| CODICON | All         | 403 Forbidden font loading error | ⬜ Not Started |
| H1      | History     | Mark highlight colors SWAPPED    | ⬜ Not Started |
| TOKENS  | All         | CSS spacing 2-4px larger         | ⬜ Not Started |
| **R12** | ProgressView| FollowUp section never visible   | ⬜ Not Started |
| **R13** | MainView    | Dropdowns invisible (clickable)  | ⬜ Not Started |
| **R14** | MainView    | Run button shows text not icon   | ⬜ Not Started |

### Migration Regressions (High Priority)

| ID  | View        | Severity | Issue                              | Status         |
| --- | ----------- | -------- | ---------------------------------- | -------------- |
| R2  | MainView    | HIGH     | Missing Merge button               | ⬜ Not Started |
| R3  | MainView    | MEDIUM   | Missing Refresh Edited File button | ⬜ Not Started |
| R4  | MainView    | MEDIUM   | Missing Refresh Commit icon        | ⬜ Not Started |
| J1  | MainView    | HIGH     | Missing debounce on instruction    | ⬜ Not Started |
| M1  | MainView    | MEDIUM   | Missing CSS variables (5)          | ⬜ Not Started |

### HistoryView Regressions (15 Items)

| ID    | Severity | Issue                            | Status         |
| ----- | -------- | -------------------------------- | -------------- |
| H1    | CRITICAL | Mark highlight colors swapped    | ⬜ Not Started |
| H2    | MEDIUM   | Missing agent-category-badge     | ⬜ Not Started |
| H3    | MEDIUM   | Different category badge colors  | ⬜ Not Started |
| H4    | LOW      | Missing config section bg        | ⬜ Not Started |
| H5    | LOW      | Missing config key styling       | ⬜ Not Started |
| H6    | LOW      | Missing hover/selected states    | ⬜ Not Started |
| H7    | LOW      | Missing config-value styling     | ⬜ Not Started |
| H8    | LOW      | Missing badge base styling       | ⬜ Not Started |
| H9-15 | LOW      | Various element styles           | ⬜ Not Started |

### ProfileView Regressions

| ID  | Severity | Issue                          | Status         |
| --- | -------- | ------------------------------ | -------------- |
| P1  | MEDIUM   | Missing model-access-summary   | ⬜ Not Started |
| P2  | LOW      | Missing models-list-container  | ⬜ Not Started |
| P3  | LOW      | Missing error state guidance   | ⬜ Not Started |
| R11 | LOW      | Unused signOut event           | ⬜ Not Started |

### JavaScript Behavioral Regressions

| ID  | View        | Severity | Issue                       | Status         |
| --- | ----------- | -------- | --------------------------- | -------------- |
| J1  | MainView    | HIGH     | Missing debounce            | ⬜ Not Started |
| J2  | MemoryView  | MEDIUM   | vscode-checkbox timing      | ⬜ Not Started |
| J3  | ProfileView | LOW      | Local state not persisted   | ⬜ Not Started |
| J4  | HistoryView | LOW      | Filter state persistence    | ⬜ Not Started |

### Refactoring Tasks

| Task                           | Status         | Impact                       |
| ------------------------------ | -------------- | ---------------------------- |
| Extract FileSelectGroup        | ⬜ Not Started | -300 lines from MainApp      |
| Extract BannerGroup components | ⬜ Not Started | -150 lines from MainApp      |
| Extract LatexDiffsSection      | ⬜ Not Started | -200 lines from MainApp      |
| Create shared message schemas  | ⬜ Not Started | Type-safe frontend ↔ backend |
| Add Zod validation to MainApp  | ⬜ Not Started | Security + type safety       |
| Convert 37 inline arrows       | ⬜ Not Started | Performance                  |
| Delete duplicate debug handler | ⬜ Not Started | Code cleanup                 |
| Install @types/sortablejs      | ✅ Complete    | Complete type definitions    |

### Architectural Tasks (NEW - Phase 5 Scope)

| Task                                | Status         | Impact                           |
| ----------------------------------- | -------------- | -------------------------------- |
| Formatters → TemplateResult         | ⬜ Not Started | Shadow DOM throughout            |
| renderLogs incremental updates      | ⬜ Not Started | Performance for large logs       |
| Create commonViewMessages.ts        | ⬜ Not Started | Zod schemas for cross-view cmds  |
| themeHandlers.ts Zod migration      | ⬜ Not Started | Type-safe theme/debug handling   |
| Eliminate normalization layers      | ✅ Complete    | -160 lines (done in Phase 3)     |
| Cross-webview command unification   | ⬜ Not Started | Consistent message handling      |

---

## 5.1 Monolithic Component (Critical)

**Problem:** `MainApp.ts` is **~2,737 lines** — far exceeding maintainable component size (~500 lines recommended).

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

## 5.2 Missing Message Validation (Security Risk)

**Problem:** MainApp handles 58+ message types with **NO Zod validation** — direct type casting only.

**Current (unsafe):**

```typescript
// MainApp.ts:297
private handleMessage(event: MessageEvent): void {
  const message = event.data as { command: string; [key: string]: unknown };
  switch (message.command) {
    case MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS:
      this.modelOptions = message.options as string;  // ❌ No validation
      break;
    // ... 57 more cases
  }
}
```

**Target (type-safe with shared contracts):**

```typescript
// handlers/messageHandlers.ts
import { z } from 'zod';

// Shared schema (also used by backend MainViewMessageHandler.ts)
export const SetModelOptionsSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS),
  options: z.string(),
});

export const MESSAGE_HANDLERS: Record<string, MessageHandler> = {
  [MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS]: (raw, ctx) => {
    const result = SetModelOptionsSchema.safeParse(raw);
    if (!result.success) return; // Silent fail, logged in dev
    ctx.setState((s) => ({ ...s, modelOptions: result.data.options }));
  },
  // ... other handlers
};

// MainApp.ts - clean dispatch
private handleMessage(event: MessageEvent): void {
  const message = event.data;
  const handler = MESSAGE_HANDLERS[message?.command];
  if (handler) handler(message, this.createContext());
}
```

---

## 5.3 Shared Message Contracts (Frontend ↔ Backend)

**Problem:** Message types are implicitly defined in both frontend and backend with no shared contract.

**Current state:**

```
MainViewMessageHandler.ts (backend)  → sends { command: 'SET_MODEL_OPTIONS', options: string }
MainApp.ts (frontend)                → expects { command: string, options?: unknown }
```

**Target architecture:**

```
src/shared/schemas/mainViewMessages.ts   # Single source of truth
├── SetModelOptionsSchema
├── UpdateFilesSchema
├── SetAgentConfigSchema
├── ... (58 message schemas)
└── MainViewMessageSchema (union of all)

src/webview/MainViewMessageHandler.ts    # Backend imports schemas
src/webview/frontend/handlers/           # Frontend imports schemas
```

**Migration approach:**

1. Create `src/shared/schemas/mainViewMessages.ts` with all 58 message schemas
2. Update `MainViewMessageHandler.ts` to use schemas when sending
3. Update `MainApp.ts` to validate with `safeParse()` when receiving
4. Add compile-time assertion: backend send types = frontend receive types

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

---

## 5.4 Duplicate Debug Mode Handling

**Problem:** MainApp adds a redundant listener for `DEBUG_MODE_SET`:

```typescript
// MainApp.ts:268-289
private handleDebugModeMessage = (event: MessageEvent): void => {
  const message = event.data as { command?: string; debugMode?: boolean };
  if (message?.command === COMMON_COMMANDS.DEBUG_MODE_SET) {
    this.debugMode = Boolean(message.debugMode);
  }
};
```

**But `BaseWebviewApp` already handles this!** See `BaseWebviewApp.ts:18-25`:

```typescript
// BaseWebviewApp.ts
protected handleMessage(event: MessageEvent): void {
  const message = event.data;
  if (message?.command === COMMON_COMMANDS.DEBUG_MODE_SET) {
    this.debugMode = Boolean(message.debugMode);
  }
  // ...
}
```

**Fix:** Delete the redundant `handleDebugModeMessage` method and listener registration in `connectedCallback()`.

---

## 5.5 Missing SortableJS Type Definitions

**Problem:** `types/sortablejs.d.ts` is incomplete — only declares minimal options.

**Current (incomplete):**

```typescript
// types/sortablejs.d.ts
declare module 'sortablejs' {
  interface Options {
    group?: string | { name: string; pull?: boolean; put?: boolean };
    sort?: boolean;
    // ... minimal subset
  }
}
```

**Fix options:**

1. **Preferred:** Install `@types/sortablejs` from DefinitelyTyped

   ```bash
   npm install -D @types/sortablejs
   ```

2. **Alternative:** Expand local definition to include full `Sortable.Event` type:

   ```typescript
   interface SortableEvent extends Event {
     oldIndex?: number;
     newIndex?: number;
     oldDraggableIndex?: number;
     newDraggableIndex?: number;
     item: HTMLElement;
     clone: HTMLElement;
     from: HTMLElement;
     to: HTMLElement;
     // ...
   }
   ```

---

## 5.6 `any` Types in themeHandlers.ts

**Problem:** Lines 21 and 30 use `any`:

```typescript
// themeHandlers.js (should be .ts)
[commands.THEME_SET]: (message: any) => { ... }
[commands.DEBUG_MODE_SET]: (message: any) => { ... }
```

**Fix:** Convert to TypeScript with proper types:

```typescript
// themeHandlers.ts
interface ThemeSetMessage {
  theme?: string;
}

interface DebugModeSetMessage {
  debugMode?: boolean;
}

export const THEME_HANDLERS: Record<string, (message: unknown) => void> = {
  [COMMANDS.THEME_SET]: (message) => {
    const { theme } = message as ThemeSetMessage;
    if (theme) document.body.dataset.vscodeThemeKind = theme;
  },
  [COMMANDS.DEBUG_MODE_SET]: (message) => {
    const { debugMode } = message as DebugModeSetMessage;
    document.body.classList.toggle('debug-mode', Boolean(debugMode));
  },
};
```

---

## 5.7 Inline Arrow Functions (37 instances)

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

## 5.8 Suggested Computed Getters

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

## Implementation Plan

### Step 1: Message Validation (Week 1)

1. Create `src/shared/schemas/mainViewMessages.ts` with all 58 schemas
2. Create `src/webview/frontend/handlers/messageHandlers.ts` with registry pattern
3. Update MainApp to use registry + Zod validation
4. Delete redundant debug mode handler

### Step 2: Component Extraction (Week 2)

1. Extract `FileSelectGroup.ts` component
2. Extract `BannerGroup.ts` components
3. Extract `LatexDiffsSection.ts` component
4. Update MainApp imports

### Step 3: Type Safety (Week 3)

1. Install `@types/sortablejs` or expand local types
2. Convert `themeHandlers.js` → `themeHandlers.ts`
3. Extract 37 inline arrows to class methods
4. Add computed getters for derived state

---

## Success Metrics

| Metric                 | Before | After |
| ---------------------- | ------ | ----- |
| MainApp.ts lines       | 2,737  | ~500  |
| Extracted components   | 0      | 6+    |
| Message schemas        | 0      | 58    |
| Zod-validated messages | 0%     | 100%  |
| Inline arrow functions | 37     | 0     |
| `any` types            | 2      | 0     |
| Duplicate handlers     | 1      | 0     |

---

## Migration Regressions (Legacy vs Lit Comparison 2026-01-25)

A comprehensive comparison of deleted legacy JS/HTML with the new Lit implementations revealed the following regressions.

### MainView Regressions (CRITICAL)

#### R1. Missing `SET_SELECTED_AGENT` Handler (CRITICAL)

**Impact:** Profile view remote agent selection is completely broken.

**Legacy behavior:** When a user clicks "Select" on an agent in ProfileView, `SET_SELECTED_AGENT` is sent to MainView, which:

- Finds best matching dropdown option (exact match, then name-only)
- Creates placeholder option if agent not in dropdown
- Updates `mainViewState` to persist selection
- Applies session type UI changes

**Current state:** No case for `MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT` in `handleMessage()` switch.

**Fix:**

```typescript
case MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT: {
  const { agentId, sessionType } = message as { agentId?: string; sessionType?: string };
  if (sessionType) this.sessionType = sessionType;
  if (agentId) {
    if (this.sessionType === 'toolUse') {
      this.selectedToolUseAgent = agentId;
    } else {
      this.selectedWorkflowAgent = agentId;
    }
  }
  this.saveState();
  break;
}
```

#### R2. Missing Merge Button (HIGH)

**Location:** LaTeXDiffs section

**Legacy HTML:**

```html
<vscode-toolbar-button id="mergeButton" icon="merge" label="Merge edits" />
```

**Current state:** `handleMerge()` exists (line 1483-1491) but no button renders it.

**Fix:** Add merge button in `renderLatexdiffsSection()`.

#### R3. Missing Refresh Edited File Button (MEDIUM)

**Location:** LaTeXDiffs section, Edited file row

**Legacy HTML:**

```html
<vscode-toolbar-button
  id="refreshEditedFileButton"
  icon="edit"
  label="Refresh edited files"
/>
```

**Fix:** Add refresh button to edited file section.

#### R4. Missing Refresh Commit Button Icon (MEDIUM)

**Location:** LaTeXDiffs section, Commit row

**Issue:** Button exists but missing `git-commit` icon in label group.

---

### HistoryView Regressions (Styling)

#### R5. Mark Highlight Colors Swapped

**Legacy CSS:**

```css
mark {
  background-color: var(--vscode-editor-findMatchHighlightBackground);
}
mark.current-match {
  background-color: var(--vscode-editor-findMatchBackground);
}
```

**Lit CSS (swapped):**

```css
mark {
  background: var(--vscode-editor-findMatchBackground);
}
mark.current-match {
  background: var(--vscode-editor-findMatchHighlightBackground);
}
```

**Also missing:** Fallback colors, `outline` on current-match, `border-radius`.

#### R6. Missing `agent-category-badge` Class

**Legacy:** `<span class="badge agent-category-badge ${categoryClass}">`
**Lit:** `<span class="badge ${categoryClass}">`

Missing inline-flex layout, alignment, gap, codicon font size.

#### R7. Different Category Badge Colors

**Legacy:** Uses semantic editor colors (`--vscode-editorInfo-background`)
**Lit:** Uses chart colors (`--vscode-charts-blue`) - different visual appearance

#### R8. Missing Config Section Background

**Legacy:** Background color, padding, border-radius, margin on `.config-section`
**Lit:** Only flex layout, no visual distinction

#### R9. Missing Config Key Styling

**Legacy:** `color: var(--vscode-editorInfo-foreground)`, `min-width` for alignment
**Lit:** Only `font-weight: 600`

---

### ProfileView Regressions

#### R10. Missing Error State for Model Access

**Legacy behavior:** Shows "unable to load" with tooltip "Try signing out and back in to refresh" when `enabledProviders.length === 0`.

**Lit behavior:** Shows "none" with no recovery guidance.

**Fix:** Add error state handling in `ApiAccessSection.ts`.

#### R11. Unused `signOut` Event

**Issue:** `signOut` event defined in `events.ts` but never used. Either implement Sign Out UI or remove the event.

---

### MemoryView Regressions

**None found** - Full functional parity achieved.

---

### ProgressView Regressions (NEW - 2026-01-25)

#### R12. FollowUp Section Never Visible (CRITICAL)

**Location:** `src/progressView/frontend/components/FollowupSection.ts:207-215`

**Symptom:** FollowUp section never appears even for completed workflow streams with output files.

**Root Cause:** Status check fails due to semantic mismatch:

```typescript
// FollowupSection.ts visibility logic
const isTerminal = this.status === 'stopped' || this.status === 'ready';
const visible = this.agentCategory === 'workflow' && isTerminal && this.hasOutputFiles;
```

**But in StreamStatusService.ts:**
```typescript
if (status === STREAM_STATUS.READY) {
  statusMemory.delete(stream);  // ← READY streams are DELETED, not stored
}
```

When `streamInfo.status` is looked up for READY streams, it returns `undefined`, not `'ready'`.
The check `undefined === 'ready'` is always **false**.

**Fix:**
```typescript
// Option 1: Handle undefined as ready
const isTerminal = this.status === 'stopped' || this.status === 'ready' || this.status === undefined;

// Option 2: Fix at source - streamInfoUtils.ts line 94
status: statuses?.get(id) ?? 'ready',  // Default to 'ready' if not in map
```

---

### MainView Regressions (NEW - 2026-01-25)

#### R13. Dropdowns Invisible But Clickable (CRITICAL)

**Location:** `src/webview/frontend/MainApp.ts:2076-2197`, `src/webview/frontend/styles.ts`

**Symptom:** Auto-extract and tool config dropdown menus are clickable but completely invisible.

**Affected menus:**
- `id="autoExtractOptions"` - Auto-extract figures, TikZ, PDF
- `id="toolConfigOptions"` - TeXCount, diagnostics attachments

**Root Cause:** Missing CSS for `vscode-context-menu` element:

```css
/* styles.ts - MISSING PROPERTIES */
.dropdown-container .dropdown-menu {
  position: absolute;
  top: calc(100% + var(--spacing-tiny));
  right: 0;
  z-index: 100;
  /* MISSING: display, background-color, color, border */
}
```

**Fix:** Add complete styling:
```css
.dropdown-container .dropdown-menu {
  position: absolute;
  top: calc(100% + var(--spacing-tiny));
  right: 0;
  z-index: 100;
  display: block;
  background-color: var(--vscode-menu-background);
  color: var(--vscode-menu-foreground);
  border: 1px solid var(--vscode-menu-border);
  border-radius: 4px;
  min-width: 160px;
}

/* Handle .show property binding */
.dropdown-container .dropdown-menu:not([show]) {
  display: none;
}
```

#### R14. Run Button Shows Text Instead of Icon (HIGH)

**Location:** `src/webview/frontend/MainApp.ts:2058-2064`

**Symptom:** Run button displays "Run" text instead of play icon.

**Legacy HTML:**
```html
<vscode-button id="executeButton" title="Execute" icon="play"></vscode-button>
```

**Current Lit (REGRESSION):**
```html
<vscode-button id="executeButton" appearance="primary" @click=${this.executeAgent}>
  Run
</vscode-button>
```

**What was lost:**
- `icon="play"` attribute
- `title="Execute"` tooltip

**Fix:**
```typescript
// Option 1: Icon only (matches legacy)
<vscode-button
  id="executeButton"
  icon="play"
  title="Execute"
  appearance="primary"
  @click=${this.executeAgent}
></vscode-button>

// Option 2: Icon + text
<vscode-button
  id="executeButton"
  title="Execute"
  appearance="primary"
  @click=${this.executeAgent}
>
  <span slot="start" class="codicon codicon-play"></span>
  Run
</vscode-button>
```

---

## Comprehensive Regression Analysis (2026-01-25)

This section documents ALL regressions discovered through systematic comparison of legacy files with Lit implementations across CSS, JavaScript, and HTML.

### CSS Token Value Differences (CRITICAL - Affects All Views)

**Problem:** All spacing tokens in Lit (`litStyles.ts`) are **2-4px larger** than legacy (`tokens.css`), affecting the entire UI layout.

| Token             | Legacy (tokens.css) | Lit (litStyles.ts) | Difference |
| ----------------- | ------------------- | ------------------ | ---------- |
| `--spacing-tiny`  | 2px                 | 4px                | +2px       |
| `--spacing-small` | 4px                 | 8px                | +4px       |
| `--spacing-medium`| 8px                 | 12px               | +4px       |
| `--spacing-large` | 12px                | 16px               | +4px       |
| `--spacing-xlarge`| 20px                | 24px               | +4px       |

**Impact:** UI elements appear more spaced out. Buttons, panels, and containers have different visual proportions.

**Fix:** Align `litStyles.ts` token values with legacy `tokens.css` or document as intentional design change.

---

### HistoryView CSS Regressions (15+ Items)

#### H1. Mark Highlight Colors Swapped (R5 - CRITICAL)

**Legacy CSS:**
```css
mark {
  background-color: var(--vscode-editor-findMatchHighlightBackground);
  color: var(--vscode-editor-findMatchHighlightForeground, inherit);
  border-radius: 2px;
}
mark.current-match {
  background-color: var(--vscode-editor-findMatchBackground);
  color: var(--vscode-editor-findMatchForeground, inherit);
  outline: 1px solid var(--vscode-editor-findMatchBorder, transparent);
}
```

**Lit CSS (SWAPPED - BUG):**
```css
mark {
  background: var(--vscode-editor-findMatchBackground);  /* ❌ Wrong */
  color: inherit;
}
mark.current-match {
  background: var(--vscode-editor-findMatchHighlightBackground);  /* ❌ Wrong */
}
```

**Missing:** Fallback colors, `border-radius: 2px`, `outline` on current-match.

#### H2. Missing `.agent-category-badge` Class (R6)

**Legacy:**
```css
.agent-category-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-tiny);
}
.agent-category-badge .codicon {
  font-size: 12px;
}
```

**Lit:** Class not present. Badge uses only generic `.badge` class.

#### H3. Different Category Badge Colors (R7)

**Legacy (semantic editor colors):**
```css
.badge.workflow { background-color: var(--vscode-editorInfo-background); }
.badge.tool-use { background-color: var(--vscode-editorWarning-background); }
```

**Lit (chart colors - different appearance):**
```css
.badge.workflow { background-color: var(--vscode-charts-blue); }
.badge.tool-use { background-color: var(--vscode-charts-orange); }
```

#### H4. Missing Config Section Background (R8)

**Legacy:**
```css
.config-section {
  background-color: var(--vscode-editor-background);
  padding: var(--spacing-small);
  border-radius: 4px;
  margin-top: var(--spacing-small);
}
```

**Lit:** Only `display: flex` and `flex-direction: column`. No visual distinction.

#### H5. Missing Config Key Styling (R9)

**Legacy:**
```css
.config-key {
  color: var(--vscode-editorInfo-foreground);
  min-width: 80px;  /* Alignment for key-value pairs */
}
```

**Lit:** Only `font-weight: 600`. No color, no min-width alignment.

#### H6. Missing `.history-item` Hover/Selected States

**Legacy:**
```css
.history-item:hover {
  background-color: var(--vscode-list-hoverBackground);
}
.history-item.selected {
  background-color: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
```

**Lit:** States may be missing or incomplete.

#### H7. Missing `.config-value` Styling

**Legacy:**
```css
.config-value {
  color: var(--vscode-descriptionForeground);
  word-break: break-word;
}
```

**Lit:** Not found in component styles.

#### H8. Missing `.badge` Base Styling

**Legacy:**
```css
.badge {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
}
```

**Lit:** May have different padding/border-radius values.

#### H9-H15. Additional Missing Styles

| Element | Legacy Property | Lit Status |
|---------|----------------|------------|
| `.search-input` | `width: 100%` | May differ |
| `.search-container` | Border, padding | May differ |
| `.filter-dropdown` | Consistent with VS Code | May differ |
| `.timestamp` | Subtle foreground color | May differ |
| `.agent-name` | Font weight, ellipsis | May differ |
| `.instruction-preview` | Line clamp, ellipsis | May differ |
| `.empty-state` | Centered, muted color | May differ |

---

### ProfileView CSS Regressions

#### P1. Missing `.model-access-summary` Styling (9 Properties)

**Legacy:**
```css
.model-access-summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-small);
  padding: var(--spacing-small);
  background-color: var(--vscode-editor-background);
  border-radius: 4px;
  margin-bottom: var(--spacing-medium);
  border: 1px solid var(--vscode-panel-border);
  font-size: 12px;
}
```

**Lit:** Class not found in component styles.

#### P2. Missing `.models-list-container` Styling

**Legacy:**
```css
.models-list-container {
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
}
```

**Lit:** Not found.

#### P3. Missing Error State Styling

**Legacy:** Shows "unable to load" with tooltip guidance when `enabledProviders.length === 0`.

**Lit:** Shows "none" with no recovery guidance or visual distinction.

---

### MainView CSS Regressions

#### M1. Missing CSS Variables

The following CSS variables used in legacy MainView are not defined in Lit:

| Variable | Legacy Value | Used For |
|----------|--------------|----------|
| `--height-small` | 24px | Input heights |
| `--height-button` | 28px | Button heights |
| `--border-radius` | 4px | Container corners |
| `--width-button-min` | 80px | Button minimum width |
| `--opacity-normal` | 1 | Normal state opacity |

**Fix:** Add to `litStyles.ts` or replace with VS Code theme variables.

#### M2. File List Item Styling Differences

**Legacy:** More compact with specific icon alignment.

**Lit:** May have different spacing due to token differences.

---

### Codicon Font 403 Forbidden Error (CRITICAL)

**Error Message:**
```
Failed to load resource: the server responded with a status of 403 (Forbidden)
codicon.ttf:1
```

**Root Cause:** The `codicon.css` file contains a relative URL `./codicon.ttf` which doesn't resolve correctly within the webview's Content Security Policy (CSP). Webviews require absolute URIs generated via `webview.asWebviewUri()`.

**Fix:** Add a document-level `@font-face` declaration BEFORE the codicon.css link in each `index.html`:

```html
<!-- In getHtmlContent() method -->
<style nonce="${nonce}">
  @font-face {
    font-family: 'codicon';
    font-display: block;
    src: url('${codiconsFontUri}') format('truetype');
  }
</style>
<link rel="stylesheet" href="${codiconUri}" id="vscode-codicon-stylesheet" />
```

Where `codiconsFontUri` is generated as:
```typescript
const codiconsFontUri = webview.asWebviewUri(
  vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.ttf')
);
```

**Affected Files:**
- `src/webview/index.html` (MainView)
- `src/progressView/index.html` (ProgressView)
- `src/historyView/index.html` (HistoryView)
- `src/profileView/index.html` (ProfileView)
- `src/memoryView/index.html` (MemoryView)

---

### HTML Structure Differences

#### 40+ Missing Element IDs (Expected)

Lit components use Shadow DOM and don't require global IDs for element selection. The following legacy IDs are intentionally not present in Lit:

**MainView (Legacy IDs removed):**
- `#agentSelector`, `#modelSelector`, `#instructionInput`
- `#runButton`, `#polishButton`, `#mergeButton`
- `#inputFilesList`, `#outputFilesList`
- `#apiKeyBanner`, `#agentConfigBanner`
- All `#latexdiff*` IDs

**HistoryView (Legacy IDs removed):**
- `#searchInput`, `#filterDropdown`, `#historyList`
- `#emptyState`, `#loadingIndicator`

**ProfileView (Legacy IDs removed):**
- `#signOutButton`, `#providersList`, `#modelAccessList`

**This is expected and correct.** Lit components use `@query` decorators for internal element references.

#### Missing CSS Classes on Buttons

**HistoryItem.ts buttons:**

**Legacy:**
```html
<button class="action-button restore-button" title="Restore">
<button class="action-button delete-button" title="Delete">
```

**Lit:**
```html
<button class="action-button" @click=${...}>  <!-- Missing restore-button/delete-button -->
```

**Impact:** Any CSS targeting `.restore-button` or `.delete-button` specifically won't apply.

#### Icon Changes in MainView

Some button icons may have changed during migration. Audit needed for:
- File action buttons (open, preview, remove)
- LaTeXDiffs section buttons
- Recording button states

---

### JavaScript Behavioral Differences

#### J1. Missing Debounce on MainView Instruction Input (HIGH)

**Legacy behavior:** Instruction input likely had debounced save to prevent excessive state persistence on every keystroke.

**Lit behavior:** `@input` handler calls `saveState()` directly, potentially causing performance issues with rapid typing.

**Fix:**
```typescript
import { debounce } from 'lodash-es';

// In MainApp.ts
private debouncedSaveState = debounce(() => this.saveState(), 300);

private handleInstructionInput(e: Event): void {
  const input = e.target as HTMLTextAreaElement;
  this.instruction = input.value;
  this.debouncedSaveState();  // ✅ Debounced
}
```

#### J2. vscode-checkbox Upgrade Timing in MemoryView (MEDIUM)

**Issue:** Custom elements may not be upgraded when initial render occurs, causing `checked` property to not reflect correctly.

**Legacy:** Used `setTimeout` or waited for `customElements.whenDefined()`.

**Lit Fix:**
```typescript
async firstUpdated() {
  await customElements.whenDefined('vscode-checkbox');
  this.requestUpdate();
}
```

#### J3. ProfileView Local State Not Persisted (LOW)

**Legacy:** ProfileView saved collapsed/expanded state of sections.

**Lit:** Uses `WebviewStateManager` but may not persist all UI states.

**Verify:** Check if section collapse states survive webview hide/show cycles.

#### J4. HistoryView Filter State Persistence

**Legacy:** Filter dropdown selection was persisted.

**Lit:** Verify filter state is saved via `WebviewStateManager`.

---

### Button Style Audit Results

**Finding:** All buttons are consistent across views. No issues found.

All Lit views use the same button patterns:
- `vscode-button` for primary actions
- `vscode-toolbar-button` for toolbar actions
- `<button class="action-button">` for inline actions

Icon usage is consistent with VS Code codicon classes.

---

## Architectural Debt (ProgressView)

These concerns were identified during code review and affect ProgressView's long-term maintainability.

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

### A2. renderLogs() Full DOM Rebuild (HIGH) → Phase 5 Scope

**Location:** `src/progressView/frontend/components/LogList.ts:131-207`

**Problem:** Every render clears and rebuilds the entire DOM:

```typescript
container.innerHTML = '';
this.groupManager.clear();
this.logManager.clear();
// ... rebuild everything
```

**Impact:** For large log lists (100+ entries), this causes visible jank during updates.

**Phase 5 Solution:** Implement incremental append pattern. See [5.11 renderLogs Incremental Updates](#511-renderlogs-incremental-updates-phase-5-scope) for detailed implementation plan.

### A3. Light DOM in ProgressView (MEDIUM) → Phase 5 Scope

**Location:** `ProgressApp.ts`, `LogList.ts`, `TaskGroupList.ts`

**Problem:** These components use Light DOM (`createRenderRoot() { return this; }`), breaking style encapsulation.

**Why it exists:** Streaming log architecture requires direct DOM manipulation that conflicts with Shadow DOM boundaries.

**Phase 5 Fix:** Refactor formatters to return `TemplateResult` instead of HTML strings, enabling Shadow DOM throughout. See [5.10 Formatter → TemplateResult Migration](#510-formatter--templateresult-migration).

---

## 5.10 Formatter → TemplateResult Migration (Phase 5 Scope)

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

| Formatter File | Functions | Effort |
|----------------|-----------|--------|
| `taskLog.ts` | 3 | 30 min |
| `toolUseLog.ts` | 5 | 1 hour |
| `streamHeader.ts` | 2 | 30 min |
| `agentLog.ts` | 4 | 1 hour |
| `litTemplates.ts` | 8 | 2 hours |
| Others (10 files) | ~20 | 4 hours |

**Total estimated effort:** ~9 hours

**Benefits:**
- Shadow DOM encapsulation possible
- No manual HTML escaping needed (Lit auto-escapes)
- Better performance via Lit's diffing
- Type-safe template composition

---

## 5.11 renderLogs Incremental Updates (Phase 5 Scope)

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

## 5.12 Cross-Webview Commands Architecture

**Problem:** 5 common commands are handled inconsistently across webviews with no Zod validation.

### Current State

| Command | Pattern | Zod Schema | Type Safety |
|---------|---------|------------|-------------|
| `THEME_SET` | `createThemeHandlers()` | ❌ None | ❌ `any` |
| `DEBUG_MODE_SET` | `BaseWebviewApp` | ❌ None | ❌ `any` |
| `STATE_RESTORE` | Manual | ❌ None | ❌ `any` |
| `WEBVIEW_READY` | Auto-sent | ❌ None | ❌ |
| `ERROR` | Generic | ❌ None | ❌ `any` |

### Target Architecture

**1. Create `src/shared/schemas/commonViewMessages.ts`:**

```typescript
import { z } from 'zod';
import { COMMON_COMMANDS } from '@common/webview/commands';

// Schema definitions
export const SetThemeMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.THEME_SET),
  theme: z.enum(['vscode-dark', 'vscode-light', 'vscode-high-contrast']),
});

export const SetDebugModeMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.DEBUG_MODE_SET),
  debugMode: z.boolean(),
});

export const StateRestoreMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.STATE_RESTORE),
  state: z.record(z.string(), z.unknown()),
});

export const WebviewReadyMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.WEBVIEW_READY),
});

export const ErrorMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.ERROR),
  message: z.string(),
  details: z.unknown().optional(),
});

// Discriminated union for routing
export const CommonViewMessageSchema = z.discriminatedUnion('command', [
  SetThemeMessageSchema,
  SetDebugModeMessageSchema,
  StateRestoreMessageSchema,
  WebviewReadyMessageSchema,
  ErrorMessageSchema,
]);

export type CommonViewMessage = z.infer<typeof CommonViewMessageSchema>;
export type SetThemeMessage = z.infer<typeof SetThemeMessageSchema>;
export type SetDebugModeMessage = z.infer<typeof SetDebugModeMessageSchema>;
```

**2. Refactor `themeHandlers.ts` → `commonMessageHandlers.ts`:**

```typescript
// src/shared/handlers/commonMessageHandlers.ts
import { CommonViewMessageSchema, COMMON_COMMANDS } from '@shared/schemas/commonViewMessages';

export interface CommonMessageContext {
  setTheme: (theme: string) => void;
  setDebugMode: (enabled: boolean) => void;
  restoreState: (state: Record<string, unknown>) => void;
  onError: (message: string, details?: unknown) => void;
}

export function handleCommonMessage(
  raw: unknown,
  context: CommonMessageContext
): boolean {
  const result = CommonViewMessageSchema.safeParse(raw);
  if (!result.success) return false;

  const message = result.data;
  switch (message.command) {
    case COMMON_COMMANDS.THEME_SET:
      context.setTheme(message.theme);
      return true;
    case COMMON_COMMANDS.DEBUG_MODE_SET:
      context.setDebugMode(message.debugMode);
      return true;
    case COMMON_COMMANDS.STATE_RESTORE:
      context.restoreState(message.state);
      return true;
    case COMMON_COMMANDS.ERROR:
      context.onError(message.message, message.details);
      return true;
    default:
      return false;
  }
}
```

**3. Update `BaseWebviewApp.ts`:**

```typescript
export abstract class BaseWebviewApp extends LitElement {
  @state() protected debugMode = false;

  protected handleMessage(event: MessageEvent): void {
    const handled = handleCommonMessage(event.data, {
      setTheme: (theme) => this.onThemeChange(theme),
      setDebugMode: (enabled) => { this.debugMode = enabled; },
      restoreState: (state) => this.onStateRestore(state),
      onError: (msg, details) => console.error(msg, details),
    });

    if (!handled) {
      this.handleViewSpecificMessage(event.data);
    }
  }

  protected onThemeChange(theme: string): void {
    document.body.dataset.vscodeThemeKind = theme;
  }

  protected onStateRestore(state: Record<string, unknown>): void {
    // Override in subclasses
  }

  protected abstract handleViewSpecificMessage(raw: unknown): void;
}
```

**4. Delete `themeHandlers.ts`** after migration.

### Files to Modify

| File | Change |
|------|--------|
| `src/shared/schemas/commonViewMessages.ts` | CREATE |
| `src/shared/handlers/commonMessageHandlers.ts` | CREATE |
| `src/shared/BaseWebviewApp.ts` | UPDATE |
| `src/common/webview/themeHandlers.ts` | DELETE |
| `src/progressView/frontend/ProgressApp.ts` | UPDATE (remove themeHandlers import) |
| All other webview apps | UPDATE (extend refactored BaseWebviewApp) |

---

## 5.13 Normalization Layer Elimination

**Status:** ✅ **Already Complete** (Phase 3 work)

The following normalizers were eliminated during ProgressView migration:

| Normalizer | Status | Replacement |
|------------|--------|-------------|
| `normalizeFileListData()` | ✅ Deleted | `FileListSchema.safeParse()` |
| `normalizeToolUseLog()` | ✅ Deleted | `ToolUseLogSchema` |
| `normalizeMissingOutputsPayload()` | ✅ Deleted | `MissingOutputsSchema` |
| `normalizeStructuredContent()` | ✅ Deleted | Direct `.data` access |
| `tryParseJson()` | ✅ Deleted | Dead code removed |

**~160 lines removed** as part of Phase 3 Zod-first architecture.

**Principle applied:** Schema is the contract - frontend trusts validated data, no defensive normalization needed.

---

## Regression Fix Priority

### Immediate (Before Release)

| ID | Issue | Effort |
|----|-------|--------|
| R1 | Missing SET_SELECTED_AGENT handler | 30 min |
| Codicon | 403 Forbidden font error | 1 hour |
| H1 | Mark highlight colors swapped | 15 min |
| J1 | Missing debounce on instruction input | 30 min |

### High Priority (Next Sprint)

| ID | Issue | Effort |
|----|-------|--------|
| R2 | Missing Merge button | 30 min |
| CSS Tokens | All spacing 2-4px larger | 2 hours |
| H2-H5 | HistoryView styling regressions | 2 hours |
| P1-P2 | ProfileView missing styles | 1 hour |

### Medium Priority (Backlog)

| ID | Issue | Effort |
|----|-------|--------|
| R3-R4 | Missing LaTeXDiffs buttons | 1 hour |
| M1 | MainView missing CSS variables | 1 hour |
| J2-J4 | Minor JS behavioral differences | 2 hours |
| H6-H15 | Remaining HistoryView styles | 2 hours |

---

## Known Bugs (Code Review Findings)

These bugs were identified during code review and should be fixed as part of Phase 5.

### HIGH Severity

#### 5.9.1 State Never Persists When saveState Called While Blocked

**Location:** `MainApp.ts:948-992`

**Problem:** In `handleRestoreState`, `saveState()` is called at line 992 while still inside the try block after `blockSave()` was called at line 948. Since `saveState()` returns early when `saveBlockCount > 0`, the restored state is never actually persisted.

**Fix:** Move the `saveState()` call after the finally block that calls `unblockSave()`.

```typescript
// Current (broken)
try {
  this.blockSave();
  // ... restore state ...
  this.saveState(); // ❌ Called while blocked - does nothing!
} finally {
  this.unblockSave();
}

// Fixed
try {
  this.blockSave();
  // ... restore state ...
} finally {
  this.unblockSave();
}
this.saveState(); // ✅ Called after unblock
```

### MEDIUM Severity

#### 5.9.2 Active Flags Stored as Truthy String Arrays

**Location:** `MainApp.ts:506-510`

**Problem:** The `collectCurrentContext` method stores `${listId}Active` flags as string arrays `['true']` or `['false']` via `[String(isActive)] as unknown as string[]`, instead of boolean values. Since `['false']` is truthy in JavaScript, downstream code checking `if (message.inputFilesActive)` will incorrectly treat inactive file lists as active.

**Fix:** Store as proper boolean values or use `'true'`/`'false'` strings directly.

```typescript
// Current (broken)
multipleFileSelections[`${listId}Active`] = [
  String(isActive),
] as unknown as string[];
// Results in ['false'] which is truthy!

// Fixed
multipleFileSelections[`${listId}Active`] = isActive;
```

#### 5.9.3 Visibility State Not Saved After Removing Last File

**Location:** `MainApp.ts:outputFilesActive assignment`

**Problem:** In `handleRemoveFile`, when the last file is removed from a list, `multiFilesVisible` and `outputFilesActive` are updated to `false` after `updateMultiFiles` already called `saveState()`. These visibility changes are never persisted. After webview reload, the file list appears empty but the visibility toggle remains active.

**Fix:** Call `saveState()` after updating visibility flags, or update flags before calling `updateMultiFiles`.

#### 5.9.4 Send Correct fileType Casing for Multi-File Picker

**Location:** `MainApp.ts:1205-1209`

**Problem:** The webview sends `fileType` as `inputFiles`/`outputFiles` (lowercase) when requesting the multi-file picker. `FileManager.handleSelectMultipleFiles` builds the command name from this value and special-cases `OutputFiles` with a capital O. With lowercase, it generates `texra.selectinputFiles` (unregistered) and skips the output-files path.

**Fix:** Map to expected `InputFiles`/`OutputFiles` casing or normalize in the message handler.

```typescript
// Current
postMessage(MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES, {
  fileType: listId, // 'inputFiles' - lowercase
});

// Fixed
const fileTypeMap: Record<string, string> = {
  inputFiles: 'InputFiles',
  outputFiles: 'OutputFiles',
};
postMessage(MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES, {
  fileType: fileTypeMap[listId] ?? listId,
});
```

#### 5.9.5 Preserve Forced API-Key Banner When Model Lacks Key

**Location:** `MainApp.ts:1345-1347`

**Problem:** The banner is hidden whenever the selected model doesn't require a key, regardless of whether the extension explicitly asked to show it (e.g., missing global API key). Previously `SHOW_API_KEY_BANNER` forced the banner to stay visible; now `updateModelApiKeyBanner` clears it on any non-key model change.

**Fix:** Track a `forced` state (or respect a server-sent flag) before auto-hiding.

```typescript
// Add forced tracking
@state() private apiKeyBannerForced = false;

private updateModelApiKeyBanner(): void {
  if (this.apiKeyBannerForced) return; // Don't auto-hide if forced
  if (!this.apiKeyBanner.requiresKey) {
    this.apiKeyBanner = { visible: false };
  }
}

// In SHOW_API_KEY_BANNER handler
case MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER:
  this.apiKeyBannerForced = true;
  // ...
```

#### 5.9.6 Handle SET_SELECTED_AGENT Messages from Extension

**Location:** `MainApp.ts:311-315` (missing case)

**Problem:** The `handleMessage` switch does not handle `SET_SELECTED_AGENT`, but the extension still sends this command (e.g., `remoteAgentUtils.ts` selects a remote agent without restoring full state). With the handler removed, those messages are ignored and the agent dropdown never updates.

**Fix:** Add a case to update the appropriate agent selector and session type.

```typescript
case MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT: {
  const { agentId, sessionType } = message as { agentId?: string; sessionType?: string };
  if (sessionType) this.sessionType = sessionType;
  if (agentId) {
    // Update appropriate dropdown based on sessionType
    if (this.sessionType === 'toolUse') {
      this.selectedToolUseAgent = agentId;
    } else {
      this.selectedWorkflowAgent = agentId;
    }
  }
  break;
}
```

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

### Low: Over-Engineering

Creating too many small components.

**Mitigation:**

- Only extract when there's clear benefit (reuse, readability, testability)
- Follow established patterns from ProgressView

---

## References

- [Lit Documentation](https://lit.dev/)
- [Zod Documentation](https://zod.dev/)
- [ProgressView patterns](./prd-progressview-phase3.md) - Reference implementation
