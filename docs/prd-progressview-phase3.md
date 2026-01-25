# PRD: ProgressView Modernization - Phase 3

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)

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

### Patterns Established

1. **State ownership**: Components own their form state; parents receive via events
2. **No DOM querying across boundaries**: Use refs within component, events across components
3. **Single `setStreamState` call**: All state updates in one place, no sequential band-aids
4. **Helper functions for complex updates**: Extract reusable logic (e.g., `updateNestedRounds`)
5. **Always clear before render**: Full re-renders must clear container first to prevent duplicates
6. **Stream switch = clear**: Changing active stream or filtering to empty category must clear log content
7. **Pending updates for race conditions**: Handle UPDATE_LOG arriving before APPEND_LOG via Map storage

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
| `common/webview/themeHandlers.js`  | ~50   | N/A                             | Phase 3a - migrate to TS          |
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

| JS Original          | TS Replacement              | Status  |
| -------------------- | --------------------------- | ------- |
| `htmlEncoding.js`    | `@shared/utils/html.ts`     | ✅ Done |
| `iconConstants.js`   | `@shared/utils/icons.ts`    | ✅ Done |
| `pathUtils.js`       | `@shared/utils/path.ts`     | ✅ Done |
| `stringUtils.js`     | `@shared/utils/string.ts`   | ✅ Done |
| `clipboardUtils.js`  | `@shared/utils/clipboard.ts`| ✅ Done |
| `domUtils.js` (partial) | `@shared/utils/dom.ts`   | ✅ Done |

**State managers migrated to `src/shared/state/`:**

| JS Original          | TS Replacement                       | Status  |
| -------------------- | ------------------------------------ | ------- |
| `ToggleStateStore.js`| `@shared/state/ToggleStateStore.ts`  | ✅ Done |
| `webviewState.js`    | `@shared/state/WebviewStateManager.ts`| ✅ Done |

**Migration stats:** JS imports reduced from 18 → 10 (44% reduction)

### Remaining JS Utilities (Require Architectural Changes)

**Key Finding**: All remaining JS utilities are **only imported by ProgressView**. They cannot be simply converted to TypeScript - they require Lit pattern replacement.

| JS File                     | Usages | Resolution                                                |
| --------------------------- | ------ | --------------------------------------------------------- |
| `templateUtils.js`          | 7      | Replace `createFromTemplate()` with Lit `html` (Phase 3b-3) |
| `dropdownUtils.js`          | 1      | Keep as local util; refactor when FollowupSection uses Lit fully |
| `textareaUtils.js`          | 1      | Keep as local util; VS Code textarea upgrade helper |
| `RecordingButtonManager.js` | 1      | Convert to Lit reactive controller (Phase 3b-2) |

### Review Checklist (Verify Nothing Missed)

Before considering Phase 3a complete, verify:

- [ ] **No JS imports in Lit components** (except the 4 deferred above)
- [ ] **All shared utilities have proper types** (no `any`, proper function signatures)
- [ ] **Index files updated** (`src/shared/utils/index.ts`, `src/shared/state/index.ts`)
- [ ] **Build compiles without errors** (`npm run compile`)
- [ ] **Original JS files can be deleted** (after all consumers migrated)

**Files to eventually delete from `src/common/modules/`:**

```
htmlEncoding.js      # ✅ Can delete - fully migrated
iconConstants.js     # ✅ Can delete - fully migrated
pathUtils.js         # ✅ Can delete - fully migrated
stringUtils.js       # ✅ Can delete - fully migrated
clipboardUtils.js    # ✅ Can delete - fully migrated
ToggleStateStore.js  # ✅ Can delete - fully migrated
webviewState.js      # ✅ Can delete - fully migrated
domUtils.js          # ⏳ Keep - still has unused functions that other views may need
templateUtils.js     # ⏳ Keep - used by formatters until Phase 3b-3
dropdownUtils.js     # ⏳ Keep - used by FollowupSection
textareaUtils.js     # ⏳ Keep - used by FollowUpInput
RecordingButtonManager.js  # ⏳ Keep - used by FollowUpInput
```

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

