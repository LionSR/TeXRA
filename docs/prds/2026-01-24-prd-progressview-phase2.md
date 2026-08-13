---
created: 2026-01-24
updated: 2026-05-04
---

# PRD: ProgressView Modernization - Phase 2

> **Parent doc:** [2026-01-24-prd-progressview-modernization.md](./2026-01-24-prd-progressview-modernization.md)

## Phase 2: Extract Shared Infrastructure

**After ProgressView is stable**, extract patterns for other webviews.

### Implementation Status (2026-01-25)

| Item                            | Status         | Notes                                                                 |
| ------------------------------- | -------------- | --------------------------------------------------------------------- |
| Base Lit app class              | ✅ Done        | `src/shared/BaseWebviewApp.ts` extracted and ProgressView now extends |
| Host bridge wrapper             | ✅ Done        | `src/shared/hostBridge.ts` + ProgressView import updated              |
| Reactive store helper           | ✅ Done        | `src/shared/createStore.ts` added for reuse                           |
| Design tokens extraction        | ✅ Done        | `src/shared/styles/tokens.css` + common.css imports it                |
| Shared resource roots           | ✅ Done        | `src/common/webview/resourceRoots.ts` includes shared styles          |
| CSS bundling                    | ✅ Done        | ProgressView bundle now inlines CSS via custom webpack loader         |
| Shared components               | ⏸️ Deferred    | No components shared by 2+ webviews yet (rule preserved)              |
| Legacy ProgressView JS cleanup  | ✅ Done        | Removed legacy JS modules and script after Lit parity                 |
| UI regression fixes             | 🟡 In Progress | Fixed some; may have remaining visual/behavior regressions            |
| Custom element CSS fixes        | ✅ Done        | Added flex layout for `log-list`, `task-group-list`, `stream-tabs`    |
| Message handler edge cases      | ✅ Done        | Pending log updates, auto-expand, stream-scoped filtering             |
| DRY template helpers            | ✅ Done        | `buildCopyButton()`, `buildDetailsSummary()` in htmlBuilders.ts       |
| Discriminated union StreamState | ✅ Done        | Type-safe mode-specific state in `src/shared/schemas/streamState.ts`  |
| CSS pilot migration             | ✅ Done        | 6 components migrated to native Lit styles (Shadow DOM)               |

**Note:** UI parity testing is ongoing. Additional regressions may be discovered during real-world usage.

---

### Lit Features Evaluation

#### Evaluated: Lit Context (`@lit/context`)

**Verdict: NOT NEEDED for ProgressView**

Lit Context solves prop drilling in deep component trees. However, ProgressView has:

- Shallow tree depth (~2-3 levels: root → container → leaf)
- Single state owner (ProgressApp)
- No services that need injection

| Context Use Case           | ProgressView Need  | Decision |
| -------------------------- | ------------------ | -------- |
| Global user/auth state     | ❌ N/A             | Skip     |
| Theme/locale               | ✅ VS Code handles | Skip     |
| Logging/analytics services | ❌ Not in webview  | Skip     |
| Deep prop drilling         | ❌ Tree is shallow | Skip     |

**When to reconsider:** If Phase 3 webviews have 5+ nesting levels or shared services, revisit Context.

---

### Lit Directives Reference

These directives are useful for ProgressView. Establish patterns in Phase 1, extract in Phase 2.

| Directive  | Import                        | Use Case                          | ProgressView Component        |
| ---------- | ----------------------------- | --------------------------------- | ----------------------------- |
| `repeat`   | `lit/directives/repeat.js`    | Keyed list rendering              | StreamTabs, FileList, LogList |
| `cache`    | `lit/directives/cache.js`     | Preserve DOM when switching views | workflow↔tooluse toggle       |
| `guard`    | `lit/directives/guard.js`     | Skip expensive re-renders         | Log entry formatting          |
| `live`     | `lit/directives/live.js`      | Sync with user-modified inputs    | FollowUpInput                 |
| `ref`      | `lit/directives/ref.js`       | Imperative DOM access             | LogList scroll position       |
| `choose`   | `lit/directives/choose.js`    | Multi-branch conditionals         | Prompt type rendering         |
| `when`     | `lit/directives/when.js`      | Simple conditionals               | Show/hide sections            |
| `classMap` | `lit/directives/class-map.js` | Dynamic CSS classes               | Status indicators             |

