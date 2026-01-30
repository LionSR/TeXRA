# PRD: Dual Logic Path Audit - February 2026

## Implementation Status

Proposed (not started):

| Item | Area                       | Status      | Notes                                               |
| ---- | -------------------------- | ----------- | --------------------------------------------------- |
| 1    | Text polishing flows       | 📝 Proposed | Consolidate MainView + ProgressView polish behavior |
| 2    | Latexdiff command dispatch | 📝 Proposed | Shared helper for latexdiff + compare actions       |
| 3    | Task state restore         | 📝 Proposed | Shared restore helper across History + Progress     |
| 4    | MainView option refresh    | 📝 Proposed | Single publisher for agent/model options            |
| 5    | Pack/Clean output payloads | 📝 Proposed | Shared output-file payload builder                  |

## Overview

The codebase has multiple **dual logic paths** where the same behavior is implemented in parallel
across two or more entry points (views, commands, and managers). These are high-impact because they

- increase drift risk when behavior changes in one path but not the other
- add redundant error handling and logging
- make feature validation harder across webviews

This PRD identifies five high-impact duplication paths and proposes consolidation into shared
helpers without changing user-visible behavior or workspace state schemas.

## Goals

- Replace duplicated logic with shared helpers or centralized workflows.
- Reduce risk of behavior drift between webviews/commands.
- Keep changes internal (no UI redesigns, no storage schema changes).

## Non-Goals

- UI layout or visual changes.
- Behavioral changes that alter saved workspace state.
- Abstracting intentionally distinct workflows into a single generic API.

---

## 1. Text Polishing Flows (MainView vs ProgressView)

**Priority:** High

**Current State:**

- `InstructionManager.handlePolishInstructionText` performs file-context assembly, calls
  `polishTextWithAI`, and posts success/error messages to the MainView. (src/webview/managers/InstructionManager.ts)
- `ProgressViewMessageHandler.handlePolishFollowUp` assembles file context from task state, calls
  `polishTextWithAI`, and posts success/errors to the ProgressView. (src/progressView/ProgressViewMessageHandler.ts)

**Problem:**

Two parallel polishing flows exist with slightly different error handling and progress behaviors.
These tend to drift when polishing input structures or success/error payloads evolve.

**Refactor:**

Create a shared helper (e.g., `@frontend/text/polishText.ts`) that accepts:

- a `FileContext`
- a `text` string
- an output callback for success/error
- an optional progress reporter

Both managers call the same helper, only passing their view-specific postMessage handler.

**Acceptance Criteria:**

- Both MainView and ProgressView polishing actions use the shared helper.
- No duplicate error handling logic remains in per-view managers.
- Success/error payloads remain identical to today’s behavior.

---

## 2. Latexdiff Command Dispatch (MainView vs ProgressView)

**Priority:** High

**Current State:**

- `DiffManager` issues latexdiff/latexdiff-vc commands for the MainView. (src/webview/managers/DiffManager.ts)
- `ProgressViewMessageHandler` issues latexdiff commands for compare/preview actions. (src/progressView/ProgressViewMessageHandler.ts)

**Problem:**

Command execution is duplicated with slightly different guardrails (base file checks, argument
ordering, and error handling). Any change to latexdiff argument rules requires updating both.

**Refactor:**

Create a shared `runLatexdiffCommand` helper in `@frontend/latex` that:

- validates required base/revision inputs
- normalizes argument order for latexdiff/latexdiff-vc
- provides a shared logging hook for missing inputs

**Acceptance Criteria:**

- MainView and ProgressView call the shared latexdiff helper.
- Error/guard behavior remains consistent across views.
- Latexdiff command argument order is defined in one place.

---

## 3. Task State Restore (HistoryView vs ProgressView)

**Priority:** Medium

**Current State:**

- `HistoryViewMessageHandler.handleRestoreAgent` converts agent config → task state and executes
  `texra.restoreState`. (src/historyView/HistoryViewMessageHandler.ts)
- `ProgressViewMessageHandler.handleRestoreState` looks up task state by stream ID and executes
  `texra.restoreState`. (src/progressView/ProgressViewMessageHandler.ts)

**Problem:**

Multiple restore paths exist with different sourcing logic, but the execution flow is identical.
Any change to restore semantics or required fields must be updated in multiple places.

**Refactor:**

Add a shared helper `restoreTaskState(taskState: TaskState)` in `@frontend/agents/restoreState.ts`.
Each view resolves its source task state, then calls the helper for execution and error handling.

**Acceptance Criteria:**

- All restore actions call the shared helper for command execution.
- Error handling/logging is centralized in one place.

---

## 4. MainView Option Refresh (Commands vs Provider)

**Priority:** Medium

**Current State:**

- `mainViewCommands` refreshes agent/model options for explicit command invocations. (src/commands/system/mainViewCommands.ts)
- `MainViewProvider` refreshes agent/model options when config/auth changes. (src/MainViewProvider.ts)

**Problem:**

Both pathways fetch the same option payloads and post the same message formats. They can drift in
error handling and refresh ordering.

**Refactor:**

Create a shared `publishMainViewOptions` helper that accepts a `Webview` instance and
flags for what to refresh (agents/models). Both command handlers and provider use this helper.

**Acceptance Criteria:**

- Agent/model option refresh is centralized in one helper.
- Both command-based and event-based refreshes use the same error handling.

---

## 5. Pack/Clean Output File Payloads (MainView vs ProgressView)

**Priority:** Medium

**Current State:**

- `ExecutionManager.handleMultipleOperation` composes pack/clean command arguments for MainView.
  (src/webview/managers/ExecutionManager.ts)
- `ProgressViewMessageHandler.handleFileOperation` composes pack/clean payloads from stream/task
  state and executes the same commands. (src/progressView/ProgressViewMessageHandler.ts)

**Problem:**

Output-file aggregation rules and `useMultipleOutputs` logic are defined twice. These can diverge
as the output file model evolves.

**Refactor:**

Introduce a shared output payload builder in `@common/files/outputPayload.ts` that:

- accepts agent config + optional generated paths
- returns `{ outputFiles, useMultipleOutputs }`

Both managers call this helper before invoking pack/clean commands.

**Acceptance Criteria:**

- Output-file aggregation logic exists in a single module.
- Pack/clean commands receive consistent payloads across views.

---

## Risks & Mitigations

| Risk                                            | Mitigation                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| Over-consolidation hides view-specific behavior | Keep view-specific UI messaging inside managers; extract only shared logic |
| Drift during refactor                           | Add unit coverage for shared helpers where practical                       |

## Milestones

### Phase 1: Extraction & Shared Helpers

- [ ] Create shared helpers for each item
- [ ] Update MainView/ProgressView/HistoryView to use helpers

### Phase 2: Validation

- [ ] `npm run compile:fast`
- [ ] `npm run lint`
- [ ] Manual spot checks for polish/latexdiff/restore flows
