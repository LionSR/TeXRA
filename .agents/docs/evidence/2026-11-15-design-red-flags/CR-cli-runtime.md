Read at `cb22acd`; covers `packages/cli/src/{runtime,commands,tui,schemas,init,bin,onboarding,config}`. `node_modules` is not installed in this checkout, so citty 0.2.2 and Effect v4 behavior is cited from the repo's own comments and the lockfile, not from the installed sources; each such claim is marked "unverified API".

### CR-1: Commands read their own flags a second time from raw argv with a hand-written scanner

- **Package:** cli
- **Flags:** a hand-written version of what the arg-parsing library provides; repetition (one flag, two parsers); non-obvious code
- **Evidence:**
  - `commands/_helpers/globalArgs.ts:323-354` `collectStringFlagValues` walks `rawArgs` for `--name`, `--name=value` and `-x value`, with its own missing-value rules (`:293-313`). Production consumers: `globalArgs.ts:157` (`--source`), `:258-259` (`--input`, `--context`), `skills.ts:85`, `plugin.ts:166`; and through `optionalStringFlagValue` (`:316-321`) `globalArgs.ts:261` (`--instruction-file`), `run.ts:519-520` (`--output`, `--output-dir`).
  - The last three are single-valued flags citty already parsed into `ctx.args` (`run.ts:482-508` declares them); the same handler reads `--model` and `--instruction` from `ctx.args` two lines away (`run.ts:518,521`). Nothing says why `--output` needs the raw scan.
  - The two parsers disagree. The scanner stops at `--` (`:335`), trims an inline value but not a separate one (`:296` vs `:312`), refuses a value that starts with `-` (`:308`), and does not know `-i=file` or `-ifile`. `detectUnknownCliFlag` (`dispatch.ts:426-439`) accepts a short cluster such as `-qi file`, which this scanner then never sees as `-i`.
  - `pickGlobalArgs` (`globalArgs.ts:154`) reads `--no-input` as `args['no-input'] === true || args.input === false`, relying on a command's own `--input <file>` never being a boolean; `booleanArg` (`:233-239`, one consumer, `subscriptionAuthCommand.ts:125`) encodes the same citty negation rule a second time. `optString` (`:222`, 12 call sites) narrows values citty already types as `string | undefined`.
  - The comment at `:155-156` gives the reason for the scanner: "citty's parsed args keep the last value only."
