# What the refused candidates share

Date: 2026-11-19
Status: proposed

Origin: a re-read of all 60 entries of `.agents/docs/refuted-candidates.json`
and the six "do not do it" rulings of
`.agents/docs/proposed/process/2026-11-17-open-proposals-triage-and-order.md`,
on `main` at `0611897`. Each entry rejects one fix. This note asks what made
the fix fail, groups the entries by that cause, and checks each group against
the code. Counts below were measured on that commit by grep and by reading the
files named; nothing was built or run.

## The result in one table

| Group                                                          | Entries | What is behind them                                              |
| -------------------------------------------------------------- | ------- | ---------------------------------------------------------------- |
| Two facts that looked like one, or a library that does not fit | 35      | Nothing. The rejections stand.                                   |
| The CLI's command framework                                    | 2       | About 1,950 hand-written lines around citty (section 1)          |
| A subscription plan is not one row                             | 4       | Three id vocabularies and a dozen ungated branches (section 2)   |
| Production code kept for a module mock                         | 3       | Ten mocks of functions that already run on an Effect service (3) |
| "Resume" names three things                                    | 1       | A listing field that is true for a finished conversation (4)     |
| A plugin's request has no declared shape                       | 4       | Facts have a schema registry, requests do not (section 5)        |
| "Is this a script run" in four spellings                       | 4       | 27 sites; rides with programs phase 5 (section 6)                |
| One project named twice                                        | 4       | A ruling with no stated reason; twelve functions (section 7)     |
| Callbacks of a framework that holds no runtime                 | 3       | Nothing to change; the rule is already in the root guide         |

The record itself has a problem of its own, in section 8: a third of its
entries no longer describe the code.

## 1. The CLI's command framework

Entries: `RT-install-cli-process-runtime`, `RT-cli-exit-code-one-function`.
Both were rejected for the same reason: citty's `runCommand` drops a
subcommand's result and passes nothing down, so every command builds its own
runtime inside an async callback and the exit code travels through a module
slot (`packages/cli/src/commands/_helpers/exitCode.ts`).

Neither entry asks whether citty earns its place. Measured:

- Twenty files import citty, all in `packages/cli/src`. `runMain` is unused;
  `runCli` (`packages/cli/src/commands/root.ts`) re-implements it.
- Around it sit about 1,950 hand-written lines: lifting global flags across
  subcommands because citty does not pass a parent's flags to a child
  (`packages/cli/src/commands/_helpers/dispatch.ts`, 597 lines), repeated
  flags read from raw `argv` because citty keeps the last value only
  (`packages/cli/src/commands/_helpers/globalArgs.ts`, 315 lines), unknown
  command and flag detection with edit-distance suggestions, usage sections
  attached through a `WeakMap`, and shell completions for three shells
  (`packages/cli/src/runtime/completion/`, about 800 lines).
- Effect ships a command module (`effect/cli`, effect 4.1.4) with shared
  parent flags accepted on either side of a subcommand, repeated and negated
  flags, suggestions for an unknown command or flag, completions for four
  shells, and a handler that is an Effect whose requirements flow up to one
  run at the process edge. Nothing in `.agents/docs` has ever weighed it.

What argues against: every module of it is marked `@stability unstable` (the
harness already depends on unstable modules: `effect/rpc`,
`effect/reactivity`, `effect/persistence/RateLimiter`); it has no default
subcommand, which `texra` with no arguments and `texra auth chatgpt` rely on;
a handler returns nothing, so an exit code would travel as a failure carrying
`Runtime.errorExitCode`; help text would change wording; and
`.claude/skills/texra-cli/SKILL.md` says to lean on citty.

Recommendation: one measured trial, ending either in a PR that deletes the
dispatch, flag and completion code, or in a new entry `EFF-ADOPT-cli` with
the numbers. The trial converts the root, one group and two leaves first and
reports before converting the rest.

## 2. A subscription plan is not one row

Entries: `LLM-subscription-credential-facade`,
`LLM-xai-token-expiry-one-reading`, `G11f-subscription-descriptor-columns`,
`G11g-usage-region-out-of-cache-key`. Each defends one piece correctly. What
they share is that there is no place where a plan is described once.

