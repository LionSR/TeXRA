# CL. The CLI: design red flags in `packages/cli/src`

Read-only, on `main` at `d70ad92` (the working tree adds only the audit
brief). Paths are relative to `packages/cli/src` unless they start with
`packages/` or `src/`. Consumer counts are `grep -rn '\bSYMBOL\b'
packages/*/src` (production) and `src/ packages/*/test` (tests). Every K id of
round 2 (`../2026-11-06-design-red-flags-round-2/K-cli.md`) is catalogued as
landed; this report reads what the CLI is after them.

## Numbers

44,932 lines in 236 files. Recursive totals: `runtime/` 11,435 (`headless/`
2,658, `platform/` 2,656, `models/` 2,361, `completion/` 798, `terminal/` 626,
`approval/` 476, root files 1,757), `commands/` 6,820 (`_helpers/` 1,786),
`chat/` 23,861 (`chatSessionController.ts` 1,007; `chat/tui/` root files
2,415, `panes/` 5,734, `forms/` 3,979, `commands/` 2,839, `state/` 2,475,
`modals/` 2,103, `input/` 1,672, `render/` 1,632), `tui/` 1,823, `schemas/`
290, `init/` 230, `bin/` 93.

Five largest files: `chat/chatSessionController.ts` 1,007;
`chat/tui/panes/statusBarDisplay.ts` 824; `chat/tui/runChatTui.tsx` 745;
`chat/tui/panes/staticTranscriptRing.ts` 716; `chat/tui/App.tsx` 610.

## CL-1: A slash command's form reaches its action through a 21-field bag of callbacks the one caller wires back to the handler it already has

- flags: information leakage, pass-through, repetition, temporal decomposition, special-general mixed
- package: cli
- kind: refactor
- size: M
- earlier: K9 (landed, #14802: the process-global table became one `SlashCommands` value). The 21-field option bag K9 also named is still 21 fields, and its "lazy thunk" is still there; this is the remainder.
- open PR: none (#14955 edits `agentModelCommands.ts`, `loginCommands.ts`, `modelAccessCommands.ts` bodies for their notices and AppSignals, not their signatures)

**Evidence.**

- A typed command reaches its body with the chat's context:
  `SlashCommand.handler(remainder, context: SlashCommandContext)`
  (`chat/tui/commands/slashRegistry.ts:45-48`), dispatched at
  `chat/tui/commands/handleSlashCommand.ts:92-98`. The same command's form gets
  only `SlashFormProps { onDone, onPersist, echoOnPersist, availableRows }`
  (`slashRegistry.ts:23-28`, mounted at `slashForms.tsx:161-193`): no context.
- So `builtinSlashCommands` (`chat/tui/commands/registerBuiltins.tsx:86-128`)
  takes 21 option fields, 20 required, to reach the context from a form:
  `stores`, `runtime`, `runSession`, `configRoots`, `onAgentSelect`,
  `onTeamSelect`, `onModelSelect`, `onMemorySelect`, `onResumeSelect`,
  `onSkillSelect`, `onLoginSelect`, `onModelAccessSelect`, `onAccountChanged`,
  `canSelectAgent`, `canSelectModel`, `getApprovalPolicy`,
  `onApprovalPolicySelect`, `onProjectApprovalPolicyChanged`,
  `getModelSwitchDisabledReason`, `connectService?`, `onError`. One production
  caller (`chat/tui/runChatTui.tsx:540-604`) and one test
  (`src/test-kernel/cli/SlashCommandDispatch.vitest.ts:38`), plus
  `packages/cli/scripts/tui-harness.tsx`.
- The caller wires most of them back to the handler the table already
  registers: `agent.handler = applyInitialCliAgentSelection`
  (`registerBuiltins.tsx:396`) and `onAgentSelect: (nextAgent) =>
  applyInitialCliAgentSelection(nextAgent, slashCommandContext())`
  (`runChatTui.tsx:559-560`); `model.handler = applyCliModelSelection`
  (`registerBuiltins.tsx:404`) and `onModelSelect` the same call
  (`runChatTui.tsx:582-583`); `/memory`'s handler calls
  `showCliMemoryPreview(roots, remainder)` (`registerBuiltins.tsx:527-534`) and
  `onMemorySelect` calls `showCliMemoryPreview(services.roots, storagePath)`
  (`runChatTui.tsx:595-596`); `/resume`'s handler calls `context.resumeRun(id)`
  (`registerBuiltins.tsx:502`) and `onResumeSelect` is `chatController.resume`
  (`runChatTui.tsx:599`), the very function `context.resumeRun` holds
  (`runChatTui.tsx:384`).
- One fact, three spellings: `configRoots: services.roots`
  (`runChatTui.tsx:600`), `options.runSession.roots`
  (`registerBuiltins.tsx:283,316,336,359,530`) and `context.runSession.roots` in
  the handlers are the same roots (`serviceSession(link, cwd, roots)`,
  `packages/texra/src/controllers/server/serviceSession.ts:264-266`). `stores`,
  `runtime`, `runSession` and `getApprovalPolicy` are passed both to
  `builtinSlashCommands` and to `SlashCommandContext`
  (`runChatTui.tsx:372-386`, `:540-563`).
- The context is a function because of the bag: `slashCommandContext` "build[s]
  it once lazily so the closures it captures (resetSessionForClear,
  chatController.resume, commands) are all defined before the first use"
  (`runChatTui.tsx:369-386`). The comment is false in its first half (it builds
  a fresh object on each of its five calls) and the second half is the reason:
  `commands` needs the context, the context needs `commands` and the
  controller, and the controller takes `getSlashCommandContext`
  (`chatSessionController.ts:198`) because its `submit` dispatches slash
  commands (`:969`), which a file headed "Host-neutral (no Ink/TUI rendering
  dependencies)" (`:1-4`) should not.
- Two handlers take the context as optional to serve the form path:
  `loginFromChat(value, stores, context?: CliContext, output)`
  (`handlers/loginCommands.ts:79-84`) and
  `applyCliModelAccessSelection(stores, selection, context:
  SlashCommandContext | undefined, output)` (`handlers/modelAccessCommands.ts:45-52`).
- An orphaned doc line sits in the bag: "The project's stored runs `/resume`
  lists, where they are held." directly above `runSession`'s own JSDoc
  (`registerBuiltins.tsx:96-99`).

**The design decision behind it.** "What does choosing X in `/x` do, and
with which chat?" is answered twice: once as the handler over the context, and
again as a callback the one caller supplies so that a form, which receives no
context, can call the same handler.

**The better design.** A form is a second way to produce the handler's
argument, so it gets the same context: `formComponent` renders with
`SlashFormProps & { context: SlashCommandContext }` (built once by
`openRegisteredCliSlashForm`, which the dispatcher calls with the context it
holds), and `bindSelection(props, action)` takes `action: (value, context,
output) => SlashCommandEffect`, the handler's shape. `builtinSlashCommands`
then takes `{ connectService? }` and nothing else; every picker binds the
function its handler names (`applyInitialCliAgentSelection`,
`applyCliModelSelection`, `showCliMemoryPreview`, `context.resumeRun`, …).
`SlashCommandContext` gains what only the chat knows (`activateSkill`,
`onProjectApprovalPolicyChanged`, `getModelSwitchDisabledReason`,
`onAccountChanged`) and loses nothing. Slash dispatch moves out of the
controller into `runChatTui`'s `onSubmit` (`handleTuiSlashCommand(line, ctx)`
then `controller.submit`), so the controller no longer needs the context, the
context is one value built after the controller, and the thunk goes.
Deleted: 20 of 21 option fields (each 2 production sites), the
`slashCommandContext` thunk and its 5 calls, `getSlashCommandContext`, the
optional-context parameters of `loginFromChat` and
`applyCliModelAccessSelection`, `modelAccessContribution`'s
`onModelAccessSelect`/`onLoginSelect` (`modelAccessContribution.tsx:81-82`).
A new command with a form is then the form and the table entry.

