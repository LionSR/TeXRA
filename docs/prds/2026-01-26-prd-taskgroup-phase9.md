---
created: 2026-01-26
updated: 2026-02-10
---

# PRD: Task Group State, UI, and Persistence - Phase 9

> **Parent doc:** [2026-01-24-prd-progressview-modernization.md](./2026-01-24-prd-progressview-modernization.md)
> **Prior phase:** [2026-01-26-prd-lit-native-phase8.md](./2026-01-26-prd-lit-native-phase8.md)
> **Related:** [2026-01-26-ui-regressions-lit-migration.md](./2026-01-26-ui-regressions-lit-migration.md)

## Overview

Phase 9 completes the modernization effort by focusing on **task group state**, **task group UI**,
**persistence**, and **Lit-native architecture** in ProgressView. Task groups are the core timeline
for workflow and tool-use runs, so their state model and UI need to be precise, scalable, and
persisted predictably.

This phase refactors task group rendering into a Lit-native pipeline (reactive controllers,
virtualized list, context-driven state), introduces a durable view-state model (collapse state,
scroll anchors, read markers), and upgrades the UI to better communicate run structure and status.

> **Status: ⬜ Not Started**

---

## Problem Statement

Task group state and UI are currently split across multiple layers with inconsistent persistence
and limited Lit-native architecture.

### Observed Semantics (What Task Groups Actually Mean)

Task groups are used as a **semantic timeline**, but the meaning shifts across agent types:

- **Workflow agents**: root task groups map to runs (`r1`, `r2`, ...), and child groups map to
  internal stages within a run (compile, latexdiff, merge, etc.).
- **Tool-use agents**: groups represent tool executions and reasoning stages; there is no concept
  of “run selection,” and ordering is more fluid.

This mismatch currently leaks into UI and persistence:

- The UI assumes “runs” are root groups but hides the ability to collapse them.
- Run selection and active run state exist only for workflow, but task groups are shared across both.
- Collapsed state is stored globally without the stream or agent type context.

### Current Architecture (As-Is)

**Backend state**

- `TaskGroupManager` persists task groups per stream via workspace storage.
- `ProgressViewState` replays groups on load and marks running groups as error on reload.

**Frontend state**

- `StreamState.taskGroups` holds group arrays (no view-state or UI preferences).
- `TaskGroupList` rebuilds the tree on every render and uses a local `previousStatuses` map.
- `LogList` stores collapse state in `WebviewStateManager` under `groupToggleStates` (global, not
  stream-scoped, no cleanup when streams are deleted).

**UI limitations**

- Root run groups are not collapsible; only child groups can toggle.
- Group header lacks a dedicated disclosure affordance; toggle state is subtle.
- No run-level summary (duration, count, status, errors), making long runs hard to scan.
- No persistent scroll anchors or unread markers for navigation.

### Persistence Gaps

- Collapse state is keyed only by `groupId`; collisions are possible when run IDs reuse across
  streams (e.g., `r1` in multiple streams).
- No persisted view state per stream (collapse, last read, scroll position).
- Deleting or clearing streams does not purge toggle state.

### UX Gaps in Long Sessions

When runs contain 100+ log entries and nested groups:

- Users lose their place after a stream switch or reload.
- No “unread” signal exists to indicate what changed since last view.
- The list lacks anchors; scanning for the latest relevant group requires manual scrolling.
- The UI mixes two different “collapsible” patterns: `<details>` for child groups and fixed root.

---

## Goals

1. **Task group view state is explicit and persisted** per stream (collapse, scroll anchors,
   unread markers, last viewed run).
2. **Lit-native rendering pipeline** replaces ad-hoc state and render-time tree building.
3. **Improved task group UI** for readability, scanability, and navigation in long sessions.
4. **Performance scales** to large logs (10k+ entries) with virtualization and memoization.

## Non-Goals

- Changing the logging pipeline or event bus architecture.
- Redesigning non-task-group components (StreamTabs, FileList, TodoList).
- Introducing new backend features unrelated to task group state or UI.

---

## Proposed Solution

### 9.1 Task Group View State Model (Persisted, Stream-Scoped)

Create a dedicated, Zod-backed view state for task groups. This state is **frontend-owned** but
persisted in a predictable format via `WebviewStateManager`, with explicit stream scoping.