| Category            | Examples                             | Approach                             |
| ------------------- | ------------------------------------ | ------------------------------------ |
| Layout/Sizing       | Scrollbar, overflow, flex layout     | CSS fixes for custom elements        |
| State Transitions   | Stream switching, filter changes     | Clear-before-render patterns         |
| Data Ordering       | Updates arriving before creates      | Pending updates Map                  |
| Component Lifecycle | Event listeners not cleaned up       | `disconnectedCallback()` cleanup     |
| vscode-elements     | Radio buttons, dropdowns not syncing | Attribute + property sync            |
| Visual Regressions  | Colors, spacing, icons different     | CSS specificity, class name matching |

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

### Stabilization Deliverables

**Phase 3b-1: UI Parity**

| Item                          | Status         |
| ----------------------------- | -------------- |
| All layout issues resolved    | 🟡 In Progress |
| All data flow issues resolved | 🟡 In Progress |
| All vscode-element issues     | 🟡 In Progress |
| Visual parity achieved        | ⬜ Not Started |
| Full manual test pass         | ⬜ Not Started |

**Phase 3b-2: Utility Conversion (after 3a)**

| Item                                 | Status         |
| ------------------------------------ | -------------- |
| `textareaUtils.js` → TypeScript      | ⬜ Not Started |
| `RecordingButtonManager` → Lit       | ⬜ Not Started |
| Remove JS imports from FollowUpInput | ⬜ Not Started |

**Phase 3b-3: Formatter Conversion (after 3c)**

| Item                                    | Status         |
| --------------------------------------- | -------------- |
| Banner formatters → TemplateResult      | ⬜ Not Started |
| Tool formatters → TemplateResult        | ⬜ Not Started |
| Message formatters → TemplateResult     | ⬜ Not Started |
| Data formatters → TemplateResult        | ⬜ Not Started |
| `LogList` uses Lit rendering            | ⬜ Not Started |
| `TaskGroupDomManager` integrated to Lit | ⬜ Not Started |
| Delete `templates.ts`                   | ⬜ Not Started |
| Delete string-based `htmlBuilders.ts`   | ⬜ Not Started |

---

## Phase 3c: Migrate Other Webviews

**Prerequisites:**

- Phase 3a (shared utilities) complete or in progress
- Phase 3b (ProgressView stabilization) demonstrates patterns work

### Migration Order

| Order | Webview         | Handler Lines | JS Modules | Rationale                             |
| ----- | --------------- | ------------- | ---------- | ------------------------------------- |
| 1     | **HistoryView** | 160           | 7          | Simplest, good validation of patterns |
| 2     | **ProfileView** | 211           | 7          | Simple, mostly static display         |
| 3     | **MemoryView**  | 278           | 7          | Has toggle state, moderate complexity |
| 4     | **MainView**    | 461           | 80+        | Most complex after ProgressView       |

### Per-Webview Migration Template

For each webview:

#### Step 1: Schema Setup

```typescript
// src/{viewName}/schemas.ts
export * from '@shared/schemas'; // Common schemas
// Add view-specific schemas if needed
```

#### Step 2: Create Lit App

```typescript
// src/{viewName}/frontend/index.ts
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import '@shared/components';  // Shared components

@customElement('{view-name}-app')
export class {ViewName}App extends LitElement {
  // ...
}
```

#### Step 3: Add Webpack Entry

```javascript
// webpack.config.js
const {viewName}Config = {
  name: '{viewName}',
  entry: './src/{viewName}/frontend/index.ts',
  // ... same pattern as progressView
};
```

#### Step 4: Delete Legacy

```
DELETE: src/{viewName}/modules/
UPDATE: src/{viewName}/index.html
```

---

### HistoryView Migration

**Complexity:** Moderate (search + list rendering + collapsibles)

**Current structure:**

- `HistoryViewMessageHandler.ts`: 160 lines (TypeScript - keep as-is)
- `modules/`: 7 JS files, ~610 lines total
  - `script.js` - Entry point
  - `historyViewState.js` - Search index + toggle states (uses `WebviewStateManager`)
  - `messageHandlers.js` - Handles UPDATE_HISTORY, HISTORY_CLEARED
  - `domHandlers.js` - Coordinator extending `BaseDomHandler`
  - `uiManagers/HistoryRenderer.js` - List rendering with templates
  - `uiManagers/HistoryEventsManager.js` - Button/search event handlers
  - `uiManagers/SearchManager.js` - mark.js integration for highlighting

