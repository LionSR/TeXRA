# Logic in the wrong layer: what the 2026-11-23 audit left open

Date: 2026-11-23
Status: proposed
Origin: a scheduled audit for abstraction-layer violations, on `main` at
`6b29e26`. It took the open items of the earlier layer notes first
([2026-11-22](2026-11-22-layer-audit-left-open.md),
[2026-11-20](2026-11-20-layer-audit-left-open.md)), then two read-only
sweeps: the hosts for rules and wording the app owns, and the harness and
app for provider facts and app vocabulary outside their owner. Each
candidate was checked against the code,
`.agents/docs/refuted-candidates.json`, the open PR (#15196) and the other
notes in this directory.

The PR that adds this note lands four findings:

- A user-question answer is built once (`userQuestionDecision`,
  `packages/texra/src/shared/session/userQuestionAnswer.ts`) for the web
  panel, the TUI modal and the headless prompt (2026-11-20 item 1). On a
  multi-select question that takes free text, the text adds to the picked
  options on every surface; the terminal reads one typed line where numbers
  pick options (`typedUserQuestionEntry`).
- llm states two facts the app and the harness restated: which models the
  Claude Code CLI runs (`isClaudeCodeModel`, beside `isCodexModel`) and the
  ChatGPT subscription's largest input window
  (`CHATGPT_SUBSCRIPTION_MAX_CONTEXT_WINDOW`). The setup prompt reads
  `KEY_PAGES` and `apiKeyEnvName`; two of its key pages had drifted and it
  listed a provider nothing serves. The harness's helper-model description
  no longer names LaTeX.
- Four notices read the app's copy: the "tasks run in this process only"
  sentence (`runsHereOnlyMessage`), the empty task list, the fork rejection
  of a program task (now `forkRun`'s alone) and the setup pill's tooltip.
- An approval policy's name is the setting row's choice label; the app's
  copy adds the description and tone.

What follows is left open, in the order worth taking.

## 1. The status bar words a plan's quota as what is left

`subscriptionQuotaSegment`
(`packages/cli/src/chat/tui/panes/statusBarDisplay.ts`) picks the window
with the highest `percentUsed` itself and prints
`formatSubscriptionUsagePercent(percentRemaining)` with "left", through a
formatter whose clamps are written for the percent used. `/login status`
and the settings view print the percent used
(`packages/texra/src/ui/copy/subscriptionUsage.ts`), so one plan reads
"70% left" and "30%". The owner is that copy module: the limiting-window
pick and one wording. Decision needed: used or left.

## 2. The harness names one plan in the model listing

`listedModels` (`packages/harness/src/model/computeModelOptions.ts`) lists
every model the ChatGPT subscription serves once signed in, by the literal
`'chatgpt-subscription'`. The other per-plan decisions are tables keyed by
`PlanRoute` in llm. A column that is true for one plan is a special case
written as data, so the question is the rule: does every session plan list
its served models (which adds the Grok subscription's), or is this the
Codex backend's alone.

## 3. A rejected GitHub token is said only in a local GUI session

`followGitHubTokenRejections`
(`packages/texra/src/controllers/session/windowNotices.ts`) presents
`githubTokenInvalid` in the extension and the desktop. The TUI follows no
such signal, and the service link forwards only `workspaceFilesWritten`
(`packages/texra/src/controllers/server/service.ts`), so a window on the
service does not hear it either. The fix is one of two: the signal becomes
session-carried, or the service forwards it and the TUI follows it.

## 4. Smaller single-owner moves

- `texra history delete` words "is active in TeXRA and was not deleted"
  (`packages/cli/src/commands/history.ts`) where `runActionRefusal`
  (`packages/harness/src/shared/session/runActions.ts`) words the same
  rejection for every other surface. The delete result carries the id, not
  the label the owner's sentence names.
- A round's kept reply reads "Open the reply to inspect the generated
  output" in a neutral row on the web
  (`packages/texra/src/ui/progress/components/FileList.ts`) and "Reply kept
  at <path>" in the warning tone in the terminal
  (`packages/cli/src/chat/tui/panes/DocumentTaskRunDetails.tsx`).
  `ROUND_ALERT` (`packages/texra/src/ui/copy/documentOutputs.ts`) has no
  entry for it. Decision needed: its tone.
- The TUI's key-save tip names Kimi K3 by hand
  (`packages/cli/src/chat/tui/commands/handlers/modelAccessCommands.ts`);
  it belongs with item 2 of the 2026-11-21 layer note.
- The loopback sign-in error names port 1455
  (`packages/texra/src/controllers/modelAccess/subscriptionProviders.ts`),
  which is llm's `CHATGPT_CALLBACK_PORTS`; it is wrong when that port was
  taken and the fallback port is used.
- The settings view words the helper-model control itself
  (`packages/texra/src/ui/settings/components/profile/ModelSelectionList.ts`)
  beside the row's title and description.
- The harness still spells the product in two temp-file prefixes
  (`packages/harness/src/agent/runtime/run/img.ts`), the shell wrapper's
  variable names (`packages/harness/src/utils/system/execUtils.ts`) and one
  export (`texraToolOfClaudeTool`,
  `packages/harness/src/common/plugins/hookConfig.ts`).

## Checked and left alone

- **A clone's recovery steps** (2026-11-20 item 2). Both hosts read
  `CLONE_COPY` now; what remains is each host's own next step (a button
  against a command to type).
- **The dispatched-children rollup** (2026-11-22 item 1). Still needs the
  decision on whether the terminal counts a script's calls.
