---
created: 2026-01-25
updated: 2026-02-10
---

# PRD: ProgressView Modernization - Phase 4

> **Parent doc:** [2026-01-24-prd-progressview-modernization.md](./2026-01-24-prd-progressview-modernization.md)

## Overview

Phase 4 migrates the remaining webviews (HistoryView, ProfileView, MemoryView, MainView) to Lit + TypeScript architecture using patterns established in ProgressView.

## Prerequisites

- Phase 3a: Shared JS utilities migrated to TypeScript ✅
- Phase 3b: ProgressView stabilized with native Lit patterns ✅
- Shared infrastructure extracted in `src/shared/` ✅

## Status Summary

| Webview         | JS Lines | Components | Complexity  | Lit Migration | Zod Validation | Status      |
| --------------- | -------- | ---------- | ----------- | ------------- | -------------- | ----------- |
| **MemoryView**  | ~305     | 5          | Low         | ✅ Complete   | ✅ Complete    | ✅ Complete |
| **HistoryView** | ~610     | 4          | Medium      | ✅ Complete   | ✅ Complete    | ✅ Complete |
| **ProfileView** | ~636     | 5          | Medium-High | ✅ Complete   | ✅ Complete    | ✅ Complete |
| **MainView**    | ~2,259   | 1 (mono)   | High        | ✅ Complete   | ❌ **Missing** | 🟡 Phase 5  |

### Lit Native Compliance (Deep-Dive Analysis 2026-01-25)

| Webview         | Compliance | Notes                                                                         |
| --------------- | ---------- | ----------------------------------------------------------------------------- |
| **MemoryView**  | **100%**   | Shadow DOM, static styles, Zod validation, registry pattern                   |
| **HistoryView** | **100%**   | Shadow DOM, static styles, Zod validation, mark.js integration                |
| **ProfileView** | **100%**   | Shadow DOM, static styles, Zod validation, auth state handling                |
| **MainView**    | **75%**    | Shadow DOM, static styles, but **no Zod**, **monolithic**, **58-case switch** |

### Message Handling Pattern Consistency

| Webview          | Pattern           | Validation | Compliant |
| ---------------- | ----------------- | ---------- | --------- |
| **ProgressView** | ✅ Registry       | ✅ Zod     | ✅        |
| **MemoryView**   | ⚠️ if/else chain  | ✅ Zod     | 🟡        |
| **HistoryView**  | ⚠️ if/else chain  | ✅ Zod     | 🟡        |
| **ProfileView**  | ✅ Single handler | ✅ Zod     | ✅        |
| **MainView**     | ❌ 58-case switch | ❌ None    | ❌        |

**Target:** All webviews should use registry pattern with Zod validation (like ProgressView).

### Completed Migrations (2026-01-25)

**Commits:**

- `111e289a` - feat: migrate memory history profile webviews
- `0e1d13e0` - fix: align lit history behaviors

**MemoryView** - 4 Lit components created:

- `MemoryApp.ts` (root), `MemoryItem.ts`, `MemoryList.ts`, `MemoryToggle.ts`, `MemoryToolbar.ts`
- All legacy `modules/` deleted (constants.js, domHandlers.js, memoryViewState.js, messageHandlers.js, uiManagers/\*, script.js)

**HistoryView** - 3 Lit components created:

- `HistoryApp.ts` (root), `HistoryItem.ts`, `HistoryList.ts`, `SearchBar.ts` (with mark.js integration)
- All legacy `modules/` deleted

**ProfileView** - 4 Lit components created:

- `ProfileApp.ts` (root), `AgentsTable.ts`, `ApiAccessSection.ts`, `ProfileInfo.ts`, `SignInPrompt.ts`
- All legacy `modules/` deleted

**MainView:** Lit migration complete (2026-01-25). Requires Phase 5 refactoring for Zod validation and component extraction.

---

## Shared Infrastructure Migration Status

### JS Files Migration Status (Updated 2026-01-26)