---

### Lit Patterns & Best Practices

These patterns should be established in Phase 1 (ProgressView) and extracted as shared infrastructure in Phase 2.

#### Pattern: `cache()` for View Switching

Preserve DOM state when toggling between workflow and tool-use views:

```typescript
import { cache } from 'lit/directives/cache.js';

render() {
  const streamState = this.getActiveStreamState();
  const isToolUse = this.isToolUseAgent();

  return html`
    <stream-tabs .streams=${this.state.streams}></stream-tabs>

    ${cache(
      isToolUse
        ? html`<tooluse-content .state=${streamState}></tooluse-content>`
        : html`<workflow-content .state=${streamState}></workflow-content>`
    )}

    <prompt-overlay .prompt=${this.activePrompt}></prompt-overlay>
  `;
}
```

**Why `cache()`:**

- Preserves scroll position when switching
- Avoids re-mounting expensive components
- Keeps form input state intact

#### Pattern: `live()` for User Inputs

Sync property with live DOM value (user can type while state updates):

```typescript
import { live } from 'lit/directives/live.js';

@customElement('followup-input')
export class FollowUpInput extends LitElement {
  @property() value = '';

  render() {
    return html`
      <textarea
        .value=${live(this.value)}
        @input=${(e: Event) =>
          (this.value = (e.target as HTMLTextAreaElement).value)}
      ></textarea>
    `;
  }
}
```

**Why `live()`:**

- Without it, Lit compares against last-rendered value
- User typing can be overwritten by stale state updates
- Essential for text inputs with external state

#### Pattern: `ref()` for Scroll Control

Get DOM reference for imperative operations:

```typescript
import { ref, createRef, Ref } from 'lit/directives/ref.js';

@customElement('log-list')
export class LogList extends LitElement {
  private containerRef: Ref<HTMLElement> = createRef();

  @property({ type: Array }) logs: LogMessageData[] = [];
  @property({ type: Boolean }) autoScroll = true;

  updated() {
    if (this.autoScroll && this.containerRef.value) {
      this.containerRef.value.scrollTop = this.containerRef.value.scrollHeight;
    }
  }

  render() {
    return html`
      <div class="log-container" ${ref(this.containerRef)}>
        ${this.logs.map((log) => html`<log-entry .log=${log}></log-entry>`)}
      </div>
    `;
  }
}
```

#### Pattern: `guard()` for Expensive Rendering

Skip re-renders when dependencies haven't changed:

```typescript
import { guard } from 'lit/directives/guard.js';

render() {
  return html`
    ${guard([this.log.id, this.log.content], () =>
      this.formatLogEntry(this.log)  // Expensive markdown/code formatting
    )}
  `;
}
```

**When to use:**

- Markdown rendering
- Syntax highlighting
- Complex HTML generation

#### Pattern: `choose()` for Multi-Branch Rendering

Cleaner than nested ternaries for prompt types:

```typescript
import { choose } from 'lit/directives/choose.js';

render() {
  return html`
    ${choose(this.prompt?.kind, [
      ['toolEdit', () => this.renderToolEdit()],
      ['bash', () => this.renderBash()],
      ['retry', () => this.renderRetry()],
      ['proposal', () => this.renderProposal()],
    ], () => html``)}
  `;
}
```

#### Pattern: Efficient List Rendering with `repeat()`

Lit's `repeat()` directive enables efficient DOM updates for sorted/reordered lists by using stable keys.