**What we give up, and risk.** Forms see the whole context (they already see
the stores and runtime). `SlashCommandDispatch.vitest.ts` and `tui-harness.tsx`
build the bag today and build a context instead.

**How I tried to refute it.** Looked for a form action that differs from its
handler: `/approval`'s form also revokes grants (it keeps that branch, now
reading `context.runSession`); `/agent` chains into `/model` (kept, it is
`onDone`). Checked that the roots are one value in both service and local
mode. Checked the K9 landing: it replaced `installedCommands`, not the bag.

## CL-2: Every headless result is still written twice by its caller, against a 33-member schema that is never decoded, and the line stamp has six writers

- flags: repetition, information leakage, overexposure
- package: cli
- kind: refactor
- size: M
- earlier: K11's first bullet ("every headless result is built three times"). The catalogue lists K11 as landed for its `ChatState`, bell and `runtime/` items; #14938 added `commandResult` for four commands. The rest is a remainder: the per-call `json`/`ndjson` pair, the 20 one-field members and the `ts` writers (K11 counted two; there are six).
- open PR: #14959 rewrites `output.ts`'s `writeCliResult` doc and moves `texra version` onto `emitCliResult`; it keeps the `{ json, ndjson, text }` shape this finding removes.

**Evidence.**

- 38 call sites in 15 files hand `emitCliResult`/`emitPagedCliResult`/
  `writeCliResult` a value twice: `json: X` and `ndjson: { kind: K, field: X }`
  (`commands/tasks.ts:130-136,246-250,274-278,298-302`,
  `commands/models.ts:69-75,96-100`, `commands/memory.ts:25-29`,
  `commands/service.ts:170-174`, `commands/config.ts:78-80,173-176`,
  `commands/agents.ts:51,79,103`, `commands/history.ts:228-231`,
  `commands/init.ts:129`, `commands/team.ts:119`, `commands/run.ts:320-324,450-454`,
  …). For a list the pair is `json: items, ndjson: items.map((x) => ({ kind,
  field: x }))` (`tasks.ts:131-132`, `models.ts:70-71`, `memory.ts:26-27`,
  `agents.ts:51`). The field name is the only thing a call site decides, and
  it is fixed per kind.
- `schemas/cliOutput.ts:112-257` registers 33 `StructWithRest` members. 20 of
  them are `{ kind: Literal(k), <field>: payload }` with `payload =
  Schema.Unknown` (`:63`); 10 pin only `kind`; 3 carry a typed field
  (`version`, `agent-result`, `result`). Nothing decodes or exports the
  schema: `CliNdjsonRecordSchema` has no reference outside the file; only its
  `.Type` is used (`CliNdjsonRecord`, 9 importing files). The header says the
  value is "the exhaustive, named `kind` registry" (`:18-23`), i.e. a literal
  list and a field name per kind, written as 120 lines of schema.
