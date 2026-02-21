# PRD: Progress View Placement — Sidebar-First with Pop-Out

## Status: Draft

## Problem

The progress view currently lives in VS Code's **bottom panel area** (alongside Terminal, Problems, Output). This placement is fundamentally wrong for the view's content:

1. **Vertical content in a horizontal slot**: The progress view renders vertically stacked content — logs, task groups, todos, usage panel, follow-up input, approval cards — inside a panel that gives ~200px of height and full viewport width. Users constantly scroll a tiny viewport.
2. **Split-layout mismatch**: The view uses an 80/20 `vscode-split-layout` (content | stream tabs) that benefits from vertical space, not horizontal. The bottom panel gives the opposite of what it needs.
3. **Split attention**: The user workflow is sequential — configure in the sidebar, then monitor in the bottom panel. Eyes bounce between two distant areas of the screen.
4. **Disconnected from input**: The main view (sidebar) and progress view (bottom panel) feel like unrelated tools rather than two stages of a single workflow.

### Current Layout

```
┌──────────────────────────────────────────────────────┐
│ Primary Sidebar│  Editor Area                        │
│ ┌────────────┐ │  ┌──────────────────────────────┐   │
│ │ Main View  │ │  │ main.tex                     │   │
│ │ (Input,    │ │  │                              │   │
│ │  Ref,      │ │  │                              │   │
│ │  Agent,    │ │  │                              │   │
│ │  Execute)  │ │  │                              │   │
│ └────────────┘ │  └──────────────────────────────┘   │
│                │  ┌──────────────────────────────┐   │
│                │  │ Bottom Panel (Progress View)  │   │  ← ~200px height
│                │  │ content...  │ tabs │           │   │
│                │  └──────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

The progress view is designed like a full application (its own navigation, interactive workflows, dense vertical content) but placed in a widget slot.

### VS Code View Locations

As of VS Code 1.106 (October 2025), extensions can place view containers in three locations:

| Location                      | `viewsContainers` key | Characteristics                                        |
| ----------------------------- | --------------------- | ------------------------------------------------------ |
| **Primary Sidebar** (left)    | `activitybar`         | Full height, ~300-400px wide, activity bar icons       |
| **Bottom Panel**              | `panel`               | Full width, ~200px tall, tab-based                     |
| **Secondary Sidebar** (right) | `secondarySidebar`    | Full height, ~300-400px wide, independent from primary |

The `secondarySidebar` contribution point was finalized in VS Code 1.106 and is now stable. This gives the progress view a natural home — the secondary sidebar is where VS Code places agent/AI tools (Chat, Copilot), and monitoring agent progress fits that pattern.

## Design

### Core Principle

The progress view **defaults to the primary sidebar**, sharing the same activity bar container as the main view. The two views swap back and forth — the user sees one at a time. The progress view can be **popped out** to either the editor area or the secondary sidebar for more space, and **popped back** to the primary sidebar.

### Layout: Primary Sidebar Mode (Default)

The progress view replaces the main view in the primary sidebar when activated. The left/right split is preserved — stream tabs render as a narrow column (icons + truncated names) at ~60px, content fills the remaining ~240px at default sidebar width.

```
Before Execute:              After Execute:
┌──────────────┐             ┌──────────────┐
│ Main View    │             │ Progress View│
│ ┌──────────┐ │             │ ┌────────┬──┐│
│ │Input [v] │ │             │ │ > Anal…│s1││
│ │Ref   [v] │ │             │ │ > Read…│s2││
│ │Aux   [v] │ │   Execute   │ │ > Gen… │s3││
│ │──────────│ │ ──────────→ │ │        │  ││
│ │[Workflow]│ │             │ │────────│  ││
│ │┌────────┐│ │             │ │Tasks   │  ││
│ ││instruc.││ │             │ │ ☑ Claim│  ││
│ │└────────┘│ │             │ │────────│  ││
│ │[Execute▶]│ │             │ │[Follow]│  ││
│ └──────────┘ │             │ └────────┴──┘│
│              │             │  [← Back]    │
└──────────────┘             └──────────────┘
```

### Layout: Editor Mode (Pop-Out)

A toolbar button pops the progress view into the editor area as a tab. The primary sidebar reverts to the main view. Full editor width gives the left/right split room to breathe.

```
┌──────────────────────────────────────────────────────┐
│ Primary Sidebar│  Editor Area                        │
│ ┌────────────┐ │  ┌──────────────────────────────┐   │
│ │ Main View  │ │  │ main.tex │ ProgressBoard │    │   │
│ │ (restored) │ │  │──────────────────────────────│   │
│ │            │ │  │ > Analyzing...  │ stream-1 ▶ │   │
│ │            │ │  │ > Reading refs  │ stream-2   │   │
│ │            │ │  │ > Generating…   │ stream-3   │   │
│ │            │ │  │                 │            │   │
│ │            │ │  │ Tasks [2/5]     │            │   │
│ │            │ │  │ ☑ Extract claims│            │   │
│ │            │ │  │─────────────────│            │   │
│ │            │ │  │ [Follow-up...]  │            │   │
│ └────────────┘ │  └──────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