| File                           | Status         | TS Replacement                          |
| ------------------------------ | -------------- | --------------------------------------- |
| `htmlEncoding.js`              | ✅ Deleted     | `@shared/utils/html.ts`                 |
| `stringUtils.js`               | ✅ Deleted     | `@shared/utils/string.ts`               |
| `pathUtils.js`                 | ✅ Deleted     | `@shared/utils/path.ts`                 |
| `clipboardUtils.js`            | ✅ Deleted     | `@shared/utils/clipboard.ts`            |
| `ToggleStateStore.js`          | ✅ Deleted     | `@shared/state/ToggleStateStore.ts`     |
| `webviewState.js`              | ✅ Deleted     | `@shared/state/WebviewStateManager.ts`  |
| `textareaUtils.js`             | ✅ Deleted     | `@shared/utils/textarea.ts`             |
| `dropdownUtils.js`             | ✅ Deleted     | `@shared/utils/dropdown.ts`             |
| `debounce.js`                  | ✅ Deleted     | `@utils/core` (perfect-debounce)        |
| `BaseWebviewMessageHandler.js` | ✅ Deleted     | `BaseViewMessageHandler.ts`             |
| `iconConstants.js`             | ⏳ Blocked     | TS exists, but imported by domUtils.js  |
| `domUtils.js`                  | ⏳ Blocked     | Partial (10/27 functions in TS)         |
| `templateUtils.js`             | ⏳ Blocked     | No TS replacement                       |
| `webviewContext.js`            | ⏳ Blocked     | registerMessageHandlers missing in TS   |
| `BaseDomHandler.js`            | ⏳ Infra       | Webview infrastructure, no migration    |
| `StreamScopedMap.js`           | ⏳ Infra       | Webview infrastructure, no migration    |
| `RecordingButtonManager.js`    | ⏳ In progress | TS controller exists, migration ongoing |

### Duplicate Constant Files to Delete

| File                               | Lines | Status                          |
| ---------------------------------- | ----- | ------------------------------- |
| `common/webview/commands.js`       | 298   | ✅ Deleted (TS version exists)  |
| `historyView/modules/constants.js` | 37    | ✅ Deleted (migration complete) |
| `profileView/modules/constants.js` | 41    | ✅ Deleted (migration complete) |
| `memoryView/modules/constants.js`  | 24    | ✅ Deleted (migration complete) |
| `webview/modules/constants.js`     | 162   | ✅ Deleted (MainView migrated)  |

---

## Migration Order

| Order | Webview         | Rationale                                      |
| ----- | --------------- | ---------------------------------------------- |
| 1     | **MemoryView**  | Simplest UI, validates migration patterns      |
| 2     | **HistoryView** | Search feature adds complexity, list rendering |
| 3     | **ProfileView** | Auth state, conditional sections               |
| 4     | **MainView**    | Most complex, benefits from earlier learnings  |

---

## Migration Best Practices

### Cross-Check with Legacy Implementation

During each webview migration, **always reference the legacy `index.html` and JS modules** to verify UI parity:

1. **Before starting**: Open the legacy webview in VS Code and screenshot/document all UI states
2. **During migration**: Compare Lit component output against legacy HTML structure
3. **After migration**: Systematically test all features side-by-side with legacy (if possible)

**Key areas to verify:**

- Element class names match CSS expectations
- Event handlers produce same behavior
- Loading states and empty states display correctly
- Collapsible sections preserve toggle state
- Keyboard shortcuts work identically
- Theme changes apply correctly (light/dark/high-contrast)

**Useful files to reference:**

- `src/{viewName}/index.html` - HTML structure, element IDs, CSS class names
- `src/{viewName}/modules/script.js` - Initialization sequence, event listeners
- `src/{viewName}/modules/constants.js` - Element IDs, class names, labels
- `src/{viewName}/modules/uiManagers/*.js` - Specific UI behavior logic

**Lesson from ProgressView**: Many regressions only surfaced during real-world usage. Proactive comparison with legacy code prevents this.

---

## Native Lit Patterns Checklist

These patterns were established in ProgressView Phase 2. All Phase 4 migrations MUST follow them.

### Component Patterns

