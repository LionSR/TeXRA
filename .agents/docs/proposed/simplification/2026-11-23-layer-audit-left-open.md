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
  the label the owner's sentence names. Checked on 2026-11-23 (evening)
  and left: the label would come from the session view, which a window of
  the service may not hold for that run, and a second sentence for that
  case is the drift this item is about.
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
  `packages/harness/src/common/plugins/hookConfig.ts`). **Landed 2026-11-23
  evening:** the prefixes are `resized-image-` and `pdf-conversion-`, the
  variables `_lifeline_pid` and `_command_status`, and the export
  `harnessToolOfClaudeTool`.

## 5. Modules that sit in a layer their readers are not (2026-11-24)

A sweep of the app outside `ui/` and the hosts' non-UI code for modules
whose readers are all in another layer, or that reach up a layer.
**Landed 2026-11-24:**

- The revision layout (`revisionLayout.ts`) left `shared/constants/` for
  `packages/texra/src/agent/output/`: every reader is Node-side, and
  `shared/` holds wire contracts and webview-shared types.
- The CLI's result writer (`emitCliResult`, `writeCliResult`) left
  `commands/_helpers/` for `packages/cli/src/runtime/platform/output.ts`,
  so `runtime/doctor.ts` no longer imports a command helper to print.
- The slash palette's typo distance (`editDistance.ts`) moved beside its
  one reader, `packages/cli/src/chat/tui/commands/slashRegistry.ts`; its
  subcommand half went when the command tree moved to effect/cli.
- `texra run`'s target wording (`runtime/runTarget.ts`) and the settings
  view's `commandOnly` (`messageFactories.ts`) folded into their one reader.

Still open, each blocked only by the files open PR #15216 holds:

- **The CLI runtime reads the chat TUI's state for a resume command.**
  `formatResumeCommand` and `oneShotResumeNotice`
  (`packages/cli/src/chat/tui/state/resumeHint.ts`) are read by the
  headless runtime (`packages/cli/src/runtime/headless/interruptedResumeHint.ts`)
  and by `texra resume` (`packages/cli/src/commands/resumeRun.ts`). Both
  belong in the runtime, beside the context they format; the TUI keeps
  the exit hint's usage lines. `chatSessionController.ts` imports
  `oneShotResumeNotice` from the TUI module, so the move waits for #15216.
- **Each GUI host stages a tool edit's two files its own way.** The
  desktop makes a directory per request and removes it
  (`packages/desktop/src/main/desktopToolEditApproval.ts`); the extension
  writes into one storage directory and removes the two files
  (`packages/extension/src/frontend/approval/VscodeToolEditApprovalHost.ts`).
  Both call `writeApprovalTempFiles`
  (`packages/texra/src/controllers/approval/tempFileManager.ts`), whose
  header names the split. The controller could stage both the same way and
  hand the host only the paths; the extension's directory is passed in by
  `ProgressViewProvider.ts`.
- **Two desktop "shared" modules only the renderer reads**
  (`packages/desktop/src/shared/desktopShellState.ts`,
  `packages/desktop/src/shared/postMessageOrigin.ts`) belong under
  `packages/desktop/src/renderer/`.

## Checked and left alone

- **A clone's recovery steps** (2026-11-20 item 2). Both hosts read
  `CLONE_COPY` now; what remains is each host's own next step (a button
  against a command to type).
- **The dispatched-children rollup** (2026-11-22 item 1). Still needs the
  decision on whether the terminal counts a script's calls.

## Re-checked 2026-11-24 (the harness and llm)

A sweep of the layers inside and at the edge of `packages/harness/src` and
`packages/llm/src`, on `main` at `dda1913b13`. Every open item of
this note and the 2026-11-15 to 2026-11-22 layer notes that falls in the
harness or llm still needs its decision (2026-11-23 item 2, 2026-11-22
item 3, 2026-11-21 item 2, 2026-11-19 items 1, 2 and 4, 2026-11-15 item
9), or sits in subscription code this sweep stayed out of.

**Landed 2026-11-24:** the harness carried a process port nothing in the
harness read, `HostResources` (the app's packaged resources root), typed
into `PlatformServices`, built by `processLayer` from
`AgentPlatform.resourcesRoot` and exported on `./plugins`. Only TeXRA's
theory templates and its transcript export read it. The app serves its own
`ResourcesRoot` reference beneath every session
(`packages/texra/src/hosts/resourcesRoot.ts`), and the port, the platform
field and the process option are gone. The 2026-11-07 ruling that kept
`resourcesRoot` held because the harness then read it for the plugins'
agent directories; those went with the agent catalog.

Found and left:

- **Two GitHub signals in the harness's signal table.**
  `githubTokenInvalid` and `githubSubscriptionsChanged`
  (`packages/harness/src/platform/appSignals.ts`) name one app plugin's
  facts; the harness neither emits nor reads either. The table could take
  the app's signals as data (an interface the app augments) or the plugin
  could own its stream. Left: the choice is the owner's, and the token
  signal's one subscriber is in `windowNotices.ts`, which open #15216
  edits.
- **`GlobalStorageFs` has no reader.** The process builds it
  (`globalStorageFsLayer`) and `PlatformServices` lists it, but no program
  in any package reads it; every reader of global storage takes the path
  as data. Removing it from `./plugins` is the published surface, which
  item 12 of the 2026-11-21 plugin note leaves to the owner.
