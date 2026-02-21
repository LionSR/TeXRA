# PRD: Progress View Placement — Co-located Sidebar with Editor Pop-Out

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

The `secondarySidebar` contribution point was finalized in VS Code 1.106 and is now stable. The secondary sidebar is where VS Code places agent/AI tools (Chat, Copilot), making it the natural home for an AI research assistant.

## Design

### Core Principle

The main view and progress view are **always co-located** — they live in the same sidebar and swap back and forth. The user sees one at a time. The progress view can be **popped out** to the editor area for more space, and **popped back** to the sidebar.

On VS Code 1.106+, the extension defaults to the **secondary sidebar**. On older versions, it falls back to the **primary sidebar** (current behavior). The two views never split across different sidebars.

### Constraint: Single Active Progress View

The progress view renders in **exactly one location** at a time — either in the sidebar (co-located with the main view) or as an editor tab. Never both simultaneously.

This is a hard constraint driven by the **approval popup system**. Tool edit approvals, bash command permissions, and proposal reviews are interactive prompts that require user action. If the progress view were rendered in two places, an approval prompt would appear in both, creating ambiguity about which one the user should interact with. The provider must send approval prompts to exactly one webview.

### Layout: Sidebar Mode (Default)

The progress view replaces the main view in the sidebar when activated. The left/right split is preserved — stream tabs render as a narrow column (icons + truncated names) at ~60px, content fills the remaining ~240px at default sidebar width.

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

(sidebar location: secondary sidebar on 1.106+, primary sidebar on older)
```

### Layout: Editor Mode (Pop-Out)

A toolbar button pops the progress view into the editor area as a tab. The sidebar reverts to the main view. Full editor width gives the left/right split room to breathe. The sidebar progress view is **deactivated** (not just hidden) — the editor tab is the sole active progress view.

```
┌──────────────────────────────────────────────────────┐
│ Sidebar        │  Editor Area                        │
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

### View Toggle

Both views have a persistent toggle in their header that lets the user switch freely between main view and progress view at any time — not just on Execute or "Back." This is the primary navigation mechanism.

```
Main View header:                    Progress View header:
┌──────────────────────────────┐     ┌──────────────────────────────┐
│ [Setup ▾] [Progress]    [⧉] │     │ [Setup] [Progress ▾]   [⧉]  │
└──────────────────────────────┘     └──────────────────────────────┘
```

The toggle is a pair of buttons (or a segmented control) in the view header. The active view is visually indicated (e.g., underlined, filled, or bolded). Clicking the inactive label swaps views. This works identically in sidebar and editor mode.

**Keyboard shortcut**: A command `texra.toggleView` (bound to a keybinding, e.g., `Ctrl+Shift+T` / `Cmd+Shift+T`) toggles between the two views. This is registered in `package.json` as a `keybindings` contribution so users can rebind it.

### Automatic Behavior

No user setting. Transitions are automatic and contextual. The toggle is always available for manual switching in addition to these automatic triggers:

| Trigger | Action |
|---|---|
| User clicks Execute in main view | Sidebar swaps to progress view; auto-focuses the new stream |
| User clicks toggle (Setup ↔ Progress) | Sidebar swaps to the selected view |
| User presses `Ctrl/Cmd+Shift+T` | Sidebar toggles between main and progress view |
| User clicks pop-out button in progress (sidebar) | Progress opens as editor tab; sidebar reverts to main view; sidebar progress view deactivated |
| User clicks pop-back button in editor progress | Editor tab closes; sidebar swaps to progress view; sidebar progress view reactivated |
| User closes editor progress tab (via VS Code ×) | Sidebar remains on main view (no forced swap) |
| User clicks Execute while progress is in editor mode | Editor progress tab focuses + auto-switches to new stream; sidebar stays on main view |

### Stream Tabs in Narrow Sidebar

At sidebar width (~300px), the stream tabs column adapts:

- **Width**: Fixed ~60px, showing single-character status icon + truncated stream name
- **Hover**: Tooltip with full stream name, agent, status, timestamp
- **Active indicator**: Left border highlight (consistent with VS Code sidebar patterns)
- **Overflow**: Vertical scroll, no horizontal scroll

At editor width (~800px+), stream tabs render at full width with status badges, timestamps, and action buttons (same as current design).

### Header Toolbar Layout

The view toggle is the left-most element in both views' headers. Pop-out/pop-back buttons appear on the right.

**Main View header** (sidebar):
```
┌──────────────────────────────────┐
│ [Setup ▾] [Progress]        [⧉] │
│                              ↑   │
│                         pop out  │
└──────────────────────────────────┘
```

The main view shows a pop-out button (`$(link-external)`) that opens the *progress view* in the editor area (shortcut for: switch to progress + pop out). This is useful when the user wants to monitor progress alongside the setup form.

**Progress View header** (sidebar):
```
┌──────────────────────────────────┐
│ [Setup] [Progress ▾]        [⧉] │
└──────────────────────────────────┘
```

**Progress View header** (editor):
```
┌──────────────────────────────────────────────┐
│ [Setup] [Progress ▾]        [← Back to bar] │
└──────────────────────────────────────────────┘
```

In editor mode, clicking "Setup" in the toggle focuses the sidebar (which shows the main view). The pop-back button closes the editor tab and returns progress to the sidebar.

These replace the current "Open in Tab" command — the behavior is now bidirectional.

### Default Sidebar Location

| VS Code Version | `viewsContainers` key | Extension home                                         |
| --------------- | --------------------- | ------------------------------------------------------ |
| 1.106+          | `secondarySidebar`    | Secondary sidebar (right side, alongside Chat/Copilot) |
| < 1.106         | `activitybar`         | Primary sidebar (left side, current behavior)          |

On 1.106+, the secondary sidebar is the preferred home because:

- It's where VS Code places AI/agent tools — users expect agent UIs there
- The primary sidebar stays free for file explorer, search, source control
- The extension doesn't compete for primary sidebar attention with core VS Code views

The fallback to `activitybar` on older versions preserves backward compatibility with no behavioral difference — the view swapping and pop-out mechanics work identically in either sidebar.

## Implementation

### Phase 1: Co-locate Views in Same Container

Move `texra.progressView` from the `texra-panel` (bottom panel) container into the same container as `texra.mainView`.

#### Changes

**`package.json`**

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