- The two keys every line carries have different owners. `contract` is added
  by the sink (`runtime/platform/logSinks.ts:253-263`). `ts` is added by
  `writeCliResult` when absent (`commands/_helpers/output.ts:66-76`, "pre-built
  record helpers keep their own") and by five producers themselves:
  `runtime/history.ts:362`, `runtime/cliTeams.ts:113`, `runtime/doctor.ts:465`,
  `runtime/headless/sessionProgressSubscription.ts:31`,
  `runtime/headless/cliPresentationHost.ts:56`. Every one of them is "now".
  The schema declares the pair as one stamp (`CliNdjsonLineStampSchema`,
  `cliOutput.ts:44-47`).
- `texra doctor` writes the same three-way format switch a third time
  (`runtime/doctor.ts:476-495`) because its failing text goes to stderr.

**The design decision behind it.** "What does a result look like in JSON and
in NDJSON?" is decided at every call site, although it follows from the
record's kind; and "when was this line written?" is decided by whoever built
the record.

**The better design.** One table `CLI_RESULT_FIELD = { task: 'task', model:
'model', 'model-catalog': 'model', memory: 'memory', … } as const` (the 20
one-field kinds) beside a literal list of the 10 spread kinds; the
`CliNdjsonRecord` type is derived from it (a mapped type, no runtime schema),
so the typo check the header wants stays. `emitCliResult(kind, value, text)`
writes `value` as JSON and `{ kind, [field]: v }` per element as NDJSON;
`commandResult` and the two typed run results stay as they are. `writeNdjsonStdout`
stamps `ts` and `contract` together, so the five producers and the
`'ts' in record` branch drop their stamping. Deleted: about 100 lines of
`cliOutput.ts`, the duplicated half of 38 call sites, five `ts` lines,
`doctor.ts`'s JSON/NDJSON branches (it keeps its stderr text branch).

**What we give up, and risk.** A record's `ts` becomes the write time of each
line rather than one time per batch (`history-entry`, `team`, `doctor-check`
lists); within one command that is milliseconds. `models.ts:174-183`'s
`model-enabled` record renames `result.model` to `id`: it either keeps its
explicit form or the result type gains `id`. The NDJSON bytes are otherwise
unchanged; `CLI_NDJSON_CONTRACT` stays 3.

**How I tried to refute it.** Looked for a call site whose JSON and NDJSON
payloads differ: only `models.ts:174-183` (the rename) and the two-kind
listings (`models.ts:148-156`, `skills.ts:61-70`), which take two calls or a
list of pairs. Checked that the schema is not decoded anywhere (production,
`src/`, `packages/*/test`, `docs/`): it is not; its only runtime reads are
`CLI_NDJSON_CONTRACT` and the `fields` of the run results.

## CL-3: The chat TUI presents the session's notices through the headless presenter, which writes raw stderr (or NDJSON on stdout) under the Ink frame

- flags: special-general mixed, non-obvious code, comment restates code
- package: cli
- kind: bug
- size: S
- earlier: none (`nonobvious-code.md` praised `cliPresentationHost.ts`'s exhaustive handler table for the headless path; the chat's use of it was not read)
- open PR: none

**Evidence.**

- The chat builds its presentation host with the headless factory:
  `createCliRuntimeHost(sessionContext)` (`chat/chatSessionController.ts:348`),
  whose `present` writes `writeTextStderr(\`${LEVEL} ${message}\`)`in text
  mode and a`kind: 'log'` record to stdout in NDJSON mode
  (`runtime/headless/cliPresentationHost.ts:47-63`). `writeTextStderr`is a
  raw`process.stderr.write` (`runtime/platform/logSinks.ts:67-80,124-126`);
  Ink owns stdout and gets `stderr: process.stderr`
  (`chat/tui/runChatTui.tsx:625-630`), so a raw write lands inside the live
  region it redraws.
- That host receives every notice the session presents to the chat:
  `createTuiHostInteractions(presentationHost, …)` forwards `emit` straight to
  it (`chat/tui/state/subscribeApprovals.ts:186-191`), and the interactions are
  the chat's attached host (`chatSessionController.ts:355-378`). The session
  presents a root run's failed end there
  (`presentTerminalResult`, `packages/harness/src/agent/runtime/HostInteractions.ts:322-338`;
  "a run's end is the session's", `:350-358`), as `requestShowError` or, for a
  missing key, `requestShowInstruction`.
- Only the run-action path is routed into the transcript: the chat's
  `notices` sends `requestShowError` to `appendLocalErrorTranscript` and
  "any other notice (a refused launch's instruction, an unknown agent)" to
  `presentationHost.emit`, i.e. stderr (`chatSessionController.ts:309-327`).
  The comment says those "go where the chat's runtime notices show"; under
  Ink that is a stray stderr line.
- The suppression someone meant reads nothing: the chat passes
  `sessionContext: { ...context, quietLogs: true }`
  (`runChatTui.tsx:498`), but no code on this path reads `quietLogs`
  (`present` does not; `createRunProgressRenderer` reads `renderRunProgress`,
  `runProgressRenderer.ts:73-76`), and `createTuiHostInteractions`'s `context`
  parameter is never used (`subscribeApprovals.ts:82`, its only occurrence).
  `outputFormat` comes from flag, env or the `cli.outputFormat` setting
  (`cliContext.ts:488-496`) and only the flag is refused for `texra chat`
  (`globalArgs.ts`'s `rejectHeadlessOnlyFlags`), so a user whose config says
  `ndjson` gets NDJSON `log` records on Ink's stdout.

How it fails: a failed root run (or a launch refused for a missing key, or an
unknown agent) prints `ERROR …`/`INFO …` on raw stderr while Ink is mounted;
Ink's next redraw erases by its own line count, leaving the line or a copy of
the frame's top row in the live region. The failure never reaches the
transcript the user is reading through this path.

**The design decision behind it.** "Where does a notice show on this
surface?" is answered by the headless presenter for the chat too, with a
context override and an unused parameter standing in for the TUI's answer.

**The better design.** The TUI's interactions own their presentation: one
handler table (`PresentationEventHandlers`, as `cliPresentationHost.ts:82-120`
already writes it) that puts `requestShowError` in
`appendLocalErrorTranscript`, `requestShowInstruction` (with
`formatInstructionActionHint`) and `agentNotFound` in `appendLocalNotice`,
and `openFile` nowhere. `createTuiHostInteractions` takes that table instead
of a `CliRuntimeHost` and a `CliContext`; the chat's `notices` is the same
table, so its cast (`chatSessionController.ts:320-322`) goes. Deleted: the
chat's `createCliRuntimeHost` call and its shutdown finalizer
(`:348-354`), `sessionContext` (`:187`, used otherwise only for
`commandName`), the `{ ...context, quietLogs: true }` override, the unused
parameter.

**What we give up, and risk.** Nothing; the headless presenter is unchanged.
Not reproduced on a TTY (`node_modules` is absent in this checkout); the
path is read end to end, and `src/test-kernel/cli/TuiApprovalRetry.vitest.ts:121`
builds the TUI interactions over `createCliRuntimeHost` as production does,
so no test sees the write.

**How I tried to refute it.** Looked for an Ink-aware stderr in
`logSinks.ts` (none: `writeRaw` is the only path), for a TUI log sink that
intercepts `writeTextStderr` (the sink is for `writeLogEntry`, not these
writes), and for a guard on `session.exited` or mode in `present` (none).
Checked that the session, not the chat, presents a run's failed end: the
harness says each failure has one presenter and names the session's for a
run's end.

## CL-4: "The user passed `--quiet`" has three representations, and the headless run context overwrites the one named for it

- flags: information leakage, non-obvious code, comment restates code, special-general mixed
- package: cli
- kind: refactor
- size: S
- earlier: none
- open PR: none

**Evidence.**

- `CliContext.quietLogs` is the flag (`runtime/platform/cliContext.ts:75,507`).
  `buildHeadlessRunContext` sets it to `true` for every headless run and
  computes `renderRunProgress` from the original first
  (`runtime/models/runModel.ts:79-86`); the chat does the same override
  (`chat/tui/runChatTui.tsx:498`).
- No reader of a derived context reads `quietLogs`. The eleven readers
  (`initPlatform.ts:220,230`, `updateChecker.ts:263`, `runModel.ts:73`,
  `runProgressRenderer.ts:70`, `clone.ts:142`, `agents.ts:32,56,73`,
  `loadConfigAndWarn.ts:28`, `defineCliCommand.ts:219`) all take the command's
  own context; the run context goes to `executeCliConfig`,
  `createCliRuntimeHost`, `formatInterruptedResumeHint`,
  `resolveDocumentTaskOutput` and `formatTeamRunInstruction`, none of which
  reads it. The override is dead.
- Because the field no longer means the flag, `executeCliConfig` reads the
  flag from a third place: "`runContext.quietLogs` is forced on for every
  headless run (`buildHeadlessRunContext`). Only the user's own `--quiet`
  keeps it unsaid: the log level it set from argv, which that derivation
  keeps" — `const userQuiet = runContext.minimumLogLevel === 'None'`
  (`runtime/headless/executeCli.ts:265-277`). A five-line comment explains a
  hand-off the structure should carry.
- `renderRunProgress` (`cliContext.ts:84-85`, default `false` at `:508`) is a
  field of the general context set by one function for one consumer
  (`createRunProgressRenderer`, `runProgressRenderer.ts:73-76`; also read at
  `executeCli.ts:215-216`): "this context is a headless run, not quiet, not
  NDJSON" stored as data on every context.

**The design decision behind it.** "Is this invocation quiet, and does its
run print progress?" is decided at the context build, again in
`buildHeadlessRunContext`, and a third time in `executeCliConfig`, each
rewriting or proxying the previous answer.

**The better design.** `quietLogs` keeps one meaning (the flag) and is never
rewritten; `buildHeadlessRunContext` and the chat's override drop their
`quietLogs: true`; `executeCliConfig` reads `runContext.quietLogs` and the
comment goes. `renderRunProgress` leaves `CliContext`: `executeCliConfig`
(the one place a headless run builds its presentation host) asks
`shouldRenderRunProgress(runContext)` and passes the answer to
`createCliRuntimeHost`, so `buildHeadlessRunContext` becomes the identity and
is deleted (4 production callers: `run.ts:197,282`, `resumeRun.ts:235`,
`team.ts:174`). Deleted: `buildHeadlessRunContext`, the
`renderRunProgress` field and its default, two overrides, the
`minimumLogLevel` proxy and its comment. Test fixtures
(`src/test-kernel/cli/fixtures/cliContext.ts:34,58`,
`RunProgressRenderer.vitest.ts:131`) set the renderer through the host
instead.

**What we give up, and risk.** None in behavior: no reader saw the overridden
value. CL-3 removes the chat's override for its own reason.

**How I tried to refute it.** Grepped every `quietLogs` reader and followed
each run context to its consumers; searched for a spread of a run context
into a reader (`{ ...runContext }`): none. Checked that `minimumLogLevel` is
`'None'` exactly when `--quiet` was passed (`cliContext.ts:497-499`).

## CL-5: The chat's one process runtime, stores and roots are threaded as props through about 20 component interfaces

- flags: pass-through, repetition
- package: cli
- kind: refactor
- size: M
- earlier: K4's React half ("The runtime reaches components through one React context (`RuntimeContext`), not through the eight interfaces of finding 4", `K-cli.md:983-985`), which PT3 deferred to it ("The Ink tree's `runChat` keeps the value. That edge is React's, and K's `RuntimeContext` covers it", `pass-through.md:349-351`). K4 landed its command-runtime half (#14820) and PT3 its `CliInvocation` (#14809); the React half did not land and the thread grew from eight interfaces to about 20 components (26 files hold the runtime).
- open PR: #14950 and #14949 edit several of these forms (`AgentListForm.tsx`, `EnabledModelsForm.tsx`, `ListForm.tsx`, `TasksForm.tsx`, …) for their copy and hints, not their props.

**Evidence.**

- 26 files under `chat/tui/` declare a `runtime` field or prop
  (`readonly runtime: ProcessRuntime`): `App.tsx:106`, `StatusBar.tsx:71`,
  `InputBar.tsx`, `formSelection.ts`, `slashContext.ts:44`,
  `modelAccessContribution.tsx`, 15 forms (`AccountAccessForm`,
  `AgentListForm`, `CliConfigForm`, `ConfigForm`, `EnabledModelsForm`,
  `GitHubTokenForm`, `MemoryListForm`, `PluginsListForm`,
  `ProviderApiKeyForm`, `ResumeListForm`, `SkillsListForm`,
  `SkillsSettingsForm`, `TasksForm`, `WorkspaceAgentsForm`, `ListForm`),
  `useAsyncListForm.ts:52,146`, `staticTranscriptRing.ts`,
  `sessionExitController.ts`, `approvalQueue.ts`, `subscribeApprovals.ts`,
  `chatSessionController.ts:208`. 26 JSX sites pass it on
  (`runtime={runtime}` / `runtime={props.runtime}`; 9 in
  `registerBuiltins.tsx`, 6 in `CliConfigForm.tsx`, 4 in `TasksForm.tsx`).
  `stores={…}` is passed at 7 JSX sites and `roots={…}` at 6.
- It is one value per Ink root: the chat's `runtime`
  (`runChatTui.tsx:148`, passed to `App` at `:610` and to
  `builtinSlashCommands` at `:557`), and `texra config edit`'s, which spreads
  its props into `CliConfigForm` (`config/runConfigTui.tsx:16-31`). No
  component chooses a runtime; each forwards it to a hook
  (`useAsyncListForm`, `useMountScope(runtime)`, `runFormWrite(runtime, …)`)
  or to a child.
- The tree already uses React context for the same kind of fact:
  `SlashCommandsProvider` (`chat/tui/commands/slashRegistry.ts:284`, mounted
  at `runChatTui.tsx:607`) and `ActiveDraftContext`
  (`chat/tui/input/activeDraft.tsx:32`).

**The design decision behind it.** "Which runtime, settings and project does
this Ink tree run its programs over?" is a fact of the root, passed by hand
to every leaf that runs a program.

**The better design.** One `ChatProcess` React context `{ runtime, stores,
roots }` (the `SlashCommandsProvider` shape), provided by `runChat` and by
`runConfigTui`; `useAsyncListForm`, `useMountScope`, `runFormWrite` and the
two status-bar reads take it from `useChatProcess()`. Non-React modules that
hold a runtime for the chat's life (`chatSessionController`,
`sessionExitController`, `subscribeApprovals`) keep their constructor
argument: they are built once at the root, not threaded. Deleted: the
`runtime` prop of about 20 component interfaces and its 26 JSX passes, the
`stores`/`roots` props of the forms that only forward them, and with CL-1
the matching fields of the slash bag.

**What we give up, and risk.** A form rendered outside a provider fails at
mount instead of at type-check; both roots provide it, and
`tui-harness.tsx` provides it once.

**How I tried to refute it.** Looked for a component given a runtime other
than its root's (none: two roots, one runtime each) and for a test that
passes a fake runtime per form (no suite under `src/test-kernel/cli/` renders
a form; `packages/cli/scripts/tui-harness.tsx` builds the root's runtime).
Checked whether a decision note refused a React context here:
none in `refuted-candidates.json` or `proposed/`.

## CL-6: Batched: an option, catches, parses and tables that restate what one owner already does, and false or doubled comments

- flags: overexposure, repetition, information leakage, comment restates code, vague name
- package: cli
- kind: refactor
- size: M
- earlier: none for these items
- open PR: none

**Evidence and the better design, item by item.**

1. **`executeCliConfig`'s `onInterruptedRunFinalized` callback has two
   callers that pass the same function.** `executeCliToolUseConfig`
   (`runtime/headless/executeCli.ts:99-129`) and `executeCliRun`
   (`commands/run.ts:339-372`) each read `tryReadCliCwd()` and pass
   `recoveryInputIsDurable ? (runId) => writeTextStderrAndWait(
   formatInterruptedResumeHint(runContext, runId, subject,
   config.workingDirectory || runContext.cwd, cwd)) : undefined`; only
   `subject` differs, `'session'` or `'workflow'`, and it follows from the
   config (`executeCliRun` runs only document tasks, `run.ts:244`,
   `resumeRun.ts:235`; `executeCliToolUseConfig` only tool-use runs). Design:
   `executeCliConfig` takes `recoveryInputIsDurable: boolean`, writes the
   hint itself with `subject` from `isTaskConfig(config)`, and returns the
   outcome's exit code with the result; `executeCliToolUseConfig` (2 callers:
   `run.ts:314`, `team.ts:228`) and the callback option go, and
   `formatInterruptedResumeHint`'s `'workflow'` becomes `'task'` (the 1.0
   word; `interruptedResumeHint.ts:23-32`).
