# PRD: ProgressView Modernization - Phase 4

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)

## Overview

Phase 4 migrates the remaining webviews (HistoryView, ProfileView, MemoryView, MainView) to Lit + TypeScript architecture using patterns established in ProgressView.

## Prerequisites

- Phase 3a: Shared JS utilities migrated to TypeScript ✅
- Phase 3b: ProgressView stabilized with native Lit patterns ✅
- Shared infrastructure extracted in `src/shared/` ✅

## Status Summary

| Webview         | JS Lines | Components | Complexity  | Status         |
| --------------- | -------- | ---------- | ----------- | -------------- |
| **MemoryView**  | ~305     | 4          | Low         | ✅ Complete    |
| **HistoryView** | ~610     | 3          | Medium      | ✅ Complete    |
| **ProfileView** | ~636     | 4          | Medium-High | ✅ Complete    |
| **MainView**    | ~2,259   | 8+         | High        | ⬜ Not Started |

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

**Remaining:** MainView migration not yet started. See migration approach below.

---

## Shared Infrastructure to Migrate First

Before migrating individual webviews, these shared JS utilities in `src/common/modules/` need attention:

### JS Files Used by Multiple Webviews

| File                  | Used By                                        | Migration Path                                         |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| `htmlEncoding.js`     | HistoryView, MemoryView, ProfileView           | Already has TS: `@shared/utils/html.ts`                |
| `iconConstants.js`    | HistoryView, MainView, domUtils.js             | Already has TS: `@shared/utils/icons.ts`               |
| `pathUtils.js`        | BaseViewContentProvider, test file             | Already has TS: `@shared/utils/path.ts`                |
| `stringUtils.js`      | MemoryView, MainView                           | Already has TS: `@shared/utils/string.ts`              |
| `clipboardUtils.js`   | BaseViewContentProvider                        | Already has TS: `@shared/utils/clipboard.ts`           |
| `ToggleStateStore.js` | HistoryView                                    | Already has TS: `@shared/state/ToggleStateStore.ts`    |
| `webviewState.js`     | HistoryView, MemoryView, ProfileView, MainView | Already has TS: `@shared/state/WebviewStateManager.ts` |
| `domUtils.js`         | Multiple views                                 | Partially migrated to `@shared/utils/dom.ts`           |
| `dropdownUtils.js`    | FollowupSection, MainView                      | Keep as local util or inline                           |

**Strategy:** TypeScript versions already exist in `@shared/`. When migrating each webview:

1. Update imports from `@common/modules/*.js` to `@shared/*`
2. After all webviews migrated, delete the JS originals

### Duplicate Constant Files to Delete

| File                               | Lines | Status                                |
| ---------------------------------- | ----- | ------------------------------------- |
| `common/webview/commands.js`       | 298   | ⏳ **DELETE NOW** - TS version exists |
| `historyView/modules/constants.js` | 37    | ✅ Deleted (migration complete)       |
| `profileView/modules/constants.js` | 41    | ✅ Deleted (migration complete)       |
| `memoryView/modules/constants.js`  | 24    | ✅ Deleted (migration complete)       |
| `webview/modules/constants.js`     | 162   | ⬜ Delete with MainView migration     |

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

### Current Structure

- `MainViewMessageHandler.ts`: 461 lines (TypeScript - keep as-is)
- `modules/`: ~20 JS files, ~2,259 lines
- `managers/`: 5 TypeScript files (keep and integrate)
  - `InstructionManager.ts`
  - `FileManager.ts`
  - `ExecutionManager.ts`
  - `DiffManager.ts`
  - `BaseWebviewManager.ts`

### Key Challenges

- Complex file selection UI with drag-and-drop
- Recording functionality (audio capture, transcription)
- Multiple manager classes with cross-dependencies
- Complex form state (file list, instruction, agent, model options)
- Diff/merge functionality integration
- Latexdiff configuration panel

### Target Structure

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

### Migration Approach (Incremental)

1. **Week 1:** Create `MainApp.ts` shell, integrate with existing managers
2. **Week 1:** Create `AgentSelector.ts` and `ActionButtons.ts` (simpler components)
3. **Week 2:** Create `FileSelector/` components (most complex)
4. **Week 2:** Create `InstructionPanel/` with recording integration
5. **Week 3:** Create `LatexdiffPanel.ts`, final integration testing
6. Delete `modules/` directory and `script.js`

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
```

**Remaining after MainView migration:**

```
src/common/modules/
├── htmlEncoding.js
├── iconConstants.js
├── pathUtils.js
├── stringUtils.js
├── clipboardUtils.js
├── ToggleStateStore.js
├── webviewState.js
├── domUtils.js
├── dropdownUtils.js
├── templateUtils.js
├── textareaUtils.js
└── RecordingButtonManager.js

src/common/webview/commands.js  ← DELETE NOW (TS version exists)

src/webview/modules/ (MainView - last remaining)
```

**Cleanup summary:**

- Deleted: ~1,551 lines (memoryView + historyView + profileView modules)
- Remaining: ~612 duplicate constant lines + ~1,872 shared utility lines + ~2,259 MainView JS lines
