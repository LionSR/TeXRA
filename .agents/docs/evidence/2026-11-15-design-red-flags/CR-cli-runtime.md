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