```typescript
import { repeat } from 'lit/directives/repeat.js';

// Without repeat() - Lit recreates DOM when order changes
render() {
  return html`${this.items.map(item => html`<div>${item.name}</div>`)}`;
}

// With repeat() - Lit moves DOM nodes when order changes
render() {
  return html`${repeat(
    this.items,
    (item) => item.id,  // Stable key function
    (item) => html`<div>${item.name}</div>`
  )}`;
}
```

**When to use `repeat()`:**

- Lists that get sorted/reordered (file lists by round, streams by time/agent)
- Lists with expensive-to-render items (log entries with formatting)
- Lists where items have stable IDs

**When `map()` is fine:**

- Small lists (<20 items)
- Lists that only append (never reorder)
- Simple items that are cheap to recreate

#### Pattern: Sorted Data at Render Time

**Don't** convert wire format to Maps for sorting. **Do** sort at render time with memoization.

```typescript
import { state } from 'lit/decorators.js';

@customElement('file-list')
export class FileList extends LitElement {
  // Wire format (Record) - no conversion needed
  @property({ type: Object })
  filesByRound: Record<string, OutputFileInfo[]> = {};

  // Memoized sorted rounds - only recomputes when data changes
  @state() private _sortedRounds: [number, OutputFileInfo[]][] = [];

  willUpdate(changedProps: PropertyValues) {
    if (changedProps.has('filesByRound')) {
      this._sortedRounds = Object.entries(this.filesByRound)
        .map(([k, v]) => [Number(k), v] as [number, OutputFileInfo[]])
        .sort((a, b) => a[0] - b[0]);
    }
  }

  render() {
    return html`${repeat(
      this._sortedRounds,
      ([round]) => round,
      ([round, files]) => html`
        <div class="round-group">
          <h4>Round ${round}</h4>
          ${files.map((f) => html`<file-item .file=${f}></file-item>`)}
        </div>
      `,
    )}`;
  }
}
```

**Benefits:**

- Wire format (Records) stays unchanged - no conversion helpers
- Sorting only happens when data actually changes (`willUpdate`)
- `repeat()` efficiently handles DOM when sort order changes

#### Pattern: Reactive Controllers for Shared Logic

Extract reusable reactive behavior into controllers.

```typescript
// shared/controllers/SortController.ts
import { ReactiveController, ReactiveControllerHost } from 'lit';

export class SortController<
  T,
  K extends keyof T,
> implements ReactiveController {
  host: ReactiveControllerHost;
  private _items: T[] = [];
  private _sortKey: K;
  private _sortOrder: 'asc' | 'desc' = 'asc';

  sorted: T[] = [];

  constructor(host: ReactiveControllerHost, sortKey: K) {
    this.host = host;
    this._sortKey = sortKey;
    host.addController(this);
  }

  set items(value: T[]) {
    this._items = value;
    this._recompute();
    this.host.requestUpdate();
  }

  setSortKey(key: K) {
    this._sortKey = key;
    this._recompute();
    this.host.requestUpdate();
  }

  toggleOrder() {
    this._sortOrder = this._sortOrder === 'asc' ? 'desc' : 'asc';
    this._recompute();
    this.host.requestUpdate();
  }

  private _recompute() {
    const cmp = this._sortOrder === 'asc' ? 1 : -1;
    this.sorted = [...this._items].sort((a, b) => {
      const aVal = a[this._sortKey];
      const bVal = b[this._sortKey];
      return aVal < bVal ? -cmp : aVal > bVal ? cmp : 0;
    });
  }

  hostConnected() {}
  hostDisconnected() {}
}

// Usage in component
@customElement('stream-tabs')
export class StreamTabs extends LitElement {
  private _sort = new SortController<StreamTabInfo, 'lastTimestamp'>(
    this,
    'lastTimestamp',
  );

  @property({ type: Array })
  set streams(value: StreamTabInfo[]) {
    this._sort.items = value;
  }

  render() {
    return html`${repeat(
      this._sort.sorted,
      (s) => s.name,
      (s) => html`<stream-tab .stream=${s}></stream-tab>`,
    )}`;
  }
}
```

