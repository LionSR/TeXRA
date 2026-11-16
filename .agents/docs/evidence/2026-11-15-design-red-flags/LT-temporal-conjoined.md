# LT: temporal decomposition, conjoined methods, special-general mixed, options the code refused to decide

Read on `main` at `d70ad92` (the tree at `74a1fba` differs only in this
folder's reports). Lens audit of `packages/*/src`, per `BRIEF.md`. Earlier
coverage of these flags, not repeated here:
`../2026-11-07-design-red-flags-lenses/temporal-conjoined.md` (TC1 to TC7),
`../2026-11-07-design-red-flags-lenses/general-special.md` (GS1 to GS7),
`../2026-11-08-design-red-flags-lenses-2/README.md` section 9 (knobs) and
`.agents/docs/proposed/simplification/2026-11-03-fewer-processing-options.md`.
The catalogue (`../2026-11-07-design-red-flags-lenses/catalogue.md`, status at
`433d874`) has TC1 to TC6 landed and TC7, GS4 and GS7 partly open.

## Numbers

| Package source (`packages/*/src`, `.ts`/`.tsx`) |  Lines | Files |
| ----------------------------------------------- | -----: | ----: |
| texra                                           | 81,527 |   473 |
| harness                                         | 79,150 |   392 |
| cli                                             | 44,932 |   236 |
| extension                                       | 15,758 |    90 |
| desktop                                         | 14,491 |    91 |
| llm                                             | 12,094 |    55 |
| trace-viewer                                    |    407 |     4 |

Five largest files: `harness/src/shared/session/sessionViewUpdate.ts` 1,078;
`harness/src/agent/runtime/loop/toolUseDispatch.ts` 1,011;
`cli/src/chat/chatSessionController.ts` 1,007;
`desktop/src/renderer/main.ts` 936;
`harness/src/agent/runtime/runRegistry.ts` 887.

## LT-1: How a command ended is a tagged type for one function, then four flags with made-up exit codes that every reader decodes back

- flags: conjoined methods, information leakage, non-obvious code
- package: harness (`utils/system/execUtils.ts`, `shared/schemas/opResults.ts`,
  `shared/schemas/followUp.ts`, `shared/schemas/runRecords.ts`, `tools/bash.ts`,
  `agent/runtime/delegation/bashDelivery.ts`, `agent/runtime/deliveryEnvelope.ts`,
  `shared/subagentFollowup.ts`, `agent/runtime/processRun.ts`); touches texra
  (`tools/lean/direct/lakeCommands.ts`, `utils/system/toolChecks.ts`,
  `tools/agentCli/codexConfig.ts`)
- kind: refactor (one wrong message, below)
- size: M
- earlier: none (`grep -rn "noExitCode\|ExecResult" .agents/docs`: only the
  refused "executeCommand as one lifted round trip", `RT-execute-command-lift`,
  which is about the program, not its result)
- open PR: none

**Evidence.**

- `executeCommand` already knows how the command ended as a tagged union,
  `Outcome` (`execUtils.ts:155-162`: `Exited { code }`, `Signalled`,
  `ReadFailed`, `TimedOut`, `LimitExceeded { stream }`, `SpawnFailed`).
  `resultFromOutcome` (`:264-317`) then flattens it into `ExecResult`
  (`opResults.ts:7-31`): `success`, `exitCode`, `timedOut`, and two optional
  flags, `outputLimitExceeded?` and `noExitCode?`. The cases without a code
  get invented ones: 1 for a signal, a read failure and a timeout
  (`:266-295`), 2 for the output limit (`:296-302`), 127 for a spawn failure
  (`:303-311`).
- Every reader that cares how the command ended decodes the flags back, each
  in its own way:
  - `tools/bash.ts:272-275` maps them to `ProcessExit`
    (`runRecords.ts:133-136`, `{ code: number | null, timedOut }`, stored in
    the `process.exit` row): `code: result.noExitCode === true ? null : result.exitCode`.
  - `bashDelivery.ts:111-115` maps them to a third shape, the follow-up
    delivery's `exit` (`followUp.ts:83-91`, `{ code, timedOut, noExitCode }`,
    stored), keeping the invented code.
  - `deliveryEnvelope.ts:46-51` writes that as XML tags, and
    `subagentFollowup.ts:255-261` parses the tags back, then ranks them
    (`:181-184`: timed out, else no exit code, else `exit N`).
  - `lakeCommands.ts:93-97` maps "timed out or limit or no code" to `-1`.
  - `toolChecks.ts:139-142` recognises a spawn failure as
    `noExitCode === true && exitCode === 127`, so it relies on the invented
    127 being the spawn case and not the signal case (also `noExitCode`,
    code 1).
  - `codexConfig.ts:197` reads `timedOut || exitCode === 127`, which matches
    a spawn failure and a shell's real "command not found" alike.
