---
created: 2026-01-25
updated: 2026-02-10
---

# PRD: ProgressView Modernization - Phase 5

> **Parent doc:** [2026-01-24-prd-progressview-modernization.md](./2026-01-24-prd-progressview-modernization.md)

## Overview

Phase 5 addresses technical debt accumulated during the MainView Lit migration. While MainView is functionally complete, it requires refactoring for long-term maintainability, security, and performance.

## Prerequisites

- Phase 4: MainView migrated to Lit ✅
- Phase 3b: ProgressView patterns established ✅
- Shared infrastructure in `src/shared/` ✅

## Status Summary

> **Overall Phase 5 Completion: 99% (regressions & validation)**
>
> Remaining refactoring tasks moved to [Phase 6](./2026-01-26-prd-progressview-phase6.md).
>
> - ✅ All critical regressions fixed (R1-R15, H1-H15, J1-J2, P1-P3, R11)
> - 🟡 R16 (FollowUp sticky positioning) partial - uses `flex-shrink: 0` but no sticky/fixed positioning
> - ✅ Zod message validation complete (mainViewMessages.ts, commonViewMessages.ts)
> - ✅ Cross-webview infrastructure unified (BaseWebviewApp pattern)
> - ✅ All JavaScript behavioral issues resolved (debounce, checkbox timing)
> - ➡️ Component extraction → [Phase 6](./2026-01-26-prd-progressview-phase6.md)
> - ➡️ Formatters migration → [Phase 6](./2026-01-26-prd-progressview-phase6.md)
>
> **Verified 2026-01-26** via code inspection.

### Critical Issues (Fix Immediately)

| ID      | View         | Issue                            | Status                                        |
| ------- | ------------ | -------------------------------- | --------------------------------------------- |
| R1      | MainView     | Missing `SET_SELECTED_AGENT`     | ✅ Fixed                                      |
| CODICON | All          | 403 Forbidden font loading error | ✅ Fixed                                      |
| H1      | History      | Mark highlight colors SWAPPED    | ✅ Fixed                                      |
| TOKENS  | All          | CSS spacing 2-4px larger         | ✅ Fixed (tokens correct)                     |
| **R12** | ProgressView | FollowUp section never visible   | ✅ Fixed                                      |
| **R13** | MainView     | Dropdowns invisible (clickable)  | ✅ Fixed                                      |
| **R14** | MainView     | Run button shows text not icon   | ✅ Fixed                                      |
| **R15** | ProgressView | User message shows plain text    | ✅ Fixed (CSS verified)                       |
| **R16** | ProgressView | FollowUp not fixed at bottom     | 🟡 Partial (`flex-shrink: 0` only, no sticky) |

### Migration Regressions (High Priority)

| ID  | View     | Severity | Issue                              | Status           |
| --- | -------- | -------- | ---------------------------------- | ---------------- |
| R2  | MainView | HIGH     | Missing Merge button               | ✅ Fixed         |
| R3  | MainView | MEDIUM   | Missing Refresh Edited File button | ✅ Fixed         |
| R4  | MainView | MEDIUM   | Missing Refresh Commit icon        | ✅ Fixed         |
| J1  | MainView | HIGH     | Missing debounce on instruction    | ✅ Fixed (300ms) |
| M1  | MainView | MEDIUM   | Missing CSS variables (5)          | ✅ Fixed         |

### HistoryView Regressions (15 Items)

| ID    | Severity | Issue                           | Status   |
| ----- | -------- | ------------------------------- | -------- |
| H1    | CRITICAL | Mark highlight colors swapped   | ✅ Fixed |
| H2    | MEDIUM   | Missing agent-category-badge    | ✅ Fixed |
| H3    | MEDIUM   | Different category badge colors | ✅ Fixed |
| H4    | LOW      | Missing config section bg       | ✅ Fixed |
| H5    | LOW      | Missing config key styling      | ✅ Fixed |
| H6    | LOW      | Missing hover/selected states   | ✅ Fixed |
| H7    | LOW      | Missing config-value styling    | ✅ Fixed |
| H8    | LOW      | Missing badge base styling      | ✅ Fixed |
| H9-15 | LOW      | Various element styles          | ✅ Fixed |

### ProfileView Regressions

| ID  | Severity | Issue                         | Status                                  |
| --- | -------- | ----------------------------- | --------------------------------------- |
| P1  | MEDIUM   | Missing model-access-summary  | ✅ Fixed                                |
| P2  | LOW      | Missing models-list-container | ✅ Fixed                                |
| P3  | LOW      | Missing error state guidance  | ✅ Fixed (ApiAccessSection.ts:36-44)    |
| R11 | LOW      | Unused signOut event          | ✅ Fixed (ProfileInfo.ts dispatches it) |

### JavaScript Behavioral Regressions