### Layout: Secondary Sidebar Mode (Pop-Out)

Alternatively, the progress view can pop out to the secondary sidebar. This keeps both views visible simultaneously with full vertical height, and matches where VS Code places AI/agent tools.

```
┌────────────────────────────────────────────────────────────┐
│ Primary Sidebar│  Editor Area          │ Secondary Sidebar │
│ ┌────────────┐ │  ┌─────────────────┐  │ ┌──────────────┐ │
│ │ Main View  │ │  │ main.tex        │  │ │ Progress View│ │
│ │ (always    │ │  │                 │  │ │ ┌────────┬──┐│ │
│ │  visible)  │ │  │                 │  │ │ │> Anal… │s1││ │
│ │            │ │  │                 │  │ │ │> Read… │s2││ │
│ │ Input [v]  │ │  │                 │  │ │ │> Gen…  │s3││ │
│ │ Ref   [v]  │ │  │                 │  │ │ │        │  ││ │
│ │ ────────── │ │  │                 │  │ │ │────────│  ││ │
│ │ [Workflow] │ │  │                 │  │ │ │Tasks   │  ││ │
│ │ ┌────────┐ │ │  │                 │  │ │ │ ☑ Claim│  ││ │
│ │ │instruc.│ │ │  │                 │  │ │ │────────│  ││ │
│ │ └────────┘ │ │  │                 │  │ │ │[Follow]│  ││ │
│ │ [Execute▶] │ │  │                 │  │ │ └────────┴──┘│ │
│ └────────────┘ │  └─────────────────┘  │ └──────────────┘ │
└────────────────────────────────────────────────────────────┘
```

**Advantages of secondary sidebar over editor pop-out:**

- Both main view and progress view visible simultaneously — no context switching
- Full vertical height (same as primary sidebar)
- Doesn't consume an editor tab (preserves the editing workspace)
- Natural home for agent monitoring (alongside VS Code Chat/Copilot)
- User can resize the secondary sidebar independently

**When editor pop-out is still preferable:**

- User wants maximum width for log content (editor area gives ~800px+ vs ~300px)
- User doesn't want to give up horizontal screen real estate to a second sidebar
- Single-monitor setups where three columns are too tight

Both pop-out targets are available simultaneously — the user chooses based on their screen real estate.

### Automatic Behavior

No user setting. Transitions are automatic and contextual:

| Trigger                                                         | Action                                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| User clicks Execute in main view                                | Primary sidebar swaps to progress view, auto-focuses the new stream                                       |
| User clicks "Back to setup" in progress (primary sidebar)       | Primary sidebar swaps back to main view                                                                   |
| User clicks pop-out button on progress (primary sidebar)        | Progress opens in secondary sidebar or editor area (see Pop-Out UI); primary sidebar reverts to main view |
| User clicks pop-back button on popped-out progress              | Popped-out view closes; primary sidebar swaps to progress view                                            |
| User closes popped-out progress (via VS Code × or sidebar drag) | Primary sidebar remains on main view (no forced swap)                                                     |
| User clicks Execute while progress is popped out                | Popped-out progress view focuses + auto-switches to new stream; primary sidebar stays on main view        |

### Stream Tabs in Narrow Mode

At sidebar width (~300px — primary or secondary sidebar), the stream tabs column adapts:

- **Width**: Fixed ~60px, showing single-character status icon + truncated stream name
- **Hover**: Tooltip with full stream name, agent, status, timestamp
- **Active indicator**: Left border highlight (consistent with VS Code sidebar patterns)
- **Overflow**: Vertical scroll, no horizontal scroll

At editor width (~800px+), stream tabs render at full width with status badges, timestamps, and action buttons (same as current design).

### Pop-Out / Pop-Back UI

**Primary sidebar toolbar buttons** (visible when progress is in the primary sidebar):

| Button                   | Codicon                   | Action                                                                    |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------- |
| Pop to secondary sidebar | `$(layout-sidebar-right)` | Opens progress in secondary sidebar; primary sidebar reverts to main view |
| Pop to editor            | `$(link-external)`        | Opens progress as editor tab; primary sidebar reverts to main view        |

**Popped-out toolbar button** (visible when progress is in secondary sidebar or editor):

| Button              | Codicon                  | Action                                                         |
| ------------------- | ------------------------ | -------------------------------------------------------------- |
| Pop back to sidebar | `$(layout-sidebar-left)` | Closes popped-out view; primary sidebar swaps to progress view |

These replace the current "Open in Tab" command — the behavior is now bidirectional and supports three locations.

## Implementation

### Prerequisites

**Minimum VS Code version**: The `secondarySidebar` contribution point requires VS Code 1.106+. The extension's `engines.vscode` field in `package.json` must be updated accordingly. If backward compatibility with older VS Code versions is needed, the secondary sidebar pop-out can be gated behind a version check, falling back to editor-only pop-out.

### Phase 1: Move Progress View to Primary Sidebar Container

Move `texra.progressView` from the `texra-panel` (bottom panel) container into the `texra` (primary sidebar) container, stacked below the main view.

#### Changes

**`package.json`**

Move the progress view declaration from `texra-panel` to `texra`:

```json
// Before
"viewsContainers": {
  "activitybar": [
    { "id": "texra", "title": "TeXRA", "icon": "..." }
  ],
  "panel": [
    { "id": "texra-panel", "title": "TeXRA ProgressBoard", "icon": "..." }
  ]
},
"views": {
  "texra": [
    { "id": "texra.mainView", ... }
  ],
  "texra-panel": [
    { "id": "texra.progressView", ... }
  ]
}

// After
"viewsContainers": {
  "activitybar": [
    { "id": "texra", "title": "TeXRA", "icon": "..." }
  ]
  // "panel" entry removed entirely
},
"views": {
  "texra": [
    { "id": "texra.mainView", ... },
    { "id": "texra.progressView", ... }
  ]
}
```

Remove the `texra-panel` container from `viewsContainers.panel` (no longer needed).

**Outcome**: Both views appear in the same primary sidebar activity bar. VS Code renders them as collapsible sections. This is the minimum viable change — no code changes to providers.

### Phase 2: Primary Sidebar View Swapping

Implement automatic show/hide so only one view is visible at a time in the primary sidebar.

#### Mechanism

VS Code's `WebviewView` API does not support programmatic show/hide of sidebar views directly. Two approaches:

**Option A: `when` clause toggling (preferred)**

Add a `when` clause to each view and toggle a context key:

```json
{
  "id": "texra.mainView",
  "when": "texra.activeView != 'progress'"
},
{
  "id": "texra.progressView",
  "when": "texra.activeView != 'main'"
}
```

```typescript
// On Execute:
vscode.commands.executeCommand('setContext', 'texra.activeView', 'progress');

// On "Back to setup":
vscode.commands.executeCommand('setContext', 'texra.activeView', 'main');
```

This fully hides the inactive view (no collapsed section header visible).

**Option B: Programmatic collapse via commands**

Use VS Code's built-in view visibility commands:

```typescript
vscode.commands.executeCommand('texra.progressView.focus');
```

Less preferred — leaves a visible collapsed section header for the inactive view.

#### Files Modified