// After (VS Code 1.106+)
"viewsContainers": {
  "secondarySidebar": [
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

Remove the `texra-panel` container from `viewsContainers.panel`.

**Outcome**: Both views appear in the secondary sidebar under a single TeXRA icon. VS Code renders them as collapsible sections. This is the minimum viable change — no code changes to providers.

**Backward compatibility note**: If the extension needs to support VS Code < 1.106, use `activitybar` instead. The `secondarySidebar` key is ignored on older versions and would cause an error. A version-gated `package.json` build step or separate extension manifest could handle this if needed.

### Phase 2: View Swapping

Implement automatic show/hide so only one view is visible at a time in the sidebar.

#### Mechanism

**`when` clause toggling (preferred)**

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
// On Execute or toggle to progress:
vscode.commands.executeCommand('setContext', 'texra.activeView', 'progress');

// On toggle to setup:
vscode.commands.executeCommand('setContext', 'texra.activeView', 'main');
```

This fully hides the inactive view (no collapsed section header visible).

#### Toggle Command and Keybinding

Register a `texra.toggleView` command that flips `texra.activeView` between `'main'` and `'progress'`:

```typescript
vscode.commands.registerCommand('texra.toggleView', () => {
  const current = contextState.activeView; // track internally
  const next = current === 'main' ? 'progress' : 'main';
  vscode.commands.executeCommand('setContext', 'texra.activeView', next);
});
```

**`package.json` keybinding**:

```json
{
  "command": "texra.toggleView",
  "key": "ctrl+shift+t",
  "mac": "cmd+shift+t",
  "when": "texra.activeView"
}
```

Both frontends also post a `SWITCH_VIEW` message when the user clicks the toggle buttons in the header. The backend handles this identically to the keybinding.

#### Files Modified

| File | Change |
|---|---|
| `package.json` | Add `when` clauses to both view declarations; register `texra.toggleView` command and keybinding |
| `src/extension.ts` | Initialize `texra.activeView` context to `'main'` on activation; register toggle command |
| `src/commands/agent/executeCommands.ts` | Set context to `'progress'` after execution starts |
| `src/progressView/ProgressViewProvider.ts` | Add `showInSidebar()` method that sets context to `'progress'` |
| `src/MainViewProvider.ts` | Add `showInSidebar()` method that sets context to `'main'` |
| `src/webview/frontend/MainApp.ts` | Add view toggle to header; post `SWITCH_VIEW` message |
| `src/progressView/frontend/ProgressApp.ts` | Add view toggle to header; post `SWITCH_VIEW` message |
| `src/shared/schemas/commonViewMessages.ts` | Add `SWITCH_VIEW` to shared inbound message schema |

### Phase 3: Pop-Out to Editor Area (Exclusive)

Open the progress view in the editor area while **deactivating** the sidebar progress view. Only one progress webview receives messages at a time.

#### Flow

1. User clicks pop-out button in progress view sidebar toolbar
2. Frontend posts `POP_OUT` message to backend
3. `ProgressViewProvider.popOutToEditor()`:
   - Calls existing `showProgressViewAsPanel()` to create/reveal editor panel
   - Sets context `texra.activeView = 'main'` (sidebar reverts to main view)
   - Marks sidebar progress view as **inactive** — `WebviewUpdater` stops sending to it
   - Syncs full state to the editor panel only
4. User clicks pop-back button in editor progress view
5. Frontend posts `POP_BACK` message to backend
6. `ProgressViewProvider.popBackToSidebar()`:
   - Disposes the editor panel via `disposePanelResources(true)`
   - Marks sidebar progress view as **active** — `WebviewUpdater` resumes sending to it
   - Sets context `texra.activeView = 'progress'` (sidebar shows progress view)
   - Syncs full state to the sidebar view

#### Exclusive Rendering

The existing `WebviewUpdater` broadcasts to all registered webviews. This must change to **exclusive mode**: only one webview is active at a time.

```typescript
// Before: broadcast to all
this.webviewUpdater = new WebviewUpdater(() => [
  this._view?.webview,
  this._panelView?.webview,
]);

// After: send to active target only
this.webviewUpdater = new WebviewUpdater(() => {
  if (this._panelView && this._panelActive) {
    return [this._panelView.webview];
  }
  return this._view ? [this._view.webview] : [];
});
```

This ensures approval prompts, log updates, and all other messages go to exactly one webview. No dual-rendering.

#### State Continuity

During pop-out/pop-back:

1. `syncFullView({ forceRebuild: true })` replays all stream metadata, logs, and state to the newly active view
2. Active stream ID is preserved across transitions
3. Pending approval prompts are replayed via `replayPendingPrompts()` to the new active view only

No state is lost because the provider is a singleton — it holds all state regardless of which webview is rendering.

#### Files Modified

| File                                             | Change                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `src/progressView/ProgressViewProvider.ts`       | Add `popOutToEditor()` and `popBackToSidebar()` methods; exclusive webview targeting |
| `src/progressView/WebviewUpdater.ts`             | Switch from broadcast to exclusive-target mode                                       |
| `src/progressView/frontend/ProgressApp.ts`       | Add pop-out/pop-back toolbar buttons; post `POP_OUT`/`POP_BACK` messages             |
| `src/progressView/ProgressViewMessageHandler.ts` | Handle `POP_OUT` and `POP_BACK` inbound messages                                     |
| `src/shared/schemas/progressView.ts`             | Add `POP_OUT` and `POP_BACK` to inbound message schema                               |
| `src/commands/progress/progressViewCommands.ts`  | Update `openProgressViewInTab` to use `popOutToEditor()`                             |

### Phase 4: Responsive Stream Tabs

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

/* Narrow: compact icon strip (sidebar mode) */
:host(.narrow) stream-tabs {
  min-width: 48px;
  max-width: 64px;
}
```

`StreamTabs` component renders a compact variant when narrow:

- Status icon only (no text label)
- Tooltip with full stream info on hover
- Active stream highlighted with left border

#### Files Modified

| File                                                 | Change                                      |
| ---------------------------------------------------- | ------------------------------------------- |
| `src/progressView/frontend/ProgressApp.ts`           | Add `ResizeObserver`, `narrow` class toggle |
| `src/progressView/frontend/components/StreamTabs.ts` | Compact rendering variant for narrow mode   |
| `src/progressView/frontend/styles/`                  | Responsive styles for stream tabs           |

### Phase 5: Header Toolbar with View Toggle

Add a unified header toolbar to both views with the view toggle and context-aware action buttons.

#### UI

Both views share the same toggle pattern — a segmented control (or button pair) with "Setup" and "Progress" labels. The active label is visually distinguished.

**Main View header** (sidebar):

```html
<div class="view-header">
  <div class="view-toggle">
    <button class="active" disabled>Setup</button>
    <button @click=${this.onSwitchToProgress}>Progress</button>
  </div>
  <vscode-button appearance="icon" @click=${this.onPopOutProgress}
    title="Open progress in editor">
    <span class="codicon codicon-link-external"></span>
  </vscode-button>
</div>
```

**Progress View header** (sidebar):

```html
<div class="view-header">
  <div class="view-toggle">
    <button @click=${this.onSwitchToSetup}>Setup</button>
    <button class="active" disabled>Progress</button>
  </div>
  <vscode-button appearance="icon" @click=${this.onPopOut}
    title="Open in editor">
    <span class="codicon codicon-link-external"></span>
  </vscode-button>
</div>
```

**Progress View header** (editor):

```html
<div class="view-header">
  <div class="view-toggle">
    <button @click=${this.onSwitchToSetup}>Setup</button>
    <button class="active" disabled>Progress</button>
  </div>
  <vscode-button appearance="icon" @click=${this.onPopBack}
    title="Back to sidebar">
    <span class="codicon codicon-layout-sidebar-right"></span>
  </vscode-button>
</div>
```

In editor mode, clicking "Setup" focuses the sidebar (which already shows the main view) rather than closing the editor tab.

The backend informs the frontend of its current placement via an outbound message (`SET_PLACEMENT`) so the correct action buttons render (pop-out vs pop-back).

#### Shared Toggle Component

The view toggle is a shared Lit component (`<view-toggle>`) used by both `MainApp` and `ProgressApp`. It accepts the active view as a property and dispatches a `switch-view` event.

#### Files Modified

| File | Change |
|---|---|
| `src/shared/components/ViewToggle.ts` | New shared toggle component |
| `src/webview/frontend/MainApp.ts` | Add view header with toggle and pop-out button |
| `src/progressView/frontend/ProgressApp.ts` | Add view header with toggle and pop-out/pop-back buttons |
| `src/progressView/ProgressViewMessageHandler.ts` | Send placement context via `SET_PLACEMENT` |
| `src/shared/schemas/progressView.ts` | Add placement enum and `SET_PLACEMENT` outbound message |

## Surface Area

### Removed

| Component                                     | Reason                                                    |
| --------------------------------------------- | --------------------------------------------------------- |
| `texra-panel` view container (`package.json`) | No longer needed; progress view co-locates with main view |
| Bottom panel icon in activity bar             | Replaced by sidebar co-location                           |
| Broadcast mode in `WebviewUpdater`            | Replaced by exclusive-target mode                         |

### Added

| Component | Reason |
|---|---|
| `texra.activeView` context key | Controls sidebar view swapping |
| `texra.toggleView` command + keybinding | Keyboard shortcut for switching views |
| `SET_PLACEMENT` outbound message | Informs frontend of current location for toolbar rendering |
| `SWITCH_VIEW` shared inbound message | Frontend toggle posts to backend to swap views |
| `src/shared/components/ViewToggle.ts` | Shared segmented control component for both views |

### Modified

| File | Nature of Change |
|---|---|
| `package.json` | View container restructuring (`secondarySidebar`), `when` clauses, keybinding, engine version bump |
| `src/extension.ts` | Context key initialization, toggle command registration |
| `src/progressView/ProgressViewProvider.ts` | Exclusive webview targeting, pop-out/pop-back methods, sidebar swap helpers |
| `src/progressView/WebviewUpdater.ts` | Exclusive-target mode (single active webview) |
| `src/progressView/frontend/ProgressApp.ts` | View toggle header, ResizeObserver, pop-out/pop-back messages |
| `src/progressView/frontend/components/StreamTabs.ts` | Responsive compact variant |
| `src/progressView/ProgressViewMessageHandler.ts` | New inbound message handlers, placement context |
| `src/shared/schemas/progressView.ts` | New message types, placement enum |
| `src/shared/schemas/commonViewMessages.ts` | Add `SWITCH_VIEW` shared inbound message |
| `src/webview/frontend/MainApp.ts` | View toggle header with pop-out button |
| `src/commands/progress/progressViewCommands.ts` | Updated pop-out command |
| `src/commands/agent/executeCommands.ts` | Auto-swap to progress on execute |
| `src/MainViewProvider.ts` | Sidebar swap helper |

### Unchanged

- All frontend components besides `ProgressApp`, `MainApp`, and `StreamTabs`
- All backend event handlers and state management
- Settings view (remains independent editor panel)
- Shared styles and controllers (no changes beyond new `ViewToggle` component)

## Non-Goals

- **Splitting views across two sidebars**: The main view and progress view are always co-located. Placing one in the primary sidebar and the other in the secondary sidebar creates split attention — the same problem as the current bottom panel placement. Both views live in the same sidebar and swap in place.
- **Dual-rendering the progress view**: The progress view renders in exactly one webview at a time. Approval prompts, follow-up inputs, and interactive workflows require a single active target. Broadcasting to multiple webviews would create ambiguous UX for approval actions.
- **Merging main view and progress view into a single webview**: They have independent state machines, lifecycles, and component trees. Co-locating in the same sidebar container achieves the UX goal without the complexity of merging.
- **Making the main view poppable to the editor**: The main view is a compact form that fits the sidebar well. No benefit to editor placement.
- **Persisting pop-out preference across sessions**: The view always starts in the sidebar. Pop-out is a transient action within a session.

## Success Criteria

1. Both views live in the secondary sidebar on VS Code 1.106+ (primary sidebar on older versions)
2. Progress view swaps with main view on Execute; "Back" swaps to main view
3. Left/right split (content | stream tabs) preserved in both sidebar and editor mode
4. Stream tabs are usable at sidebar width (~300px) with icon-only compact mode
5. Pop-out opens progress as editor tab; sidebar reverts to main view; only the editor tab receives messages
6. Pop-back closes editor tab; sidebar shows progress view; only the sidebar receives messages
7. Approval prompts appear in exactly one location — never duplicated
8. State continuity maintained across all transitions (no lost streams, logs, or approvals)
9. Closing the editor tab via VS Code × does not force-swap the sidebar
10. Execute while in editor mode focuses the editor tab, does not swap sidebar
11. `npm run typecheck` passes
12. Bottom panel container fully removed from `package.json`
