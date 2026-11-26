# Logic in the wrong layer: what the 2026-11-26 audit left open

Date: 2026-11-26
Status: proposed
Origin: a scheduled audit for abstraction-layer violations, on `main` at
`7538e2e`. Four read-only sweeps (the hosts, the app and llm, the harness,
and the open items of the six earlier layer notes) and a reverse import graph
of every source file. Each candidate was checked against the code,
`.agents/docs/refuted-candidates.json` and the three open PRs (#15216,
#15229, #15230), which still hold 430 files; every item of the 2026-11-25
note waits on them or on #15245, and so does most of what follows.

The PR that adds this note lands the instances no open PR holds, under one
rule: a fact is stated in the layer that owns it, and the layers above read
it.

- **Harness.** The `executions` and `script` tool descriptions read the
  history-query caps, the listing default, the log tail and two defaults
  from the constants that enforce them. `usageAgentName` left `shared/` for
  `agent/runtime/run/pricing.ts` and asks `programGrants` which programs the
  app wrote. `CHILD_TOOLS` names `AGENT_TOOL_NAME`.
- **Clone.** `CLONE_COPY` (`packages/texra/src/ui/copy/clone.ts`) words the
  token prompt, the invalid-token line and the invalid-project line; `latex/`
  keeps the storage key and the format rule, and the extension and the
  terminal add nothing of their own.
- **App.** Monaco's unread extension lists are gone and the language table
  knows `.ltx` and `.latex`; the export controller has one table of
  empty-run reasons; the plugins commands and the composer's auto-approve
  row read `PLUGINS_PAGE` and `TASK_APPROVAL`.
- **Extension.** The LaTeX guard's message lists `LATEX_EXTENSIONS`.

What follows is left open, in the order worth taking.

## 1. Held by #15229 or #15230

- **Leftover background shells are cleaned up in two layers.**
  `packages/harness/src/controllers/session/sweepLeftoverRuns.ts` deletes
  ended `process` runs and
  `packages/harness/src/agent/runtime/leftoverChildren.ts` ends unfinished
  ones. One sweep in `agent/` needs `sessionOwners.ts`.
- **Which delivery family a run kind uses** is decided in
  `leftoverChildren.ts` (`FAMILY_OF`), in `childDelivery.ts` and in
  `bashDelivery.ts`.
- **The tools that start a child run are listed twice.** `CHILD_TOOLS`
  (`packages/harness/src/shared/transcript/scriptStage.ts`) has `self`;
  `DELEGATION_TOOLS` (`toolRowSections.ts`) does not.
- **The `HistoryQuery` service and its page schema** sit in
  `packages/harness/src/shared/session/runHistory.ts`; only `agent/`,
  `tools/` and `controllers/` read them.
- **App vocabulary in llm.** `isCodexModel` and `isClaudeCodeModel`
  (`packages/llm/src/models/modelRoute.ts`) are read outside llm only by
  `packages/texra/src/shared/agentCliSettings.ts` and the app's agent-CLI
  tools, which #15230 deletes. `codexBackendModelId` stays: llm's own
  Responses configuration reads it.
- **The resume command is formatted in the TUI.** `formatResumeCommand` and
  `oneShotResumeNotice` (`packages/cli/src/chat/tui/state/resumeHint.ts`) are
  read by `runtime/headless/interruptedResumeHint.ts` and
  `commands/resumeRun.ts`: the one upward import left in `runtime/`.
- **A pasted image is named at render time** (`Date.now()` in
  `packages/texra/src/shared/utils/pastedImageName.ts`), so the host checks
  the name again. The fix changes `hostRequest.ts`.

## 2. Left to #15245

The data-structure audit of the same morning gives the CLI's sign-in one
`transport` field, which removes the `--device` with `--no-browser` conflict
that only `/login` checked (`texra auth <provider> login` let the device
flow win). It edits the `/login` parser and its readers, so the move of the
chat-only modules out of `packages/cli/src/runtime/` (item 5 of the
2026-11-25 note) waits for it.

## 3. Free, and not taken

- **The executions tool's name and default action** are spelled in
  `packages/harness/src/tools/ExecutionsTool.ts` and again as plain strings
  in `shared/tools/executionsDisplay.ts`, `shared/tools/toolInputPreview.ts`
  and `shared/transcript/toolRowModel.ts` (one site compares the name
  without normalizing it). `shared/toolUse.ts` already holds the tool's wait
  limits; the fourth site, `toolRowSections.ts`, is held, so the constant
  goes in with it.
- **The CLI words a plan switched on inline**
  (`packages/cli/src/runtime/models/modelAccessSelection.ts`) beside
  `ACCOUNT_OUTCOME.planDisabled`, and `/logout` composes the sign-out lines
  by hand with the account copy's `label` where
  `subscriptionSignOutOutcomeMessage` uses the provider's `displayName`.
  Decision needed: which name a sign-out line carries.
- **"No model available" has three wordings in the CLI**
  (`packages/cli/src/runtime/doctor.ts`, and two in
  `packages/cli/src/runtime/models/modelAccess.ts`).
- **The project's approval policy** reads "Approval policy:" in the
  extension's status bar and "Project approval policy:" in the terminal.
- **Dropped-file URLs are decoded twice**, by the renderer
  (`packages/texra/src/ui/progress/fileDropHandler.ts`) and by
  `MainViewDroppedFilesController.ts`. Not verified for Electron's
  `File.path`.

## Checked and left alone

- **Import directions.** No app module in `shared/`, `utils/`, `model/` or
  `latex/` imports `ui/` or `controllers/`, and no harness module imports a
  higher layer, apart from files the open PRs hold.
- **App vocabulary in the harness.** None outside comments.
- **SQL above the session stores.** Only the history-query process, a
  separate store by design.