**Message types:**

| Command            | Direction         | Purpose                |
| ------------------ | ----------------- | ---------------------- |
| `GET_HISTORY_DATA` | webview → backend | Request history list   |
| `UPDATE_HISTORY`   | backend → webview | Send history items     |
| `RERUN_AGENT`      | webview → backend | Re-execute agent       |
| `RESTORE_AGENT`    | webview → backend | Load config to main    |
| `DELETE_AGENT`     | webview → backend | Remove history item    |
| `CLEAR_HISTORY`    | webview → backend | Clear all history      |
| `HISTORY_CLEARED`  | backend → webview | Confirm clear complete |

**Key features to preserve:**

- Search with mark.js text highlighting
- Prev/next match navigation (keyboard: Enter, Shift+Enter)
- Collapsible sections with persisted toggle states
- Category badges (workflow vs toolUse)
- File config display (input, media, reference, auxiliary, output)
- Tool config in collapsible extra details

**After migration:**

```
src/historyView/
├── frontend/
│   ├── index.ts                    # Entry, register components
│   ├── HistoryApp.ts               # Root: message routing, state (~200 lines)
│   └── components/
│       ├── SearchBar.ts            # Search input + nav buttons + mark.js
│       ├── HistoryList.ts          # List container with empty state
│       └── HistoryItem.ts          # Single item with collapsible details
├── styles/                         # Keep existing CSS
├── HistoryViewMessageHandler.ts    # Keep existing TypeScript
├── HistoryViewContentProvider.ts   # Update to load Lit bundle
└── HistoryViewProvider.ts          # Keep existing
```

**Migration approach:**

1. Create `HistoryApp.ts` with message handlers (UPDATE_HISTORY, HISTORY_CLEARED)
2. Create `SearchBar.ts` - integrate mark.js, emit search/navigate events
3. Create `HistoryItem.ts` - collapsible with toggle state via `ToggleStateStore`
4. Create `HistoryList.ts` - render items with `repeat()` directive
5. Update `HistoryViewContentProvider.ts` to load Lit bundle
6. Delete `modules/` directory and `script.js`

**Estimated: 3-4 days**

---

### ProfileView Migration

**Complexity:** Medium-High (conditional rendering based on auth state + tier)

**Current structure:**

- `ProfileViewMessageHandler.ts`: 211 lines (TypeScript - keep as-is)
- `modules/`: 6 JS files, ~636 lines total
  - `script.js` - Entry point
  - `profileViewState.js` - Auth state (authenticated, user, tier, remoteAgents)
  - `messageHandlers.js` - Handles UPDATE_PROFILE
  - `domHandlers.js` - Coordinator
  - `uiManagers/AgentsTable.js` - Remote agents table + auth UI sections
  - `uiManagers/ProfileEventsManager.js` - Sign in/out, API mode, agent select

**Message types:**

| Command               | Direction         | Purpose                  |
| --------------------- | ----------------- | ------------------------ |
| `GET_PROFILE_DATA`    | webview → backend | Request user profile     |
| `UPDATE_PROFILE`      | backend → webview | Send profile data        |
| `SELECT_AGENT`        | webview → backend | Select remote agent      |
| `SIGN_IN`             | webview → backend | Initiate authentication  |
| `SIGN_OUT`            | webview → backend | Sign out user            |
| `SET_API_ACCESS_MODE` | webview → backend | Toggle included/personal |

**Key features to preserve:**

- Conditional sections based on auth status:
  - Unauthenticated: Sign-in button
  - Authenticated: Profile info + agents table + API access section
- Tier-specific displays (Free/Max/Ultra):
  - Access expiration date
  - Model restrictions (`allowedModels`: null=all, []=none, string[]=specific)
- Remote agents table with columns: name, category, multi-output, description, visibility
- API access mode radio buttons (included vs personal keys)

**After migration:**

