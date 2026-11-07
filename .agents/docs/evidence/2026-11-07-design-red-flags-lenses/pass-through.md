# Lens: pass-through variables and decorators (ch. 7)

**Read at:** main `03c2f51d5d480ca199b7192c687595d20aced5d7`. Read-only; the
only file written is this report.

**Scope.** `packages/*/src`, whole repo. The lens: a parameter, options bag
or context object that layers carry without using, only so it reaches one
deep reader; a wrapper or decorator that only forwards; an interface method
that restates the one below it. For each, the better carrier is a
`Context.Service` or `Context.Reference` the deep reader yields, or a value
captured where it is made.

**Method.** A TypeScript-AST scan of every production function (14,652
functions in 1,342 files) recorded each parameter's references and whether
each one is only a call argument. It also chained those parameters by callee
name to find multi-hop paths. A second scan listed class fields that are
stored only to be forwarded, and object literals and classes whose members
only forward. I then read the strongest candidates in full, and grepped every
symbol against the three evidence folders, the 2026-11-05 and 2026-11-07
architecture notes and `refuted-candidates.json`. Open PRs #14741, #14795,
#14796 and #14797 rewrite none of the files in findings 1 to 6. I listed
their changed files with `gh api …/pulls/N/files`.

## Numbers

Lines (`.ts`/`.tsx` under `src/`): harness 80,391; texra 82,852; cli 45,328;
extension 16,748; desktop 14,661; llm 12,029; trace-viewer 418.

Parameters whose every use is an argument to another call. This is an upper
bound: `x => f(x)` counts. The context-typed column is the one that matters,
and counts parameters typed `SettingsStores`, `WorkspaceRoots`, `CliContext`,
`StateStore`, `ConfigProvider`, `Context.Context`, `WorkspaceAgentsStores`,
`ProcessRuntime`, `Session` or `PluginEnv`.

| package   | functions | params | only-forwarded | context-typed | of which only forwarded |
| --------- | --------: | -----: | -------------: | ------------: | ----------------------: |
| cli       |     2,893 |  3,375 |    1,039 (31%) |           126 |                      65 |
| harness   |     4,555 |  5,784 |    1,925 (33%) |            95 |                      62 |
| texra     |     4,202 |  4,745 |    1,545 (33%) |            83 |                      55 |
| extension |     1,113 |  1,006 |      406 (40%) |            63 |                      35 |
| desktop   |     1,199 |    987 |      384 (39%) |             3 |                       0 |
| llm       |       660 |    774 |      264 (34%) |             0 |                       0 |

Pass-through by type (all packages): `SettingsStores` 71 of 90; `CliContext`
29 of 68 (30 of 71 counting `Pick<>`); `WorkspaceRoots` 25 of 59;
`StateStore` 22 of 34; `Context.Context` 17 of 17; `ConfigProvider` 15 of 20;
`WorkspaceAgentsStores` 11 of 11. 966 functions are single-call forwarders,
most of them host port adapters (see "Already settled").

Effect's own context carriers, production definitions. `Context.Reference`:
9, all in the harness. `Context.Service`: 54 harness, 15 texra, 3 desktop,
**0 cli, 0 extension, 0 llm**. Uses: `Effect.context<…>()` 11,
`Context.pick(` 8, `withProcessServices(` 23. The two host packages that
define no service of their own are the two with the most context-typed
forwarding per line.

Comment share of the files the findings centre on: `RunCall.ts` 37%
(127/343), `defineCliCommand.ts` 47% (100/209), `bbtClient.ts` 31%
(138/443), `executeAgent.ts` 25% (99/388), `sessionPrograms.ts` 23%
(66/280), `childLaunch.ts` 23% (57/247), `cliContext.ts` 23% (135/568).

On the whole the harness core is good under this lens. Its run-scoped facts
already travel as `SessionRoots`, `RunCall`, `ChildRuns` and `ToolContext`,
and it captures context through `Context.pick` (see "Good modules"). The
findings below are the places where that discipline stops: one field on the
run record, the SDK's session door, and the two host packages and one plugin
that never adopted it.

---

## Finding 1. The keys a launch brings ride on the run record, open to every plugin tool, only to reach a child's environment

**Red flags:** pass-through variable; overexposure (provider secrets on a
plugin-facing interface); two representations (the fiber's environment, and
a record field); a false comment.

**Hops:** 4 to the root run's reader and 7 to a child's, across 9 files.
**Deep reader:** `withApiKeys` (`packages/harness/src/agent/runtime/executeAgent.ts:253-268`),
which provides the run's `ProjectEnvironment` and `ConfigProvider`.

**Evidence.**