**New schema (frontend-only):**

```typescript
// src/progressView/frontend/taskGroupState.ts
import { z } from 'zod';

export const TaskGroupViewStateSchema = z.object({
  collapsed: z.record(z.string(), z.boolean()).prefault({}),
  lastSeenAt: z.record(z.string(), z.number()).prefault({}),
  scrollAnchors: z.record(z.string(), z.string().nullish()).prefault({}),
  runPin: z.record(z.string(), z.string().nullish()).prefault({}),
});
export type TaskGroupViewState = z.infer<typeof TaskGroupViewStateSchema>;
```

**Key behaviors:**

- Keys are **stream-scoped**: `collapsed[streamId:groupId:startTime]`.
- `lastSeenAt` stores timestamps per group to enable unread markers.
- `scrollAnchors` stores the last focused group ID per stream.
- `runPin` optionally pins a run group for quick access.

**Deep design considerations:**

- **Keying strategy**: include `startTime` to avoid reusing stale collapse state when `r1` restarts.
- **State ownership**: view state must remain **frontend-only** (never sent by backend).
- **Local pruning**: cap per-stream entries (LRU) to avoid state bloat in `vscode.setState`.
- **Legacy migration**: read `groupToggleStates` once, convert to stream-scoped keys, then delete.

**Integration points:**

- `LogList` becomes a thin presenter; view state lives in a new `TaskGroupViewStateManager`.
- Clear view state when streams are deleted (`DELETE_STREAM`, `CLEAR_ALL`).

---

### 9.2 Lit Reactive Controllers (State, Audio, Scroll)

Replace ad-hoc logic with Lit `ReactiveController`s to keep state concerns isolated and testable.

**Current ad-hoc listeners (to eliminate):**

- `LogList.ts` attaches `document`-level `toggle`, `click`, and `file-click` handlers; these are
  global, not scoped to the component, and make state ownership unclear.
- `TaskGroupList.ts` maintains a local `previousStatuses` map and directly triggers
  `AudioNotificationService`, coupling UI state and side effects.

**Controller set (expanded):**

| Controller                       | Responsibility                                         | Used By            |
| -------------------------------- | ------------------------------------------------------ | ------------------ |
| `TaskGroupViewStateController`   | Collapse state + persistence + cleanup                 | LogList, TaskGroup |
| `ScrollAnchorController`         | Restore scroll anchor per stream + pin logic           | LogList            |
| `AudioNotificationController`    | Completion sound, de-dupe per stream/group             | TaskGroupList      |
| `ResizeObserverController`       | Container resize signals for virtualizer + auto height | TaskGroupList      |
| `IntersectionObserverController` | Unread markers when headers enter viewport             | TaskGroupHeader    |

**Lit-native pattern:** each controller registers `hostConnected()` and `hostUpdated()` for
component-scoped side effects (no document-level listeners). Controllers own persistent state and
expose tiny APIs to the host component.

**Example controller responsibilities (deep dive):**

- `TaskGroupViewStateController`
  - Wraps `WebviewStateManager` with stream-scoped keys (streamId + groupId + startTime).
  - Provides `getCollapsed(group)` / `setCollapsed(group, value)` and handles LRU pruning.
  - Clears view state on stream deletion (hooked from message handlers).
- `ScrollAnchorController`
  - Stores `scrollAnchors[streamId]` and restores on stream switch.
  - Guards auto-scroll (only scroll to bottom when user is already near bottom).
  - Works with `vscode-scrollable` and virtualizer to avoid jumpiness.
- `AudioNotificationController`
  - Tracks last seen status per group and emits sound only on running → stopped/error transition.
  - De-duplicates on re-renders and stream replays.
- `ResizeObserverController`
  - Observes log container height changes and triggers virtualizer `requestUpdate()` or recalcs.
  - Eliminates layout thrash from manual `getBoundingClientRect()` loops.
- `IntersectionObserverController`
  - Marks groups as read when headers enter view.
  - Enables unread count badges per run without manual scroll math.

---

### 9.3 Task Group State Machine (Explicit)

Task groups already carry `status`, but UI doesn’t treat it as a state machine. We should make
transitions explicit for correct UI + audio + unread behavior.

**State transitions (expected):**