```
src/profileView/
├── frontend/
│   ├── index.ts                    # Entry, register components
│   ├── ProfileApp.ts               # Root: message routing, conditional layout (~250 lines)
│   └── components/
│       ├── ProfileInfo.ts          # Email, tier, access expiration display
│       ├── ApiAccessSection.ts     # Radio buttons + enabled providers
│       ├── AgentsTable.ts          # Remote agents table with select buttons
│       └── SignInPrompt.ts         # Unauthenticated state UI
├── styles/                         # Keep existing CSS
├── ProfileViewMessageHandler.ts    # Keep existing TypeScript
├── ProfileViewContentProvider.ts   # Update to load Lit bundle
└── ProfileViewProvider.ts          # Keep existing
```

**Migration approach:**

1. Create `ProfileApp.ts` with conditional rendering based on `authenticated` state
2. Create `SignInPrompt.ts` - simple sign-in button component
3. Create `ProfileInfo.ts` - display user email, tier badge, expiration
4. Create `ApiAccessSection.ts` - radio buttons with mode change events
5. Create `AgentsTable.ts` - table with `repeat()`, select button events
6. Update `ProfileViewContentProvider.ts` to load Lit bundle
7. Delete `modules/` directory and `script.js`

**Estimated: 4-5 days**

---

### MemoryView Migration

**Complexity:** Low-Medium (simple list + toggle state)

**Current structure:**

- `MemoryViewMessageHandler.ts`: 278 lines (TypeScript - keep as-is)
- `modules/`: 5 JS files, ~305 lines total
  - `script.js` - Entry point (sends TWO initial requests: data + enabled)
  - `memoryViewState.js` - Minimal state (just `items` array, no persistence)
  - `messageHandlers.js` - Handles UPDATE_MEMORY, UPDATE_MEMORY_ENABLED
  - `domHandlers.js` - Coordinator
  - `uiManagers/MemoryRenderer.js` - List rendering with metadata
  - `uiManagers/MemoryEventsManager.js` - Refresh, open folder, delete handlers

**Message types:**

| Command                 | Direction         | Purpose                    |
| ----------------------- | ----------------- | -------------------------- |
| `GET_MEMORY_DATA`       | webview → backend | Request memory file list   |
| `UPDATE_MEMORY`         | backend → webview | Send memory items          |
| `OPEN_MEMORY_FILE`      | webview → backend | Open file in editor        |
| `OPEN_MEMORY_FOLDER`    | webview → backend | Open folder in OS explorer |
| `DELETE_MEMORY`         | webview → backend | Delete a memory file       |
| `GET_MEMORY_ENABLED`    | webview → backend | Query toggle state         |
| `SET_MEMORY_ENABLED`    | webview → backend | Update toggle state        |
| `UPDATE_MEMORY_ENABLED` | backend → webview | Confirm toggle state       |

**Key features to preserve:**

- Memory enabled checkbox toggle
- Refresh and open folder toolbar buttons
- Memory items with:
  - File path display
  - Metadata (size, line count, updated date)
  - Content preview in collapsible
  - Open and delete action buttons
- Empty state display
- **Special:** Must wait for `vscode-checkbox` web component before setting checked

**After migration:**

```
src/memoryView/
├── frontend/
│   ├── index.ts                    # Entry, register components
│   ├── MemoryApp.ts                # Root: message routing, state (~150 lines)
│   └── components/
│       ├── MemoryToolbar.ts        # Refresh + open folder buttons
│       ├── MemoryToggle.ts         # Enable/disable checkbox
│       ├── MemoryList.ts           # List container with empty state
│       └── MemoryItem.ts           # Single item with preview collapsible
├── styles/                         # Keep existing CSS
├── MemoryViewMessageHandler.ts     # Keep existing TypeScript
├── MemoryViewContentProvider.ts    # Update to load Lit bundle
└── MemoryViewProvider.ts           # Keep existing
```

**Migration approach:**

1. Create `MemoryApp.ts` with two-phase initialization (data + enabled state)
2. Create `MemoryToggle.ts` - checkbox with proper web component lifecycle handling
3. Create `MemoryToolbar.ts` - refresh and open folder buttons
4. Create `MemoryItem.ts` - metadata display + preview collapsible
5. Create `MemoryList.ts` - render items with `repeat()`, handle empty state
6. Update `MemoryViewContentProvider.ts` to load Lit bundle
7. Delete `modules/` directory and `script.js`

**Estimated: 2-3 days**

---

### MainView Migration (Largest)