2. **The `models` group catches its platform failure twice.** Every model
   command hands `defineCliCommand` `catchExitCode: reportModelPlatformFailure`
   (`commands/models.ts:113,126,205,221,237`), which reports any failure of
   the program and of the runtime build (`defineCliCommand.ts:165-181,235-239`).
   The programs catch the platform open again by hand with the same function:
   `listModels` (`models.ts:49-61`), `showModel` (`:79-88`) and
   `initModelCommandPlatform` (`:135-141`, used at `:144-145,170-171`, which
   then narrows a `services | { exitCode }` union with `'exitCode' in`).
   Design: the programs `yield* cliPlatform` and let `catchExitCode` speak;
   `initModelCommandPlatform`, the two `Effect.exit` blocks and the union go.
   `setModelEnabled`'s own catch (`:189-194`) stays: it words a different
   failure.
3. **`CliContext.approvalPrompt` is never set.** Declared
   (`runtime/platform/cliContext.ts:108-110`) and read once
   (`runtime/approval/approvalPrompts.ts:49-56`); no production code and no
   test assigns it (`grep -rn approvalPrompt packages src`). Delete the field
   and the branch; `askCliApprovalQuestion` is `askCliQuestion`.
4. **Three yes/no prompts parse the answer by hand.** `runtime/pruneStorage.ts:68-73`
   (`/^y(es)?$/i`, default no), `commands/plugin.ts:114-115` (same regex),
   `runtime/platform/updateChecker.ts:306-311` (`'' | 'y' | 'yes'`, default
   yes). Design: `confirmCliQuestion(question, { default })` beside
   `askCliQuestion` in `logSinks.ts`, which also prints the `[y/N]`/`[Y/n]`
   suffix from the default.