`packages/harness/AGENTS.md` lists seven places an API-key provider touches,
six of them held by the compiler, and then says a plan is "not enforced".
Measured:

- Four plans under three id vocabularies: the route (`chatgpt-subscription`,
  `PLAN_ROUTES` in `packages/llm/src/errors.ts`), the sign-in id (`chatgpt`,
  `grok`, `packages/harness/src/shared/model/subscriptionAuth.ts`) and the
  key-plan id (`kimiCode`, `glmCodingPlan`,
  `packages/texra/src/shared/model/codingPlans.ts`). The two app catalogs
  share no type.
- `PLAN_ROUTES` holds two columns. Everything else about a plan is in about
  ten other tables, nine of them typed against a `Record` of one of the
  three vocabularies.
- About a dozen sites branch by plan with no exhaustiveness check, among them
  `decideModelRoute` and `routeConfig`
  (`packages/llm/src/models/modelRoute.ts`), the limit readers in
  `packages/llm/src/api/verdict.ts`, and `subscriptionCredential`
  (`packages/harness/src/agent/runtime/modelAccess/credentials.ts`), which
  tests for ChatGPT and treats everything else as xAI: a third sign-in plan
  would take xAI's path without a compile error.
- ChatGPT is named in about 38 files across six packages, Grok in about 27.
  The extension and the desktop wire a command for ChatGPT only.

Recommendation: the mirror of "a new provider is data". One plan table in
`packages/llm` keyed by route, whose row carries what the branches test
(credential kind, how a limit reply is recognised, the wire model rewrite,
whether a usage read exists), with the sign-in id and the key-plan id derived
from it. First step, which stands alone: make those branches
exhaustive over the route, starting with `subscriptionCredential`. The table
is a design decision and gets its own note.

## 3. Production code kept for a module mock

Entries: `RF-TT-11-locate-tool-module`,
`TEST-kernel-default-process-without-validation-model`, and the second half
of `G11f-subscription-descriptor-columns`.

The repo has 20 `vi.mock` calls in 14 suites. At least ten replace a function
that already requires only an Effect service, for which the suite could
provide a layer:

| Mocked                                                                                     | Service it already runs on                                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `locateTool`, `runTool`, `executeCommand`, `detectLatexSettingsStatus`, `compileLatex2Pdf` | `ChildProcessSpawner` (`src/test-kernel/support/childProcessTestLayer.ts` has the scripted layer) |
| `ghGet`, `fetchAnnotations`                                                                | `Secrets` and `HttpClient`                                                                        |
| `cliSecretsLayer`                                                                          | `Secrets`                                                                                         |
| `leanServerPool`                                                                           | `LeanLanguageServices`                                                                            |

`packages/texra/src/tools/setup/toolProbing.ts` is a one-export file with one
consumer, kept because a suite mocks it. One production read exists for tests
only: `VITEST` in
`packages/harness/src/agent/runtime/run/recordedRequest.ts`.

Recommendation: replace the module mocks of this repo's own modules with
layers, then delete what was kept for them, `toolProbing.ts` first. No new
test; the suites keep their assertions.

`G11f`'s mock reason is already gone: there are no call-through lambdas in
`packages/texra/src/controllers/modelAccess/subscriptionProviders.ts`, and
`packages/texra/test/tools/setup/DefaultSetupPlatform.vitest.ts` has no spy.
Only its first half (both columns are read) still holds.

## 4. "Resume" names three things

Entry: `RT-listing-entry-actions`. The rejection is right: the listing and the
view answer different questions. The cause is that both answers carry one
word.

- The listing's `resumable` (`packages/harness/src/agent/storage/runListing.ts`)
  means "these rows can be continued here". It is true for a finished
  conversation, so `texra history` prints "(resumable)" beside conversations
  that completed.
- The view's `resume` action
  (`packages/harness/src/shared/session/runActions.ts`) means "this run was
  interrupted".
- Sending a message to an ended conversation is `followUp.send`, which calls
  the same `resumeRun` behind the same check.