#### Build Improvement: CSS Bundling

**Current:** 30 CSS files loaded via `@import` statements in `index.css`.

**Problem:** Each `@import` is a separate request during development, adding latency.

**Solution:** Bundle CSS in webpack alongside the JS bundle.

```javascript
// webpack.config.js - progressView target
const progressViewConfig = {
  entry: './src/progressView/frontend/index.ts',
  module: {
    rules: [
      { test: /\.ts$/, use: 'ts-loader' },
      {
        test: /\.css$/,
        use: [path.resolve(__dirname, 'scripts/inlineCssLoader.js')], // Inlines CSS + @import
      },
    ],
  },
};
```

```typescript
// frontend/index.ts - import CSS
import '../styles/index.css'; // Bundled with JS
import './ProgressApp';
```

**Benefits:**

- Single bundle request instead of 30+ CSS files
- Dead code elimination for unused styles (future)

**Note:** Keep external CSS loading as fallback for development hot-reload.

---

### Existing Infrastructure to Leverage

Already exists in `src/common/`:

| Existing                  | Location          | Lit Migration Path                      |
| ------------------------- | ----------------- | --------------------------------------- |
| `BaseViewContentProvider` | `common/webview/` | Keep for HTML shell generation          |
| `BaseViewMessageHandler`  | `common/webview/` | Replace with `BaseWebviewApp` Lit class |
| `BaseWebviewProvider`     | `common/webview/` | Keep, add Lit bundle loading            |
| `domUtils.js`             | `common/modules/` | Delete after Lit migration              |
| `templateUtils.js`        | `common/modules/` | Delete after Lit migration              |
| `common.css`              | `common/styles/`  | Keep as-is (works with light DOM)       |
| `WebviewStateManager`     | `common/modules/` | Wrap in Lit reactive controller         |
| `ToggleStateStore`        | `common/modules/` | Replace with Lit `@state`               |

### What Gets Extracted from ProgressView

| Pattern                | From ProgressView        | Shared Location                |
| ---------------------- | ------------------------ | ------------------------------ |
| Base Lit app class     | `ProgressApp.ts`         | `src/shared/BaseWebviewApp.ts` |
| Common Lit components  | `<prompt-overlay>`, etc. | `src/shared/components/`       |
| Reactive store pattern | `store.ts`               | `src/shared/createStore.ts`    |
| Host bridge wrapper    | Message posting          | `src/shared/hostBridge.ts`     |
| Design tokens          | CSS variables            | `src/shared/styles/tokens.css` |

Note: Schemas already live in `src/shared/schemas/` from Phase 1 (single source of truth).

Shared components remain in view folders until a second webview adopts them.

### Shared Components (Proven in ProgressView)

Only extract components **actually used** by multiple webviews:

| Component           | ProgressView | MainView | Others |
| ------------------- | ------------ | -------- | ------ |
| `<texra-button>`    | ✓            | ✓        | ✓      |
| `<texra-tabs>`      | ✓            | ✓        | -      |
| `<texra-file-list>` | ✓            | ✓        | -      |
| `<texra-toolbar>`   | ✓            | ✓        | -      |

**Rule**: No component goes in `src/shared/` until it's used by 2+ webviews.

### Directory Structure After Phase 2