- The path into a root run: `StartInput.apiKeys`
  (`packages/harness/src/shared/session/runtimeRequest.ts:371`, also in
  `effect/sessions.ts:121`'s `ResumeInput`), then `sessionPrograms.start`'s
  `rootRun({ ...input, config, runId })` (`effect/sessionPrograms.ts:165`),
  then `rootLaunch.ts:144` `apiKeys: launch.apiKeys`, then
  `ExecuteAgentOptions.apiKeys` (`executeAgent.ts:73-76`), then
  `withApiKeys(options.apiKeys)` over the opening (`:328`) and again over
  the forked run (`:386`).
- The same keys are also copied onto the run record: `apiKeys:
  options.apiKeys` (`executeAgent.ts:230`) fills `RunLaunch.apiKeys`
  (`run/AgentRun.ts:118-120`). That record is the call's
  `ToolRun.apiKeys` (`RunCall.ts:168-170`). `ToolRun` is exported to plugin
  authors (`packages/harness/src/plugins.ts:186`). The field's only readers
  forward it:
  - `startChildRun`: `apiKeys: call?.run.apiKeys`
    (`delegation/childLaunch.ts:84`);
  - `resumeOwnedChild`: the same (`:110`);
  - `closeLeftoverRun`: `parent: Pick<RunLaunch, 'runId' | 'apiKeys'>`,
    then `resumeRun(run.id, { apiKeys: parent?.apiKeys })`
    (`leftoverChildren.ts:104,122`), then `ResumeRunOptions`
    (`resumeRun.ts:58-60`), then `executeAgent` (`resumeRun.ts:254`).
- No app tool reads `run.apiKeys` (0 hits in `packages/texra/src`), yet
  `RunCall.ts:144-147` says `ToolRun` holds "exactly the fields the app's
  tools read". That comment is false. There are 0 test references to
  `apiKeys` in `src/test-kernel` and `packages/*/test`, so neither the root
  path nor the child inheritance is pinned.
- Why the record field exists: the registry runs a child's opening "in the
  caller's fiber" (`runRegistry.ts:296-297`), but under `inSession`, which
  re-provides the workspace `.env` layer over it
  (`controllers/session/sessionOwners.ts:248-250`). That hides the parent's
  merged `ProjectEnvironment`. The run itself is forked on the context
  captured when the session was built (`FiberMap.runtime`,
  `sessionOwners.ts:236-238`), so it inherits nothing from the caller. The
  comment at `childLaunch.ts:70-72` says this. So the keys must travel
  separately, but they travel as a field on a record every tool sees, and
  every launch door has to remember to forward them.
- The one door that has no record to read them from drops them.
  `wakeRun` resumes a run for its queued input with `resumeRun(runId, {})`
  (`agent/followUp/ToolUseFollowUp.ts:122`). The service starts and resumes
  runs with the client's keys (`packages/texra/src/controllers/server/serviceSession.ts:610,628`,
  `packages/cli/src/commands/tasks.ts:250`), so a service run that is woken
  by its input resumes without them. I did not run this. It is the
  unknown-unknown this carrier invites. The design below does not fix it
  either: the wake fiber is the session's.

**The design decision behind it.** "Which provider keys does this run's
environment hold?" is answered twice: once by the fiber (`withApiKeys`) and
once by a field that every launch door must copy by hand.

**The better design.** One `Context.Reference` carries the keys, and the
deep reader yields it:

```ts
/** The provider keys the launch brought; none by default. */
export const LaunchKeys = Context.Reference<Readonly<Record<string, string>>>(
  '@texra-ai/harness/LaunchKeys',
  { defaultValue: () => ({}) },
);
```

1. `sessionPrograms.start` and `resume` provide it at the door:
   `Effect.provideService(LaunchKeys, input.apiKeys ?? {})`.
2. `executeAgent`'s opening reads `yield* LaunchKeys`. It runs in the
   caller's fiber, and neither the `.env` layer nor the captured session
   context holds this key. `Effect.provide(context)` merges
   (`node_modules/effect/dist/internal/effect.js:1366-1368`), so the
   caller's value survives `inSession`.
3. The opening applies `withApiKeys(keys)`. It returns
   `run.pipe(withApiKeys(keys), Effect.provideService(LaunchKeys, keys))`,
   so the value is captured where it is made, because the fork does not
   inherit it.
4. A child opened from the parent's tool call, and a leftover child resumed
   by `Effect.forkScoped` inside the parent's run, read the parent's value
   from their fiber.

**Deleted:**

- `ExecuteAgentOptions.apiKeys` (`executeAgent.ts:73-76`, 3 writers) and
  `:230`;
- `RunLaunch.apiKeys` (`AgentRun.ts:118-120`);
- `ToolRun.apiKeys` (`RunCall.ts:168-170`), which also takes the secrets off
  the plugin surface;
- `'apiKeys'` in `ResumeRunOptions` (`resumeRun.ts:60`, `:254`);
- `rootLaunch.ts:144`;
- `childLaunch.ts:84,110` and its comment at `:70-72`;
- `leftoverChildren.ts:104`'s `apiKeys` member and `:122`'s forward.

`StartInput.apiKeys`, `ResumeInput.apiKeys` and the service protocol's field
(`controllers/server/protocol.ts:215`) stay. They are the boundary's input.
`LaunchKeys` is not exported from `./plugins`.

