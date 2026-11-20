# Logic in the wrong layer: what the 2026-11-20 audit left open

Date: 2026-11-20
Status: proposed
Origin: a scheduled audit for abstraction-layer violations, on `main` at
`f38bb2a`. It did one read-only sweep of the three hosts against the app,
and a check of the harness for provider and product facts. Each candidate
was checked against the code, `.agents/docs/refuted-candidates.json` and the
other notes in this directory.

The PR that adds this note lands six findings:

- llm decides a provider's endpoint (`RouteFacts.chinaPlatforms`) and the
  GLM Coding Plan's precedence over a user endpoint. Before, the precedence
  was split between `readModelSettings` and `decideModelRoute` (item 3 of the
  2026-11-19 layer note).
- Harness messages and the session-label prompt no longer name TeXRA or
  TikZ (part of item 8 of that note).
- `/config` reads `settingEnumChoices`, so an enum shows its choice label.
- The settings body parses its own messages, so a malformed one is reported
  the same way on both GUI hosts.
- The file-actions controller checks that both compared files exist.
- The window body resolves a workspace-relative `openFile` path.

What follows each needs a decision.

## 1. A user-question answer is assembled per surface

`parseUserQuestionAnswer` (`packages/cli/src/runtime/headless/userQuestionAnswer.ts`)
returns free text as one string even on a multi-select question. The TUI
modal (`packages/cli/src/chat/tui/modals/UserQuestion.tsx`) drops free text
on a multi-select question. The web panel
(`packages/texra/src/ui/progress/components/UserQuestionPanel.ts`) merges it
into the selected list. So one question gets a different answer shape on
each surface. One pure `userQuestionAnswer(question, { selected, text })`
beside `UserQuestionAnswers`
(`packages/harness/src/shared/schemas/requestPayloads.ts`) would own it.
Decision needed: which shape wins for multi-select with free text.

## 2. The GUI session summary counts differently per host

The desktop rail (`packages/desktop/src/renderer/desktopShell.ts`,
`projectStatus`) reads waiting, interrupted, running and unseen from
`view.rollup`. The extension status bar
(`packages/extension/src/frontend/statusBar/taskStatusBar.ts`) counts
`runs.filter(isWorking)`, children included, and has no interrupted state,
yet its comment says it words itself like the rail. A
`sessionStatusSummary(view)` in `packages/texra/src/ui/copy/runStatus.ts`
would own both. Decision needed: does the status bar count child runs?

## 3. A clone's recovery steps are decided per host

`packages/extension/src/commands/git/gitCommands.ts` and
`packages/cli/src/commands/clone.ts` each decide which links and next step
an invalid-token or auth-failure outcome offers. They differ: the extension
offers a Retry button nothing handles, and the CLI always prints the docs
URL. A `cloneRecovery(outcome, remote)` beside `CLONE_COPY`
(`packages/texra/src/ui/copy/clone.ts`) would return the links and the
step. Decision needed: the one set of steps, and whether a GUI retries.

## 4. The desktop's open-file verbs drop facts

After this PR's `openFile` fix, two desktop gaps remain. The preview host
drops `line` (`packages/desktop/src/main/desktopWindowHost.ts`). Every
latexdiff output opens as `kind: 'external'`
(`packages/desktop/src/main/desktopHostRequests.ts`). Whether a PDF tab can
take a line, and whether a diff inside the workspace should open as a
workspace file, is a desktop product call.

## 5. Tool descriptions with LaTeX examples

The harness's glob and grep tool descriptions (`packages/harness/src/tools/glob.ts`,
`packages/harness/src/tools/grep.ts`) use `**/*.tex` examples. A neutral
example changes the tool text every run records and what the model sees in
TeXRA, so it was left.

## Checked and left alone

- **The tool-edit request header.** Three surfaces word it from
  `REQUEST_ASK.edit` and the same relative path. Only the headless summary
  adds `(from <tool>)`, which is that sink's choice, not a drifted rule.
- **The stored provider list `MODEL_PROVIDERS`** beside llm's
  `BACKEND_PROTOCOLS`. Storage owns that enum on purpose, so that a catalog
  change is never a silent stored-format change, and a compile-time check
  ties the two lists together.
- **The `texra.db` file name and temp-file prefixes.** The first is a
  stored format; the second is invisible.