| File                                       | Change                                                          |
| ------------------------------------------ | --------------------------------------------------------------- |
| `package.json`                             | Add `when` clauses to both view declarations                    |
| `src/extension.ts`                         | Initialize `texra.activeView` context to `'main'` on activation |
| `src/commands/agent/executeCommands.ts`    | Set context to `'progress'` after execution starts              |
| `src/progressView/ProgressViewProvider.ts` | Add `showInSidebar()` method that sets context to `'progress'`  |
| `src/MainViewProvider.ts`                  | Add `showInSidebar()` method that sets context to `'main'`      |

### Phase 3: Pop-Out to Editor Area

Reuse the existing `showProgressViewAsPanel()` infrastructure to open the progress view in the editor area when the user clicks the pop-out button.

#### Flow

1. User clicks editor pop-out button in progress view header toolbar
2. Frontend posts `POP_OUT_EDITOR` message to backend
3. `ProgressViewProvider.popOutToEditor()`:
   - Calls existing `showProgressViewAsPanel()` to create/reveal editor panel
   - Sets context `texra.activeView = 'main'` (primary sidebar reverts to main view)
   - Syncs full state to the editor panel
4. User clicks pop-back button in editor progress view
5. Frontend posts `POP_BACK` message to backend
6. `ProgressViewProvider.popBackToSidebar()`:
   - Disposes the editor panel via `disposePanelResources(true)`
   - Sets context `texra.activeView = 'progress'` (primary sidebar shows progress view)
   - Syncs full state to the sidebar view

#### State Continuity

The existing `WebviewUpdater` already broadcasts to both sidebar and panel webviews. During pop-out/pop-back:

1. `syncFullView({ forceRebuild: true })` replays all stream metadata, logs, and state to the target view
2. Active stream ID is preserved across transitions
3. Pending approval prompts are replayed via `replayPendingPrompts()`

No state is lost because the provider is a singleton — it holds all state regardless of which webview is rendering.

#### Files Modified

| File                                             | Change                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `src/progressView/ProgressViewProvider.ts`       | Add `popOutToEditor()` and `popBackToSidebar()` methods                         |
| `src/progressView/frontend/ProgressApp.ts`       | Add pop-out/pop-back toolbar buttons; post `POP_OUT_EDITOR`/`POP_BACK` messages |
| `src/progressView/ProgressViewMessageHandler.ts` | Handle `POP_OUT_EDITOR` and `POP_BACK` inbound messages                         |
| `src/shared/schemas/progressView.ts`             | Add `POP_OUT_EDITOR` and `POP_BACK` to inbound message schema                   |
| `src/commands/progress/progressViewCommands.ts`  | Update `openProgressViewInTab` to use `popOutToEditor()`                        |

### Phase 4: Pop-Out to Secondary Sidebar

Add the secondary sidebar as an alternative pop-out target using VS Code 1.106's `secondarySidebar` contribution point.

#### Approach

Unlike the editor pop-out (which uses `createWebviewPanel`), secondary sidebar placement uses a **statically declared view** registered under the `secondarySidebar` container. The provider manages a third webview target.

**`package.json`**

```json
"viewsContainers": {
  "activitybar": [
    { "id": "texra", "title": "TeXRA", "icon": "..." }
  ],
  "secondarySidebar": [
    { "id": "texra-secondary", "title": "TeXRA ProgressBoard", "icon": "$(server-process)" }
  ]
},
"views": {
  "texra": [
    { "id": "texra.mainView", "when": "texra.activeView != 'progress'" },
    { "id": "texra.progressView", "when": "texra.activeView != 'main'" }
  ],
  "texra-secondary": [
    { "id": "texra.progressView.secondary", "when": "texra.progressLocation == 'secondary'" }
  ]
}
```

#### Flow

1. User clicks secondary sidebar pop-out button in progress view header
2. Frontend posts `POP_OUT_SECONDARY` message to backend
3. `ProgressViewProvider.popOutToSecondary()`:
   - Sets context `texra.progressLocation = 'secondary'` (makes secondary view visible)
   - Sets context `texra.activeView = 'main'` (primary sidebar reverts to main view)
   - Opens/focuses the secondary sidebar via `vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar')`
   - Syncs full state to the secondary sidebar webview
4. Pop-back reverses: hides secondary view, shows progress in primary sidebar

#### Provider Changes

`ProgressViewProvider` already manages dual webviews (`_sidebarReady` / `_panelReady`). This extends to a third target:

