# Logic in the wrong layer: what the 2026-11-25 audit left open

Date: 2026-11-25
Status: proposed
Origin: a scheduled audit for abstraction-layer violations, on `main` at
`37a22c5`. Three read-only sweeps (the hosts, the harness and llm, the app)
and a reverse import graph of every source file: for each module, the
directories its production readers sit in. Each candidate was checked against
the code, `.agents/docs/refuted-candidates.json`, the open PRs (#15216,
#15229, #15230) and the other notes in this directory. The three open PRs
hold about 430 files between them, so most of what follows waits on them.

The PR that adds this note lands the instances no open PR holds, under one
rule: a module lives in the layer its readers are in, and a fact is worded
where its other wording is.

- **Harness, run-loop modules that sat below the runtime.** `readCause` and
  the ancestry walks (`ancestorIds`, `ancestryRows`) left `shared/session/`,
  and `classifyAgentError` left `common/errors/`, for `agent/runtime/`: the
  run loop is their only reader. The toast a failure becomes
  (`agentErrorPresentation`) is `presentAgentFailure`'s own body now, with
  the union type that carried it between two files gone.
- **Harness, tool modules that sat below the tools.** `refusalCopy` is
  `tools/approval/refusalCopy.ts`, the external-root lookup
  (`findExternalRoot`) is file-local in `tools/pathResolution.ts`, the
  HTML-to-Markdown converter is `tools/web/htmlToMarkdown.ts`, and the
  bundled-skills path is written where the skill sources are listed, not in
  the run-storage layout.
- **App.** The session title's wording (`formatSessionTitle`) and the clone
  notice (`overleafCloneNotice`) are `ui/copy` modules, so `shared/` and
  `latex/` no longer import `ui/`. Diagnostic formatting is in `tools/`, the
  terminal output cap beside `TerminalRunResult`, and the draft polish
  beside the request that calls it (the app's one-file `agent/runtime/` is
  gone).
- **One label, three derivations.** A subscription's account label was
  computed by the controller, again by the settings view and a third time by
  the terminal, each with its own fallback. Left to #15234, which names an
  account through one function (`subscriptionAccountLabel`).
- **Host rules.** `adoptLoginShellEnvironment` knows Windows has no login
  shell, where only the desktop did; the extension's linter asks
  `isLatexFile`, so a `.ltx` file is built before its diagnostics are read.

What follows is left open, in the order worth taking.

## 1. Harness modules whose readers are one higher layer, held by #15229

Same rule as above; each fix edits a file #15229 or #15230 holds.

- `packages/harness/src/shared/toolResultText.ts` formats a tool result for
  the model. Its readers are the dispatch loop, the completed-run archive,
  the MCP server and `bash`; no UI reads it.
- `packages/harness/src/utils/core/httpStatus.ts` and
  `packages/harness/src/utils/core/backoffSchedule.ts` are read only by
  tools and the runtime.
- `BASH_BACKGROUND_LOG_CAP_CHARS` (`packages/harness/src/shared/toolUse.ts`)
  is read only by `tools/bash.ts` and `tools/executions/processOutput.ts`.
- `packages/harness/src/agent/runtime/delegation/bashDelivery.ts` is read
  only by `tools/bash.ts`.

## 2. The store file's name sits in `utils/`

`storeFileName` (`packages/harness/src/utils/system/appNamespace.ts`) is read
only by the session stores in `controllers/session/`, and
`projectDatabase.ts` spells `${namespace}.db` by hand beside a call to it.
It belongs with the store schema. Left because
`packages/harness/docs/spec.md` cites the current path and #15229 holds that
file.

## 3. Why a model cannot be served is worded twice in the harness

`routeDecision.ts` (`packages/harness/src/agent/runtime/modelAccess/`) words
an unserved model from `config.retired` / `config.openRouterOnly`;
`UNAVAILABLE_REASON_BUILDERS`
(`packages/harness/src/model/computeModelOptions.ts`) words the same verdict
again, and the two texts have drifted ("Choose an active model" against
"Choose another model"). `modelAvailability.ts` says a surface's words for
each kind are the app's. Decision needed: one harness sentence both read, or
a reason kind the app words.

## 4. The settings view decides model-list rules at render time

`ModelSelectionList.ts`
(`packages/texra/src/ui/settings/components/profile/`) groups by source and
splits out deprecated models, repeats the harness rule that the last enabled
model cannot be switched off (`computeModelOptions.ts`), and makes up an
option for a helper model that is not in the list. The controller should send
the groups, the lock and the helper choices. The wire shape is
`settingsViewMessages.ts`, which #15229 holds.

## 5. CLI directories that import upward

- `packages/cli/src/runtime/completion/` imports
  `CLI_GLOBAL_FLAG_DESCRIPTORS` from `commands/_helpers/cliCommand`, and its
  only reader is `commands/root.ts` (held). It belongs under `commands/`.
- `packages/cli/src/runtime/headless/taskAttach.ts` imports
  `fullTranscriptEntryLayout` from `chat/tui/panes/` (held).
- `runtime/models/apiStatus.ts`, `loginOptions.ts` and
  `modelAccessSelection.ts`, and `runtime/terminal/clipboardImage.ts`, are
  read only by `chat/tui/`. Moving them is mechanical; left to keep this PR
  to modules with a wrong import direction or a duplicated fact.

## 6. Smaller single-owner moves

- `common/files/fileHandlingRules.ts` imports `WORKSPACE_DIFF_SUFFIX` from
  `latex/latexdiff/diffFileNameManager.ts` (held): `common/` reading up.
- `utils/text/braceBalancedMacro.ts` and `utils/text/xmlCdata.ts` are each
  read by one subsystem (`latex/criticismParser.ts`, `agent/output/`), both
  held.
- `installAdvice` for the LaTeX tab is computed in the controller
  (`LatexToolingController.ts`) and again at render time
  (`ui/settings/tabs/LaTeXTab.ts`, held).
- The settings controller words its LaTeX and extension notices inline
  (`controllers/settingsView/settingsToolCommands.ts`) where its sibling
  commands read `ui/copy`. `providerKeyActions.ts` does the same and is held,
  so the two go together.
- `shared/model/modelPicker.ts` mixes the picker's wording with pricing
  predicates. Decision needed: whether `model/` may import `ui/copy`.
- `texra tasks start` prepends the one-shot run's guidance ("This CLI run
  exits after your final response") to a task that outlives the terminal
  (`packages/cli/src/commands/tasks.ts`, through
  `commands/_helpers/runInstructions.ts`). Decision needed: whether that is
  intended for a service task.

## Checked and left alone

- **The desktop editor tree's order.** `listDirectory`
  (`workspaceFileRequest.ts`) sorts by name and the renderer sorts again,
  directories first. #15232, opened the same morning, gives the tree one
  sort, so this audit did not touch either file.
- **Harness import directions.** No module imports a higher layer than
  `packages/harness/AGENTS.md` "Layer order" allows, and no string the
  harness or llm sends a model or shows a user carries the app's vocabulary.
- **`texra`-prefixed hash domains in llm**
  (`texra-google-interactions-prefix-v1`,
  `texra-openai-responses-prefix-v1`): persisted names, with the format
  decision item 8 of the 2026-11-19 note defers.