**Complexity:** High (file selection, recording, multiple managers)

**Current structure:**

- `MainViewMessageHandler.ts`: 461 lines (TypeScript - keep as-is)
- `modules/`: ~20 JS files, ~2,259 lines
- `managers/`: 5 TypeScript files (keep and integrate)
  - `InstructionManager.ts`
  - `FileManager.ts`
  - `ExecutionManager.ts`
  - `DiffManager.ts`
  - `BaseWebviewManager.ts`

**Key challenges:**

- Complex file selection UI with drag-and-drop
- Recording functionality (audio capture, transcription)
- Multiple manager classes with cross-dependencies
- Complex form state (file list, instruction, agent, model options)
- Diff/merge functionality integration
- Latexdiff configuration panel

**After migration:**

```
src/webview/
├── frontend/
│   ├── index.ts
│   ├── MainApp.ts                  # Root: message routing, orchestration
│   ├── store.ts                    # Form state types
│   └── components/
│       ├── FileSelector/
│       │   ├── FileSelector.ts     # Container with drag-drop
│       │   ├── FileList.ts         # Categorized file lists
│       │   └── FileItem.ts         # Single file with remove button
│       ├── InstructionPanel/
│       │   ├── InstructionPanel.ts # Instruction input + recording
│       │   └── RecordingButton.ts  # Audio recording UI
│       ├── AgentSelector.ts        # Agent + model dropdowns
│       ├── ActionButtons.ts        # Run, Polish, etc.
│       └── LatexdiffPanel.ts       # Diff configuration
├── managers/                       # Keep existing TypeScript
│   ├── InstructionManager.ts
│   ├── FileManager.ts
│   ├── ExecutionManager.ts
│   └── DiffManager.ts
├── styles/                         # Keep existing CSS
├── MainViewMessageHandler.ts       # Keep existing
└── MainViewContentProvider.ts      # Update to load Lit bundle
```

**Migration approach (incremental):**

1. **Week 1:** Create `MainApp.ts` shell, integrate with existing managers
2. **Week 1:** Create `AgentSelector.ts` and `ActionButtons.ts` (simpler components)
3. **Week 2:** Create `FileSelector/` components (most complex)
4. **Week 2:** Create `InstructionPanel/` with recording integration
5. **Week 3:** Create `LatexdiffPanel.ts`, final integration testing
6. Delete `modules/` directory and `script.js`

**Estimated: 2-3 weeks**

---

### Webview Migration Summary

| Webview     | JS Lines | Components | Complexity  | Estimate   |
| ----------- | -------- | ---------- | ----------- | ---------- |
| HistoryView | ~610     | 4          | Moderate    | 3-4 days   |
| ProfileView | ~636     | 5          | Medium-High | 4-5 days   |
| MemoryView  | ~305     | 5          | Low-Medium  | 2-3 days   |
| MainView    | ~2,259   | 8+         | High        | 2-3 weeks  |
| **Total**   | ~3,810   | 22+        |             | ~4-5 weeks |

---

## Build Configuration

### Final webpack.config.js

```javascript
const path = require('path');

const baseWebviewConfig = {
  target: 'web',
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@agent': path.resolve(__dirname, 'src/agent'),
      '@common': path.resolve(__dirname, 'src/common'),
      '@utils': path.resolve(__dirname, 'src/utils'),
      '@eventBus': path.resolve(__dirname, 'src/eventBus'),
      '@logger': path.resolve(__dirname, 'src/logger'),
    },
  },
  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
};

const webviewConfigs = [
  'progressView',
  'webview',
  'historyView',
  'profileView',
  'memoryView',
].map((name) => ({
  ...baseWebviewConfig,
  name,
  entry: `./src/${name}/frontend/index.ts`,
  output: {
    path: path.resolve(__dirname, `dist/${name}`),
    filename: 'bundle.js',
  },
}));

module.exports = [extensionConfig, ...webviewConfigs];
```