Recommendation: the listing field says what it means (`continues`, with
`continueBlocked` for the reason) and `resume` stays for an interrupted run.
It is a public name on the SDK's listing and a label in the CLI, cheap before
1.0 and a breaking change after.

## 5. A plugin's request has no declared shape

Entries: `UI-inquiry-decode-by-reference`, `DOC-user-edit-on-task-run`,
`RT-tui-approve-handler`, `UI-request-card-declaration-record`, and the
ruling against unifying the CLI's approval stack with the web panels.

The stated cause, "a plugin's payload is opaque to the harness", is half
true. A plugin's facts are declared: `Plugin.factKinds`
(`packages/harness/src/tools/plugins.ts`) carries a schema per kind, checked
on write and on read from the store. A plugin's request has no such
declaration: `data` is JSON, and the only description of how to show it is a
web component's tag.

What follows from that, measured:

- The terminal has no presentation of a plugin request.
  `packages/cli/src/chat/tui/state/approvalQueue.ts` filters them out and
  `packages/cli/src/runtime/headless/approvalAdapter.ts` answers one with
  `Effect.never`. The one plugin request today (the external inquiry) does
  not block its run, so nothing waits forever; an inquiry simply cannot be
  answered from a terminal.
- The answer set is already shared: `REQUEST_ACTIONS`
  (`packages/texra/src/shared/session/surfaceDecision.ts`) and
  `packages/texra/src/ui/copy/requestCards.ts` are read by the web panels,
  the terminal's cards and the headless prompts. What stays per host is
  layout, keys and forms, which is why both concrete unifications failed.
- The view carries facts as JSON although the harness holds their schema, so
  each reader decodes again (three sites, two plugins, all in
  `packages/texra/src`).

Decided 2026-11-19: the external inquiry tool is retired. It is the only
plugin request and the only user of `Plugin.decision`, so with it go the web
panel, the terminal's filters and the decode in the panel, and
`UI-inquiry-decode-by-reference` has nothing left to refuse. No request
declaration is built for a request nobody posts. What remains to decide is
whether the harness keeps a plugin request (`kind: 'plugin'`,
`Plugin.decision`) with no consumer in the repo; the PR that retires the
tool removes it in a commit of its own, so that the owner can drop that
commit. The typed fact read is small and stays as it is.

## 6. "Is this a script run" in four spellings