```

src/
├── shared/ # Extracted from ProgressView
│ ├── schemas/
│ │ ├── index.ts # Common schema re-exports
│ │ ├── identifiers.ts # StreamTabId, ExecutionId, etc.
│ │ ├── status.ts # StreamStatus, TaskGroupStatus
│ │ └── errors.ts # ProviderError, RetryErrorInfo
│ ├── components/
│ │ └── index.ts # Placeholder until shared components are reused
│ ├── styles/
│ │ └── tokens.css # Design tokens
│ ├── BaseWebviewApp.ts # Message handling base class
│ ├── createStore.ts # Reactive store helper
│ └── hostBridge.ts # Host bridge wrapper
│
├── progressView/
│ ├── frontend/ # Lit components
│ │ ├── index.ts
│ │ ├── store.ts
│ │ ├── ProgressApp.ts
│ │ └── components/
│ ├── schemas.ts # Progress-specific + shared imports
│ └── ProgressViewMessageHandler.ts
│
├── webview/ # MainView (Phase 3)
├── historyView/ # Phase 3
├── profileView/ # Phase 3
└── memoryView/ # Phase 3

```

---

## Anti-Patterns to Avoid

### Band-Aid Patterns in Legacy Code

These sequential workarounds have accumulated over time. **Do not replicate them in Lit migrations.**

---

### 1. Render-State Comparison for Change Detection

**Legacy Pattern:**

```javascript
// progressViewState.js
this.lastRenderedStream = ''; // Track what was last rendered

// messageHandlers.js
if (state.activeStream !== state.lastRenderedStream) {
  clearContent(); // Manual DOM wipe
  state.lastRenderedStream = state.activeStream;
}
```

**Why It's Bad:** Duplicates state to detect changes. Creates drift between actual DOM and tracked state.

**Lit Solution:** Reactive properties automatically trigger re-renders.

```typescript
@customElement('progress-app')
export class ProgressApp extends LitElement {
  @state() private activeStream = '';

  // Lit automatically re-renders when activeStream changes
  // No manual tracking needed - the framework handles change detection

  render() {
    // This only runs when @state properties change
    return html`<stream-content .stream=${this.activeStream}></stream-content>`;
  }
}
```

**Key Insight:** Lit's reactive system uses dirty-checking on `@state()` and `@property()` decorators. When you assign a new value, Lit schedules an update. No manual comparison required.

---

### 2. Pending ID Buffers for Async Coordination

**Legacy Pattern:**

```javascript
// RunSelector.js
this._pendingActiveId = null;  // Buffer selection before backend confirms

selectRun(runId) {
  this._pendingActiveId = runId;  // Optimistic UI
  postMessage('selectRun', { runId });
}

handleBackendConfirm(confirmedId) {
  if (this._pendingActiveId === confirmedId) {
    this._pendingActiveId = null;  // Clear buffer
  }
  // What if they don't match? Silent failure.
}
```

**Why It's Bad:** Two sources of truth. Race conditions if user clicks fast. Silent failures on mismatch.

**Lit Solution:** Single source of truth with explicit loading states.

```typescript
@customElement('run-selector')
export class RunSelector extends LitElement {
  @state() private selectedRunId = '';
  @state() private isSelecting = false;
  @state() private previousRunId = ''; // For rollback

  async selectRun(runId: string) {
    // 1. Save previous state for rollback
    this.previousRunId = this.selectedRunId;

    // 2. Optimistic update
    this.selectedRunId = runId;
    this.isSelecting = true;

    try {
      // 3. Wait for backend confirmation
      await postMessage('selectRun', { runId });
      // Success - state is already correct
    } catch (error) {
      // 4. Rollback on failure
      this.selectedRunId = this.previousRunId;
      console.error('Failed to select run:', error);
    } finally {
      this.isSelecting = false;
    }
  }

  render() {
    return html`
      <select
        .value=${this.selectedRunId}
        ?disabled=${this.isSelecting}
        @change=${(e: Event) =>
          this.selectRun((e.target as HTMLSelectElement).value)}
      >
        ${this.runs.map(
          (run) => html`<option value=${run.id}>${run.label}</option>`,
        )}
      </select>
      ${this.isSelecting ? html`<span class="loading">...</span>` : nothing}
    `;
  }
}
```