```
running → stopped (success)
running → error (failure)
running → stopped (manual stop)
running → error (reload auto-end)
```

**Rules:**

- Audio fires only on `running → stopped/error` and only once per group per stream.
- UI badges update immediately but do not re-announce on re-render.
- “Unread” markers trigger when a group receives new logs after it was last seen.

---

### 9.3 Task Group UI Enhancements

Upgrade task group readability while keeping the existing visual language.

**UI improvements:**

1. **Run-level collapsible groups** (root groups can toggle).
2. **Explicit disclosure icon** with consistent rotation + keyboard focus styles.
3. **Run summary chip** (duration, message count, status).
4. **Unread markers** for groups with new logs since last viewed.
5. **Sticky run headers** when scrolling long runs (CSS `position: sticky`).

**Optional power features:**

- Collapse/Expand all actions in StreamHeader toolbar.
- Jump-to-run menu (uses `scrollAnchors` and `runPin`).

---

### 9.4 Tree Construction + Row Model (Deeper)

Current tree building is repeated on every render, and messages are re-sorted each time. Replace
with memoized tree and flattened row generation so virtualization and unread tracking become
straightforward.

**Inputs:**

- `groups[]` (TaskGroup)
- `messages[]` (LogMessageData)
- `activeRunId` (workflow)

**Derived structures:**

1. **GroupMap**: `Map<groupId, TaskGroup>` (fast lookups)
2. **ChildMap**: `Map<parentId, TaskGroup[]>` (hierarchy)
3. **MessageMap**: `Map<groupId, LogMessageData[]>`
4. **Tree**: root groups sorted by `startTime`
5. **Rows**: flattened sequence with `row.kind` + `row.depth` for virtualizer

**Row model sketch:**

```ts
type Row =
  | { kind: 'group-header'; group: TaskGroup; depth: number }
  | { kind: 'log-entry'; message: LogMessageData; depth: number }
  | { kind: 'group-spacer'; depth: number };
```

**Why rows matter:**

- Virtualizer needs a flat list.
- Sticky headers can be applied to `group-header` rows only.
- Unread tracking becomes “has any row of group been viewed?”

---

### 9.4a Separation of Concerns (Task Group Series)

Task group UX spans data, state, rendering, and side effects. This phase enforces **clear
responsibility boundaries** so each part is independently testable and replaceable.

**Ownership boundaries (target):**

- **Backend** (`ProgressViewState`, `TaskGroupManager`)
  - Owns: persist task group data, replay on load
  - Must not own: UI state, collapse state, scroll anchors
- **Message handlers** (`messageHandlers.ts`)
  - Owns: validate + merge incoming task group payloads
  - Must not own: DOM updates, persistence of UI state
- **View state** (`TaskGroupViewStateManager` + controller)
  - Owns: collapse/unread/scroll/pin
  - Must not own: task group data, sorting logic
- **Tree + row model** (`TaskGroupList` helpers)
  - Owns: deterministic transforms (groups + messages → rows)
  - Must not own: persistence, side effects
- **Rendering** (Lit templates + virtualizer)
  - Owns: present rows, apply CSS
  - Must not own: state transitions, audio
- **Side effects** (controllers)
  - Owns: audio, scroll, intersection, resize
  - Must not own: direct data mutations

**Why this matters:**

- Prevents UI state from leaking into backend persistence.
- Avoids data merges in render, which makes virtualization unstable.
- Eliminates document-level listeners that bypass component lifecycles.

**Concrete moves (from current code):**

- `LogList` stops owning `ToggleStateStore`; view state moves to controller + manager.
- `TaskGroupList` stops tracking `previousStatuses`; audio moves to controller.
- `TaskGroupList` becomes a pure “data → rows → render” component.

---

### 9.4b Separation of Concerns (Workflow vs Tool-Use)

Task groups are shared across both agent types, but **rendering and interaction goals differ**.
This phase clarifies responsibility boundaries so each mode can evolve without coupling.

**Workflow (run-centric) owns:**

- **Run selection context** (selectedRunId / activeRunId).
- **Run summaries** (duration, usage, outputs, missing outputs).
- **Collapsible root groups** (runs) with explicit disclosure + persistence.
- **Run-based filters** (only show the active run).

**Tool-use (turn-centric) owns:**