- A wrong message comes out of it. A timeout has `timedOut: true`,
  `exitCode: 1` and no `noExitCode` (`execUtils.ts:287-294`). For a
  background command (`run_in_background`, still bounded by `timeout`,
  `bash.ts:141, 256`), `bash.ts:273` therefore stores `code: 1`, and `processRun.ts:130`
  writes "The command failed with exit code 1 (timed out)": the 1 is
  `executeCommand`'s convention, not the command's. The envelope's comment
  says the opposite path exists so that "no reader takes it for a real exit"
  (`deliveryEnvelope.ts:47-48`).

Consumers: `ExecResult` is named in 13 places outside `execUtils.ts`, and is
public from `@texra-ai/harness/node` (`node.ts:62`); `noExitCode` has 12
references in production, `outputLimitExceeded` 6, `.timedOut` on an
`ExecResult` 9.

**The design decision behind it.** "How did the command end" is answered once
as a type, then re-answered as a boolean bundle that only means something in
combination, so every reader has to know which combinations `executeCommand`
builds and which exit codes it invents.

**The better design.** `ExecResult` carries the outcome itself:
`{ success, stdout, stderr, end }`, where `end` is
`{ _tag: 'Exited'; code } | { _tag: 'TimedOut' } | { _tag: 'LimitExceeded'; stream } | { _tag: 'NoExit'; why: 'spawn' | 'signal' | 'read' }`
(the private `Outcome` minus its `PlatformError`, which `resultFromOutcome`
already reduces to text). `success` stays because most of the 33 calling
files read only it and `stdout`. The stored shapes collapse to one:
`ProcessExit` gains the follow-up's need (a timeout is `timedOut: true` with
`code: null`), and the follow-up delivery's `exit` becomes `ProcessExitSchema`,
so `noExitCode` and its XML tag go. Readers write `end._tag === 'NoExit' &&
end.why === 'spawn'` (`toolChecks`), `end._tag === 'Exited' ? end.code : null`
(`bash.ts`, `lakeCommands`), and the follow-up line reads the one shape.
Deleted: `exitCode`, `timedOut`, `outputLimitExceeded`, `noExitCode` on
`ExecResult`, `resultFromProcessOutput`'s flag bag (`:88-108`), the three
invented codes, the follow-up `noExitCode` field and tag (4 sites), and the
-1 / 127 conventions in the app.

**What we give up, and risk.** `ExecResult` is public at 0.x; the follow-up
row's `exit` is stored, so its shape change is a format change (its own
commit, "Needs your eye"). `installGithubAction.ts:286-292` reads
`git diff`'s real exit codes 0 and 1; it keeps them as `end.code`
(`overleafClone.ts:263` reads its own `GitCloneFailed.exitCode`,
not an `ExecResult`).

**How I tried to refute it.** Looked for a reader that needs the invented
codes as numbers: the shell's real 127 and `executeCommand`'s spawn 127 are
told apart only by `noExitCode`, and nothing needs the 1 or the 2. Looked for
a dated note keeping the flat shape: none. Checked that the timeout case
really lacks `noExitCode`: `resultFromOutcome`'s `TimedOut` branch passes
only `{ timedOut: true }` (`execUtils.ts:287-294`).

## LT-2: The shared conversation shell asks "am I on the desktop" and answers it twice, in TypeScript and again in CSS

- flags: special-general mixed, repetition, comment restates code
- package: texra (`ui/progress/ProgressApp.ts`, `ui/progress/progressAppStyles.ts`);
  touches desktop (`renderer/main.ts:810`) and extension
  (`progressView/index.html:27`)
- kind: refactor
- size: S
- earlier: GS3 (landed) took the host question out of the shared settings
  view; nothing covered the progress shell (`grep -rn "placement" .agents/docs`:
  only unrelated hits)
- open PR: none

**Evidence.**

- `ProgressApp.placement` is `'sidebar' | 'editor' | 'desktop'`
  (`ProgressApp.ts:103`). The first two are layouts of one host; the third is
  a host's name, set by the desktop renderer
  (`desktop/src/renderer/main.ts:808-810`).
