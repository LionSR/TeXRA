# Logic in the wrong layer: what the 2026-11-27 audit left open

Date: 2026-11-27
Status: proposed
Origin: a scheduled audit for abstraction-layer violations, on `main` at
`3bc72f1`. Three read-only sweeps (the hosts, the app, the harness and llm)
and an import graph of each. Every candidate was checked against the code,
`.agents/docs/refuted-candidates.json`, the 2026-11-25 and 2026-11-26 layer
notes and the five open PRs (#15216, #15230, #15242, #15245, #15247), which
hold 178 files.

The PR that adds this note lands what no open PR holds, under one rule: a
name or a module lives in the layer whose code reads it, and is written
once.

- **Harness names.** `EXECUTIONS_TOOL_NAME`, `SELF_TOOL_NAME` and
  `SKIPPED_RESULT_NAME` sit beside the agent, program and script tool names;
  `DELIVERY_ATTRIBUTE` sits beside `DELIVERY_FAMILY`. The row model, the
  input preview, the script stage and the delivery summary read them where
  each compared a literal of its own.
- **Harness modules.** `toolResultText.ts` left `shared/` for `tools/core/`;
  the HTTP retry rule left `utils/core/` for `tools/timeouts.ts`, its one
  reader.
- **App.** The transcript export's seven modules left `agent/` for
  `packages/texra/src/controllers/export/`; its wording is
  `packages/texra/src/ui/copy/transcriptExport.ts`.
- **Hosts.** The clone prompt and the headless proposal's instruction label
  read the copy.

No import runs upward in the harness, the app or the CLI beyond the three
edges the earlier notes record. What follows is left open, in the order
worth taking.

## 1. Free, and a decision first

- **The approval card and its controller both decide "is this a LaTeX
  file".** `packages/texra/src/ui/progress/components/ToolEditRequestPanel.ts`
  offers `previewProposed` only for a LaTeX file, and
  `packages/texra/src/controllers/approval/ToolEditApprovalController.ts`
  branches on `isLatexFile` again, falling back to `openProposed`. No host
  sends the action for another file, so that branch and both hosts'
  `openProposed` are unreachable from a card; three desktop approval tests
  drive it directly to edit the proposed copy on disk. Decision: delete the
  port and rewrite those tests through the diff view, or give every file an
  "open proposed copy" action.
- **The transcript layout classifies edits by its own rule.**
  `packages/texra/src/ui/progress/turnLayout.ts` keeps a row's diff in view
  when `toolDisplayKind` is `edit`; the harness draws a diff for
  `isEditLikeToolName` (`packages/harness/src/shared/tools/toolKind.ts`),
  which also takes a delegated agent's `edit`, `multiedit` and
  `str_replace*` names and is not exported to the app. The same file spells
  `grep`, `glob` and `agent`. The fix is a new SDK export, or an `isEdit`
  fact on the row model; #15230 removes the plugin whose rows differ today.
- **The compile fixer's instruction and launch config are in the
  extension** (`packages/extension/src/commands/latex/latexCommands.ts`):
  `COMPILE_FIX_RULES`, `entryAgent()`, the default model and
  `helperModel: true`, none of it VS Code's. Decision: whether the rules
  survive the removal of prompt tutoring at all; if they do, they belong
  beside `packages/texra/src/agent/entryAgent.ts`.
- **The CLI's terminal title derives session activity itself**
  (`packages/cli/src/chat/tui/terminalTitle.ts`): only a root run counts as
  running, where the desktop title and the extension's pill call
  `sessionActivity`. Decision: whether a working background agent under a
  waiting root reads as running in the tab.
- **`shared/session/` holds the run state updaters** (`runState.ts`,
  `runFacts.ts`, `inFlight.ts`, `turnRowHandlers.ts`) that only `agent/`,
  `tools/` and `controllers/` read. `packages/harness/AGENTS.md` places the
  row model there on purpose; moving them is about 150 import edits and
  changes that document first.
- **The harness names a deleted app plugin.** `RETIRED_PLUGIN_FACTS`
  (`packages/harness/src/shared/schemas/rowVersions.ts`) lists
  `theory/output` and `theory/accepted`. It is a stored-format rule, so the
  cut is a format change.

## 2. Held by an open PR

- **Plans with no credential are dropped in the view.**
  `packages/texra/src/controllers/session/hostSnapshotSource.ts` passes a
  `missing_credentials` quota through and
  `packages/texra/src/ui/progress/components/PlanUsageMeters.ts` filters it,
  so the desktop footer, which tests the unfiltered list, renders with no
  chips. The controller should return none. (#15216)
- **The quota window a plan runs out of first is chosen twice.**
  `PlanUsageMeters.ts` drops a window past its reset before taking the
  fullest; `packages/cli/src/chat/tui/panes/statusBarDisplay.ts` sorts
  without dropping. One function in
  `packages/texra/src/ui/copy/subscriptionUsage.ts`. (#15245)
- **"Is this write a provider key"** is tested in
  `packages/cli/src/chat/tui/modelConnection.ts`, in `hostSnapshotSource.ts`
  and in `packages/texra/src/controllers/settingsView/settingsViewBody.ts`.
  One predicate beside `apiKeyEntry` in llm. (#15216)
- **The desktop sidebar toggle reads `rollup.waiting`**
  (`packages/desktop/src/renderer/main.ts`) where the rail and the dock
  badge read `attentionOf`. (#15216)
- **The device-code prompt is assembled in three hosts**; see
  `2026-11-24-subscription-sign-in-presenters-left-open.md`. (#15245)
- **The run display category** (`runDisplayCategory`,
  `packages/harness/src/tools/executionFormatters.ts`) is keyed by bare
  strings in `packages/harness/src/shared/schemas/runRecords.ts` and derived
  a third way in `packages/cli/src/runtime/history.ts`. (#15245, #15216)
  Landed 2026-11-28: `serializeFilteredConfig` takes the record alone and
  reads whether it is a program's run from it (`programOf`), so the
  string-keyed table, the CLI's mapping onto it and the executions tool's
  view read for the category are gone. A run the session view no longer
  lists is filtered too, where it used to print unfiltered.
- **The `bash` timeout cap** is `600_000` in the schema, in its description
  and in the timeout message of `packages/harness/src/tools/bash.ts`.
  (#15245)
  Landed 2026-11-28: one constant beside the schema, and the description
  words the cap and the default from the two constants (the same text).
  The timeout message no longer states the cap.
- **"Does the total include the agents' spend"** is decided by field
  comparison in `packages/texra/src/ui/progress/components/UsagePanel.ts` and
  by a child count in `packages/cli/src/chat/tui/sessionStatus.ts`.
  (#15242, #15245)
- **`RunTabs.ts` walks `childIds` by hand** where `descendantRuns` has a
  seen-set, and **`packages/texra/src/shared/state/PersistedState.ts`** is
  read only by renderers. (#15216)
  Landed 2026-11-28 (#15216 closed without merging): the search filter
  walks a run's tree with `descendantRuns`, and `PersistedState.ts` is
  `packages/texra/src/ui/progress/PersistedState.ts`, beside the session
  surfaces that read it; `shared/state/` held nothing else and is gone.
- The items of section 1 of the 2026-11-26 note that #15229 freed are
  unchanged: the two leftover-run sweeps, `FAMILY_OF`, and the resume
  command formatted under `chat/tui/state/`, whose readers #15216 and
  #15245 hold.

## Checked and left alone

- **`CHILD_TOOLS` and `DELEGATION_TOOLS`** differ by `self` on purpose: a
  script's `self()` call is a stage row, never a card with a launch section.
- **The file dialog's titles**
  (`packages/texra/src/controllers/session/launcherFilePicker.ts`) are not
  the launcher's button labels; reading them from the copy table needs a
  lookup that can miss.
- **`shared/model/modelLabel.ts`** forwards to llm in one line, for eleven
  readers that would otherwise each handle an unknown model.