5. **False and doubled comments.** `ChatSessionController.stop`'s doc
   ("using the configured child policy, for `reason`: a `user` stop also
   cancels its remote background work", `chat/chatSessionController.ts:147-149`)
   describes a parameter the method does not take (`stop(): void`, the
   reason is fixed at `'user'`, `:731`). `runChatTui.tsx:676-679` says "What
   the session's publisher still holds…" twice, the first copy stale.
   `runChatTui.tsx:369-371`'s "build it once lazily" is CL-1's.
6. **The signal-to-exit-code table is spelled in three policies.** SIGINT
   130, SIGTERM 143 and SIGHUP 129 are written in `leaveAtOnce`
   (`runtime/platform/initPlatform.ts:108-112`, `129` a literal), in the chat's
   policy (`chat/tui/sessionExitController.ts:304-312`, `129` a literal
   again) and in the platform's graceful policy (`initPlatform.ts:241-249`),
   which names SIGINT and SIGTERM only, so a SIGHUP before Ink mounts or
   during a headless run takes Node's default death, skipping the
   platform's close that the other two signals get (`processSignals.ts:1-7`:
   "an unnamed signal keeps Node's default"). Design: `CliExitCode.Hangup:
   129` and one `SIGNAL_EXIT_CODE` record in `exitCodes.ts` the three
   policies map over; whether the graceful policy answers SIGHUP is then a
   visible choice, not an omission.