### tsconfig.json Updates

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "useDefineForClassFields": false,
    "paths": {
      "@shared/*": ["src/shared/*"],
      // ... existing paths
    },
  },
}
```

---

## Phase 3 Success Metrics

### Phase 3a (JS → TS Migration)

| Metric                            | Before | Current | Target |
| --------------------------------- | ------ | ------- | ------ |
| TS files in `src/shared/utils/`   | 0      | 5       | 8+     |
| JS imports in ProgressView        | 12     | 8       | 0      |
| Pure-function utils migrated      | 0      | 4       | 4      |
| ProgressView-only utils remaining | -      | 8       | 0\*    |

\*ProgressView-only utilities will be migrated to Lit patterns or local TS in Phase 3b.

### Phase 3b (ProgressView Stabilization & Native Conversion)

**3b-1: UI Parity**

| Metric                          | Before | After |
| ------------------------------- | ------ | ----- |
| Known UI regressions            | TBD    | 0     |
| Manual test checklist pass rate | TBD    | 100%  |

**3b-2: Utility Conversion**

| Metric                                | Before | After |
| ------------------------------------- | ------ | ----- |
| JS imports in ProgressView components | 3+     | 0     |
| `RecordingButtonManager` as JS class  | 1      | 0     |

**3b-3: Formatter Conversion**

| Metric                             | Before | After |
| ---------------------------------- | ------ | ----- |
| Formatters returning `HTMLElement` | 15+    | 0     |
| Manual `innerHTML` assignments     | 10+    | 0     |
| `document.createElement()` calls   | 30+    | 0     |
| String-based HTML builders         | 20+    | 0     |

### Phase 3c (Webview Migration)

| Metric                       | Before Phase 3 | After Phase 3 |
| ---------------------------- | -------------- | ------------- |
| Total webview JS files       | ~38            | 0             |
| Type coverage (all webviews) | ~50%           | 100%          |
| Lit components (total)       | ~15            | ~37           |
| Webviews using Lit           | 1              | 5             |

**Per-Webview Metrics:**

| Webview     | JS Files Deleted | Lit Components Added |
| ----------- | ---------------- | -------------------- |
| HistoryView | 7                | 4                    |
| ProfileView | 6                | 5                    |
| MemoryView  | 5                | 5                    |
| MainView    | 20               | 8                    |
| **Total**   | 38               | 22                   |

---

## Phase 3 Risks

### High: ProgressView UI Regressions (Phase 3b)

Unknown regressions may exist that only surface during real-world usage.

**Mitigation:**

- Systematic manual testing against legacy implementation
- User feedback collection
- Quick iteration on discovered issues
- Consider keeping legacy JS as reference (not deployed) until confident

### Medium: Pattern Drift (Phase 3c)

Each webview migration may deviate from established patterns.

**Mitigation**: Use Phase 2 shared infrastructure. Code review against ProgressView patterns.

### Medium: Nested Record Complexity

The `Record<string, Record<string, T[]>>` pattern for run/round data is error-prone.

**Mitigation**: Use `updateNestedRounds` helper. Consider flattening to `Map<CompositeKey, T[]>` if pattern keeps causing issues.

### Medium: MainView Complexity (Phase 3c)

MainView has more manager classes and cross-dependencies than ProgressView.

**Mitigation:**

- Keep existing TypeScript managers (`InstructionManager.ts`, etc.)
- Migrate JS modules incrementally, not all at once
- Test each component integration before proceeding

### Low: Diminishing Returns (Phase 3c)

Smaller webviews may not benefit as much from Lit migration.

**Mitigation**: Keep migrations simple for small webviews. Don't over-engineer.

### Low: mark.js Integration (HistoryView)

Search highlighting via mark.js may need adaptation for Lit's reactive rendering.

**Mitigation**:

- Use `ref()` directive to get DOM reference for mark.js
- Re-apply marks in `updated()` lifecycle when items change
- Consider extracting to reactive controller if pattern is useful elsewhere

### Low: vscode-checkbox Lifecycle (MemoryView)

The `vscode-checkbox` web component must be defined before setting `checked` property.

**Mitigation**:

- Use `customElements.whenDefined('vscode-checkbox')` before setting state
- Or use Lit's `@query` with `updateComplete` promise

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

## References

- [Lit Documentation](https://lit.dev/)
- [Lit Reactive Controllers](https://lit.dev/docs/composition/controllers/)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [GitLens](https://github.com/gitkraken/vscode-gitlens) - Production Lit webviews in VS Code
- [Zod Documentation](https://zod.dev/)