| ID  | View        | Severity | Issue                     | Status                                  |
| --- | ----------- | -------- | ------------------------- | --------------------------------------- |
| J1  | MainView    | HIGH     | Missing debounce          | ✅ Fixed (300ms)                        |
| J2  | MemoryView  | MEDIUM   | vscode-checkbox timing    | ✅ Fixed (MemoryToggle.ts:32-35)        |
| J3  | ProfileView | LOW      | Local state not persisted | N/A (no collapsible sections)           |
| J4  | HistoryView | LOW      | Filter state persistence  | N/A (no filter; search state persisted) |

### Refactoring Tasks

| Task                           | Status      | Impact                           |
| ------------------------------ | ----------- | -------------------------------- |
| Extract FileSelectGroup        | ➡️ Phase 6  | -300 lines from MainApp          |
| Extract BannerGroup components | ➡️ Phase 6  | -150 lines from MainApp          |
| Extract LatexDiffsSection      | ➡️ Phase 6  | -200 lines from MainApp          |
| Create shared message schemas  | ✅ Complete | mainViewMessages.ts (46 schemas) |
| Add Zod validation to MainApp  | ✅ Complete | All 34 message types validated   |
| Convert 37 inline arrows       | ➡️ Phase 6  | Performance                      |
| Delete duplicate debug handler | ✅ Complete | commonMessageHandlers.ts         |
| Install @types/sortablejs      | ✅ Complete | Complete type definitions        |

### Architectural Tasks (NEW - Phase 5 Scope)

| Task                           | Status      | Impact                                                                              |
| ------------------------------ | ----------- | ----------------------------------------------------------------------------------- |
| Formatters → TemplateResult    | ✅ Complete | 14 formatters use Lit templates; bridge pattern intentional for Light DOM streaming |
| renderLogs incremental updates | 🟡 Hybrid   | appendLog/updateLog are incremental; full rebuild only on stream switch             |

