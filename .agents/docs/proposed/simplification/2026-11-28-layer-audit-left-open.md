# Logic in the wrong layer: what the 2026-11-28 audit left open

Date: 2026-11-28
Status: proposed
Origin: a scheduled audit for abstraction-layer violations, on `main` at
`5b7f63e`. It took the items the 2026-11-25, 2026-11-26 and 2026-11-27 layer
notes left behind open PRs that have since merged or closed, read each
against the code, and ran one read-only sweep of the hosts. Two PRs were
open (#15275, #15276); neither holds a file named here.

The PR that adds this note lands seven of them, under one rule: a fact is
decided in the layer that owns it, and the views and hosts above read it.

- **App controller, not the view.** A plan with no credential is left out of
  `HostSnapshot.planUsage` (`hostSnapshotSource.ts`); the meters filtered it
  at render, so the desktop footer rendered empty.
- **One function in the copy.** The window a plan runs out of first
  (`limitingQuotaWindow`) and the desktop toggle's "waiting on you". The
  approval policy lines, which this audit also found worded per host, landed
  the same morning as `APPROVAL_POLICY_LINE` in #15287.
- **llm.** `routedApiKeyProvider` answers "is this secret a known provider's
  key" for the terminal, the host snapshot and the settings body.
- **Harness.** `isEditLikeToolName` is on the transcript entry, and the turn
  layout keeps an edit in view by the rule that draws its diff.
- **Hosts.** The desktop sidebar toggle reads `attentionOf`; the resume
  command is `packages/cli/src/runtime/resumeCommand.ts`, so `runtime/` and
  `commands/` no longer import the TUI for it.
- **App import direction.** `WORKSPACE_DIFF_SUFFIX` is in
  `packages/texra/src/common/files/fileHandlingRules.ts`; `common/` no
  longer imports `latex/`.

What follows is left open, in the order worth taking.

## 1. A decision first

- **Two headless renderers read "a live child" differently.**
  `packages/cli/src/runtime/headless/runProgressRenderer.ts` lists a child
  for the status line when `isLive`;
  `packages/cli/src/runtime/headless/sessionProgressSubscription.ts` writes
  the `run.children` record for `holder === 'here'`, under a comment that
  says live. A child idle between turns is in the record and off the line.
  The record is read by machines, so which reading it carries is a wire
  decision.
- **The extension pill's spend counts a tree for `holder === 'here'`**
  (`packages/extension/src/frontend/statusBar/taskStatusBar.ts`) beside a
  count that reads `rollup.running` (`isLive`). Decision: whether an idle
  conversation's spend belongs in the tooltip while another run works; then
  a "roots whose tree is live" read beside `descendantRuns`.
- **The CLI's terminal title, the compile fixer's launch config, the
  approval card's `openProposed` branch**: unchanged from section 1 of the
  2026-11-27 note.
- **The quota window past its reset** is dropped by the meters, which tick,
  and not by the terminal's status bar, which reads the snapshot again on a
  timer and holds no clock for it. Left as each surface's.

## 2. Free

- **The settings view decides model-list rules at render time**
  (`packages/texra/src/ui/settings/components/profile/ModelSelectionList.ts`):
  the last-enabled lock and the made-up helper option. Item 4 of the
  2026-11-25 note; the wire shape is
  `packages/texra/src/shared/settingsView/settingsViewMessages.ts`.
- **"Does the total include the agents' spend"** is still a field comparison
  in `packages/texra/src/ui/progress/components/UsagePanel.ts` and a child
  count in `packages/cli/src/chat/tui/sessionStatus.ts`.
- **The device-code prompt** is assembled in three hosts
  (`2026-11-24-subscription-sign-in-presenters-left-open.md`).
- **The settings controller words its notices inline**
  (`packages/texra/src/controllers/settingsView/settingsToolCommands.ts`).

## Checked and left alone

- **`installAdvice` in the LaTeX tab.** The controller calls it to build the
  allowlist of install commands and the tab to render one platform's advice:
  a pure read of one table, with no value computed twice.
- **The two leftover-run sweeps** do different jobs at different times: one
  deletes ended shells at session open, the other finishes a resuming
  parent's children.
- **`rootWaiting` and `canStopRootRun`**
  (`packages/cli/src/chat/tui/state/sessionRunState.ts`) match none of
  `isLive`, `isWorking` or `isIdle`: Ctrl-C's rule counts a `ready` root and
  not one waiting on its own request.
