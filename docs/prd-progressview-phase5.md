# PRD: ProgressView Modernization - Phase 5

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)

## Overview

Phase 5 addresses technical debt accumulated during the MainView Lit migration. While MainView is functionally complete, it requires refactoring for long-term maintainability, security, and performance.

## Prerequisites

- Phase 4: MainView migrated to Lit ✅
- Phase 3b: ProgressView patterns established ✅
- Shared infrastructure in `src/shared/` ✅

## Status Summary

### Migration Regressions (Fix First)

| ID  | View        | Severity | Issue                              | Status         |
| --- | ----------- | -------- | ---------------------------------- | -------------- |
| R1  | MainView    | CRITICAL | Missing `SET_SELECTED_AGENT`       | ⬜ Not Started |
| R2  | MainView    | HIGH     | Missing Merge button               | ⬜ Not Started |
| R3  | MainView    | MEDIUM   | Missing Refresh Edited File button | ⬜ Not Started |
| R4  | MainView    | MEDIUM   | Missing Refresh Commit icon        | ⬜ Not Started |
| R5  | HistoryView | MEDIUM   | Mark highlight colors swapped      | ⬜ Not Started |
| R6  | HistoryView | LOW      | Missing agent-category-badge class | ⬜ Not Started |
| R7  | HistoryView | LOW      | Different category badge colors    | ⬜ Not Started |
| R8  | HistoryView | LOW      | Missing config section background  | ⬜ Not Started |
| R9  | HistoryView | LOW      | Missing config key styling         | ⬜ Not Started |
| R10 | ProfileView | MEDIUM   | Missing error state for model info | ⬜ Not Started |
| R11 | ProfileView | LOW      | Unused signOut event               | ⬜ Not Started |

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
| Convert themeHandlers.js → TS  | ⬜ Not Started | Eliminate `any` types        |
| Install @types/sortablejs      | ⬜ Not Started | Complete type definitions    |

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