- **No run selection** (all groups visible by default).
- **Prompt-driven highlights** (pending approvals or tool results).
- **Chronological continuity** (no run filters).
- **Session-scoped unread markers** (entire stream, not per run).

**Shared (mode-agnostic) responsibilities:**

- Group tree + row model transformation.
- Virtualizer rendering pipeline.
- View state persistence (collapse, unread, scroll anchors).
- Audio notifications on completion.

**Implementation boundary (target):**

- `WorkflowStreamContent` decides _which_ groups are visible and passes an explicit filter
  (`activeRunId`) into `LogList/TaskGroupList`.
- `ToolUseStreamContent` passes `isToolUse` + `activeRunId = null` and does not participate in
  run filtering or run-summary UI.
- `TaskGroupList` must not branch on agent category for anything except visibility rules already
  specified by props.

**Why this matters:**

- Prevents future features (e.g., run-level controls) from leaking into tool-use streams.
- Makes virtualizer and view-state logic reusable with minimal conditional logic.

---

### 9.4 Lit-Native Rendering Pipeline

Refactor `TaskGroupList` to a declarative data pipeline: **groups/messages in → tree model →
flattened rows → virtualized render**.

**Pipeline:**

```
TaskGroupStore (groups + messages)
  → buildTree() (memoized)
  → flattenTree() (rows with depth + kind)
  → <lit-virtualizer> renderRow(row)
```

**Row types:**

- `group-header`
- `group-content` (slot)
- `log-entry`

This unlocks virtualization and keeps rendering deterministic.

---

### 9.4c TaskGroupDomManager → Declarative Architecture

The goal is to remove any remaining “DOM manager” patterns by expressing task groups as pure data
and letting Lit own DOM updates.

**Declarative target:**

```
groups + messages + viewState
  → buildTree()
  → flattenRows()
  → renderRow(row)
```

**What changes vs DOM manager patterns:**

- **No manual `appendChild()` / `insertBefore()`**: row order is derived and stable.
- **No DOM querying for state**: collapse/unread/scroll are stored in view state controllers.
- **No imperative “insert chronologically”**: sorting happens in the tree builder.
- **No external mutation of elements**: all UI changes are via Lit re-render.

**Concrete refactor moves:**

- Replace `TaskGroupDomManager`‑style helpers with **pure functions**:
  - `buildGroupTree(groups, messages)`
  - `flattenGroupRows(tree, viewState)`
  - `getGroupVisibility(row, activeRunId, isToolUse)`
- Move **status transition logic** (audio) into `AudioNotificationController`.
- Move **toggle persistence** into `TaskGroupViewStateController`.
- Keep `TaskGroupList` focused on `renderRow()` only.

**Transitional pattern (if needed):**

- Keep `LogEntry` as Light DOM and render it via `<log-entry .message=${...}>`.
- Avoid direct DOM mutations inside `LogEntry`; if needed, convert formatter output to templates.

**Detailed decomposition (from imperative → declarative):**

| Imperative Responsibility           | Declarative Replacement                           |
| ----------------------------------- | ------------------------------------------------- |
| Insert rows chronologically         | Sort in `buildGroupTree()` based on timestamps    |
| Track expanded/collapsed DOM state  | `TaskGroupViewStateController` (stream-scoped)    |
| Track completion + play audio       | `AudioNotificationController` (state transitions) |
| Manually hide/show groups           | `getGroupVisibility()` in row pipeline            |
| DOM query for scroll & toggle icons | `ScrollAnchorController` + Lit template           |

**Row generation details:**

1. **Tree build** (`buildGroupTree`)
   - Index groups in `Map<id, group>`.
   - Index children by `parentGroupId`.
   - Bucket messages by `groupId`.
   - Return root groups sorted by `startTime`.

2. **Flatten** (`flattenGroupRows`)
   - Depth-first walk of the tree.
   - Emit `group-header` row.
   - Emit group messages (if expanded).
   - Emit child groups (if expanded).
   - Emit optional `group-spacer` row for visual separation.

3. **Visibility rules**
   - Workflow: if `activeRunId` set, only emit rows under that root group.
   - Tool-use: always emit all rows.
   - Collapsed groups: emit header only, no children/messages.

**Key invariants (must hold):**