- **Better design:** one reader of repeated flags at the citty edge. Either (a) `defineCliCommand` hands the handler `ctx.args` with repeatable flags already collected into arrays (a `repeat: true` marker on the arg definition, collected once by Node's `util.parseArgs({ multiple: true })` over the same definition table), or (b) keep the scanner but call it in one place, from the arg definitions marked repeatable. Handlers then write `ctx.args.input` and `ctx.args.output` and never touch `rawArgs`. Single-valued flags are read from `ctx.args` only.
- **Deleted:** `optionalStringFlagValue`, `collectCommonAgentRunFlags`' raw-argv half, `booleanArg`, the `args.input === false` reading, `rawArgs` as a parameter of `pickGlobalArgs` and `loadConfigAndWarn`, the five handler-side `collectStringFlagValues` calls.
- **Size:** about 150 lines, 8 files.
- **Risk / owner decision:** owner decision if the fix changes which spellings are accepted (`-ifile`, a value after `--`). Unverified API: whether citty 0.2.2 can return every occurrence of a string flag.

### CR-2: Which commands are interactive is a list of names consulted in three files

- **Package:** cli
- **Flags:** special and general code mixed; information leakage; an option for a special case
- **Evidence:**
  - `globalArgs.ts:193` `INTERACTIVE_COMMAND_NAMES = ['chat', 'setup']`.
  - `defineCliCommand.ts:164` looks the command's own `meta.name` up in that list to choose `INTERACTIVE_GLOBAL_ARGS` (`:189`) and to wrap `setup` with `rejectHeadlessOnlyFlags` (`:192-197`).
  - `dispatch.ts:395-406` looks the name up again, guarded by `commandPath.length === 2`, to add the three headless-only flags back to the known-flag table, "instead of downgrading it to unknown".
  - `globalArgs.ts:176-185` `INTERACTIVE_GLOBAL_ARGS` restates five of the eight `GLOBAL_ARGS` rows by hand, and `HEADLESS_ONLY_GLOBAL_ARG_NAMES` (`:161-165`) is its complement, so the split is written twice.
  - The list is by name, not by behavior: `texra resume` ends in the same chat (`defineCliCommand.ts:60-66` names it) and is not in it; a nested command named `setup` would match `defineCliCommand.ts:164` but not `dispatch.ts:397`.
  - Net effect of the three sites: the flag is removed from the command's args, then re-added to the unknown-flag table, so that a third site can reject it with a different message.
- **Better design:** an interactive command declares all of `GLOBAL_ARGS` like every other command, and the definition that knows it owns the terminal rejects the headless-only flags in its own `setup` (`chat.ts`, `setup.ts` call `rejectHeadlessOnlyFlags`). The flags then parse, so dispatch needs no special case, and the list of names is gone.
- **Deleted:** `INTERACTIVE_COMMAND_NAMES`, `INTERACTIVE_GLOBAL_ARGS`, the `Omit` type, the `interactive` branch of `defineCliCommand`, `dispatch.ts:395-406`.
- **Size:** about 60 lines, 5 files.
- **Risk / owner decision:** owner decision: `texra chat --help` would list `--print`, `--output-format` and `--no-input` unless the usage renderer hides them. Open PR #14953 changes `dispatch.ts` (only `stripAnsi` to `stripVTControlCharacters`); it does not touch this.

### CR-3: K11 remainder: the NDJSON line stamp has four writers and the kind registry is 33 copies of one struct

- **Package:** cli
- **Flags:** repetition (a rule with several owners); non-obvious code
- **Evidence:** K11's headless item (catalogue row K11, "landed (#14875 …)") is still in the tree.
  - `ts` is written at `commands/_helpers/output.ts:67-75` (with the test `'ts' in record ? record : { ...record, ts }`), `runtime/headless/cliPresentationHost.ts:56`, `runtime/headless/sessionProgressSubscription.ts:31` and `runtime/doctor.ts:468`. `contract` is written at a fifth place, `runtime/platform/logSinks.ts:262`. `schemas/cliOutput.ts:38-46` documents the split ("`ts`, appended by `emitCliResult` unless the record set its own, and `contract`, appended by the NDJSON sink").
  - `schemas/cliOutput.ts:111-256`: 33 `Schema.StructWithRest(Schema.Struct({ kind: Schema.Literal(x), field: payload }), [Schema.Record(...)])` members, `payload = Schema.Unknown` (`:62`). Two members carry a real schema (`agent-result`, `result`). The schema value has no decoder: `CliNdjsonRecordSchema` is file-local and only `typeof … .Type` leaves the file (`:259`).
  - `runtime/doctor.ts:476-502` `writeDoctorReport` is a third copy of the `json | ndjson | text` switch `writeCliResult` owns (`output.ts:58-83`).
- **Better design:** `writeNdjsonStdout` stamps both keys (`{ ...record, ts, contract }`), so a line's stamp has one writer and no record carries `ts`. The registry is a `Record<kind, primaryField>` table from which the union type is derived, plus the two typed members. `writeDoctorReport` passes its three forms to `writeCliResult` and keeps only its choice of stream for the text form.
- **Deleted:** four `ts: new Date().toISOString()` literals, the `'ts' in record` branch, about 110 lines of struct repetition, doctor's json and ndjson branches.
- **Size:** about 180 lines, 6 files.
- **Risk / owner decision:** owner decision, small: doctor's records in one report would no longer share one timestamp unless the sink is given it; `ts` moves from "when the result was built" to "when the line was written". Open PR #14959 changes `output.ts` (a comment only) and does not touch this.

### CR-4: The headless run context is a rewritten copy of `CliContext`, and `quietLogs` means two things

- **Package:** cli
- **Flags:** temporal decomposition; non-obvious code; state in a field that is derivable; a vague name
- **Evidence:**
  - `runtime/platform/cliContext.ts:83-84` `renderRunProgress: boolean`, "set by `buildHeadlessRunContext`"; `buildCliContext` always writes `false` (`:507`).
  - `runtime/models/runModel.ts:80-86` `buildHeadlessRunContext` returns `{ ...context, quietLogs: true, renderRunProgress: shouldRenderRunProgress(context) }`. `shouldRenderRunProgress` (`runtime/headless/runProgressRenderer.ts:66-70`) reads `!context.quietLogs`, so it must be computed from the context before the same statement overwrites `quietLogs`. Calling it on the result always answers `false`.
  - After the copy `quietLogs` no longer means `--quiet`: `executeCli.ts:267` comments "`runContext.quietLogs` is forced on for every headless run", `runChatTui.tsx:498` does the same (`sessionContext: { ...context, quietLogs: true }`), while `runModel.ts:73`, `agents.ts:32,56,73`, `clone.ts:142` and `loadConfigAndWarn.ts:28` read it as the user's flag.
  - `executeCli.ts:215-216` re-derives part of the rule: `runContext.outputFormat === 'text' && runContext.renderRunProgress`.
  - Four callers must remember the copy: `run.ts:197,282`, `team.ts:174`, `resumeRun.ts:235`. `selectCliRunModel(context, …)` must be given the original (it reads `quietLogs` for its notice), `executeCliRun(config, runContext, …)` the copy; `run.ts` holds both in scope.
- **Better design:** the context keeps one fact, `quiet` (the flag). "A headless run and a chat render their own output, so the platform's log sink is silent" is decided where the platform is initialized for a run (`initPlatform.ts:220-230` reads it), from the command, not from a rewritten flag. `createRunProgressRenderer` computes `!quiet && outputFormat !== 'ndjson'` itself.
- **Deleted:** `CliContext.renderRunProgress`, `buildHeadlessRunContext` and its four calls, `shouldRenderRunProgress` as an export, the second `runContext` variable in `run.ts` and `team.ts`, the test fixture's `renderRunProgress` override (`src/test-kernel/cli/fixtures/cliContext.ts:34,58`).
- **Size:** about 80 lines, 9 files.
- **Risk / owner decision:** none; behavior is unchanged if the platform's silent sink is chosen by the same commands.

### CR-5: `CliContext.approvalPrompt` has no writer

- **Package:** cli
- **Flags:** an export with no consumer; an option for a special case
- **Evidence:** `runtime/platform/cliContext.ts:107-109` declares `approvalPrompt?: (request: CliPromptRequest) => Effect<string, Error>`. Its one reader is `runtime/approval/approvalPrompts.ts:49-57` (`const injected = …context.approvalPrompt; return injected ? yield* injected(request) : yield* askCliQuestion(…)`). `grep -rn "approvalPrompt\b"` over `packages/*/src`, `packages/*/test`, `packages/cli/scripts` and `src/` finds those two files only: nothing sets it, in production or in a test.
- **Better design:** `askCliApprovalQuestion` calls `askCliQuestion`.
- **Deleted:** the field, the `injected` branch, and `CliPromptRequest` as an export of `cliContext.ts` (it moves beside its one user).
- **Size:** about 20 lines, 2 files.
- **Risk / owner decision:** none. Open PR #14959 changes `cliContext.ts` (the approval-policy env name and two comments), not this field.

### CR-6: The run-model candidate order is written twice

- **Package:** cli
- **Flags:** repetition (a rule with two owners)
- **Evidence:** `runtime/models/runModel.ts:38-43` and `runtime/models/chatDefaults.ts:58-63` build the same four-row list in the same order: `explicit-override`, `environment`, `command-config` (`cliCommandDefaults(stores, role).model`), `builtin-default` (`CLI_CHEAP_START_MODEL`). The headless one feeds `selectCliRunnableModel`; the chat one feeds `decideRunModel` directly and `runChatTui.tsx:227` then calls `selectCliRunnableModel` on its own. The two differ only in the role string and in who trims the override.
- **Better design:** one `cliRunModelCandidates(stores, { override, envModel, role })` in `runModel.ts`, used by both; `resolveChatDefaults` keeps the agent half only.
- **Deleted:** one of the two lists, the "decision named no model" throw in `chatDefaults.ts:67-68` if the chat goes through the same selection.
- **Size:** about 30 lines, 3 files.
- **Risk / owner decision:** none. Related, not the same: FB2 (the notice dropped by two callers).

### CR-7: Batched: options whose value the callee already holds

- **Package:** cli
- **Flags:** an option for a special case; pass-through variable
- **Evidence:**
  - `commands/_helpers/loadConfigAndWarn.ts:22,31` `options.printConfigWarnings`: one caller passes it, `commands/doctor.ts:116` (`false`); the other caller is `defineCliCommand.ts:202`. The function's name says it warns. `rawArgs = []` (`:21`) is a default no caller uses.
  - `runtime/terminal/pager.ts:28-31` `pageStdout(text, { stdoutIsTty?, headless? })`: one caller, `commands/_helpers/output.ts:99-102`, which copies both from the `CliInvocation` context that `pageStdout` could read (it already runs in that context's Effect).
  - `runtime/terminal/terminalRequirements.ts:31-45` `formatInteractiveTerminalFailure` takes `dumbTerminalOptions?: { commandName?, nonInteractiveFallback? }` nested inside its options, with `commandName || 'texra'`. Four callers (`chat.ts:54`, `setup.ts:20`, `resumeRun.ts:126,181`); every one holds `context.commandName`, two do not pass it, so `texra-local chat` prints `texra chat needs a capable terminal`.
  - `runtime/doctor.ts:446` `style: CliStyle = createCliStyle(false)`: one caller (`:496`), which always passes a style.
- **Better design:** `loadConfigAndWarn` returns the context and `defineCliCommand` prints the warnings (doctor shows them as a report row). `pageStdout(text)` reads the invocation. `formatInteractiveTerminalFailure(reason, context, { headlessMessage, command, fallback? })` takes the command name from the context. `formatDoctorText(report, style)`.
- **Deleted:** `printConfigWarnings`, the `rawArgs` default, `pageStdout`'s options object, `dumbTerminalOptions`, one default parameter.
- **Size:** about 50 lines, 8 files.
- **Risk / owner decision:** none (the `texra-local` wording is a fix).

### CR-8: "Can this process run an Ink UI?" has an owner, and three commands restate it with drift

- **Package:** cli
- **Flags:** repetition (a rule with several owners); special and general code mixed; non-obvious code
- **Evidence:**
  - The owner: `runtime/terminal/terminalRequirements.ts:21-29` `interactiveTerminalFailure` over `context.mode` (which `cliContext.ts:339-351` `cliMode` sets to headless for `--print`, `--no-input`, `CI` or a non-TTY stdin), `stdoutIsTty` and `termIsDumb`. Callers: `chat.ts:49`, `setup.ts:17`, `resumeRun.ts:123,176`, `subscriptionLogin.ts:48`, and the bare-`texra` route through `isInteractiveCli` (`cliContext.ts:358-369`, `root.ts:58-64`).
  - `commands/init.ts:165-169` restates it by hand: `!opts.yes && context.mode !== 'headless' && context.stdoutIsTty === true && context.termIsDumb !== true`.
  - `commands/config.ts:231-237` (`config edit`'s builder) uses a different rule: `ambient.stdinIsTty && context.stdoutIsTty && !context.termIsDumb`, read from `readCliAmbientState()` instead of `context.mode`. `--no-input`, `--print` and `CI=1` do not stop it, so `texra config edit --no-input` on a terminal opens the TUI that `--no-input` ("disable all prompts", `cliContext.ts:330-335`) exists to prevent.
  - `commands/config.ts:268-271` (`config`'s default route) uses a third: `ambient.stdinIsTty && ambient.stdoutIsTty ? 'edit' : 'show'`, which ignores `TERM=dumb`. Under `TERM=dumb` on a TTY, bare `texra config` (the entry point `docs/guide/configuration.md:12` and `docs/guide/texra-cli.md:36` give) routes to `edit`, whose builder then refuses it with exit 2, instead of falling back to `show`. Bare `texra` makes the same choice correctly through `isInteractiveCli`.
  - `runtime/platform/updateChecker.ts:254-262` is a fourth: `isCi`, then all three ambient TTY flags. Its one caller (`chat.ts:64`) runs it only after `chat.ts:49` refused every non-interactive terminal, so the CI, stdin and stdout checks are unreachable; only the stderr check adds anything.
- **Better design:** every command asks `interactiveTerminalFailure(context)`. `init` writes `!opts.yes && interactiveTerminalFailure(context) === undefined`; `config edit` throws on `interactiveTerminalFailure(context)` with its own message; `config`'s `default` makes the root's choice (`root.ts`'s `defaultRootSubcommand` body as one function over the routed argv, used by both `default`s). `notifyCliUpdate` keeps only `context.stderrIsTty`, `ndjson` and `quiet`.
- **Deleted:** the three hand-written conditions, the `readCliAmbientState` reads in `config.ts` (2) and the three dead ambient checks in `updateChecker.ts`.
- **Size:** about 35 lines, 4 files.
- **Risk / owner decision:** owner decision (small, user-visible): `texra config` under `CI`, `--print`, `--no-input` or `TERM=dumb` shows the config instead of opening (or refusing) the TUI, and `texra config edit --no-input` refuses. Each is what `--no-input` and the bare-`texra` route already promise.

### CR-9: A failure's exit code is decided per command: `report` sends a program's `CliUsageError` to `catchExitCode`, and three helpers catch the whole cause before `report` sees it

- **Package:** cli
- **Flags:** repetition (a rule with several owners); a comment that is false; silent degradation; special and general code mixed
- **Evidence:**
  - The owner is `report` in `commands/_helpers/defineCliCommand.ts:165-181`: interrupts only exits 130, else `Cause.squash`, then `catchExitCode` when set, else rethrow to `runCli`, which turns a `CliUsageError` into exit 2 (`root.ts:196-199`). With `catchExitCode` set, a `CliUsageError` the program raises takes the command's catch code: `report` never asks what the error is. The option's own doc says otherwise (`defineCliCommand.ts:97-98`: "A usage error the program raises instead still exits 2").
  - Effect: every `texra tasks` refusal exits 1, not 2. `tasks.ts` sets `catchExitCode: CliExitCode.AgentError` on all five subcommands (`:126,148,193,265,290`) and refuses with `CliUsageError` inside the program: `findTask` ("No task …", `:71-78`), `requestTask` ("refused as a usage error", `:91,104-108`), `start`'s empty instruction (`:196-199`), and `resolveCliRunAgent`'s unknown agent (`:213`, `runtime/agents.ts:57-61`).
  - Two commands re-implement the missing case by hand: `plugin.ts:40-45` `pluginExitCode` (`CliUsageError || PluginRequestError` to 2, else 1; 7 uses) and `resumeRun.ts:46-53` `resumeFailureExit` (`CliUsageError` to 2, else 1; 2 uses) beside `loadFailureMessage` written three more times (`:105,155`).
  - Three helpers catch the whole cause, interruption included, ahead of `report`, so a Ctrl-C reads as a failure and is printed as one:
    - `commands/_helpers/subscriptionAuthCommand.ts:31-40` `withCliAuthError` (`Effect.matchCause`, `writeErrorStderr(Cause.squash(cause))`, then `ModelOrNetworkError`), wrapped round `login`, `logout` and `status` (`:76,136,163`). The device-code prompt tells the user "Waiting for approval... (Ctrl-C cancels)" (`runtime/models/subscriptionLogin.ts:89`).
    - `commands/models.ts:50-61` and `:78-87` (`Effect.exit` round the platform and the read, then `reportModelPlatformFailure(Cause.squash(…))`), `:135-140` `initModelCommandPlatform` ("Any cause counts, defects and interruption included", `:130-134`) with the value-or-exit-code union its two callers narrow by `'exitCode' in services` (`:143-144`, `:170-171`), and `:189-194` (`catchCause` to exit 2). All five `models` subcommands already pass `catchExitCode: reportModelPlatformFailure` (`:113,126,205,221,237`), which reports the same failures with the same words.
  - Whether a Ctrl-C reaches these helpers as an interrupt cause is what `report`'s own branch (`:166-171`) and `initPlatform.ts:126-131` ("that disposal interrupts the command's fibers first") say; the text `Cause.squash` gives an interrupts-only cause is unverified (Effect sources not installed).
- **Better design:** `report` owns the classification: interrupts only, exit 130; a `CliUsageError`, its message and exit 2; anything else, `catchExitCode`. Then `models` programs `yield* cliPlatform` and read, `setModelEnabled` keeps only an `Effect.catch` (failures, not interrupts) for its usage refusals, the three auth commands set `catchExitCode: CliExitCode.ModelOrNetworkError`, `pluginExitCode` keeps only `PluginRequestError`, and `runResumeCommand` lets its refusals propagate.
- **Deleted:** `withCliAuthError` and its three `if (!result.ok)` lines, `initModelCommandPlatform` and the `'exitCode' in services` union, the two `Effect.exit` blocks in `models.ts`, `resumeFailureExit`, `pluginExitCode`'s `CliUsageError` half, the false sentence in `defineCliCommand.ts`.
- **Size:** about 100 lines, 6 files.
- **Risk / owner decision:** owner decision (user-visible exit codes): `texra tasks` refusals exit 2 instead of 1, and a Ctrl-C during `texra auth … login`, `models …` exits 130 with no error line. Both are what `report` and the help say today.

### CR-10: Batched: small items with one owner each, written a second time

- **Package:** cli
- **Flags:** repetition; an option for a special case; shared mutable state; a hand-written version of what the harness or citty provides; a UI renderer repairing a data-model problem; a comment that is false; vague name
- **Evidence and fix, per item:**
  - (a) **The launch-approval notice is written at three launch sites, beside a startup snapshot of the same rule.** `runtime/headless/executeCli.ts:203-207`, `commands/tasks.ts:207-212` and `chat/tui/runChatTui.tsx:175-179` each write `launchApprovalNotice(context.requestedApprovalPolicy, projectApprovalPolicy(config))` then `writeTextStderr`; `cliContext.ts:483-486` computes `CliContext.approvalPolicy` once at startup from the same provider, and `team.ts:142,189`, `interruptedResumeHint.ts:30` and `resumeRun.ts:185` read that snapshot. `projectApprovalPolicy` and `effectiveApprovalPolicy` (`cliContext.ts:547-558`) are one-line wrappers over `Settings.getConfig` and the harness's `launchPolicy`. Fix: one `launchApprovalFor(context, config)` beside `launchApproval` that writes the notice and returns the `LaunchApproval`; the readers of the snapshot read the policy at their decision. A remainder of U2 (catalogue: landed), whose CLI side kept the notice at each site. Deleted: two of three notice blocks, `projectApprovalPolicy` and `effectiveApprovalPolicy` as exports.
  - (b) **Which members a command section accepts is written twice.** `runtime/platform/cliConfig.ts:183-186` `COMMAND_SECTION_KEYS` (`chat`: agent, model; `run`: model) restates the schemas of `CLI_CHAT_SETTING` and `CLI_RUN_SETTING` (`packages/texra/src/shared/settings/texraSettings.ts:99-101,113`). Fix: `configFileWarnings` decodes a project-file value with the row's schema and `{ onExcessProperty: 'error' }` (the root guide's one site that must refuse), and names the excess keys from that issue. Deleted: the Map and the nested-key loop (`:222-228`).
  - (c) **`renderCliPrompt`'s stream options are constant.** `tui/renderCliPrompt.tsx:10-21` takes `stdout`, `stderr` ("passed in … so the choice of stream stays in the caller") and an optional `colorEnabled` with `?? true` (`:52`); both callers pass `process.stdout`, `process.stderr` and a color flag (`config/runConfigTui.tsx:27-31`, `init/runInitWizard.tsx:221-228`), which is the only reason both files sit on oxlint's `CLI_WRITERS` list (`oxlint.config.mts:276-277`). It already reads `process.stdin` itself (`:55`). Fix: it takes the streams itself and `colorEnabled` as required. Deleted: two options, the default, two allowlist entries (one added for `renderCliPrompt.tsx`).
  - (d) **K4 remainder: `updateNotifyStarted`.** `runtime/platform/updateChecker.ts:232-252` keeps a module latch "once per process" for `notifyCliUpdate`, whose one caller (`commands/chat.ts:64`) is the first step of one command's program, which a process runs once. K4 (catalogue: landed, #14820) named this latch as becoming that first step; the step moved and the latch stayed. Deleted: the latch and its two lines.
  - (e) **The env read restates harness `envVar`.** `cliContext.ts:383-387` `envTier` and `runtime/models/browser.ts:60-66` write `Config.String(key).pipe(Config.option, Effect.orDie)` by hand; `envVar` (`packages/harness/src/utils/system/envFlags.ts:47-52`, exported from `@texra-ai/harness/node`) is that expression, and `runtime/models/validationModel.ts:396-425` already uses it. Deleted: two copies (`envTier` keeps only its trim).
  - (f) **`doctor` redacts e-mail addresses in one of its three forms.** `runtime/doctor.ts:456-458` applies `redactEmailDiagnostics` to each check's message and hint in the text form only; the JSON form (`:481`) and the NDJSON records (`:464-473`) carry the same check unredacted. Fix: redact once where a check is built (`check`, `:110-118`), so every form carries the same text. Deleted: the two render-time calls. Owner decision (small): JSON and NDJSON output change.
  - (g) **`history show --export` validates an enum by hand.** `commands/history.ts:278-283` declares `export` as `type: 'string'` and checks `html | md` itself (`:290-296`) with `formatInvalidExportFormatText` (`runtime/history.ts:346-348`, one caller); `type: 'enum', options: ['html', 'md']` (as `GLOBAL_ARGS` does, `globalArgs.ts:90-99`) is validated by citty, reported by `runCli` as a usage error, and offered by shell completion (`runtime/completion/completionCommandTree.ts:61-63` reads enum `options`). Deleted: the check and the formatter.
  - (h) **`history show` reports one fact under two names.** `runtime/history.ts:188,198` binds `records.readResumable` to `checkpointPresent`, derives `resumable = config !== null && checkpointPresent` (`:210`), and the detail record carries both (`:226,240`); the text prints "(resumable)" and "Checkpoint: present" (`:391,437`). The listing's `resumable` (`:453`) is the harness's own `resumeFrom.kind === 'checkpoint'` (`packages/harness/src/agent/storage/runListing.ts:58`). Deleted: `checkpointPresent` (field and line). Owner decision: the `history show` JSON shape.
  - (i) **The recorded output destination is read by sync throwers, wrapped at one caller and not the other, under comments naming a field that is gone.** `runtime/headless/documentTaskOutput.ts:448-490` `resumeDocumentTaskOutputFile`/`Directory` decode `launch` with `decodeUnknownSync` and `throw new CliUsageError`; `resumeRun.ts:221-229` wraps each in `Effect.try`, `run.ts:355-356` calls them bare inside an `Effect.fn` (a throw there is a defect, reported as a crash), and both re-test `typeof … === 'string'` on values the schema already typed. `run.ts:353`, `:381` and `resumeRun.ts:214` call the record "the persisted `cli` block" and "`cli.expectedOutputFiles`"; the field is `launch` (`run.ts:219-233`). Fix: one `cliLaunchOutput` Effect that fails with `CliUsageError` and returns the absolute paths; both callers `yield*` it. Deleted: the two `Effect.try` wrappers, the redundant type tests, three false comments.
  - (j) **Optional members its one implementation always sets.** `CliRuntimeHost.prepareInteractivePrompt?` and `holdForPrompt?` (`runtime/headless/cliPresentationHost.ts:33-36`) are always defined by `createCliRuntimeHost` (`:113-114`), the only implementation (production and tests); callers write `?.()` (`executeCli.ts:221,260`). Deleted: two `?`, two `?.`.
- **Size:** about 120 lines, 15 files.
- **Risk / owner decision:** (f) and (h) change JSON output (owner); the rest none.

## Good modules here

- `runtime/platform/processSignals.ts` `holdSignals`: one owner of `process.on('SIG…')`, newest holder answers, release restores; every signal policy in the CLI (`initPlatform.ts`, `foregroundCommand.ts`, the chat's exit controller) is one call to it.
- `runtime/platform/foregroundCommand.ts` `runForegroundCommand`: the pager and self-update child over `ChildProcessSpawner`, with SIGINT held for the child under `acquireUseRelease` and the interrupt decided from the child's own exit. Small interface, real behavior.
- `runtime/platform/logSinks.ts`: `writeRawAndWait` wraps the stream callback once, `askCliQuestion` is an `acquireUseRelease` over readline that also answers end of input; nothing else in the slice touches `process.stdout` for writing.
- `runtime/headless/taskAttach.ts`: `tasks attach` feeds the service's frames into the same `WebviewSessions` graph the webviews run and prints what the view finishes; no state of its own beyond a printed count.
- `runtime/platform/initPlatform.ts` `CliPlatform`: one lazy, cached layer per command runtime; `leave` closes the platform scope before the runtime, in the order the comment states.
- `runtime/platform/loginShellEnv.ts`: one reader of the login shell's environment, scoped, timed out and killed as a group.
- `runtime/completion/completionCommandTree.ts`: completion derived from the citty tree, so a flag or enum option needs no completion edit (which is why CR-10 (g) wants `--export` as an enum).

## Considered and left alone

- The `{ json, ndjson, text }` triple at 38 `emitCliResult` call sites: K11's first item; CR-3 carries its registry and stamp half.
- `commands/_helpers/exitCode.ts` `pendingExitCode` and `root.ts:56` `routedArgs`: module slots forced by citty dropping a subcommand's return value; the one exit function is refused (`RT-cli-exit-code-one-function`).
- `runtime/platform/cliService.ts`, `commands/service.ts`, the service log sink (`service.ts:49-60`): `.agents/docs/proposed/architecture/2026-11-06-cli-service-root-causes.md` and `2026-11-15-host-rules-and-app-facts-with-two-owners.md` item 1.
- `runtime/headless/executeCli.ts`'s shutdown step and `Deferred`: F5 (landed, #14837) and its refused remainder.
- `runtime/headless/documentTaskInputs.ts`'s prepare/finish pair and `requireWorkspaceFiles`: LO-1.
- `CliStartupConfig`, `rootCommand` exports: LS-1c. `cliConfig.ts:237` `contextFromArgs` comment: LC-1c and open PR #14959.
- `commands/version.ts`'s own `TEXRA_OUTPUT_FORMAT` read: open PR #14959 moves it onto `defineCliCommand`.
- `strip-ansi` in `taskAttach.ts`, `terminalText.ts`, `ansiWrap.ts`: open PR #14953.
- `runtime/models/modelAccess*.ts`, `apiStatus.ts`, `tui/ui/glyphs.ts`, `KeyHints.tsx`, `runProgressRenderer.ts`: changed by open PRs #14949 and #14950; not audited past their open diffs.
- `CliRunStatus` (`schemas/cliOutput.ts:261-289`): the frozen headless vocabulary, left by the names lens.
- `runtime/models/validationModel.ts` in the production tree: the shipped bundle swaps in a stub (`scripts/stub-internal-validation-model.mjs`); the K11 split moved it under `models/`.
- `cliEnvValue` as a raw `process.env` read: the lint rule makes `cliContext.ts` the one reader on purpose (`oxlint.config.mts:190-194,265-269`); CR-10 (e) only removes the restated `envVar`.
- Two palettes, `tui/ui/colors.ts` (Ink names with light-background substitutes) and `runtime/terminal/style.ts` (picocolors, named colors only): picocolors cannot paint the hex substitutes, so a merge needs a second color library; no deletion without one.
- `tui/noColorOutput.ts`'s module signal `tuiColorEnabled`, set as the stream is wrapped and read by `ansiMarkdown.ts` and `TextInput.tsx`: chat-side readers (CC slice); the publish-once signal is the shape the TUI's other process facts use.
- `tui/ui/Select.tsx`'s `mode: 'multi'` with `selectedValues?`/`onToggle?` required only in that mode: one caller (`chat/tui/modals/UserQuestion.tsx:347`), in the chat slice.
- `bin/texra.ts` and `bin/texraServe.ts`: two entries with the same five-line skeleton; one shared helper would serve two callers and hide which entry runs.

## Summary

| Id | Title | Package | Flags | Size | Owner decision? |
| --- | --- | --- | --- | --- | --- |
| CR-1 | Commands re-read their own flags from raw argv with a hand-written scanner | cli | hand-written version of a library; repetition; non-obvious code | ~150 lines, 8 files | yes (accepted spellings) |
| CR-2 | Which commands are interactive is a name list consulted in three files | cli | special and general mixed; information leakage; option for a special case | ~60 lines, 5 files | yes (`chat --help` flags) |
| CR-3 | K11 remainder: NDJSON `ts`/`contract` stamp has five writers; kind registry is 33 copies of one struct | cli | repetition; non-obvious code | ~180 lines, 6 files | yes, small (`ts` meaning) |
| CR-4 | The headless run context is a rewritten `CliContext`; `quietLogs` means two things | cli | temporal decomposition; non-obvious code; derivable state; vague name | ~80 lines, 9 files | no |
| CR-5 | `CliContext.approvalPrompt` has no writer | cli | export with no consumer; option for a special case | ~20 lines, 2 files | no |
| CR-6 | The run-model candidate order is written twice | cli | repetition | ~30 lines, 3 files | no |
| CR-7 | Batched: options whose value the callee already holds | cli | option for a special case; pass-through variable | ~50 lines, 8 files | no |
| CR-8 | "Can this process run an Ink UI?" restated with drift in `init`, `config edit`, `config`'s route, the update check | cli | repetition; special and general mixed; non-obvious code | ~35 lines, 4 files | yes, small (`texra config` routing) |
| CR-9 | Exit codes decided per command: `report` sends a program's `CliUsageError` to `catchExitCode`; three helpers catch interrupts as failures | cli | repetition; false comment; silent degradation; special and general mixed | ~100 lines, 6 files | yes (exit codes) |
| CR-10 | Batched: launch-approval notice ×3, section keys, prompt streams, K4 latch, `envVar`, doctor redaction, `--export` enum, `checkpointPresent`, output-destination readers, optional host members | cli | repetition; option for a special case; shared mutable state; hand-written version; renderer repair; false comment | ~120 lines, 15 files | yes for (f), (h) |