> **Open to ideas:** We welcome suggestions for more native Lit patterns that could improve the architecture. See [Phase 6 section 6.2b](./2026-01-26-prd-progressview-phase6.md#62b-lit-directive--native-feature-improvements) for areas open for exploration.
> | Create commonViewMessages.ts | ✅ Complete | Zod schemas for 5 common cmds |
> | themeHandlers.ts Zod migration | ✅ Complete | commonMessageHandlers.ts |
> | Eliminate normalization layers | ✅ Complete | -160 lines (done in Phase 3) |
> | Cross-webview command unification | ✅ Complete | BaseWebviewApp pattern |

---

## 5.1 Monolithic Component (Critical)

➡️ **Moved to [Phase 6](./2026-01-26-prd-progressview-phase6.md#61-monolithic-component-extraction)**

MainApp.ts (~2,900 lines) requires component extraction. See Phase 6 for target structure and extraction plan.

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
// themeHandlers.ts (should be .ts)
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

## 5.7-5.8 Performance Optimizations

➡️ **Moved to [Phase 6](./2026-01-26-prd-progressview-phase6.md#62-inline-arrow-functions-37-instances)**

- Inline arrow function extraction (37 instances)
- Computed getters for derived state

---

## Phase 5 Completed Work

### Message Validation ✅

1. Created `src/shared/schemas/mainViewMessages.ts` with 46 schemas
2. MainApp uses Zod validation via `safeParse()`
3. Deleted redundant debug mode handler

### Type Safety ✅

1. Installed `@types/sortablejs`
2. Migrated `themeHandlers.ts` to `commonMessageHandlers.ts` with Zod

### Success Metrics (Phase 5)

| Metric                 | Before | After   |
| ---------------------- | ------ | ------- |
| Message schemas        | 0      | 46 ✅   |
| Zod-validated messages | 0%     | 100% ✅ |
| `any` types            | 2      | 0 ✅    |
| Duplicate handlers     | 1      | 0 ✅    |

**Remaining metrics → [Phase 6](./2026-01-26-prd-progressview-phase6.md#success-metrics)**

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
const visible =
  this.agentCategory === 'workflow' && isTerminal && this.hasOutputFiles;
```

**But in StreamStatusService.ts:**

```typescript
if (status === STREAM_STATUS.READY) {
  statusMemory.delete(stream); // ← READY streams are DELETED, not stored
}
```

When `streamInfo.status` is looked up for READY streams, it returns `undefined`, not `'ready'`.
The check `undefined === 'ready'` is always **false**.

**Fix:** ✅ **Applied** - Option 1 implemented in `FollowupSection.ts:209`:

```typescript
const isTerminal =
  this.status === 'stopped' ||
  this.status === 'ready' ||
  this.status === undefined;
```

#### R15. User Message Shows Plain Text (HIGH)

**Location:** `src/progressView/frontend/formatters/logFormatters/messageFormatters.ts:39-48`

**Symptom:** User messages in ProgressView appear as plain text without the styled bubble/container.

**Expected behavior:** User messages should display with:

- Right-aligned container
- Background color with left border accent
- Icon and timestamp header
- Styled content area

**Current HTML generated:**

```html
<div class="user-message-container">
  <div class="user-message">
    <div class="user-message-header">
      <i class="codicon codicon-comment user-message-icon"></i>
      <span class="user-message-timestamp">...</span>
    </div>
    <div class="user-message-content">...</div>
  </div>
</div>
```

**Root Cause:** CSS styles defined in `user-message.css` are imported into `index.css`, but since `LogList.ts` uses Light DOM, styles should apply. Investigation needed to determine if:

1. CSS import chain is broken
2. CSS variables are missing in litStyles.ts tokens
3. Class names don't match between formatter and CSS

**Investigation Required:**

- Verify `user-message.css` is loaded in webview
- Check CSS variable values (`--spacing-small`, `--color-text-link`, etc.)
- Inspect DOM to see if classes are applied but styles aren't

#### R16. FollowUp Section Not Fixed at Bottom (MEDIUM) - 🟡 PARTIAL

**Location:** `src/progressView/frontend/components/WorkflowStreamContent.ts:137-144`

**Symptom:** FollowUp section position moves based on log message history length instead of staying fixed at the viewport bottom.

**Expected behavior:** FollowUp section should be pinned to the bottom of the stream panel, independent of log content height.

**Current layout:**

```
┌─────────────────────┐
│ Log messages...     │
│ (variable height)   │
├─────────────────────┤  ← FollowUp moves with content
│ Followup Section    │
└─────────────────────┘
```

**Target layout:**

```
┌─────────────────────┐
│ Log messages...     │
│ (scrollable)        │
├─────────────────────┤  ← FollowUp fixed at bottom
│ Followup Section    │
└─────────────────────┘
```

**Current state (2026-01-26):**

- `flex-shrink: 0` applied in `logs.css:29-31` - prevents shrinking
- **No sticky/fixed positioning** - section flows with content
- Partial fix only

**Fix approaches:**

1. CSS `position: sticky; bottom: 0;` on followup-section
2. Flex layout with `flex-grow: 1` on log area and fixed height followup
3. CSS Grid with `grid-template-rows: 1fr auto`

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
<vscode-button
  id="executeButton"
  appearance="primary"
  @click="${this.executeAgent}"
>
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

| Token              | Legacy (tokens.css) | Lit (litStyles.ts) | Difference |
| ------------------ | ------------------- | ------------------ | ---------- |
| `--spacing-tiny`   | 2px                 | 4px                | +2px       |
| `--spacing-small`  | 4px                 | 8px                | +4px       |
| `--spacing-medium` | 8px                 | 12px               | +4px       |
| `--spacing-large`  | 12px                | 16px               | +4px       |
| `--spacing-xlarge` | 20px                | 24px               | +4px       |

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
  background: var(--vscode-editor-findMatchBackground); /* ❌ Wrong */
  color: inherit;
}
mark.current-match {
  background: var(--vscode-editor-findMatchHighlightBackground); /* ❌ Wrong */
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
.badge.workflow {
  background-color: var(--vscode-editorInfo-background);
}
.badge.tool-use {
  background-color: var(--vscode-editorWarning-background);
}
```

**Lit (chart colors - different appearance):**

```css
.badge.workflow {
  background-color: var(--vscode-charts-blue);
}
.badge.tool-use {
  background-color: var(--vscode-charts-orange);
}
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
  min-width: 80px; /* Alignment for key-value pairs */
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

| Element                | Legacy Property         | Lit Status |
| ---------------------- | ----------------------- | ---------- |
| `.search-input`        | `width: 100%`           | May differ |
| `.search-container`    | Border, padding         | May differ |
| `.filter-dropdown`     | Consistent with VS Code | May differ |
| `.timestamp`           | Subtle foreground color | May differ |
| `.agent-name`          | Font weight, ellipsis   | May differ |
| `.instruction-preview` | Line clamp, ellipsis    | May differ |
| `.empty-state`         | Centered, muted color   | May differ |

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

| Variable             | Legacy Value | Used For             |
| -------------------- | ------------ | -------------------- |
| `--height-small`     | 24px         | Input heights        |
| `--height-button`    | 28px         | Button heights       |
| `--border-radius`    | 4px          | Container corners    |
| `--width-button-min` | 80px         | Button minimum width |
| `--opacity-normal`   | 1            | Normal state opacity |

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
  vscode.Uri.joinPath(
    extensionUri,
    'node_modules',
    '@vscode/codicons',
    'dist',
    'codicon.ttf',
  ),
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
  <button class="action-button delete-button" title="Delete"></button>
</button>
```

**Lit:**

```html
<button class="action-button" @click="${...}">
  <!-- Missing restore-button/delete-button -->
</button>
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

## Architectural Debt & Performance (ProgressView)

➡️ **Moved to [Phase 6](./2026-01-26-prd-progressview-phase6.md#66-architectural-debt-progressview)**

- A1. TaskGroupDomManager coupling
- A2. renderLogs() full DOM rebuild
- A3. Light DOM in ProgressView
- Formatter → TemplateResult migration
- renderLogs incremental updates

---

## 5.12 Cross-Webview Commands Architecture

**Problem:** 5 common commands are handled inconsistently across webviews with no Zod validation.

### Current State

| Command          | Pattern                 | Zod Schema | Type Safety |
| ---------------- | ----------------------- | ---------- | ----------- |
| `THEME_SET`      | `createThemeHandlers()` | ❌ None    | ❌ `any`    |
| `DEBUG_MODE_SET` | `BaseWebviewApp`        | ❌ None    | ❌ `any`    |
| `STATE_RESTORE`  | Manual                  | ❌ None    | ❌ `any`    |
| `WEBVIEW_READY`  | Auto-sent               | ❌ None    | ❌          |
| `ERROR`          | Generic                 | ❌ None    | ❌ `any`    |

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
import {
  CommonViewMessageSchema,
  COMMON_COMMANDS,
} from '@shared/schemas/commonViewMessages';

export interface CommonMessageContext {
  setTheme: (theme: string) => void;
  setDebugMode: (enabled: boolean) => void;
  restoreState: (state: Record<string, unknown>) => void;
  onError: (message: string, details?: unknown) => void;
}

export function handleCommonMessage(
  raw: unknown,
  context: CommonMessageContext,
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
      setDebugMode: (enabled) => {
        this.debugMode = enabled;
      },
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

| File                                           | Change                                    |
| ---------------------------------------------- | ----------------------------------------- |
| `src/shared/schemas/commonViewMessages.ts`     | CREATE                                    |
| `src/shared/handlers/commonMessageHandlers.ts` | CREATE                                    |
| `src/shared/BaseWebviewApp.ts`                 | UPDATE                                    |
| `src/common/webview/themeHandlers.ts`          | DELETE                                    |
| `src/progressView/frontend/ProgressApp.ts`     | UPDATE (remove themeHandlers import)      |
| All other webview apps                         | UPDATE (extend refactored BaseWebviewApp) |

---

## 5.13 Normalization Layer Elimination

**Status:** ✅ **Already Complete** (Phase 3 work)

The following normalizers were eliminated during ProgressView migration:

| Normalizer                         | Status     | Replacement                  |
| ---------------------------------- | ---------- | ---------------------------- |
| `normalizeFileListData()`          | ✅ Deleted | `FileListSchema.safeParse()` |
| `normalizeToolUseLog()`            | ✅ Deleted | `ToolUseLogSchema`           |
| `normalizeMissingOutputsPayload()` | ✅ Deleted | `MissingOutputsSchema`       |
| `normalizeStructuredContent()`     | ✅ Deleted | Direct `.data` access        |
| `tryParseJson()`                   | ✅ Deleted | Dead code removed            |

**~160 lines removed** as part of Phase 3 Zod-first architecture.

**Principle applied:** Schema is the contract - frontend trusts validated data, no defensive normalization needed.

---

## Regression Fix Priority

### Immediate (Before Release)

| ID      | Issue                                 |
| ------- | ------------------------------------- |
| R1      | Missing SET_SELECTED_AGENT handler    |
| Codicon | 403 Forbidden font error              |
| H1      | Mark highlight colors swapped         |
| J1      | Missing debounce on instruction input |

### High Priority

| ID         | Issue                           |
| ---------- | ------------------------------- |
| R2         | Missing Merge button            |
| CSS Tokens | All spacing 2-4px larger        |
| H2-H5      | HistoryView styling regressions |
| P1-P2      | ProfileView missing styles      |

### Medium Priority

| ID     | Issue                           |
| ------ | ------------------------------- |
| R3-R4  | Missing LaTeXDiffs buttons      |
| M1     | MainView missing CSS variables  |
| J2-J4  | Minor JS behavioral differences |
| H6-H15 | Remaining HistoryView styles    |

---

## Known Bugs (Code Review Findings)

➡️ **Moved to [Phase 6](./2026-01-26-prd-progressview-phase6.md#67-known-bugs-from-phase-5-code-review)**

6 bugs identified during code review (5.9.1-5.9.6) including state persistence, truthy array issues, and missing handlers.

---

## Risks

➡️ **Moved to [Phase 6](./2026-01-26-prd-progressview-phase6.md#risks)**

---

## References

- [Lit Documentation](https://lit.dev/)
- [Zod Documentation](https://zod.dev/)
- [ProgressView patterns](./2026-01-24-prd-progressview-phase3.md) - Reference implementation