- Row order is deterministic for a given `(groups, messages, viewState)` input.
- No DOM reads to determine state; render is fully derived from inputs.
- Collapsed state is persisted and restored per stream.
- Audio notifications never fire from render or re-render; only from state transitions.

**Event flow (new pattern):**

- User toggles group → `TaskGroupViewStateController.setCollapsed()` → state update → re-render.
- New log message arrives → message handler updates `streamState.logs` → re-render.
- Group status update arrives → state update → `AudioNotificationController` evaluates transition.

**Edge cases to account for:**

- **Out-of-order messages**: pending updates should merge into message array without forcing re-sort
  each time; sorting should be stable and incremental where possible.
- **Missing group**: messages with unknown `groupId` should render in “ungrouped” section.
- **Group replay on restore**: re-hydrate view state first, then render (no flicker).
- **Repeated group IDs**: include `startTime` in view-state key.

**Performance considerations:**

- Cache tree results when `(groups, messages)` identity is unchanged.
- Use `guard()` around `renderRow(row)` for expensive rows (markdown/KaTeX).
- Avoid per-render `Array.sort()` by storing sorted arrays once in memoized helpers.

---

### 9.5 Virtualized Log Rendering

Integrate `@lit-labs/virtualizer` for log rendering at scale.

**Targets:**

- `TaskGroupList` renders flattened rows via virtualizer.
- `LogEntry` remains Light DOM until formatter conversion is complete.

**Fallback behavior:**

- Feature flag in `ProgressView` settings to disable virtualization for debugging.

---

### 9.6 Persistence Cleanup Rules

1. **Stream deletion** clears view state for that stream.
2. **Clear all** resets all view state.
3. **Run replacement** (same `groupId` but newer `startTime`) gets a new key to avoid stale collapse.
4. **Max entries** for view state (LRU cap, default 200 groups per stream).

---

### 9.7 @lit-labs/task (Async State Machine)

Use `@lit-labs/task` for async fetch flows with cancellation, loading states, and error handling.

**Why here:** task groups are not the only async surface. The webviews already fetch or receive data
that can arrive late or be canceled (model options, relay tier config, profile data). `Task` makes
these states explicit and avoids race conditions from overlapping requests.

**Target use cases (deep dive):**

- **Model options**: In `MainApp`, the model list is updated by messages but also needs fallback
  refreshes. A `Task` can fetch or reconcile options and render loading/error states cleanly.
- **Relay tier config**: In Profile or Settings, fetch `/relay/tier-config` and display tier
  capabilities with a retryable error state.
- **Deferred metadata**: For progress view, fetch additional metadata for run summaries without
  blocking initial render.

**Example shape (conceptual):**

```typescript
import { Task } from '@lit-labs/task';

private readonly tierTask = new Task(this, {
  task: async ([profileToken]) => fetchTierConfig(profileToken),
  args: () => [this.profileToken],
});

render() {
  return this.tierTask.render({
    pending: () => html`<loading-state></loading-state>`,
    complete: (data) => html`<tier-summary .data=${data}></tier-summary>`,
    error: (err) => html`<error-state .error=${err}></error-state>`,
  });
}
```

**Benefits:**

- Built-in cancellation on arg changes
- Standardized loading/error UI
- Removes manual `isLoading`/`try/catch` boilerplate

---

### 9.8 Context API (@lit/context)

Use `@lit/context` to eliminate prop drilling and centralize state access for related components.

**Why here:** MainView and ProgressView both pass large prop bundles through multiple layers.
Context is a better fit than long argument lists or brittle event chains.

**Context candidates (deep dive):**

- **SessionContext**: session type, agent category, model selection, provider config.
- **FileStateContext**: selected files, checkbox states, and file list visibility.
- **StreamStateContext**: current stream state for ProgressView (run selection, logs, groups).
- **PromptStateContext**: active approvals/prompts, pending follow-ups.

**Integration points:**

- MainView: `MainApp → FileSelectGroup` currently passes 10+ props; replace with context providers.
- ProgressView: `ProgressApp → StreamHeader / TaskGroupList / UsagePanel` can consume stream context
  without relaying via intermediate containers.

**Benefits:**

- Fewer render-triggering prop changes
- Clear state ownership boundaries
- Easier component reuse across views

---

## Implementation Plan

### Phase 9a: State + Persistence (2-3 hours)