- Four decisions branch on the name, and three of them are made twice:
  - the task-list button: dropped in a run's header
    (`ProgressApp.ts:289-290`, `onDesktop ? nothing : sessions.button`), but
    rendered in the New-task header (`:291`) and hidden there by CSS
    (`progressAppStyles.ts:74`);
  - the drawer: not rendered (`ProgressApp.ts:182`,
    `this.placement !== 'desktop'`) and also hidden by CSS
    (`progressAppStyles.ts:75`);
  - New task and Settings: dropped (`ProgressApp.ts:273`,
    `const end = onDesktop ? [] : [newTask, settings]`) under a comment that
    says they "end the row in every layout" (`:271`);
  - the window items (pop out, LaTeXDiffs): none on the desktop
    (`ProgressApp.ts:123`);
  - the Active now strip: rendered (`:513-523`, a live `run-tabs`) and
    hidden by CSS alone (`progressAppStyles.ts:107-109`).
- Each CSS rule's comment states the actual reason, which is not "desktop":
  "The desktop rail lists each project's tasks, so the sessions button and
  drawer would be a second list there" (`:72-73`), and "Its rail already
  lists the running tasks" (`:86-87`).

**The design decision behind it.** "Does the host around this shell already
list the tasks and own the window's commands?" is a fact about the host's
chrome. The shell asks for the host's name instead, and then decides each
consequence once in markup and once in styles.

**The better design.** The placement names the layout, not the host:
`'sidebar' | 'editor' | 'embedded'`, where `embedded` means "the host's
chrome lists tasks and owns New task, Settings and the window items". The
template is the one place that omits those parts (the New-task header's
button, the Active now strip and the overflow included); the CSS keeps only
the layout rules for `embedded` (header height, centred launcher). Deleted:
the three `display: none` rules and their two comments
(`progressAppStyles.ts:72-77`, the half of `:84-87` about the strip, `:107-109`), the `onDesktop`
local, and the false half of the comment at `:271`.

**What we give up, and risk.** One more rename across the desktop renderer
and the styles; the desktop's look is unchanged. A CSS-only hide kept the
`run-tabs` element subscribed while invisible; omitting it in the template
stops that.

**How I tried to refute it.** Looked for a second host that sets `desktop`
(the trace viewer mounts the shell without a placement,
`trace-viewer/src/main.ts:87-96`), and for a reason the CSS hide is needed
beside the template (a slot a host fills, an animation): none; the drawer
and the run header's button are already omitted in TypeScript. Checked the
rest of `packages/texra/src` and the harness for another host-name branch in
shared code: none left (`grep -rnE "isDesktop|onDesktop|hostKind"`), which is
why this one stands out.

## LT-3: Whether a notice offers "never remind me" is decided by whoever emits it, beside a table that says the app decides each key's affordances once

- flags: special-general mixed, information leakage, overexposure
- package: harness (`shared/schemas/progressEvents.ts`,
  `agent/runtime/AgentLaunchContext.ts`, `common/errors/agentErrorClassification.ts`);
  touches texra (`ui/copy/instructionActions.ts`) and extension
  (`frontend/ui/instruction.ts`, `frontend/events/agentEventListeners.ts`)
- kind: refactor
- size: S
- earlier: none (`grep -rn "showSuppress\|RESUME_REFUSED" .agents/docs`: none)
- open PR: none

**Evidence.**

- `RequestShowInstructionPayload.showSuppress?` (`progressEvents.ts:35-41`,
  and again in `LaunchNoticeSchema`, `:56-62`) is one VS Code dialog's
  "Never remind me" button. Its producers: the harness's two notices pass
  `false` (`AgentLaunchContext.ts:39`, `agentErrorClassification.ts:60`);
  the app's three omit it, so they are suppressible
  (`texra/src/tools/documents/documentTools.ts:315-318, 325-328`,
  `cli/src/runtime/platform/cliService.ts:185-188`). Only the extension reads
  it (`agentEventListeners.ts:133`, into `instruction.ts:35`, default
  `true`); the desktop's handler (`desktop/src/main/desktopHostRequests.ts:83-87`)
  and the CLI's (`cli/src/runtime/headless/cliPresentationHost.ts:87-92`)
  ignore it.
- The other affordance of the same notice, its action buttons, is decided by
  key in the app: `ACTIONS_BY_KEY` (`texra/src/ui/copy/instructionActions.ts:28-41`),
  whose header says "which affordances a key gets is the application's to
  say, here, once" (`:1-5`). So one question, "what does the notice with key
  K offer", has two owners: the table for buttons, each emitter for the
  suppress toggle. The value the emitters pass is a function of the key:
  `false` exactly for `HARNESS_INSTRUCTION_KEY` members.