```typescript
// WebviewUpdater receives all active webviews
this.webviewUpdater = new WebviewUpdater(() =>
  [
    this._view?.webview, // Primary sidebar
    this._panelView?.webview, // Editor panel
    this._secondaryView?.webview, // Secondary sidebar
  ].filter(Boolean),
);
```

The secondary sidebar view is registered as a separate `WebviewViewProvider` (same pattern as the primary sidebar), but backed by the same `ProgressViewProvider` singleton for state.

#### Files Modified

| File                                             | Change                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `package.json`                                   | Add `secondarySidebar` container and secondary progress view declaration                         |
| `src/progressView/ProgressViewProvider.ts`       | Register secondary sidebar view provider; manage third webview target; add `popOutToSecondary()` |
| `src/progressView/frontend/ProgressApp.ts`       | Add secondary sidebar pop-out button; post `POP_OUT_SECONDARY` message                           |
| `src/progressView/ProgressViewMessageHandler.ts` | Handle `POP_OUT_SECONDARY` inbound message                                                       |
| `src/shared/schemas/progressView.ts`             | Add `POP_OUT_SECONDARY` to inbound message schema                                                |
| `src/extension.ts`                               | Register secondary sidebar view provider; initialize `texra.progressLocation` context            |

### Phase 5: Responsive Stream Tabs

Adapt the stream tabs column for narrow (sidebar) vs wide (editor) contexts.

#### Approach

The progress view frontend detects its container width via `ResizeObserver` and applies a CSS class:

```typescript
private resizeObserver = new ResizeObserver(([entry]) => {
  const narrow = entry.contentRect.width < 500;
  this.classList.toggle('narrow', narrow);
});

connectedCallback() {
  super.connectedCallback();
  this.resizeObserver.observe(this);
}
```

CSS adapts the stream tabs column:

```css
/* Default: full-width tabs (editor mode) */
stream-tabs {
  min-width: 180px;
}

/* Narrow: compact icon strip (primary/secondary sidebar mode) */
:host(.narrow) stream-tabs {
  min-width: 48px;
  max-width: 64px;
}
```

`StreamTabs` component renders a compact variant when narrow:

- Status icon only (no text label)
- Tooltip with full stream info on hover
- Active stream highlighted with left border

This works identically in both sidebar locations since both are ~300px wide.

#### Files Modified

| File                                                 | Change                                      |
| ---------------------------------------------------- | ------------------------------------------- |
| `src/progressView/frontend/ProgressApp.ts`           | Add `ResizeObserver`, `narrow` class toggle |
| `src/progressView/frontend/components/StreamTabs.ts` | Compact rendering variant for narrow mode   |
| `src/progressView/frontend/styles/`                  | Responsive styles for stream tabs           |

### Phase 6: Header Toolbar with Navigation

Add a header toolbar to the progress view with context-aware navigation and pop-out buttons.

#### UI

The header renders differently based on current placement:

**Primary sidebar** (full toolbar):

```html
<div class="progress-header">
  <vscode-button
    appearance="icon"
    @click="${this.onBackToSetup}"
    title="Back to setup"
  >
    <span class="codicon codicon-arrow-left"></span>
  </vscode-button>
  <span class="header-title">ProgressBoard</span>
  <vscode-button
    appearance="icon"
    @click="${this.onPopOutSecondary}"
    title="Open in secondary sidebar"
  >
    <span class="codicon codicon-layout-sidebar-right"></span>
  </vscode-button>
  <vscode-button
    appearance="icon"
    @click="${this.onPopOutEditor}"
    title="Open in editor"
  >
    <span class="codicon codicon-link-external"></span>
  </vscode-button>
</div>
```

**Secondary sidebar or editor** (pop-back only):

```html
<div class="progress-header">
  <vscode-button
    appearance="icon"
    @click="${this.onPopBack}"
    title="Back to sidebar"
  >
    <span class="codicon codicon-layout-sidebar-left"></span>
  </vscode-button>
  <span class="header-title">ProgressBoard</span>
</div>
```

The backend informs the frontend of its current placement via an outbound message so the correct buttons render. The "Back to setup" button is only shown in the primary sidebar (in other locations, the primary sidebar already shows the main view).