- Add `TaskGroupViewStateSchema` and `TaskGroupViewStateManager`.
- Migrate `LogList` persistence from `ToggleStateStore` to view state manager.
- Namespace keys with `streamId` + `groupId` + `startTime`.
- Purge view state on `DELETE_STREAM` / `CLEAR_ALL`.

### Phase 9b: Lit Controllers (3-4 hours)

- Introduce reactive controllers for persistence, audio, and scroll anchors.
- Replace document-level event listeners with component-bound handlers.

### Phase 9c: UI Enhancements (3-5 hours)

- Add disclosure icon + root group collapse support.
- Add run summary chip and unread markers.
- Add sticky headers for long runs.

### Phase 9d: Virtualized Rendering (4-6 hours)

- Build tree + row pipeline for task groups and logs.
- Integrate `@lit-labs/virtualizer` in `TaskGroupList`.
- Add feature flag + fallback mode.

### Phase 9e: Async Tasks (2-3 hours)

- Introduce `@lit-labs/task` in MainView/ProfileView for model options and tier config.
- Standardize loading/error UI patterns.

### Phase 9f: Context Migration (3-4 hours)

- Add `@lit/context` providers in MainView and ProgressView.
- Replace deep prop drilling with context consumers (FileSelectGroup, InstructionPanel, etc.).

---

## File Impact

| Area                    | Files (expected)                                                                |
| ----------------------- | ------------------------------------------------------------------------------- |
| View state              | `src/progressView/frontend/taskGroupState.ts` (new)                             |
| Controllers             | `src/progressView/frontend/controllers/TaskGroup*.ts` (new)                     |
| Controllers             | `src/progressView/frontend/controllers/ScrollAnchorController.ts` (new)         |
| Controllers             | `src/progressView/frontend/controllers/AudioNotificationController.ts` (new)    |
| Controllers             | `src/progressView/frontend/controllers/ResizeObserverController.ts` (new)       |
| Controllers             | `src/progressView/frontend/controllers/IntersectionObserverController.ts` (new) |
| Components              | `src/progressView/frontend/components/TaskGroupList.ts`                         |
| Components              | `src/progressView/frontend/components/TaskGroupItem.ts`                         |
| Components              | `src/progressView/frontend/components/TaskGroupHeader.ts`                       |
| Components              | `src/progressView/frontend/components/LogList.ts`                               |
| Styles                  | `src/progressView/styles/groups.css`, `src/progressView/styles/logs.css`        |
| Settings (feature flag) | `src/shared/schemas/progressViewMessages.ts` (optional)                         |
| Async tasks             | `src/webview/frontend/*` (task usage in MainApp/Profile)                        |
| Context providers       | `src/webview/frontend/context/*` (new)                                          |
| Context providers       | `src/progressView/frontend/context/*` (new)                                     |

---

## Success Metrics

| Metric                     | Target                                 |
| -------------------------- | -------------------------------------- |
| Collapse state persistence | Restores accurately across reloads     |
| Group key collisions       | 0 observed (stream-scoped + startTime) |
| Large log performance      | Smooth scroll at 10k entries           |
| Task group UI scan time    | 30% fewer clicks to find a run         |

---

## Validation Scenarios (Task Group Series)

1. **Reload after crash**: running groups should render as error with end time, and audio should
   not re-fire on load.
2. **Stream switch**: collapse state + scroll anchor restore for each stream.
3. **Two streams with r1**: ensure collapse state does not bleed across streams.
4. **Massive logs** (10k entries): virtualized list remains smooth and scrolls correctly.
5. **Unread markers**: new log entries after last view trigger badges, clear on view.

---

## Risks & Mitigations

| Risk                                    | Mitigation                                              |
| --------------------------------------- | ------------------------------------------------------- |
| Virtualizer conflicts with details tags | Render custom group rows without `<details>` in virtual |
| Shadow DOM CSS regressions              | Keep Light DOM until formatter styles are migrated      |
| State bloat in webview storage          | LRU cap + cleanup on stream deletion                    |
| Audio notifications double-fire         | Controller tracks per-stream status transitions         |

---

## Open Questions

1. Should run-level collapse be persisted or reset on new run creation?
2. Should unread markers clear on visibility or on explicit "mark as read"?
3. Should virtualization be default-on or opt-in via settings?