**What we give up.** Nothing in behaviour. The design relies on the opening
running in the caller's fiber (`runRegistry.ts:296-297`), so a future change
that forks the opening would drop the keys without any error. One test that
starts a child under keys should come with the change; today none exists.
The wake path stays without keys, and is reported here so its owner can
decide.

**Change amplification.** "A new door that starts or resumes a run (a
scheduled child, a fork)": today it is one more `apiKeys: …` forward per
door (three exist, and the fourth, `wakeRun`, has none); after, 0.

**Depends on:** none. The files are round-2 package A's (child runs).

---

## Finding 2. `Sessions` hands the whole process context four calls down to read one service, beside an owner that nothing reads

**Red flags:** pass-through variable; a dead parameter; a false comment.

**Hops:** `services` goes through 4 hops in 5 functions in 2 files; `owner`
goes through 2 hops to no reader. **Deep reader:** `admitInput`'s
`Context.get(services, AgentCatalog).get(agent)`
(`packages/harness/src/effect/sessionPrograms.ts:109`).

**Evidence.**

- The capture: `makeSessions(yield* SessionOwner, yield* Effect.context<ProcessServices>())`
  (`effect/processLayer.ts:222-227`).
- `services` is then passed by `makeSessions` (`sessionPrograms.ts:251`) to
  the `sessionFor` closure (`:254-256`), then to `sessionOf(session,
  services, owner)` (`:232`, used only at `:239`), then to `start(session,
  services, owner, input)` (`:141`, used only at `:145`), then to
  `admitInput(input, session, services: Context.Context<AgentCatalog>)`
  (`:100`), which reads one service at `:109`.
- `owner` is a parameter of `start` (`:142`) that its body never mentions
  (`:139-181`). `sessionOf` takes it (`:233`) only to hand it to `start`.
  The live uses are all in `makeSessions`' own closure (`:264,275-277`).
- The comment at `:247-248` says "`services` is the process's context,
  which every run's fiber is provided". It is not provided here: `start`
  provides only `session` (`:166`). Runs get the process services from the
  capture in `controllers/session/sessionOwners.ts:229-238`. A reader who
  trusts the comment looks in the wrong file.

**The design decision behind it.** "What does a launch check need from the
process?" One service. The code answered "everything, in case".

**The better design.** Capture the value where the layer is built:
`makeSessions(yield* SessionOwner, yield* AgentCatalog)`. Then
`sessionOf(session, catalog)`, `start(session, catalog, input)`, and
`admitInput(input, session, catalog)` with `catalog.get(agent)`.

**Deleted:**

- `Effect.context<ProcessServices>()` (`processLayer.ts:225`);
- the `owner` parameters (`sessionPrograms.ts:142,233`);
- three `Context.Context<ProcessServices>` parameters, each now a catalog;
- the false sentence at `:247-248`;
- the `ProcessServices` type import.

`makeSessions` has one caller and no test references.

**What we give up.** Nothing.

**Change amplification.** "Change which context a run's fiber runs on":
today a reader is pointed to `sessionPrograms.ts` (the comment) and to
`sessionOwners.ts` (the code); after, one file.

**Depends on:** none. `effect/` is the public-surface package's area (R3-Q,
E's second PR).

---

## Finding 3. `CliContext` is a parameter of 71 CLI functions, and 30 of them only forward it to the output and prompt readers

**Red flags:** pass-through variable; information leakage (the output format
is read in 22 places); a decorator that only forwards.

**Hops:** 3 to 4, from `contextFromArgs` to `defineCliCommand` to a
command's `run` to its helpers to the reader. 30 forwarding functions in 16
files, plus 37 `run: (context, ctx) =>` lambdas. **Deep readers:**
- `emitCliResult` and `emitPagedCliResult` (`commands/_helpers/output.ts:39-64,74`),
  which read `.outputFormat`;
- `cliProgressWriter` (`:17-21`);
- `shouldUseSubscriptionDeviceCode` (`runtime/subscriptionLogin.ts:39-48`);
- `askCliApprovalQuestion` (`runtime/approval/approvalPrompts.ts:61-70`),
  which reads `.approvalPrompt`;
- `initCliPlatform` (`runtime/initPlatform.ts:245-387`).

**Evidence.**

