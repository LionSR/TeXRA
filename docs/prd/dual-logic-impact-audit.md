# PRD: Dual-Logic Impact Audit (2026-02)

## Implementation Status

Proposed (unimplemented):

| Item                    | Status      | Notes                                                    |
| ----------------------- | ----------- | -------------------------------------------------------- |
| Agent config assembly   | ⏳ Proposed | Consolidate execution config builders across views       |
| Active file inference   | ⏳ Proposed | Unify active-file inference in a shared helper           |
| Output file operations  | ⏳ Proposed | Centralize multi-output resolution for pack/clean        |
| Restore pipeline        | ⏳ Proposed | Single entrypoint for AgentConfig → TaskState → MainView |
| File context formatting | ⏳ Proposed | Shared builder for file context strings used in prompts  |

## Overview

This PRD identifies five high-impact dual-logic paths where the same intent is implemented in
multiple places. These duplications increase change amplification and create drift risk. The
proposed refactors aim to reduce redundancy without changing user-facing behavior or stored
workspace state schemas.

## Goals

- Reduce logic drift by consolidating shared behavior into focused helpers.
- Keep state schemas stable (no migrations or schema changes).
- Prefer direct, shallow refactors over new abstractions.

## Non-Goals

- UI redesigns or feature changes.
- Any changes to persisted workspace state formats.
- Rewriting flows that are intentionally distinct for UI/UX reasons.

---

# Audit Items

## 1. Agent Config Assembly (Main View vs Progress View)

**Priority:** High

**Current State:**

- MainView execution builds `AgentConfig` in `ExecutionManager.handleExecute`, mapping UI fields
  (agent category, tool config, output files, media files) and validating before execution.
  【F:src/webview/managers/ExecutionManager.ts†L46-L116】
- ProgressView rebuilds `AgentConfig` when setting up agent proposals, duplicating the mapping
  of input/output fields and active flags before restoring state.
  【F:src/progressView/ProgressViewMessageHandler.ts†L524-L589】
- Follow-up execution also reconstructs agent configs, output files, and `useMultipleOutputs`
  in a separate helper (`buildFollowupTaskState`).【F:src/progressView/ProgressViewMessageHandler.ts†L1120-L1226】

**Refactor Proposal:**

Introduce a shared `@common/execution` helper (e.g., `buildExecutionConfig`) that:

- Normalizes agent category, tool config defaults, media file mapping, and output file toggles.
- Accepts a minimal input shape from both MainView and ProgressView.
- Returns `{ agentConfig, activeFiles? }` for downstream use.

**Acceptance Criteria:**

- MainView and ProgressView both use the shared config builder.
- No behavior change in which fields are set or validated.

---

## 2. Active File Inference (Config Conversion vs Follow-up/Proposal)

**Priority:** High

**Current State:**

- History restore builds `TaskState.activeFiles` by computing per-file flags based on file arrays
  and `useMultipleOutputs` in `agentConfigToTaskState`.【F:src/utils/config/configConversion.ts†L15-L57】
- ProgressView proposal setup re-derives active flags from file arrays with local `hasFiles`
  logic, independent of the conversion helper.【F:src/progressView/ProgressViewMessageHandler.ts†L534-L578】
- Follow-up task construction mutates active flags again based on outputs-as-references and
  attach-outputs state.【F:src/progressView/ProgressViewMessageHandler.ts†L1217-L1226】

**Refactor Proposal:**

Add a shared `deriveActiveFiles` helper in `@common/state` that can:

- Compute base active-file flags from an `AgentConfig` (current behavior).
- Optionally apply follow-up adjustments (reference/output toggles).

**Acceptance Criteria:**

- All active-file computation routes through a single helper.
- Follow-up adjustments are explicit parameters rather than ad-hoc mutations.

---

## 3. Output File Operations (Pack/Clean)

**Priority:** Medium

**Current State:**

- MainView `ExecutionManager.handleMultipleOperation` dispatches pack/clean with a direct
  `outputFiles` list from the UI message.【F:src/webview/managers/ExecutionManager.ts†L140-L155】
- ProgressView `handleFileOperation` recomputes output files by merging declared outputs and
  generated paths, then decides `useMultipleOutputs` based on several heuristics.
  【F:src/progressView/ProgressViewMessageHandler.ts†L879-L909】

**Refactor Proposal:**

Create a shared `resolveOutputFilesForOperation` helper that:

- Takes `taskState`, generated outputs, and UI overrides.
- Returns `{ outputFiles, useMultipleOutputs }` to both callers.

**Acceptance Criteria:**

- Both pack/clean entry points rely on the shared helper.
- Multi-output resolution is identical regardless of UI entry point.

---

## 4. Restore Pipeline (History View vs Command Restore)

**Priority:** Medium

**Current State:**

- HistoryView restore builds a `TaskState` from `AgentConfig` and calls `texra.restoreState`.
  The conversion logic lives in `agentConfigToTaskState`.
  【F:src/historyView/HistoryViewMessageHandler.ts†L120-L129】【F:src/utils/config/configConversion.ts†L31-L57】
- `texra.restoreState` then converts the `TaskState` to a MainView snapshot using
  `buildMainViewState` and posts it to the webview or pending state store.
  【F:src/commands/history/stateRestoreCommand.ts†L33-L63】【F:src/common/state/mainViewStateUtils.ts†L14-L56】

**Refactor Proposal:**

Add a single `restoreAgentConfig` helper that owns:

- `AgentConfig → TaskState` conversion
- `TaskState → MainViewPersistedState` conversion
- Optional immediate execution toggle

**Acceptance Criteria:**

- HistoryView uses the unified helper instead of calling `agentConfigToTaskState` directly.
- `texra.restoreState` remains the only command entrypoint for restoring state.

---

## 5. File Context Formatting (Follow-up vs Text Enhancement)

**Priority:** Medium

**Current State:**

- Follow-up instruction rendering assembles file context strings directly from `AgentConfig`
  and `WorkspaceFS` in `renderFollowupInstruction`.【F:src/progressView/ProgressViewMessageHandler.ts†L1229-L1263】
- Text enhancement builds a separate file context string from `FileContext` in
  `polishTextWithAI`, including custom formatting and file lists.【F:src/utils/text/textEnhancementUtils.ts†L40-L169】

**Refactor Proposal:**

Create a shared file-context formatter that:

- Accepts a normalized `FileContext` (or `AgentConfig`) and outputs a string block.
- Supports labels and array formatting once in one place.

**Acceptance Criteria:**

- Follow-up instruction and text enhancement reuse the shared formatter.
- File context string output remains unchanged in both flows.

---

## Design Notes

The largest design issue is **change amplification**: when a file flag or output rule changes,
several unrelated parts of the extension must update in tandem. Consolidating the five paths
above makes the system behave like it was designed with a single source of truth from the start,
reducing drift and easing future changes.