| Pattern              | Requirement                                                                          |
| -------------------- | ------------------------------------------------------------------------------------ |
| Shadow DOM           | No `createRenderRoot()` override — use Lit default                                   |
| Static styles        | Use `static styles = [codiconStyles, animationStyles, css\`...\`]` array composition |
| Arrow functions      | Use arrow functions for event handlers to preserve `this` binding                    |
| @property vs @state  | `@property` for parent inputs, `@state` for internal state                           |
| @query               | Use for imperative DOM access only; await `updateComplete` first                     |
| Reflected properties | Use `reflect: true` for CSS `:host([attr])` targeting                                |

**Example:**

```typescript
@customElement('my-component')
export class MyComponent extends LitElement {
  static styles = [
    codiconStyles,
    css`
      :host {
        display: block;
      }
      :host([visible]) {
        display: flex;
      }
      .container {
        padding: var(--spacing-medium);
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) visible = false;
  @state() private loading = false;

  private handleClick = (event: Event): void => {
    this.loading = true;
  };
}
```

### Message Handling Patterns

| Pattern           | Requirement                                                      |
| ----------------- | ---------------------------------------------------------------- |
| Registry pattern  | Use `Record<string, Handler>` instead of switch statements       |
| Zod validation    | Validate at entry point with `safeParse()`, silent fail on error |
| Context interface | Pass `getState()`/`setState()` accessors, not direct state       |
| Pending updates   | Buffer out-of-order messages in component-scoped Map             |

**Example:**

```typescript
const MESSAGE_HANDLERS: Record<string, MessageHandler> = {
  [COMMANDS.UPDATE_DATA]: handleUpdateData,
  [COMMANDS.CLEAR]: handleClear,
};

export function handleUpdateData(raw: unknown, ctx: Context): void {
  const result = UpdateDataSchema.safeParse(raw);
  if (!result.success) return; // Silent fail
  ctx.setState((prev) => ({ ...prev, data: result.data }));
}
```

### Rendering Patterns

| Pattern       | When to Use                                |
| ------------- | ------------------------------------------ |
| `nothing`     | Element should be absent from DOM entirely |
| `?hidden`     | Element stays in DOM but visually hidden   |
| `repeat()`    | Lists with stable keys (sorted/reordered)  |
| `classMap()`  | Dynamic CSS class bindings                 |
| `live()`      | Textarea/input to preserve cursor position |
| `when()`      | Conditional template blocks                |
| `ifDefined()` | Optional attributes                        |

### Event Patterns

| Pattern               | Requirement                                                |
| --------------------- | ---------------------------------------------------------- |
| Custom events factory | Centralized event creation with typed details              |
| bubbles + composed    | All custom events must use `bubbles: true, composed: true` |
| Event naming          | Use kebab-case: `item-select`, `filter-change`             |

**Example:**

```typescript
// events.ts
function createEvent<T>(type: string, detail: T): CustomEvent<T> {
  return new CustomEvent(type, { detail, bubbles: true, composed: true });
}

export const ViewEvents = {
  itemSelect: (detail: { id: string }) => createEvent('item-select', detail),
  refresh: () => createEvent('refresh', undefined),
};