**Key Insight:** One `@state()` variable is the source of truth. Loading state is explicit. Rollback is straightforward.

---

### 3. Resolution Functions with Side Effects

**Legacy Pattern:**

```javascript
// progressViewState.js
resolveActiveRunId(streamId) {
  const current = this.getActiveRunId(streamId);
  if (current) return current;

  // Side effect inside a "resolver"!
  const resolved = this._resolveFromCandidates(streamId);
  if (resolved) this.setActiveRunId(streamId, resolved);  // Mutation!
  return resolved;
}
```

**Why It's Bad:**

- Called 9+ times per message (redundant computation)
- Mutates state in a function named "resolve" (unexpected side effect)
- Callers can't distinguish "no run exists" vs "not cached yet"

**Lit Solution:** Pure computed getters + explicit setters.

```typescript
@customElement('progress-app')
export class ProgressApp extends LitElement {
  @state() private runIdCache = new Map<string, string>();
  @state() private activeStream = '';

  // GETTER: Pure, no side effects, safe to call multiple times
  get activeRunId(): string | null {
    // First check cache
    const cached = this.runIdCache.get(this.activeStream);
    if (cached) return cached;

    // Compute from candidates (pure computation, no mutation)
    return this.computeRunIdFromCandidates(this.activeStream);
  }

  // SETTER: Explicit mutation, clear intent
  setActiveRunId(streamId: string, runId: string) {
    const next = new Map(this.runIdCache);
    next.set(streamId, runId);
    this.runIdCache = next; // Triggers re-render
  }

  // Pure computation - can be memoized if needed
  private computeRunIdFromCandidates(streamId: string): string | null {
    const streamState = this.state.streamStates.get(streamId);
    if (!streamState) return null;

    // Return first available run ID
    const candidates = [
      ...streamState.runInstructions.keys(),
      ...streamState.runUsage.keys(),
    ];
    return candidates[0] ?? null;
  }
}
```

**Key Insight:** Getters compute, setters mutate. Never both in the same function.

---

### 4. Manual State Wipes on Mode Switch

**Legacy Pattern:**

```javascript
// messageHandlers.js
_clearAgentCategoryState() {
  dom.taskGroups.clear();
  dom.logEntries.clear();
  dom.fileList.clear();
  dom.todoList.clear();
  dom.runSelector.clear();
  dom.usageSummary.clear();
  // 6 more clear() calls...
}

handleUpdateStreams(message) {
  if (previousCategory !== newCategory) {
    this._clearAgentCategoryState();  // Nuclear option
  }
}
```

**Why It's Bad:**

- Shotgun surgery: add a new panel → must update clear function
- Forgets to clear something → stale data bugs
- Clears everything even when only category changed

**Lit Solution:** Component-level separation handles this automatically.

```typescript
@customElement('progress-app')
export class ProgressApp extends LitElement {
  @state() private isToolUse = false;

  render() {
    // When isToolUse changes, Lit removes old component tree and creates new one
    // No manual clearing needed - child component state is naturally scoped
    return html`
      <stream-tabs .streams=${this.state.streams}></stream-tabs>

      ${
        this.isToolUse
          ? html`<tooluse-content .state=${this.streamState}></tooluse-content>`
          : html`<workflow-content
              .state=${this.streamState}
            ></workflow-content>`
      }

      <prompt-overlay .prompt=${this.activePrompt}></prompt-overlay>
    `;
  }
}

// Each content component manages its own state
@customElement('tooluse-content')
export class ToolUseContent extends LitElement {
  @property({ type: Object }) state!: StreamState;

  // When this component is removed from DOM, all its state goes with it
  // When re-added, it starts fresh
  render() {
    return html`
      <todo-list .todos=${this.state.todos}></todo-list>
      <log-list .logs=${this.state.logs}></log-list>
    `;
  }
}
```

**Key Insight:** Component lifecycle = state lifecycle. Remove component = clear its state.

---

### 5. Global Mutable Maps for Race Condition Handling