- `HARNESS_INSTRUCTION_KEY.RESUME_REFUSED` (`progressEvents.ts:21`) has no
  emitter anywhere (`grep -rn "RESUME_REFUSED\|'resumeRefused'"` over
  `packages/*/src`, `src/`, `packages/*/test`, `packages/harness/example`:
  the declaration and its `NO_ACTIONS` row only, added in #14896).

**The design decision behind it.** The payload was shaped like the one host
API that renders it (`showInformationMessage` plus an extra button), so the
emitter decides a presentation detail the host table already decides for
the other buttons.

**The better design.** The payload is `{ key, message }`. The app's
key table owns both affordances: `instructionAffordances(key)` answers
`{ actions, suppressible }`, with `suppressible: false` for the harness's
keys, and the extension reads it where it reads the actions. Deleted:
`showSuppress` from the interface and `LaunchNoticeSchema` (2), from the two
harness producers (2) and from the extension's call (1);
`showInstructionWithSuppress`'s positional `showSuppress = true` parameter
becomes the table's answer; `RESUME_REFUSED` and its row.

**What we give up, and risk.** An embedder of the SDK could no longer mark
one notice of a key suppressible and another of the same key not; no
emitter does. `HARNESS_INSTRUCTION_KEY` is public at 0.x.

**How I tried to refute it.** Looked for an emitter that passes `true` or
varies the flag for one key: none. Looked for a host other than VS Code with
a suppress state: the desktop and the CLI have none, so the flag is one
host's. Checked `#14896`'s body for a planned emitter of `resumeRefused`:
it adds the key with the table row only.

## LT-4 (batched): smaller instances of state set in one place and read in another, and of a helper that is only correct inside its caller's markup

- flags: conjoined methods, temporal decomposition, repetition, non-obvious code
- package: cli (a), harness (b), texra (c), cli (d)
- kind: refactor
- size: S each; M together
- earlier: none for any part (`grep -rn "routedArgs\|registrationDrafts\|buildDetailsSummary\|isSubscriptionLoginTarget" .agents/docs`: none)
- open PR: none

**(a) The bare-`texra` route reads the argv through a module `let`.**
`runCli` writes `routedArgs = rawArgs` (`cli/src/commands/root.ts:168`)
before dispatch, and the root command's `default` resolver reads it
(`:56-65`) to choose `chat` or `help`. The resolver is correct only after
`runCli` ran in the same process; anything else that resolves the root's
default (a test that runs `rootCommand` directly, a second `runCli` in one
process before the write) reads another invocation's argv or the empty
array. The choice needs only `rawArgs`, which
`runCli` holds: it can decide "no subcommand: insert `chat` or `help`" next
to `detectUnknownCliCommand` (`:170`), which already resolves the
subcommand, and the root keeps `default: 'help'`. Deleted: the `let`,
`defaultRootSubcommand`'s re-parse of the global flags (`:59-63`). Refute
check: the comment at `:54-55` gives the reason (the resolver is called with
no arguments); deciding in `runCli` does not need the resolver.

**(b) `registrationDrafts(…, born, ended)` takes two parameters of which the
second is read only when the first is false.** `shared/session/runFacts.ts:267-299`:
`born` chooses `run.start` and `start`, and `ended` (the grants a
re-registration ends) is used only when `!born` (`:291`). Its one caller
(`agent/storage/runLifecycle.ts:136-138`) computes both from one fact:
`prior`, with `ended = prior ? activationRows : []`. So a valid call has two
shapes, `born` with no rows or a rebirth with rows, written as a boolean and
an array that must agree. Better: one parameter,
`prior: null | readonly SessionRowDraft[]` (null: a birth), or inline the
16 lines into `registrationRows`, its only caller, which lives one module
over in `agent/storage/` while the function sits in `shared/` (1 caller in
`packages/*/src`, none in tests).

**(c) `buildDetailsSummary` is a slot's content whose container every
caller writes, five ways.** `ui/progress/formatters/htmlBuilders.ts:137-167`
returns a `slot="summary"` div and says "The caller must render it inside a
`<wa-details>` and rely on its built-in toggle icon" (`:139-141`). Its five
callers each write that container: `toolCard.ts:47`, `dataFormatters.ts:24`
and `bannerFormatters.ts:124` with `appearance="plain" icon-placement="start"
class="banner-details …"`; `LatexdiffResults.ts:162` and
`ContextManagement.ts:65-69` with `class="banner-details" appearance="plain"`
and no `icon-placement`, so two of the five cards put the toggle icon at the
other end. The container and its summary are one part. Better: one
`bannerDetails({ summary options, open, classes, body })` that writes the
`<wa-details>` with one placement and the body's `banner-content` div;
`buildDetailsSummary` becomes file-local. Deleted: five copies of the
container attributes. Risk: the two cards without `icon-placement` change
their toggle side; that is the inconsistency, but a person may notice.

**(d) "Is this a subscription login" is written as `'chatgpt' || 'grok'`
beside the list that owns it.** `SUBSCRIPTION_AUTH_PROVIDERS = ['chatgpt',
'grok']` (`harness/src/shared/model/subscriptionAuth.ts:9`) is iterated at
five CLI sites, while `modelAccessSelection.ts:239` and
`loginOptions.ts:47` test the two names by hand. A third subscription
provider would be listed and then refused by both. Better: a type guard
beside the constant (`isSubscriptionAuthProvider`), used at both sites.

## A thin lens, said plainly

The earlier lens (TC1 to TC7, GS1 to GS7) and the lens-2 knobs table have
mostly landed, and the tree shows it: a grep of the harness for an app,
provider or host word in code finds none outside the model layer; the only
host-name branch left in shared UI code is LT-2; `prepare*`/`finish*` export
pairs, `initialize()` methods and "call X first" comments are nearly gone
(`grep` for the ordering phrases finds one hand-off protocol, LT-4 c). The
remaining instances of these flags are mostly in single areas and already
reported there (CL-1, CL-7, HR-6, HS-4, TC-3, TT-5, TT-6, TU-2, TU-3, TU-6,
TU-7). This lens adds the cross-package ones above. Spot checks that TC1 to
TC6 have not regressed: `openBuilt` is the one display entry
(`extension/src/frontend/latex/openBuild.ts:128`); `ModelInvoker.consume`
owns an attempt in one function (`ModelInvoker.ts:246-330`, its accumulator
local); `run.entry.enter` is the one way into a run's cell
(`loop/runLoop.ts:178, 248`, `loop/runProgram.ts:123`); compaction is two
entry points (`run/compaction.ts:285, 299`); `releaseUploads` is gone from
`packages/llm/src`.

## Good modules in this area

- `executeCommand`'s private `Outcome` (`harness/src/utils/system/execUtils.ts:155-162`):
  how a spawned command ended, as a closed union. LT-1 asks that it be the
  result, not an intermediate.
- `credentialChanged` (`harness/src/platform/appSignals.ts:56-78`): emitted
  by the store's own commit finalizer, so no writer has to remember to
  announce its write. The pattern to copy for any "write, then tell the
  views" pair.
- `ACTIONS_BY_KEY` (`texra/src/ui/copy/instructionActions.ts:28-41`): one
  table, keyed by the notice, of what each host offers beside it. LT-3 gives
  it the last affordance.
- `run.entry.enter` and `ModelInvoker.consume` (TC5, TC3 landed): the
  before-commit and after-commit halves of one rule in one combinator, so no
  caller can run one half alone.

## Already settled, left alone

- `fromParent`, the dead sender option: HR-3 in this round.
- `renderSettingsNumberRow`'s `revertOnEmpty`: kept with a reason (L2-9.7 in
  `../2026-11-07-design-red-flags-lenses/catalogue.md`).