7. **`texra history show` reports one fact as two fields, one under a false
   name.** `checkpointPresent` is documented as "Whether the run's loop
   opened it: its rows hold a `run.position`" (`runtime/history.ts:92-93`)
   but is `records.readResumable` (`:188`), which is false for an ended
   document task whose loop did open (`deriveResumability`'s `finished`,
   `packages/harness/src/agent/storage/resumability.ts:59-68`).
   `resumable` is `config !== null && checkpointPresent` (`:210`); both
   reach the JSON record (`:224-241`) and the text prints `(resumable)` and
   `Checkpoint: present` for the same fact (`:383-385,437`). The listing
   names the refusal instead (`resumeBlocked`, `:66-68`). Design: one
   `resumable` plus the `readRejection` reason the listing already shows;
   `checkpointPresent` goes from the record and the text. This changes
   `history show`'s JSON keys.

**The design decision behind it.** Each item answers a question its owner
already answers: what an interrupted run prints (the run skeleton), how a
model command fails (`catchExitCode`), how stdin is read (`askCliQuestion`),
what a signal exits with (`CliExitCode`).

**What we give up, and risk.** Items 1 to 5 change nothing a user sees.
Item 6 changes what a SIGHUP does if the graceful policy takes it up, and
item 7 drops `checkpointPresent` from `history show`'s JSON: each is its own
commit and a "Needs your eye" line.

**How I tried to refute it.** Checked for a third caller of
`onInterruptedRunFinalized` (none) and for a document task reaching
`executeCliToolUseConfig` (none: `run.ts:138-140` routes by
`documentTaskOf`). Checked that the `models` in-program catch covers no
failure `catchExitCode` misses: both receive every cause the program fails
with. Searched the test tree for `approvalPrompt` (none).

## CL-7: `transcriptEntryLayout`'s three-valued `mode` is still two decisions, with one combination no caller reaches and a caller that redoes the tool lines after it

- flags: conjoined methods, special-general mixed, non-obvious code
- package: cli
- kind: refactor
- size: S
- earlier: K11's third bullet ("`transcriptEntryLayout`'s three-valued `mode` … a mode plus a caller-side correction"). The catalogue's K11 row lists the `ChatState`, bell and `runtime/` items, not this one; the code is as K11 read it. Remainder.
- open PR: none

**Evidence.**

- `type TranscriptEntryLayoutMode = 'live' | 'scrollback' | 'scrollback-budget'`
  (`chat/tui/panes/transcriptEntryLayout.ts:32`) is read as two booleans:
  "elide the body" (`mode !== 'scrollback-budget'`, `:206`, `:266`) and "use
  the live/rich display" (`mode === 'live'` for assistant text, `:248`;
  `mode === 'live' || mode === 'scrollback-budget'` for tools, `:264`).
- The `'scrollback'` × `tool` combination is never reached: the only
  `'scrollback'` caller returns early for tools
  (`panes/TranscriptEntry.tsx:104-111`, `<ToolUseRow>` first), and the other
  callers pass `'live'` (`TranscriptEntry.tsx:156`,
  `transcriptViewport.ts:21`) or `'scrollback-budget'`
  (`staticTranscriptRing.ts:190`, `fullTranscriptEntryLayout`). So
  `useRichDisplay` is always true where it is computed and its
  `wrapDisplayLines` fallback (`:269-271`) is dead.
- `fullTranscriptEntryLayout` (`:342-364`) calls the layout in
  `'scrollback-budget'`, then for a tool throws its lines away and
  recomputes them with `showFullOutput: true` and a plain wrap: a mode plus a
  caller-side correction, as K11 said.

**The design decision behind it.** "How much of a row does this surface
show?" is one enum whose members each bundle two answers, so a new surface
picks the member whose bundle is closest and patches the rest.