**Legacy Pattern:**

```javascript
// messageHandlers.js (module scope)
const pendingLogUpdates = new Map();  // Global mutable state

handleUpdateLog(message) {
  if (!dom.logEntries.update(message.logMessage)) {
    // Log doesn't exist yet, store for later
    pendingLogUpdates.set(message.logMessage.id, message.logMessage);
  }
}

handleAppendLog(message) {
  const pending = pendingLogUpdates.get(message.logMessage.id);
  const merged = { ...message.logMessage, ...pending };
  pendingLogUpdates.delete(message.logMessage.id);
  // Render merged
}
```

**Why It's Bad:**

- Map grows unbounded if APPEND_LOG never arrives
- Not cleared when stream is deleted → memory leak
- Race: UPDATE → stream deleted → APPEND → stale update applied to wrong stream

**Lit Solution:** Component-scoped state with lifecycle cleanup.

```typescript
@customElement('log-list')
export class LogList extends LitElement {
  @property({ type: String }) streamId = '';
  @property({ type: Array }) logs: LogMessage[] = [];

  // Component-scoped pending state
  @state() private pendingUpdates = new Map<string, Partial<LogMessage>>();

  // Lifecycle: Clean up when stream changes
  willUpdate(changed: PropertyValues) {
    if (changed.has('streamId')) {
      // New stream = clean slate
      this.pendingUpdates = new Map();
    }
  }

  // Called by parent when UPDATE_LOG arrives
  applyPendingUpdate(logId: string, update: Partial<LogMessage>) {
    const existing = this.logs.find((l) => l.id === logId);
    if (existing) {
      // Log exists, apply update directly
      this.logs = this.logs.map((l) =>
        l.id === logId ? { ...l, ...update } : l,
      );
    } else {
      // Log doesn't exist yet, store pending
      this.pendingUpdates = new Map(this.pendingUpdates).set(logId, update);
    }
  }

  // Called by parent when APPEND_LOG arrives
  appendLog(log: LogMessage) {
    const pending = this.pendingUpdates.get(log.id);
    const merged = pending ? { ...log, ...pending } : log;

    // Clean up pending
    if (pending) {
      const next = new Map(this.pendingUpdates);
      next.delete(log.id);
      this.pendingUpdates = next;
    }

    this.logs = [...this.logs, merged];
  }
}
```

**Key Insight:** State scoped to component. When component unmounts (stream switch), pending state goes with it.

---

### 6. Scattered `isToolUse` Conditionals

**Legacy Pattern:**

```javascript
// 18 occurrences across messageHandlers.js
if (isToolUseAgent(stream)) {
  dom.todoList.show();
  dom.runSelector.hide();
} else {
  dom.todoList.hide();
  dom.runSelector.show();
}

// Later, same pattern repeated:
if (isToolUseAgent(stream)) {
  renderToolUseToolbar();
} else {
  renderWorkflowToolbar();
}
```

**Why It's Bad:**

- 18 places to update when adding a new agent category
- Easy to miss one conditional → inconsistent UI
- Logic spread across 1000+ lines

**Lit Solution:** Single branching point with dedicated components.