Entries: `RUN-handed-down-as-general-turn-end`,
`RUN-trusted-script-launch-grants`, `RUN-turn-next-move-function`,
`DISPATCH-script-lanes-semaphore`, and `RUNEND-child-report-from-launch`
(added by #15087).

The audit finding behind them said a script run is a model-less run dressed
as a tool-use run. Measured, the cost of that is small: 25 to 30 lines of
`packages/harness/src/agent/runtime/loop/` are reached only by a script run,
against about 1,400 shared, and the script door serves a model's `script`
call as well. The rejections stand.

What remains is that 27 sites in 21 files ask about it in four spellings
(`scriptCallOf(config) !== null`, `programOf(config) !== null`,
`config.script != null`, `kind === 'background'`) for three different
questions: is it trusted, does it end with its script, does it have a
conversation to fork or follow up. `forkRun` and `PlanTool` test the raw
field. `.agents/docs/proposed/architecture/2026-11-06-programs-not-agents.md`
plans the three named facts. They landed without a `run.config` change:
`runsScript`, `backgroundScriptOf` and `programOf` in
`packages/harness/src/shared/schemas/runRecords.ts`, which every site now
reads. What rides with phase 5 is the run shape's two program-only reads
(children's spend in `runOwnership.ts`, no resume after an end in
`continuesFromRows`).

## 7. One project named twice

Entries: `EFF-ADOPT-config-provider`, `SESSION-roots-carry-rooted-fs`,
`PLATFORM-roots-drop-global-slots`, `SCOPE-external-roots-standalone-service`.

Each stops at "settings stay synchronous by ruling". The ruling
(`.agents/docs/implemented/simplification/2026-09-20-effect-facility-adoption.md`,
section 3) gives no reader that needs a synchronous answer, and the path it
cites for `ConfigProvider` no longer exists. The code is in better shape than
the ruling:

- `Settings.get` already returns an Effect; all 62 callers are inside one.
  The synchronous reads are `Settings.getConfig` and three raw `config.get`
  calls, 25 sites. Six of them cannot wait: the replacement engine, a tool's
  prompt callback, the approval policy callback, the status bar, the host
  snapshot and the CLI's reads before its runtime exists.
- A read is not a held copy: `JsonStore` compares the file's inode, time and
  size on every `get` and re-reads on a change, so another process's edit is
  seen with no watcher.

So the rejections stand, and the ruling should say why: six readers cannot
wait, and a read is one `stat`.

The real duplication is narrower. A session builds the `SessionRoots` value
and the `WorkspaceFs` and `StorageFs` services from one `roots`, and about
twelve functions then take both, reading the project's path from the value
and its files from the service
(`packages/texra/src/latex/texTools.ts`,
`packages/texra/src/tools/AcceptRunFilesTool.ts`,
`packages/harness/src/tools/ExecutionsTool.ts` among them). Nothing makes the
two agree except the one place that builds them. Small item: inside an
Effect, a file's root is read from the service, and a function that holds the
service takes no path beside it.

`packages/harness/src/utils/files/externalRoots.ts` is process-wide state
with no reset; `packages/harness/test/tools/PathResolution.vitest.ts`
registers a root and never clears it. The entry's "#12071" is explained
nowhere in the repo.

## 8. The record of refused candidates

- Twenty of the 60 entries name a file that is gone, a symbol that is gone
  or a declaration that has changed, and nothing reports it; the suite that
  checked was removed. The count understates it: an entry whose reason has
  gone while its symbol stayed is not found this way (`G11f`'s mock,
  `EFF-ADOPT-config-provider`'s "Zod catalog row",
  `RUN-trusted-script-launch-grants`' `isTaskConfig`,
  `RT-cli-exit-code-one-function`'s `settleExitCode`).
- Three entries reject nothing: `HARNESS-approval-denial-kinds-already-collapsed`
  (already built), `RF-TC-11-store-credential-comment` (the comment was
  true) and `EFF-ADOPT-timeouts-already-effect` (already Effect). They record
  that an audit misread the code, which the next audit does not need.
- Fifteen entries reject moving a hand-written lifecycle onto an Effect
  primitive (`RcMap` three times, `FiberHandle`, `Semaphore`, `Schedule`,
  `CircuitBreaker`, `McpClient`, workflow, event log, the SQL helpers). Each
  is right about its primitive. Together they say the audit prompt "a
  hand-written version of what Effect provides" proposes by resemblance; the
  two questions that decided nearly all of them are "does the primitive have
  a read that does not acquire" and "does the fact outlive the service that
  would own it". Asking those first would have saved the builds that were
  reverted.

Recommendation: at step 5 of the triage note, rewrite the 20 drifted entries
against the code, delete the three that reject nothing, add the six rulings
of 2026-11-19, and give each entry that names one a `reopenWhen` line (four
already state a condition in prose: `EFF-ADOPT-mcp-client`,
`EFF-ADOPT-workflow-run-loop`, `UI-inquiry-decode-by-reference`,
`ROW-followup-closed-as-run-removed`). None of those four conditions holds on
effect 4.1.4 and `main` at `0611897`.

Done on 2026-11-19, except for the entries other open pull requests were
editing, which they update: every other entry was re-read against the code,
the three that reject nothing are deleted, the six rulings are recorded, and
the entries that state a condition carry a `reopenWhen`.

## Order

1. Section 3 (mocks to layers) and the first step of section 2 (exhaustive
   branches): no decision needed.
2. Section 1's trial: ends in a PR or a recorded rejection.
3. Section 4's rename: a public name, in its own commit.
4. Section 8 at triage step 5, after #15085 and #15087, which both add an
   entry.
5. Section 5: the inquiry tool is retired in its own PR.
6. Sections 2 (the table) and 6: a design note or the owner's schedule.
