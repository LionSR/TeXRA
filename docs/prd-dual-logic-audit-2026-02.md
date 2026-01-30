# PRD: Dual Logic Audit - High Impact Refactors (2026-02)

## Overview

Identify and consolidate the most impactful **dual-logic paths** that create drift risk, inconsistent
behavior, or duplicated UI logic. The focus is on high-leverage refactors that reduce change
amplification without touching user-facing behavior or persisted workspace state.

## Goals

- Remove duplicate logic paths that create inconsistent UX or maintenance overhead.
- Centralize shared behavior in minimal, well-named helpers (prefer functions over classes).
- Keep changes internal and avoid UI or state schema changes.

## Non-Goals

- UI redesigns or layout changes.
- Changes to persisted workspace state.
- New abstractions that hide view-specific UX differences.

---

# 1) Main View Options Refresh Pipeline

**Priority:** High - options drift impacts initial render and manual refresh.

**Current State:**

- `MainViewMessageHandler.handleWebviewReady()` loads options and posts both model + agent options
  on startup.
- `mainViewCommands.refreshModelOptions`, `refreshAgentOptions`, and `refreshAllOptions` reimplement
  similar option loading + postMessage flows for manual refresh.

**Refactor:**

- Extract a shared helper (function) that loads model + agent options and posts to a provided webview.
- Keep authentication banner logic in `handleWebviewReady()` but reuse the shared options helper for
  both startup and command refresh paths.

**Acceptance Criteria:**

- Only one helper builds and posts main view option payloads.
- Manual refresh commands and webview-ready path use the same helper.
- Grep for `postMessage.*modelOptions\|agentOptions` shows a single call site (the helper).

---

# 2) Open-File Behavior (Editor Reuse + Cursor Reveal)

**Priority:** High - multiple entry points open files; inconsistent selection behavior creates UX drift.

**Current State:**

- `openFileCommands.openFile()` opens files and reveals a line with custom selection logic.
- `openFileInEditor()` and `ensureFileOpen()` in `@frontend/vscode/vscodeEditor.ts` implement their
  own editor reuse + reveal behavior.

**Refactor:**

- Consolidate open/reveal behavior into a single helper in `@frontend/vscode`.
- `openFileCommands.openFile()` becomes a thin wrapper that delegates to the shared helper instead of
  duplicating editor logic. The command registration and public API remain unchanged.

**Acceptance Criteria:**

- One canonical open-and-reveal implementation exists in `@frontend/vscode`.
- `openFileCommands.openFile()` delegates to it with no inline editor-reuse or reveal logic.
- Command and programmatic open flows produce identical editor behavior for the same inputs.

---

# 3) Workflow Proposal File Lists in Progress View

**Priority:** Medium - duplicate list assembly risks UI drift between permission cards and panels.

**Current State:**

- `PermissionCard.renderWorkflowFiles()` builds the same per-category file lists as
  `RequestPanels.renderProposalFiles()`.
- Both components repeat the same `combine()` helper and nearly identical list rendering.

**Refactor:**

- Add a small shared helper (e.g., `buildWorkflowFileLists()` + `renderFileList()`) in a local
  module under `progressView/frontend/components`.
- Both components call the helper for file list assembly + rendering.

**Acceptance Criteria:**

- File list assembly and rendering exist in exactly one helper module.
- Both components call the shared helper; grep confirms no remaining inline `combine()` calls for
  file list assembly in either component.

---

# 4) Permission Rejection Feedback Flow

**Priority:** Medium - duplicated feedback gating logic risks inconsistent behavior.

**Current State:**

- `PermissionCard.handleRejectClick()` uses a two-step feedback flow (first click opens feedback,
  second submits).
- `RequestPanels.handleActionClick()` reimplements similar logic with its own feedback tracking.

**Refactor:**

- Extract a shared feedback coordinator (function or small helper) that handles:
  - toggling feedback open state
  - retrieving feedback values
  - deciding whether to emit the final action
- Keep UI differences (single-card vs panel list) in the component, but reuse the core decision logic.

**Acceptance Criteria:**

- A single helper controls the reject-with-feedback decision flow.
- PermissionCard and RequestPanels delegate feedback gating to the shared helper; neither component
  contains its own open/submit state machine.

---

# 5) Timestamp Formatting Consistency Across Views

**Priority:** Medium - inconsistent timestamps reduce perceived quality and complicate future changes.

**Current State:**

- `HistoryItem` formats timestamps directly with `toLocaleString()`.
- Progress view uses a dedicated timestamp utility (`formatTimestamp`, `getTimeFormatter`,
  `getDateTimeFormatter`).

**Refactor:**

- Create a shared `@shared/utils/datetime` formatter for view-facing timestamps.
- Migrate HistoryView and ProgressView to use the shared formatter to guarantee consistent output.

**Acceptance Criteria:**

- HistoryView and ProgressView use the same formatting helper for display timestamps.
- Timestamp formatting behavior is defined in one module under `@shared/utils/`.
- Grep for `toLocaleString` in HistoryView returns zero matches after migration.

---

## Sequencing

All five items are independent and can be implemented in any order or in parallel. Items 3 and 4 both
touch `PermissionCard` and `RequestPanels` but modify different methods (file list rendering vs.
feedback handling), so concurrent work is feasible with minimal merge-conflict risk.

## Risks & Mitigations

| Risk                                     | Mitigation                                                          |
| ---------------------------------------- | ------------------------------------------------------------------- |
| Refactors obscure view-specific UX       | Keep helpers small and pure; keep view-specific control flow local. |
| Behavior drift in open-file handling     | Add regression checks using existing command paths.                 |
| UI mismatch in progress view permissions | Snapshot markup or compare rendered output during verification.     |

## Success Metrics

- Five dual-logic paths consolidated into shared helpers.
- Reduced diff surface when changing options refresh, file opening, permission feedback, or timestamp formatting.
- No changes to workspace state schemas.