```typescript
@customElement('progress-app')
export class ProgressApp extends LitElement {
  // Single place to determine agent type
  private get isToolUse(): boolean {
    const stream = this.state.streams.find(
      (s) => s.name === this.state.activeStreamId,
    );
    return stream?.agentCategory === 'toolUse';
  }

  render() {
    // ONE branching point - components below have no isToolUse checks
    return html`
      <stream-tabs .streams=${this.state.streams}></stream-tabs>

      ${
        this.isToolUse
          ? html`<tooluse-content .state=${this.streamState}></tooluse-content>`
          : html`<workflow-content
              .state=${this.streamState}
            ></workflow-content>`
      }
    `;
  }
}

// Tool-use component - NO isToolUse checks needed
@customElement('tooluse-content')
export class ToolUseContent extends LitElement {
  @property({ type: Object }) state!: StreamState;

  render() {
    // This component only exists when isToolUse=true
    // So we just render tool-use UI unconditionally
    return html`
      <todo-list .todos=${this.state.todos}></todo-list>
      <follow-up-input></follow-up-input>
      <tooluse-toolbar></tooluse-toolbar>
    `;
  }
}

// Workflow component - NO isToolUse checks needed
@customElement('workflow-content')
export class WorkflowContent extends LitElement {
  @property({ type: Object }) state!: StreamState;

  render() {
    // This component only exists when isToolUse=false
    return html`
      <run-selector .runs=${this.state.runs}></run-selector>
      <task-group-list .groups=${this.state.taskGroups}></task-group-list>
      <workflow-toolbar></workflow-toolbar>
    `;
  }
}
```

**Key Insight:** Branch once at the top. Child components don't know about the condition.

---

### 7. Save-Blocking Counters (MainView)

**Legacy Pattern:**

```javascript
// mainViewState.js
blockSave() { this._saveBlockCount++; }
unblockSave() {
  this._saveBlockCount--;
  if (this._saveBlockCount === 0) this.save();
}

// Every programmatic update must be wrapped:
state.blockSave();
try {
  updateFileList();
  updateSettings();
  updateOutputFiles();
} finally {
  state.unblockSave();
}
```

**Why It's Bad:**

- Easy to forget `unblockSave()` in error paths → saves never happen
- Nested calls require careful counter tracking
- Every new feature must remember to use this pattern

**Lit Solution:** Batch updates happen automatically via reactive state.

```typescript
@customElement('main-app')
export class MainApp extends LitElement {
  @state() private state: MainViewState = initialState;

  // Single state update = single save
  updateMultipleFields(updates: Partial<MainViewState>) {
    // Lit batches property changes into single render cycle
    this.state = { ...this.state, ...updates };
    // Save happens once after render completes
  }

  // Or use updated() lifecycle for auto-save
  updated(changed: PropertyValues) {
    if (changed.has('state')) {
      // Debounced save after any state change
      this.debouncedSave();
    }
  }

  private saveTimeout?: number;
  private debouncedSave() {
    clearTimeout(this.saveTimeout);
    this.saveTimeout = window.setTimeout(() => {
      postMessage('saveState', this.state);
    }, 100); // Debounce rapid changes
  }

  // Example: multiple updates in one call
  handleBatchUpdate() {
    // All these changes become ONE state update
    this.state = {
      ...this.state,
      fileList: newFiles,
      settings: newSettings,
      outputFiles: newOutputs,
    };
    // Lit batches → one render → one save
  }
}
```

**Key Insight:** Lit's update batching is automatic. Multiple property changes in same microtask = one render.

---

### Summary: Legacy Pattern → Lit Solution

| Legacy Problem                      | Root Cause              | Lit Solution                               |
| ----------------------------------- | ----------------------- | ------------------------------------------ |
| `lastRenderedStream` comparison     | Manual change detection | `@state()` triggers automatic re-renders   |
| `_pendingActiveId` buffers          | Async coordination      | Single source of truth + loading states    |
| `resolveActiveRunId()` side effects | Mutation in getters     | Pure getters + explicit setters            |
| `_clearAgentCategoryState()`        | Manual DOM lifecycle    | Component lifecycle = state lifecycle      |
| Global `pendingLogUpdates` map      | Scope creep             | Component-scoped `@state()` with cleanup   |
| 18× `isToolUse` checks              | No separation boundary  | Single branch point + dedicated components |
| `blockSave()/unblockSave()`         | Manual batching         | Lit's automatic update batching            |

**Rule of Thumb:** If you're adding a `_pending*`, `_last*`, `_previous*`, or `*Count` variable, stop and reconsider the data flow. There's likely a Lit pattern that handles it automatically.