#### Files Modified

| File                                             | Change                                                 |
| ------------------------------------------------ | ------------------------------------------------------ |
| `src/progressView/frontend/ProgressApp.ts`       | Add header bar with context-aware buttons              |
| `src/progressView/ProgressViewMessageHandler.ts` | Handle `BACK_TO_SETUP` message; send placement context |
| `src/shared/schemas/progressView.ts`             | Add placement context to outbound messages             |

## Surface Area

### Removed

| Component                                     | Reason                                                   |
| --------------------------------------------- | -------------------------------------------------------- |
| `texra-panel` view container (`package.json`) | No longer needed; progress view moves to primary sidebar |
| Bottom panel icon in activity bar             | Replaced by sidebar co-location                          |

### Added

| Component                                            | Reason                                     |
| ---------------------------------------------------- | ------------------------------------------ |
| `texra-secondary` view container (`package.json`)    | Secondary sidebar pop-out target           |
| `texra.progressView.secondary` view (`package.json`) | Secondary sidebar progress view instance   |
| `texra.activeView` context key                       | Controls primary sidebar view swapping     |
| `texra.progressLocation` context key                 | Controls secondary sidebar view visibility |

### Modified

| File                                                 | Nature of Change                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `package.json`                                       | View container restructuring, `when` clauses, secondary sidebar, engine version bump |
| `src/extension.ts`                                   | Context key initialization, secondary sidebar view registration                      |
| `src/progressView/ProgressViewProvider.ts`           | Three-target webview management, pop-out/pop-back methods, sidebar swap helpers      |
| `src/progressView/frontend/ProgressApp.ts`           | Header toolbar, ResizeObserver, pop-out/pop-back messages                            |
| `src/progressView/frontend/components/StreamTabs.ts` | Responsive compact variant                                                           |
| `src/progressView/ProgressViewMessageHandler.ts`     | New inbound message handlers, placement context                                      |
| `src/shared/schemas/progressView.ts`                 | New message types, placement enum                                                    |
| `src/commands/progress/progressViewCommands.ts`      | Updated pop-out commands                                                             |
| `src/commands/agent/executeCommands.ts`              | Auto-swap to progress on execute                                                     |
| `src/MainViewProvider.ts`                            | Sidebar swap helper                                                                  |

### Unchanged

- All frontend components besides `ProgressApp` and `StreamTabs`
- All backend event handlers and state management
- Main view components and state
- Settings view (remains independent editor panel)
- Shared styles and controllers (no changes)

## Non-Goals

- **Merging main view and progress view into a single webview**: They have independent state machines, lifecycles, and component trees. Co-locating in the same sidebar container achieves the UX goal without the complexity of merging.
- **Making the main view poppable to the editor**: The main view is a compact form that fits the sidebar well. No benefit to editor placement.
- **Responsive main view layout**: The main view already works at sidebar width. No changes needed.
- **Settings view placement changes**: Settings view opens as an editor tab on demand. Orthogonal to this work.
- **Persisting pop-out preference across sessions**: The view always starts in the primary sidebar. Pop-out is a transient action within a session.
- **Backward compatibility with VS Code < 1.106**: The secondary sidebar contribution point requires 1.106+. If needed, this can be addressed separately with a version-gated fallback (editor-only pop-out on older versions).

## Success Criteria

1. Progress view renders in the primary sidebar, swapping with the main view on Execute
2. Left/right split (content | stream tabs) preserved in all three locations (primary sidebar, secondary sidebar, editor)
3. Stream tabs are usable at sidebar width (~300px) with icon-only compact mode
4. Pop-out to editor opens progress as editor tab; primary sidebar reverts to main view
5. Pop-out to secondary sidebar opens progress in right sidebar; primary sidebar reverts to main view
6. Pop-back from either location closes the popped-out view; primary sidebar shows progress view
7. State continuity maintained across all transitions (no lost streams, logs, or approvals)
8. Closing a popped-out view (via VS Code ×) does not force-swap the primary sidebar
9. Execute while progress is popped out focuses the popped-out view, does not swap primary sidebar
10. `npm run typecheck` passes
11. Bottom panel container fully removed from `package.json`