- `CliContext` is decided once from argv (`runtime/cliContext.ts:55-58`,
  "decided once at build"; `:70-77`, "a flag is exactly the kind of fact a
  layer-build capture is for: it cannot change mid-process"). It is built
  once per command (`commands/_helpers/defineCliCommand.ts:124-130`) and
  handed to `run(context, ctx)` (`:66-69`). From there it is a value.
- Functions that only forward it (the scan's list):
  - `agents.ts`: `emitCopyResult` (`:97-111`, used only to reach
    `emitCliResult`), `customizeAgent`, `resetAgent` and `keepAgent`
    (`:119,145,175`, which forward to `initCliPlatform` and
    `emitCopyResult`);
  - `config.ts:64,96`;
  - `history.ts:43`;
  - `memory.ts:20,37`;
  - `models.ts:89,164,190`, and `initModelCommandPlatform` (`:152-160`), a
    wrapper that forwards it to `initCliPlatform`;
  - `tasks.ts`: `serviceClient` (`:86-93`) and `requestTask` (`:96`);
  - `team.ts:91,108`;
  - `service.ts:76,164`;
  - `init.ts:110`;
  - `workflow.ts:248`;
  - `subscriptionAuthCommand.ts:71`;
  - `approvalPrompts.ts:55,115,122` and `approvalAdapter.ts:61`;
  - `modelAccessSelection.ts:220`.
- The context object also serves as a key: `cliPromptLanes = new
  WeakMap<CliContext, PerKeyLane>()` (`approvalPrompts.ts:50-57`), "one
  prompt lane per CLI context: a single stdin". A process fact is reached
  through the identity of a value that every caller must hold.
- `.outputFormat` is read in 22 places across 16 files, so a new format or
  TTY rule is spelled in each.
- The TUI carries it as a field too (`chat/tui/commands/handlers/slashContext.ts:26`),
  and `runChat(runtime, context, …)` reads it 17 times
  (`chat/tui/runChatTui.tsx:155`).
- Found, not repeated: K4 (round 2, `K-cli.md:361-399`) turns
  `initCliPlatform` into a `CliPlatform` service of a per-command runtime,
  which removes the 32 `initCliPlatform(context)` calls. This finding is the
  other half: the context still travels to the output, progress, prompt and
  TTY readers after K4.

**The design decision behind it.** "How does this invocation talk to the
terminal?" is a per-process fact. It is passed as data, so each helper on
the way must take it.

**The better design.** One service, provided at the edge that builds the
context:

```ts
export class CliInvocation extends Context.Service<CliInvocation, {
  readonly context: CliContext;
  /** `emitCliResult`'s body, with the format captured. */
  readonly emit: (result: CliResult) => void;
  readonly emitPaged: (result: CliResult) => Effect.Effect<void>;
  /** `cliProgressWriter`'s choice, made once. */
  readonly progress: (text: string) => void;
  /** The one stdin's lane. */
  readonly onPromptLane: <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}>()('@texra-ai/cli/CliInvocation') {}
```

`defineCliCommand` runs `program.pipe(Effect.provideService(CliInvocation,
invocationOf(context)))`. With K4, it is `Layer.succeed(CliInvocation)(…)`
in the same per-command runtime. `texra doctor`, the one command that
cannot use `defineCliCommand`, provides it itself. Helpers write `const {
emit } = yield* CliInvocation`, and `emit` stays synchronous.

**Deleted:**

- the `context` parameter of the 30 forwarding functions above;
- `Pick<CliContext, 'outputFormat'>` in `emitCliResult`,
  `emitPagedCliResult` and `cliProgressWriter`;
- `initModelCommandPlatform`'s forward;
- `cliPromptLanes` and `onCliPromptLane`, whose lane becomes a field built
  with the invocation (still `withPerKeyLane`, per
  `EFF-ADOPT-per-key-lane-semaphore`);
- with K4, the 32 `initCliPlatform(context)` arguments.

The builder keeps its `context` argument only for the synchronous argv
refusals it throws before any runtime exists (`defineCliCommand.ts:51-65`).

**What we give up.** Command helpers gain `CliInvocation` in `R`. 11 test
files name `CliContext`, and they provide a test invocation instead. The Ink
tree's `runChat` keeps the value. That edge is React's, and K's
`RuntimeContext` covers it.

**Change amplification.** "A new output format, or a new rule for where
progress goes": today the 22 `.outputFormat` reads in 16 files; after, the
invocation's builder. "A new helper in a command that prints a result":
today a `context` parameter threaded from `run`; after, `yield*
CliInvocation`.

**Depends on:** lands with K4 (package 8.1, round-3 row R21, owner F), or
alone before it with `Effect.provideService` at the edge.

---

## Finding 4. Log channels are passed as strings through helpers, a port and two options, though the fiber's log annotation already carries them

**Red flags:** pass-through variable, across three packages; a port member
whose only job is to forward a string.

**Hops:** up to 5. One path is `signInWithSubscription(stores, channel, …)`
→ `vscodePresenter(provider, channel)` → `showLoggedErrorMessage(channel)`
→ `showLoggedMessage(channel)` → `announce(channel)` → `withLogChannel`.
Another is `texraProcessLayer` → `AgentDirectoryService` → `reportIssue` →
`agentIssues(channel, …)` → `showLoggedMessageWithDocs(channel)` →
`withLogChannel`. **Deep reader:** `withLogChannel`, which is
`Effect.annotateLogs(self, { [LOG_CHANNEL]: channel })`
(`packages/harness/src/logger/effectLog.ts:20-23`).

**Evidence.**

- The harness states the rule: code "names its channel once for the whole
  program rather than threading a channel string through every helper"
  (`effectLog.ts:3-5`). And: "Annotations nest, so a callee that names its
  own channel keeps it: this sets the channel for the entries that don't"
  (`:17-19`).
- The extension's notice helpers take the channel as their first
  parameter: `announce` (`packages/extension/src/frontend/ui/errorHandlingUtils.ts:27-38`),
  `showLoggedErrorMessage` (`:48-71`), `showLoggedMessage` (`:78-85`),
  `showLoggedInfoMessage` (`:88-94`) and `showLoggedMessageWithDocs`
  (`:97-125`). They have 13 + 15 + 16 + 20 call sites in 10, 12, 9 and 7
  files. Further down the same chain:
  - `safeExecuteCommand(…, channel = DEFAULT_CHANNEL)`
    (`frontend/system/commandUtils.ts:54-66`, 6 calls);
  - `invokeLatexWorkshopBuild(uri, channel, …)`
    (`frontend/latex/openBuild.ts:97-108`, 2);
  - `vscodePresenter(provider, channel)` and `signInWithSubscription(stores,
    channel, …)` (`frontend/auth/subscriptionSignIn.ts:59-61,138-141`);
  - `promptExtensionInstall`'s `opts.channel` (`frontend/ui/instruction.ts:95-103`);
  - `BundledViewContentProvider.channel`, a field stored only to forward to
    `withLogChannel` (`common/webview/BundledViewContentProvider.ts:74`).
- The channel also crosses package lines. The app's process-layer option
  `agentIssues: (channel, message, docsId) => …`
  (`packages/texra/src/controllers/texraProcessLayer.ts:64-70`) exists so
  that `agentIssues(AGENT_LOAD_CHANNEL, message, docsId)` (`:129-133`)
  reaches `showLoggedMessageWithDocs` (`packages/extension/src/extension.ts:152`).
  The harness's `AgentDirectoryService` takes `channel: string` as an
  option (`agent/index/AgentDirectoryService.ts:49`). It has one writer, a
  constant (`texraProcessLayer.ts:125`), and the class re-applies it at
  every log (`:92,163,179,198`).
- In the harness, `ExecuteCommandBaseOptions.channel?`
  (`utils/system/execUtils.ts:154`) is used as `options.channel ?? CHANNEL`
  (`:467`). Eight callers pass their own constant:
  - `img.ts:132,222,279`;
  - `grep.ts:166`;
  - `texcount.ts:104`;
  - `texfmt.ts:24`;
  - `latexindentpt.ts:131`;
  - the extension's `latexCommands.ts:35,71,118`.

  The pass-through exists because the callee names a channel and so
  overrides the caller's. The same pattern holds in `texTools.ts:29,191`.

**The design decision behind it.** "Which channel does this line belong
to?" is a fact of the program the line runs in. Effect carries it in the
fiber's log annotations. These helpers asked their callers instead.

**The better design.** The helpers name no channel. Each program names one
at its entry with `withLogChannel(CHANNEL)` (`Effect.annotateLogs`,
`Effect.d.ts:19258`; `annotateLogsScoped`, `:19448`, for a scope). The
guard that already wraps a command, `activeFileGuards.ts:116-140`, is such
an entry: its `channel` option is the one naming and it stays.
`executeCommand` and `compileLatex2Pdf` stop naming a channel, so their
lines inherit the caller's. `AgentDirectoryService` uses a module constant,
and the reporter's call runs inside it.

**Deleted:**

- the `channel` parameters of the 5 helpers in `errorHandlingUtils.ts`,
  `safeExecuteCommand`, `invokeLatexWorkshopBuild`, `vscodePresenter`,
  `signInWithSubscription` and `promptExtensionInstall`;
- `BundledViewContentProvider.channel`;
- the `channel` parameter of `agentIssues` (port);
- `AgentDirectoryService`'s `channel` option;
- `ExecuteCommandBaseOptions.channel`;
- `texTools`' `channel` option;
- about 75 call-site arguments.

`writeLogLine(channel, …)` (`logSink.ts:169-180`) stays: it serves the
fiberless sites.

**What we give up.** A line from a helper called outside any named program
prints without a channel prefix (`logSink.ts:123-124`) until its entry names
one. No caller today logs a helper's lines under a channel other than its
own.

**Change amplification.** "Rename a module's channel": today the constant,
plus every string argument that repeats it (for example 8 of
`showLoggedMessage(CHANNEL`); after, one `withLogChannel`. "A new notice
helper": today a `channel` first parameter and its threading; after, none.

**Depends on:** none. The `executeCommand` part touches the file of M10
(round 2), which deletes `ExecuteCommandBaseOptions.settings` there: one PR
for both options is the smaller diff.

---

## Finding 5. The Zotero port goes through every Zotero tool's program to reach the URL builder

**Red flags:** pass-through variable; a decorator (`withZoteroPort`) that
reads one value only to pass it down.

**Hops:** 4, for example `withZoteroPort` → `addItems` → `addItem` →
`callZoteroConnector` → `zoteroUrl`. 5 files. **Deep readers:** `zoteroUrl`
and `zoteroUnreachableError` (`packages/texra/src/tools/zotero/bbtClient.ts:66-75`).

**Evidence.**

- `withZoteroPort` (`bbtClient.ts:43-63`) reads `Settings.get(call.env.roots,
  ZOTERO_PORT_KEY)` off `ToolContext` and hands the number to each tool's
  program: `ZoteroAddTool.ts:251`, `ZoteroCollectionsTool.ts:222`,
  `ZoteroSearchTool.ts:207` and `ZoteroExportTool.ts:87`. Its comment says
  "the port is the only thing these tools need from the call".
- The programs do not use it themselves; they pass it on:
  - `addItems` passes it to `checkZoteroRunning(port)` and `addItem(item,
    port, …)` (`ZoteroAddTool.ts:208-217`);
  - `addItem` passes it to `callZoteroConnector(…, port)` (`:183-205`);
  - `listCollections` passes it to `callBetterBibTeX(…, port, …)`
    (`ZoteroCollectionsTool.ts:147-154`);
  - `searchZotero` does the same (`ZoteroSearchTool.ts:139-176`), and so
    does `exportEntries` (`ZoteroExportTool.ts:46-60`).
- The transports take it as a parameter only to build a URL and an error:
  `callBetterBibTeX` (`bbtClient.ts:273-292`), `checkZoteroRunning`
  (`:339-348`) and `callZoteroConnector` (`:401-440`), plus their
  classifiers `bbtRequestError` (`:233-259`) and `connectorRequestFailure`
  (`:353-372`).
- The plugin's availability probe spells the URL grammar a second time:
  `` `http://127.0.0.1:${port}/…` `` (`plugin.ts:72,80`) beside `zoteroUrl`
  (`bbtClient.ts:66-68`).
- 0 test references to `withZoteroPort` or to the three transports.

**The design decision behind it.** "Where is Zotero?" is a fact of the call
(its project's setting). The call is already in the fiber as `ToolContext`
(`agent/core/tools/ToolTypes.ts:223`, part of `PluginToolServices`). The
code read it at the top and threaded the answer down.

**The better design.** The deep reader yields the service. The three
transports open with `const port = yield* zoteroPort`, where `zoteroPort =
Effect.flatMap(ToolContext, (call) => Settings.get<number>(call.env.roots,
ZOTERO_PORT_KEY))`, and their classifiers take the port from them. The
probe builds its URLs with `zoteroUrl`.

**Deleted:**

- `withZoteroPort` (1 definition, 4 uses);
- the `port` parameter of the 5 tool programs and the 3 transports;
- the probe's second URL spelling.

This lands with H's batched merge of the two classifiers
(`H-app-tools.md:718-722`).

**What we give up.** One settings read per request instead of per call. It
is a synchronous `config`-slot read (`shared/config/settings.ts:225-238`),
and an `add` of N items makes N of them.

**Change amplification.** "A fifth Zotero tool": today `withZoteroPort` and
a `port` parameter on each helper it calls; after, the program alone.

**Depends on:** none.

---

## Finding 6 (smaller). The agent catalog's per-workspace methods take the stores and restate `workspaceAgents(stores)`

**Red flags:** interface methods that restate the one below; conjoined
method (one branch of `visible` reads no store at all).

**Hops:** 4 in one file: `forLaunch(stores)` → `resolve(stores)` →
`visible(stores)` → `workspaceAgents(stores)` → `new
WorkspaceAgentsController({ repoState, globalState })`. **Deep reader:** the
controller's selection read.

**Evidence.**

- `AgentCatalogShape` has three per-workspace members:
  - `visible(stores, scope?)` (`agent/index/agentCatalog.ts:109-112`);
  - `forLaunch(stores, identifier, source?)` (`:118-125`);
  - `workspaceAgents(stores)` (`:127-129`).

  `visible` without a scope is `workspaceAgents(stores).getVisibleAgents()`
  (`:271-286`). With a scope, it is a catalog lookup that ignores `stores`
  (`:275-283`).
- Internally, `resolve` takes `stores` only to call `visible` (`:288-304`).
  `forLaunch` takes them only for `resolve` (`:358-370`). A new controller
  is built on every call (`:263-269`).
- Consumers: `.visible(` 9, `.forLaunch(` 5, `.workspaceAgents(` 6, in 15
  files across 4 packages.

**The better design.** One per-workspace door, `catalog.workspaceAgents(stores)`,
a view built once by its holder with the stores captured. It carries
`visible()` and `forLaunch(identifier, source?)`. The store-free scoped
branch becomes `catalog.pinned(scope)`. `visible` and `forLaunch` leave the
catalog's interface, and `resolve`/`visible` lose their `stores`. After M8
(round 2), `WorkspaceAgentsStores` loses `globalState` (`AppState`), so the
view captures only `repoState`.

**What we give up.** A caller of a single read writes
`catalog.workspaceAgents(roots).visible()` instead of
`catalog.visible(roots)`.

**Change amplification.** "A new per-workspace read": today one more
`(stores, …)` member and its internal threading; after, a method on the
view.

**Depends on:** sits best after M8's `globalState` removal.

---

## Found by earlier rounds; this lens's new angle only

- **M8 (round 2): the global state store as a `WorkspaceRoots` field
  beside `AppState`.** The extension threads it by hand in four ways:
  - `Effect.map(AppState, createVscodeLeanLanguageServices)`
    (`packages/extension/src/extension.ts:144`) passes the store 5 hops:
    `executeFileCommand`, `sendPositionRequest` or `executeProjectCommand`
    (`frontend/lean/VscodeIntegration.ts:229-243,313-324,455-464`), then
    `getClientProvider` (`:267-275`), then `promptExtensionInstall`, then
    `showInstructionWithSuppress` (`frontend/ui/instruction.ts:27-44,95-104`).
  - `withProcessServices(runtime, initializeLatexSupport(roots.globalState))`
    (`extension.ts:398-402`) passes it as an argument to a program that
    already runs over `AppState` (`frontend/setup.ts:16-17,57`).
  - `ProgressViewProvider` takes both `globalState` and `roots`, which
    carries the same store (`progressView/ProgressViewProvider.ts:139-158`).
    It hands both to `createAgentPresentationHost`, which threads it 2 more
    hops (`frontend/events/agentEventListeners.ts:115-140,224-247`).
  - It also reaches `createExtensionHostRequests` (`options.globalState`
    beside `options.roots`, `progressView/extensionHostRequests.ts:112,202,418,432`).

  Under M8 these become `yield* AppState` in `showInstructionWithSuppress`
  and in the onboarding writers. 12 parameters and fields go.
- **M10 (round 2): `ExecuteCommandBaseOptions.settings` exists for one git
  identity read.** The hop counts M10 did not give:
  - `getTeXCountStats` → `getTeXCount` → `getIndividualCounts` →
    `runTexcount` → `runTool` → `executeCommand` → `gitAuthorEnv`
    (`packages/texra/src/latex/texcount.ts:93-108,133-162,187-209,265-271`;
    `utils/system/execUtils.ts:79-105`). That is 6 hops for a spawn that
    never commits.
  - `gitReads.ts:30-102` has 6 functions, each taking `settings` only for
    `gitValue`.
  - `workspaceInfo.ts:63-66,111-118`, `repositoryOverview.ts:46-60,89` and
    `grep.ts:163-165` do the same, and 17 sites pass `settings: undefined`.
- **K4 (round 2):** the `initCliPlatform(context)` half of finding 3.
- **D (round 1, `D-model-call.md:588-589`):** `ModelInvoker.call`
  re-provides `UsageLog` and `RouteRetries` that it took from the same
  context (`ModelInvoker.ts:941-942`).
- **G5 (round 2):** `hostRunActions`' pass-through ports and the
  `runAgentRequest` → `startAgentRequest` → `runValidated` options chain
  (`controllers/session/hostRunActions.ts:224-279`). #14796 also touches
  this file.
- **F (round 1):** `CliRunReads`' forwarding (`F-hosts.md:349-351`) and
  `answerShared`'s 14-member binding bag (`openGuiWindow.ts:450-474`).
- **O (round 2, `O-llm-providers.md:226`):** the oauth providers'
  pass-through exports.
- **T8 (round 3):** the extension command map forwarding to an actions
  record (`commands.ts:73-110`).
- **Q (round 3, `Q-public-surface.md:632`):** `Run.interrupt` forwards to
  `run.stop`.

## Good modules in this area

- **`SessionRoots`** (`packages/harness/src/platform/rootedFs.ts:27-31`): a
  session's roots as a service the run loop yields (31 `yield*
  SessionRoots` sites), not as a parameter of every step.
- **`RunCall` and `ChildRuns`** (`agent/runtime/RunCall.ts:265`,
  `agent/runtime/ToolServices.ts:163`): `Context.Reference`s with defaults
  that a plugin tool reads instead of being handed. They are the model for
  finding 1.
- **`ProjectEnvironment` and `CommandDirs`** (`utils/system/nodeWorkspace.ts:65-67`,
  `utils/system/platformPaths.ts:37`): references with sensible defaults.
- **`Context.pick` at the capture points**: `tools/liveTools.ts:153`,
  `controllers/session/SessionRequests.ts:66-68`,
  `agent/runtime/loop/runProgram.ts:88`, `agent/runtime/ToolServices.ts:144`.
  Each forwards only the services its program needs, as the root
  `AGENTS.md` asks.
- **`ToolContext`'s provision at dispatch**
  (`agent/runtime/loop/toolUseDispatch.ts:541-555`): `ToolContext`,
  `ChildRuns` and `RunCall` are provided once per call, so no tool takes its
  call as a parameter. Finding 5 extends this down to the Zotero transport.

## Already settled, left alone

- **`SettingsStores` and `WorkspaceRoots` passed as data** (71 + 25
  only-forwarded parameters). This is Ousterhout's own remedy for
  pass-through variables, a context object (ch. 7.5). The repo chose it on
  purpose: "a setting answers for the stores the caller holds as data … the
  value answers for that project rather than for whichever roots the
  calling fiber happens to carry" (`packages/harness/src/shared/config/settings.ts:17-23`).
  The root `AGENTS.md` says the same ("Carry the workspace root as data from
  its holder"). A process holds several projects (desktop, the service).
  Inside a session's fiber the harness already yields `SessionRoots` at the
  top. The long CLI chains of `stores` (`loginCommands.ts:61-157`,
  `modelAccessSelection.ts:58-220`) are this design, not a defect of it.
- **`withProcessServices`** (`effect/processLayer.ts:82-89`). It re-provides
  the whole runtime context, but that context is exactly `ProcessServices
  | Sessions`, and Q lists it as a good module (`Q-public-surface.md:722`).
- **The usage log's `config` and `env` on every entry**
  (`agent/runtime/run/pricing.ts:70-105`,
  `packages/texra/src/telemetry/UsageLogService.ts:110-118,265-290`).
  These are values captured where the entry is made, so the consent can be
  read again at flush and entries queued before an opt-out can be dropped.
  They are not pass-through.
- **`ExecutionsTool`'s `RunToolContext`** (`tools/ExecutionsTool.ts:77-81`):
  a two-field context object built once per call.
- **Host port adapters** (`desktop/src/main/desktopWindowHost.ts:257-300`,
  `desktopProjectSurface.ts:100-160`, `extension/src/frontend/hosts/VscodeUiHost.ts`).
  Most of the 966 single-call forwarders are here, and each adds a project
  name, a report-instead-of-raise, or the VS Code call. They were audited in
  N (round 2).
- **`rootedFileSystem`** (`utils/files/rootedFileSystem.ts:217-305`): a
  decorator whose forwards each add root confinement.
- **`Scope` parameters** (8 only-forwarded: `createAgentPresentationHost`,
  `cliServiceProjects`, `leanServerPool.lease`, …). Passing the scope that a
  program must outlive its caller in is how `Effect.forkIn` and
  `Effect.provideService(Scope.Scope, scope)` are meant to be used.
- **`withPerKeyLane` in finding 3's prompt lane** stays a lane, not a
  `Semaphore` (`EFF-ADOPT-per-key-lane-semaphore`).

## Effect-native mapping (checked against `node_modules/effect` 4.1.2 `.d.ts`)

| #   | Today                                                                                   | Effect-native                                                                                       | API (file:line)                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `apiKeys` on `RunLaunch` and `ToolRun`, forwarded at 3 launch doors                       | `LaunchKeys` `Context.Reference` (default `{}`), read in the opening, re-provided on the forked run | `Context.Reference` (`Context.d.ts:1741`, interface `:395-400`); `Effect.provideService` (`Effect.d.ts:12173`); `Effect.provideContext` merges (`internal/effect.js:1366-1368`); the fork's captured context: `FiberMap.runtime` (`FiberMap.d.ts:1140`); `Effect.forkScoped` inherits (`Effect.d.ts:17216`) |
| 2   | `Effect.context<ProcessServices>()` threaded through 4 calls, and an unread `owner`       | `yield* AgentCatalog` once in the layer; the shape captured                                         | `Layer.effect` (`Layer.d.ts:1166`, effect run in the layer's scope); `Context.Service` (`Context.d.ts:196`)                                                                                                                                                                       |
| 3   | `CliContext` parameter on 71 functions; a `WeakMap` keyed by it                          | `CliInvocation` `Context.Service`, provided at `defineCliCommand` (or as a layer of K4's runtime)   | `Context.Service` (`Context.d.ts:196`); `Effect.provideService` (`Effect.d.ts:12173`); `Layer.succeed` (`Layer.d.ts:839`)                                                                                                                                                         |
| 4   | channel strings through 10 helpers, 1 port and 3 options                                 | the fiber's log annotation, named once per program                                                  | `Effect.annotateLogs` (`Effect.d.ts:19258`), `Effect.annotateLogsScoped` (`:19448`), via `withLogChannel` (`effectLog.ts:20-23`)                                                                                                                                                  |
| 5   | the Zotero `port` through 8 functions                                                    | the transport yields `ToolContext` and reads the setting                                            | `Context.Service` `ToolContext` (`agent/core/tools/ToolTypes.ts:223`); `Effect.flatMap`                                                                                                                                                                                           |
| 6   | `stores` on three catalog members                                                        | a per-workspace view value, built once by its holder                                                | none (a plain value)                                                                                                                                                                                                                                                              |

`ConfigProvider.ConfigProvider` is itself a `Context.Reference`
(`ConfigProvider.d.ts:332`), which is why `withApiKeys`'s
`Effect.updateService` (`Effect.d.ts:11986`) works over the run's fiber
today, and why finding 1 needs no new mechanism.