// Usage in component
this.dispatchEvent(ViewEvents.itemSelect({ id: item.id }));
```

### CSS Patterns

| Pattern         | Requirement                                                |
| --------------- | ---------------------------------------------------------- |
| Design tokens   | Access via CSS custom properties (`var(--spacing-medium)`) |
| Shared styles   | Import from `@shared/styles/litStyles.ts`                  |
| Codicon styles  | Import `codiconStyles` for icon fonts                      |
| No external CSS | All component styles in `static styles` array              |

---

## MemoryView Migration

**Complexity:** Low-Medium (simple list + toggle state)

### Current Structure

- `MemoryViewMessageHandler.ts`: 278 lines (TypeScript - keep as-is)
- `modules/`: 5 JS files, ~305 lines total
  - `script.js` - Entry point (sends TWO initial requests: data + enabled)
  - `memoryViewState.js` - Minimal state (just `items` array, no persistence)
  - `messageHandlers.js` - Handles UPDATE_MEMORY, UPDATE_MEMORY_ENABLED
  - `domHandlers.js` - Coordinator
  - `uiManagers/MemoryRenderer.js` - List rendering with metadata
  - `uiManagers/MemoryEventsManager.js` - Refresh, open folder, delete handlers

### Message Types

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

### Target Structure

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

### Key Features to Preserve

- Memory enabled checkbox toggle
- Refresh and open folder toolbar buttons
- Memory items with:
  - File path display
  - Metadata (size, line count, updated date)
  - Content preview in collapsible
  - Open and delete action buttons
- Empty state display
- **Special:** Must wait for `vscode-checkbox` web component before setting checked

---

## HistoryView Migration

**Complexity:** Moderate (search + list rendering + collapsibles)

### Current Structure

- `HistoryViewMessageHandler.ts`: 160 lines (TypeScript - keep as-is)
- `modules/`: 7 JS files, ~610 lines total
  - `script.js` - Entry point
  - `historyViewState.js` - Search index + toggle states (uses `WebviewStateManager`)
  - `messageHandlers.js` - Handles UPDATE_HISTORY, HISTORY_CLEARED
  - `domHandlers.js` - Coordinator extending `BaseDomHandler`
  - `uiManagers/HistoryRenderer.js` - List rendering with templates
  - `uiManagers/HistoryEventsManager.js` - Button/search event handlers
  - `uiManagers/SearchManager.js` - mark.js integration for highlighting

### Message Types

| Command            | Direction         | Purpose                |
| ------------------ | ----------------- | ---------------------- |
| `GET_HISTORY_DATA` | webview → backend | Request history list   |
| `UPDATE_HISTORY`   | backend → webview | Send history items     |
| `RERUN_AGENT`      | webview → backend | Re-execute agent       |
| `RESTORE_AGENT`    | webview → backend | Load config to main    |
| `DELETE_AGENT`     | webview → backend | Remove history item    |
| `CLEAR_HISTORY`    | webview → backend | Clear all history      |
| `HISTORY_CLEARED`  | backend → webview | Confirm clear complete |

### Target Structure

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

### Key Features to Preserve

- Search with mark.js text highlighting
- Prev/next match navigation (keyboard: Enter, Shift+Enter)
- Collapsible sections with persisted toggle states
- Category badges (workflow vs toolUse)
- File config display (input, media, reference, auxiliary, output)
- Tool config in collapsible extra details

### Special Consideration: mark.js Integration

Search highlighting via mark.js may need adaptation for Lit's reactive rendering.

**Mitigation:**

- Use `ref()` directive to get DOM reference for mark.js
- Re-apply marks in `updated()` lifecycle when items change
- Consider extracting to reactive controller if pattern is useful elsewhere

---

## ProfileView Migration

**Complexity:** Medium-High (conditional rendering based on auth state + tier)

### Current Structure

- `ProfileViewMessageHandler.ts`: 211 lines (TypeScript - keep as-is)
- `modules/`: 6 JS files, ~636 lines total
  - `script.js` - Entry point
  - `profileViewState.js` - Auth state (authenticated, user, tier, remoteAgents)
  - `messageHandlers.js` - Handles UPDATE_PROFILE
  - `domHandlers.js` - Coordinator
  - `uiManagers/AgentsTable.js` - Remote agents table + auth UI sections
  - `uiManagers/ProfileEventsManager.js` - Sign in/out, API mode, agent select

### Message Types

| Command               | Direction         | Purpose                  |
| --------------------- | ----------------- | ------------------------ |
| `GET_PROFILE_DATA`    | webview → backend | Request user profile     |
| `UPDATE_PROFILE`      | backend → webview | Send profile data        |
| `SELECT_AGENT`        | webview → backend | Select remote agent      |
| `SIGN_IN`             | webview → backend | Initiate authentication  |
| `SIGN_OUT`            | webview → backend | Sign out user            |
| `SET_API_ACCESS_MODE` | webview → backend | Toggle included/personal |

### Target Structure

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

### Key Features to Preserve

- Conditional sections based on auth status:
  - Unauthenticated: Sign-in button
  - Authenticated: Profile info + agents table + API access section
- Tier-specific displays (Free/Max/Ultra):
  - Access expiration date
  - Model restrictions (`allowedModels`: null=all, []=none, string[]=specific)
- Remote agents table with columns: name, category, multi-output, description, visibility
- API access mode radio buttons (included vs personal keys)

---

## MainView Migration (Largest)

**Complexity:** High (file selection, recording, multiple managers)

**Status:** ✅ Migrated to Lit (2026-01-25) — but requires **[Phase 5 refactoring](./2026-01-25-prd-progressview-phase5.md)**

### Current Structure (Post-Migration)

- `MainViewMessageHandler.ts`: 461 lines (TypeScript - backend)
- `frontend/MainApp.ts`: **~2,737 lines** ⚠️ MONOLITHIC
- `managers/`: 5 TypeScript files (integrated)
  - `InstructionManager.ts`
  - `FileManager.ts`
  - `ExecutionManager.ts`
  - `DiffManager.ts`
  - `BaseWebviewManager.ts`
- Legacy `modules/`: ✅ Deleted

### Key Challenges (Addressed)

- ✅ Complex file selection UI with drag-and-drop
- ✅ Recording functionality (audio capture, transcription)
- ✅ Multiple manager classes with cross-dependencies
- ✅ Complex form state (file list, instruction, agent, model options)
- ✅ Diff/merge functionality integration
- ✅ Latexdiff configuration panel

### Phase 5 Required (Post-Migration Refactoring)

MainView migration is functionally complete but requires Phase 5 refactoring for maintainability:

- **Monolithic component:** 2,737 lines needs extraction into 6+ components
- **Missing validation:** 58 message types lack Zod validation (security risk)
- **Known bugs:** 6 bugs identified during code review (see Phase 5)

**See [2026-01-25-prd-progressview-phase5.md](./2026-01-25-prd-progressview-phase5.md) for full details.**

---

## Build Configuration

### webpack.config.js Updates

```javascript
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
```

---

## Success Metrics

### Per-Webview Metrics

| Webview     | JS Files Deleted | Lit Components Added |
| ----------- | ---------------- | -------------------- |
| MemoryView  | 5                | 5                    |
| HistoryView | 7                | 4                    |
| ProfileView | 6                | 5                    |
| MainView    | 20               | 8                    |
| **Total**   | 38               | 22                   |

### Overall Metrics After Phase 4

| Metric                       | Before Phase 4 | After Phase 4 |
| ---------------------------- | -------------- | ------------- |
| Total webview JS files       | ~38            | 0             |
| Type coverage (all webviews) | ~60%           | 100%          |
| Lit components (total)       | ~15            | ~37           |
| Webviews using Lit           | 1              | 5             |

---

## Risks

### Medium: Pattern Drift

Each webview migration may deviate from established patterns.

**Mitigation**: Use Phase 2 shared infrastructure. Code review against ProgressView patterns.

### Medium: MainView Complexity

MainView has more manager classes and cross-dependencies than ProgressView.

**Mitigation:**

- Keep existing TypeScript managers (`InstructionManager.ts`, etc.)
- Migrate JS modules incrementally, not all at once
- Test each component integration before proceeding

### Low: Diminishing Returns

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

## Cleanup After All Migrations

### JS Files to Delete

**Already deleted (2026-01-25):**

```
src/memoryView/modules/     ✅ All deleted
src/historyView/modules/    ✅ All deleted
src/profileView/modules/    ✅ All deleted
src/webview/modules/        ✅ All deleted (MainView migrated)
```

**Shared utilities deleted (2026-01-26):**

These files had complete TS replacements in `@shared/` and zero active imports:

```
src/common/modules/
├── htmlEncoding.js         ✅ Deleted → @shared/utils/html.ts
├── stringUtils.js          ✅ Deleted → @shared/utils/string.ts
├── pathUtils.js            ✅ Deleted → @shared/utils/path.ts
├── clipboardUtils.js       ✅ Deleted → @shared/utils/clipboard.ts
├── ToggleStateStore.js     ✅ Deleted → @shared/state/ToggleStateStore.ts
├── webviewState.js         ✅ Deleted → @shared/state/WebviewStateManager.ts
├── textareaUtils.js        ✅ Deleted → @shared/utils/textarea.ts
├── dropdownUtils.js        ✅ Deleted → @shared/utils/dropdown.ts
├── debounce.js             ✅ Deleted → @utils/core (perfect-debounce)
└── BaseWebviewMessageHandler.js ✅ Deleted → BaseViewMessageHandler.ts
```

Also cleaned up:

- Removed 10 obsolete URI entries from `BaseViewContentProvider.ts`
- Removed 8 obsolete type declarations from `common-modules.d.ts`
- Updated `pathUtils.test.js` to import from `@shared/utils/path`

**Remaining JS files (have blockers):**

```
src/common/modules/
├── iconConstants.js        ⏳ Blocked: imported by domUtils.js
├── domUtils.js             ⏳ Blocked: only 10/27 functions migrated to TS
├── templateUtils.js        ⏳ Blocked: no TS replacement exists
├── webviewContext.js       ⏳ Blocked: registerMessageHandlers missing in TS
├── BaseDomHandler.js       ⏳ Webview infrastructure (no migration needed)
├── StreamScopedMap.js      ⏳ Webview infrastructure (no migration needed)
└── RecordingButtonManager.js ⏳ Migration in progress (TS controller exists)
```

**Cleanup summary:**

- Phase 4 deleted: ~1,551 lines (memoryView + historyView + profileView modules)
- Phase 4 shared utils deleted: 10 files (~800 lines)
- Remaining: 11 JS files, 3 CSS files to delete (see below)

---

## Final JS/CSS Cleanup (Audited 2026-01-26)

### Deleted (2026-01-26) - Zero External Imports

**JS Constants (3 files)** - TS replacements exist in `@shared/schemas/`:

```
src/common/constants/agentTypes.js    ✅ DELETED
src/common/constants/streamStatus.js  ✅ DELETED
src/common/constants/todoStatus.js    ✅ DELETED
```

**JS Dead Code (3 files)** - Never imported anywhere:

```
src/common/modules/StreamScopedMap.js      ✅ DELETED
src/common/modules/webviewContext.js       ✅ DELETED
src/common/modules/files/baseFileUtils.js  ✅ DELETED
```

**CSS Duplicates (3 files)** - Replaced by Lit TypeScript styles:

```
src/historyView/styles/index.css  ✅ DELETED → historyViewStyles.ts
src/memoryView/styles/index.css   ✅ DELETED → Lit component styles
src/profileView/styles/index.css  ✅ DELETED → profileViewStyles.ts
```

### Remaining JS Files (5 files) - Internal Cross-References Only

> **ACTION REQUIRED:** These 5 files form a closed dependency chain with **zero external consumers**.
> They can be safely deleted together in a single cleanup pass. After deletion, also remove their
> entries from `BaseViewContentProvider.ts` and type declarations from `common-modules.d.ts`.

These files only import each other (no external TypeScript imports):

| File                        | Imported By                         | Status               |
| --------------------------- | ----------------------------------- | -------------------- |
| `iconConstants.js`          | domUtils.js                         | ⏳ Delete with chain |
| `templateUtils.js`          | RecordingButtonManager.js           | ⏳ Delete with chain |
| `domUtils.js`               | BaseDomHandler.js, templateUtils.js | ⏳ Delete with chain |
| `RecordingButtonManager.js` | (none - never instantiated)         | ⏳ Delete with chain |
| `BaseDomHandler.js`         | (none - never imported)             | ⏳ Delete with chain |

```
src/common/modules/
├── iconConstants.js        # Chevron classes, agent decorators
├── templateUtils.js        # createFromTemplate, createCodicon
├── domUtils.js             # DOM utilities (40+ functions)
├── RecordingButtonManager.js # Recording button class
└── BaseDomHandler.js       # Base class for DOM handlers
```

**Why safe to delete:**

- Main view migration (commit 12c8efc75) removed all import map references
- Modern webviews use Lit components with webpack bundles
- No TypeScript code imports these modules
- All functionality replicated in Lit components or `@shared/` utilities

### CSS Files to Keep

| File                        | Reason                                           |
| --------------------------- | ------------------------------------------------ |
| `common/styles/common.css`  | Light DOM baseline for all webviews              |
| `shared/styles/tokens.css`  | Design tokens (consider dedup with litStyles.ts) |
| `progressView/styles/*.css` | Formatter output + Light DOM layout (19 files)   |

**Note:** ProgressView CSS files must remain as Light DOM CSS because:

- LogList, TaskGroupList are Light DOM components
- Formatters generate HTML strings (not Lit templates) that need external CSS