**The better design.** Name the member for the surface that asks and let
the layout own each surface's whole answer: `'live' | 'printed' | 'measured'
| 'reader'` (today `'live'`, `'scrollback'`, the ring's `'scrollback-budget'`,
and `fullTranscriptEntryLayout`'s `'scrollback-budget'` plus its patch). The
tool case then has three reachable branches and no condition: `'live'`
elided rich lines, `'measured'` whole rich lines, `'reader'` full output
wrapped; `'printed'` never sees a tool and says so with `ToolUseRow`.
`fullTranscriptEntryLayout` keeps only its inset add-back. Deleted: the
`useRichDisplay` condition and its dead `wrapDisplayLines` fallback
(`:264-271`), the tool override in `fullTranscriptEntryLayout` (`:353-363`).
K11's two-boolean shape is the alternative; the surface names keep each
caller's current output without a new option.

**What we give up, and risk.** Display only; the transcript-reader and ring
layouts stay byte-identical if each caller passes today's effective values.
`src/test-kernel/cli` pins the live layout through the pane suites.

**How I tried to refute it.** Listed every `transcriptEntryLayout(` call
(four, plus `fullTranscriptEntryLayout`) and checked which reach the tool
case; `ToolUseRow` paints tools without this layout.

## CL-8: The chat resolves its model at four sites, each restating the stores and a recovery sentence, and the in-chat reconnect uses the startup's sentence

- flags: repetition, overexposure, information leakage
- package: cli
- kind: refactor
- size: S
- earlier: none
- open PR: none (#14949 and #14950 edit `modelAccess.ts`'s route and status copy, not `selectCliRunnableModel`'s options)

**Evidence.**

- `selectCliRunnableModel([{ model, reason }], { stores: { ...stores,
  runtime }, noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
  RECOVERY) })` is written at four chat sites:
  `chat/tui/runChatTui.tsx:227-235` (startup), `chat/chatSessionController.ts:746-754`
  (a fresh root run), `chat/tui/modelConnection.ts:134-141` (after a sign-in),
  `chat/tui/commands/handlers/agentModelCommands.ts:149-156` (`/model`
  before the first run). The headless path is the fifth
  (`runtime/models/runModel.ts:66-68`, default sentence).
- The sentence is two nested string options: `noAvailableModelsMessage?:
  string` (`runtime/models/modelAccess.ts:75-80,337,346`) holding
  `formatCliNoAvailableModelsRecovery({ configureKeyAction?: string })`
  (`:86-88,110-116`). Three spellings exist: the default, `CHAT_STARTUP_MODEL_RECOVERY`
  ("add a provider API key with `texra setup`", `runChatTui.tsx:142-144`) and
  `CHAT_API_MODE_MODEL_RECOVERY` ("… with `/key`", `handlers/slashContext.ts:82-84`,
  also read by `ModelListForm.tsx:85-87`).
- `connectChatModel` runs inside a mounted chat (it is the `onAccountChanged`
  of a slash form, `runChatTui.tsx:546-555`) but is handed the startup
  sentence (`recovery: CHAT_STARTUP_MODEL_RECOVERY`, `:551`), so a failed
  resolve after `/login` tells the user to run `texra setup` from the chat
  they are in, where every other in-chat path says `/key`.

**The design decision behind it.** "Which model does this chat run, and
what does it say when none can?" is decided at each site, with the
surface's wording passed in as data.

**The better design.** One chat function beside the controller,
`selectChatModel(stores, model, reason)`, that owns the stores spread and
the in-chat sentence; the four sites call it, and startup alone passes its
own sentence (it runs before Ink and exits). `noAvailableModelsMessage` and
`configureKeyAction` collapse into one `recovery: string` the headless
default fills. Deleted: three copies of the options block, one of the two
nested options, and the startup constant's second use (`:551`).

**What we give up, and risk.** A wording change after `/login` (from `texra
setup` to `/key`), which is the fix.

**How I tried to refute it.** Checked whether `connectChatModel` can run
before Ink mounts (no: only a slash form's account change calls it, and
forms exist only once Ink is up). Checked the four sites for a reason
difference that needs separate code: they differ only in `reason` and
`model`.

## CL-9: Once a command's platform is up every diagnostic is dropped, so `--verbose` does nothing for the command's work and warn-level fallbacks are silent

- flags: non-obvious code, temporal decomposition, information leakage
- package: cli
- kind: bug
- size: S
- earlier: round 3's V S17 holds "the CLI's log sink is silent by design" for the TUI's Ink-bound items (`../2026-11-07-design-red-flags-round-3/V-compromises.md:161,242`; round 4's X S2 cites it for the headless denial notice). New evidence that decision did not weigh: the documented `--verbose` and the warn-level fallbacks of every headless command go to the same silent sink.
- open PR: none

**Evidence.**

- The sink has three writers ordered by time: `bin/texra.ts:24`
  (`prePlatformDiagnosticSink`, every level to stderr), `defineCliCommand.ts:218-221`
  (the same, or `silentLogSink` under `--quiet`), then `openCliPlatform`
  unconditionally: "Every command renders its own output, so the platform's
  log lines go nowhere" (`runtime/platform/initPlatform.ts:158-160`). Every
  `Effect.log*` reaches the sink through the diagnostics logger
  (`packages/harness/src/logger/effectDiagnostics.ts:20,66-77`,
  `logSink.ts:190-195`).
- `--verbose` is "Emit debug-level diagnostics (the terminal has no level
  filter of its own)" (`commands/_helpers/globalArgs.ts:80-84`); it sets
  `minimumLogLevel: 'Debug'` (`cliContext.ts:497-499`), which the logger
  honors and the sink then discards for everything after the platform opens.
  What it still changes is NDJSON's debug `log` rows
  (`sessionProgressSubscription.ts:92`), not diagnostics.
- Fallbacks that "log the cause at warn" therefore say nothing in any
  command with a platform: the pager that could not run, "writing the output
  directly" (`runtime/terminal/pager.ts:60-66`); a user-question or approval
  prompt that failed (`runtime/headless/approvalAdapter.ts:99-102`,
  `runtime/approval/approvalPrompts.ts:169-171`, whose cause does reach the
  request row); the platform-level warnings the harness logs for the same
  session (resumability, store reads). The code knows: comments route around
  it by writing stderr directly ("the log sink is silent for every CLI
  command", `executeCli.ts:265-269`; `chatSessionController.ts:641-643`), which
  makes each such site decide again where its warning goes.

How it fails: `texra run --verbose …` prints the runtime build's debug lines
and then nothing from the run; a warn-level fallback in `texra history list`
(the pager) is invisible even with `--verbose`.

**The design decision behind it.** "Where do this process's diagnostics go?"
is answered three times by whoever ran last, and the last answer ignores the
level the context decided.

**The better design.** The sink is decided once, from the context, where
the runtime's level already is: a headless or one-shot command keeps
`prePlatformDiagnosticSink` for its whole life and its default level becomes
`'Warning'` (so the `[agentRegistry] Loaded …` info noise round 5 noted stays
off), `--verbose` `'Debug'`, `--quiet` `'None'`; the chat installs the silent
sink when Ink mounts (where V S17's reason holds), or a sink that turns
`WARN`+ into transcript notices if the owner wants them seen. `openCliPlatform`
stops calling `setLogSink`, and the sites that write stderr only because the
sink is silent may go back to `Effect.logWarning`.

**What we give up, and risk.** Warnings that were dropped start appearing on
stderr for headless commands; stdout and NDJSON stay unchanged (the sink
writes stderr only). The TUI path is unchanged.

**How I tried to refute it.** Looked for a second sink after the platform (a
file log, a TUI sink): none. `commands/service.ts:53-85` installs the
background service's own log; `cliService.ts:249-253` (`quietClient`) and
`doctor.ts:60` install the silent sink again, a fourth and fifth writer. Checked that `--verbose` is not rejected or documented as
pre-platform only: it is accepted by every command, the chat included
(`INTERACTIVE_GLOBAL_ARGS`, `globalArgs.ts:176-185`).

## Good modules in this area

- `chat/tui/hosts/cliProviderKeys.ts`: every terminal surface that writes a
  provider key goes through one binding of the shared
  `SettingsProfileKeyController`, so the secret name, label and refresh are
  the graphical hosts'.
- `runtime/platform/processSignals.ts` `holdSignals`: policies held as a
  stack, the newest holder answers, `process.on` in one file. CL-6 item 6
  only moves the codes into one table.
- `commands/_helpers/defineCliCommand.ts`: the one place a command enters its
  runtime; builder-time `CliUsageError`, `catchExitCode` and the TUI mount
  after the program finish are each decided once.
- `chat/tui/state/cliState.ts`'s `ChatState` with `fieldOf`/`chatField`: one
  value per conversation, each module the only writer of its field, `/clear`
  a new value.
- `chat/tui/modelConnection.ts`: "held until a model is connected" is a
  `Latch`, as K3 proposed.
- `runtime/headless/taskAttach.ts`: a live task printed through the same
  `fullTranscriptEntryLayout` and `writeProgressRow` the chat and
  `texra run` use, so the three outputs cannot drift.
- `chat/tui/state/resumeHint.ts` `formatResumeCommand`: shell quoting through
  `effect/process/CommandLine.quote` per platform rather than by hand.
- `runtime/headless/cliPresentationHost.ts`'s exhaustive handler table for
  the headless path (CL-3 is about the chat borrowing it, not about the
  table).

## Already settled, left alone

- The chat's bell re-deriving "the turn finished" from four conditions
  (`chat/tui/runChatTui.tsx:705-728`): refused,
  `CLI-tui-bell-from-attention` (`.agents/docs/refuted-candidates.json`).
- The TUI's answer path for prompts (`RT-tui-approve-handler`), the exit
  code's several writers (`RT-cli-exit-code-one-function`), the bootstrap
  install (`RT-install-cli-process-runtime`): refused, same file.
- The run claim and exit code in `chat/tui/state/sessionRunState.ts` and
  `runtime/headless/executeCli.ts`'s shutdown step: round 1's F1 and F5,
  settled as K's "Already settled" lists them (`K-cli.md:890-904`). CL-6 item 1
  touches only `executeCliConfig`'s callback option, not the shutdown race.
- The background-service files (`runtime/platform/cliService.ts`,
  `commands/service.ts`, `runtime/headless/taskAttach.ts`,
  `chat/tui/state/attachedTask.ts`): the CLI-service note
  (`.agents/docs/proposed/architecture/2026-11-06-cli-service-root-causes.md`).
- The silent sink under Ink (V S17,
  `../2026-11-07-design-red-flags-round-3/V-compromises.md:242`): held; CL-9
  reports only the headless commands and `--verbose`, which S17 did not
  weigh.
- `dispatch.ts`'s leading global flags: already one partition
  (`.agents/docs/proposed/simplification/2026-11-14-llm-history-lowering-and-reply-document-recovery.md:267-271`).
- The validation scripts' hand-written argv strictness: outside this area and
  recorded (`2026-11-15-natives-and-owners-left-open.md` item 1).
- `runtime/models/validationModel.ts` in the production tree: the shipped
  bundle loads a stub in its place (`validationModel.ts:8-12`,
  `scripts/stub-internal-validation-model.mjs`); K11's `runtime/` split
  landed (#14820) and left it there on purpose.
- `Semaphore.makeUnsafe(1)` lanes and the uninterruptible
  `followUp.send` + presentation in `chatSessionController.ts:776,800-853`:
  K's "Already settled".
- The status bar, scrollback ring and child list (`statusBarDisplay.ts`,
  `staticTranscriptRing.ts`, `SubagentList*.tsx`): K1, K2, K6, K7, K8 landed
  (#14792) and #14949/#14950/#14955 rewrite them now; not re-audited here.