- `ChildRunDelivery` as a union on family and outcome, and the delivery
  envelope's text grammar: the owner's decision, recorded in
  `.agents/docs/proposed/simplification/2026-11-14-tool-card-result-and-delivery-shapes.md` §3.
  LT-1 changes only the `exit` field inside it.
- The file verbs' `latexdiff` special case in `openGuiWindow.ts`: TC-1 in this
  round.
- `StreamedToolCards.failOpen` called by hand by each driver: TC7's texra
  remainder, reported again as TT-5.
- `modelAccessChanged` emitted after each write: the earlier lens's "Already
  settled" (`../2026-11-07-design-red-flags-lenses/temporal-conjoined.md:554-559`).
- `openRequest` then `decisionOf` (`harness/src/agent/runtime/requests.ts:449`,
  `loop/toolGuard.ts:260-269`): the open commits in the asker's batch and the
  wait is the same read a resume makes from the stored row; the write-point
  contract in `packages/harness/AGENTS.md`.
- `OpenOptions.persistent` and the plugin hooks with one implementer: the
  options inventory's "Rejected".
- `executeCliConfig`'s `afterRun` / `onInterruptedRunFinalized` hooks: two
  callers, each passing a different one (`cli/src/commands/run.ts:361, 377`,
  `runtime/headless/executeCli.ts:113`); not a special case.
