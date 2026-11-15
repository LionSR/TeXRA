# Lens: shallow modules, pass-through, overexposure (LS)

Read at `cb22acd`. Covered: `packages/{harness,texra,llm,cli,desktop,extension,trace-viewer}/src`
(1338 production files, 4829 `export` declarations), with `packages/*/test`,
`packages/*/tests`, `src/` and `scripts/` counted separately as test consumers.

## Method and numbers

Every `export const|function|class|interface|type` declaration was listed and
its importers counted by name over every `import { … }`, namespace member
access, dynamic `import()` destructuring and `export { … } from` in the tree.
A name that only a side-effect import registers (Lit custom elements) or that
`import()` destructures (`runChat`, `runConfigTui`, the llm wire models) is
not counted as unconsumed.

| Package      | Exports | No production importer, not an entry re-export | One production importer |
| ------------ | ------- | ---------------------------------------------- | ----------------------- |
| harness      | 1864    | 14                                             | 820                     |
| texra        | 1502    | 65 (41 are custom-element classes)             | 713                     |
| cli          | 833     | 13                                             | 481                     |
| llm          | 275     | 11 (7 are dynamic-import targets)              | 125                     |
| desktop      | 212     | 4                                              | 139                     |
| extension    | 135     | 22 (20 are custom-element classes)             | 70                      |
| trace-viewer | 8       | 0                                              | 8                       |

Re-export statements: 180, all in the documented entries
(`packages/harness/src/{index,host,plugins,node,schemas,transcriptEntry}.ts`,
`shared/schemas/index.ts`, `packages/llm/src/{index,node}.ts`,
`packages/texra/src/ui/styles/index.ts`). No shim or convenience barrel was
found outside them.

The "exported only for a test" species is already recorded
(`2026-11-07-design-red-flags-round-5-tests/2-code-for-tests.md`) and is not
repeated: `decodeXmlEntities`, `LocalRuntimeStateSchema`, `SessionViewUpdater`,
`STORE_HELD_MESSAGE`, `RunRegistryInit`, `ResumeRunOptions`, `judgeFailure`,
`BuildCliContextInit`, `runHeadlessAgent`, `DESKTOP_PROJECTS`, `GitCloneFailed`,
`FLUSH_INTERVAL`, `injectStandaloneTrace`, `GitHubRateLimitError`,
`ownFactsChecked` (T, round 6).

## Findings

### LS-1a: harness exports that nothing imports, in production or tests

- **Package:** harness
- **Flags:** overexposure; an export with no consumer
- **Evidence:** each has zero importers anywhere; every use is in its own file.
  - `shared/session/runRowsShape.ts:117` `export interface TakenFollowUp` (used at `:65` only).
  - `shared/session/inFlight.ts:29` `export type Failure` (6 in-file uses).
  - `controllers/session/readSessionView.ts:67` `export const readSessionView`; the one call is `:133` in the same file. `index.ts:46`, `effect/sessionPrograms.ts:26` and `effect/processLayer.ts:26` import other names from the file.
  - `agent/runtime/runRegistry.ts:172` `export interface Launch`.
  - `agent/followUp/Inbox.ts:74` `export type Sent`.
  - `agent/storage/runLifecycle.ts:208` `export const deliveryId`; called at `:232` only. Every other `deliveryId` in the tree is the `Inbox` field of the same name (`Inbox.ts:67`, `followUpMessages.ts:37`).
- **Better design:** drop the `export` keyword on each. `readSessionView` the file is then one public reader (the project view) over a private one.
- **Deleted:** 6 exports.
- **Size:** 6 lines, 5 files.
- **Risk / owner decision:** none. The harness declaration build inlines a local type used in an exported signature; check `config/api-reports/*.api.md` regenerates without a `(undocumented)` forgotten-export warning for `Launch` and `Sent`.

### LS-1b: app exports that nothing imports

- **Package:** texra
- **Flags:** overexposure; an export with no consumer
- **Evidence:** zero importers anywhere.
  - `shared/session/sessionFrames.ts:54` `export type EventInput = typeof EventInputSchema.Type` has no use at all, in or out of the file: a dead type.
  - `shared/constants/latexToolchain.ts:491` `MissingLatexTool` (return type at `:505` only).
  - `controllers/server/client.ts:151` `compatible`, `:374` `ensureService`, `:522` `followed`: called at `:173,179,460`, `:619`, `:556` of the same file and nowhere else.
  - `agent/export/loadChatExportInput.ts:38` `ChatExportInputUnreadable`, `:54` `ChatExportLoadResult`; `agent/export/schemas.ts:42` `ChatExportInputSchema` (only its `.Type` alias at `:48` is imported).
  - Tagged errors caught by tag string, never imported: `controllers/server/serve.ts:70` `ServiceAlreadyRunning` (`cli/src/commands/service.ts:117` uses `Effect.catchTag('ServiceAlreadyRunning', …)`); `tools/github/githubClient.ts:31,50` `GitHubAuthError`, `GitHubPermanentError`.
- **Better design:** delete `EventInput`; make the rest file-local. `client.ts` then exports what a host writes against (`linkService`, `isOlder`, `isNewer`, the service info readers), not its internals.
- **Deleted:** 1 type, 10 exports.
- **Size:** 12 lines, 6 files.
- **Risk / owner decision:** none. `GhPullRequest` (`tools/github/prTypes.ts:125`, also unused) is in `nonobvious-code.md` and is left to that row.

### LS-1c: CLI and llm exports that nothing imports

- **Package:** cli (4), llm (2)
- **Flags:** overexposure; an export with no consumer
- **Evidence:**
  - `cli/src/runtime/platform/cliConfig.ts:104` `CliStartupConfig` (return type at `:243`; `cliContext.ts:102` names it in a comment).
  - `cli/src/chat/tui/input/draftAttachments.ts:28` `PastedImageEntry`.
  - `cli/src/chat/tui/state/subscribeApprovals.ts:75` `TuiHostInteractions`.
  - `cli/src/commands/root.ts:67` `rootCommand`: 6 uses, all in `root.ts`.
  - `llm/src/oauth/oauthRequest.ts:27,43` `OAuthNetworkError`, `OAuthUnexpectedResponse`: matched by tag at `oauth/xai/xaiOAuthClient.ts:94` and `oauth/SubscriptionOAuthCoordinator.ts:58`.
- **Better design:** drop `export`.
- **Deleted:** 6 exports.
- **Size:** 6 lines, 5 files. PR #14959 changes `cliConfig.ts`; land after it or in it.
- **Risk / owner decision:** none.

### LS-2: two desktop services exist to carry two arguments across one call

- **Package:** desktop
- **Flags:** shallow module; pass-through; an interface with one implementation that adds only a name
- **Evidence:** `main/desktopProjects.ts:147-150` declares `class DesktopProjects extends Context.Service<DesktopProjects, DesktopProjectRegistry>`; `main/desktopAttention.ts:37-40` declares `DesktopAttentionPort`. Each is provided once and read once, and the provide wraps the read directly:
  - `main/index.ts:226-235`: `followDesktopAttention.pipe(Effect.provideService(DesktopProjects, registry), Effect.provideService(DesktopAttentionPort, electronAttentionPort({ … })))`.
  - `main/desktopAttention.ts:107-108`: `const projects = yield* DesktopProjects; const port = yield* DesktopAttentionPort;`.
  - No other reader in `packages/*/src`; no test names either tag (0 files under `packages/*/test`, `packages/*/tests`, `src/`). `electronAttentionPort` is the port's one implementation and sits in the same file as the tag.
- **Better design:** `followDesktopAttention(registry, port)` as a plain function of its two arguments. The startup program already holds both values on the line that provides them, so the context adds a lookup and two tag classes and hides nothing. `DesktopAttentionPortShape` stays as the parameter's type if a fake is ever wanted.
- **Deleted:** `DesktopProjects`, `DesktopAttentionPort` (2 service classes, 2 `provideService` calls, the "served to the surfaces that follow them" comment at `desktopProjects.ts:145-146`).
- **Size:** about 25 lines, 3 files.
- **Risk / owner decision:** none.

### LS-3: four formatter files of one function or one type, each with one consumer

- **Package:** texra
- **Flags:** shallow module; single-caller extraction
- **Evidence:** under `packages/texra/src/ui/progress/formatters/`:
  - `logFormatters/compactionActivityFormatter.ts` (17 lines): one function that returns one `<compaction-activity>` element; its only importer is `formatters/index.ts:21`, and the element (`components/CompactionActivity.ts`) has this file as its only importer.
  - `logFormatters/toolFormatters/webFormatters.ts` (18 lines): one call of `buildToolUseDetails` with five literals; only importer `index.ts:30`.
  - `logFormatters/dataFormatters.ts` (29 lines): one template; only importer `index.ts:23`.
  - `baseLogFormatter.ts` (12 lines): `export type FormatResult = TemplateResult | null` under a 6-line header; 7 importers, all inside `formatters/`.
  - `formatters/index.ts` itself has one consumer (`components/StageList.ts`) and holds the `ROW_FORMATTERS` table these four feed.
- **Better design:** `index.ts` is the owner of "one painter per row kind". The three one-row painters become entries written in that table's file (or, for web search, beside `formatToolUseTemplate` in `toolFormatters.ts`, which already imports `buildToolUseDetails`), and `FormatResult` is declared where `RowFormatters` uses it. A row kind is then added in one file instead of two.
- **Deleted:** 4 files, 3 exported functions.
- **Size:** about 80 lines moved or removed, 9 files.
- **Risk / owner decision:** none.

### LS-4a: the service's `ServiceControl` tag carries one record from the line that builds it to the one layer that reads it

- **Package:** texra
- **Flags:** shallow module; pass-through; an interface with one implementation that adds only a name (LS-2's species)
- **Evidence:**
  - `controllers/server/service.ts:84-104` declares `class ServiceControl extends Context.Service<ServiceControl, { version, socket, startedAt, clients, draining, admission, watching, stop }>`.
  - Its one implementation is the literal `const control: Context.Service.Shape<typeof ServiceControl> = { … }` at `controllers/server/serve.ts:192-217`, and the one provision is nine lines below it: `serviceHandlers.pipe(Layer.provide(Layer.succeed(ServiceControl)(control)))` (`serve.ts:220-224`).
  - Its one reader is `serviceHandlers` (`service.ts:192-195`, `const control = yield* ServiceControl;`), and `serviceHandlers` has one consumer, that same `serve.ts:221`.
  - 0 files under `packages/*/test`, `packages/*/tests` or `src/` name `ServiceControl` or `serviceHandlers`, so no fake rides on the tag. `ServiceProjects` beside it is a real port (the CLI implements it, `cli/src/runtime/platform/cliService.ts:77-244`) and stays.
  - The catalogue's L2-3.13 renamed this file's ports and left the tag; nothing there weighed whether it should exist.
- **Better design:** `serviceHandlers(control: ServiceControlShape)` is a function returning the `TexraRpcs.toLayer(…)` layer, and `serve` calls it with the record it just built. The shape keeps its doc comments as a plain interface; the handlers still `yield* ServiceProjects`.
- **Deleted:** the `ServiceControl` service class and its key string, `Layer.succeed(ServiceControl)` and the `Layer.provide` around it, one `yield*`.
- **Size:** about 15 lines, 2 files.
- **Risk / owner decision:** none.

### LS-4b: `DesktopProjectRecords` is provided twice, each time to the one call on the next line

- **Package:** desktop
- **Flags:** shallow module; pass-through (LS-2's species, in the same startup program)
- **Evidence:**
  - `main/desktopProjectRecords.ts:107-114` declares `DesktopProjectRecordsShape = ReturnType<typeof openDesktopProjectRecords>` and `class DesktopProjectRecords extends Context.Service<…>`, "served to the registry and the launch read by the startup program that opened them".
  - `main/index.ts:131` builds the value (`const projectRecords = openDesktopProjectRecords(yield* GlobalValues)`) and provides it twice, each to one call: `readRememberedDesktopProjects().pipe(Effect.provideService(DesktopProjectRecords, projectRecords))` (`:136-138`) and `openDesktopProjectRegistry({ … }).pipe(Effect.provideService(DesktopProjectRecords, projectRecords))` (`:147-153`).
  - The two readers open with `const records = yield* DesktopProjectRecords` (`main/desktopProjects.ts:222` and `:315`); `openDesktopProjectRegistry` already takes an options object (`DesktopProjectRegistryOptions`, `:292-297`) with five other startup values in it. No other file names the tag; 0 test files do.
  - PR #14953 changes `desktopProjectRecords.ts` (the schema lines only, `:26-31`); it does not touch the tag.
- **Better design:** `readRememberedDesktopProjects(records)` and a `records` field on `DesktopProjectRegistryOptions`, beside `service`, `dataRoot` and `processRoots`. With LS-2, the desktop's startup program provides no service of its own: every value it builds is an argument.
- **Deleted:** the `DesktopProjectRecords` class, two `Effect.provideService` calls, `DesktopProjectRecords` in `openDesktopProjectRegistry`'s requirement type (`:297`), the comment at `desktopProjectRecords.ts:109-110`.
- **Size:** about 15 lines, 3 files. Land with LS-2; DK-8 rewrites the registry's use of the same records (`desktopProjects.ts:335-446`), so one PR for both is the smaller diff.
- **Risk / owner decision:** none.

### LS-5: the headless presentation host is a five-member interface with one implementation, two members optional though always set, and the chat holds all of it for `emit`

- **Package:** cli
- **Flags:** an interface with one implementation that adds only a name; overexposure; non-obvious code (optional members that are never absent)
- **Evidence:**
  - `runtime/headless/cliPresentationHost.ts:24-38` exports `interface CliRuntimeHost { emit; attachRunProgressRenderer; prepareInteractivePrompt?; holdForPrompt?; close }`. Its one implementation is `createCliRuntimeHost` in the same file (`:40-128`), which always sets both optional members (`:113-114`). Its readers still write `presentationHost.holdForPrompt?.()` and `presentationHost.prepareInteractivePrompt?.()` (`executeCli.ts:221,260`).
  - The interface's only other use is a parameter type: `createTuiHostInteractions(host: CliRuntimeHost, …)` (`chat/tui/state/subscribeApprovals.ts:79-83`), which reads one member, `host.emit` (`:190`). The chat builds the host (`chat/chatSessionController.ts:348`) on a context whose `renderRunProgress` is always `false` (`cliContext.ts:507`), so in the chat the renderer is `undefined` and three of the five members are inert; it uses `emit` and `close`.
  - The renderer underneath repeats the shape: `runtime/headless/runProgressRenderer.ts:52-64` declares a file-local `interface RunProgressRenderer` whose one implementation is `class DefaultRunProgressRenderer implements RunProgressRenderer` (`:86`), built by `createRunProgressRenderer` (`:72-85`, one caller, `cliPresentationHost.ts:43`). `attachRunProgressRenderer` (`:111-112`) forwards to it, and `prepareInteractivePrompt` and `holdForPrompt` are `runProgress?.preserve()` and `runProgress?.suspend()` under new names.
- **Better design:** one value, typed by inference from `createCliRuntimeHost`, with every member present. `createTuiHostInteractions` takes `emit: CliRuntimeHost['emit']` (or `Pick<…, 'emit'>`) instead of the host. The renderer is `class RunProgressRenderer` with no interface in front of it. After CR-4, `createRunProgressRenderer` reads the flag itself, and the host's `prompting` and `beforeWrite` hooks are `renderer.suspend` and `renderer.preserve` under their own names.
- **Deleted:** the exported `CliRuntimeHost` interface (or its two `?`), the file-local `RunProgressRenderer` interface, the `Default` class name, two `?.()` calls, the host parameter of `createTuiHostInteractions`.
- **Size:** about 35 lines, 5 files (two test files build the host: `src/test-kernel/cli/TuiApprovalRetry.vitest.ts:121`, `RunProgressRenderer.vitest.ts:127`). Land after or with CR-4, which deletes `renderRunProgress` in the same files.
- **Risk / owner decision:** none.


## Good modules here

- **The service's lifecycle record** (`texra/src/controllers/server/serve.ts:150-217`): why the service is leaving and how many admissions are under way are one `SubscriptionRef`, and `admission` is an `Effect.acquireRelease` over it, so a drain can never miss a start that checked before it. LS-4a moves where the record is handed over, not this.
- **`ROW_FORMATTERS`** (`texra/src/ui/progress/formatters/index.ts:52-89`): one painter per transcript row kind, indexed by the kind, so a missing painter is a type error. LS-3 only asks that the one-row painters live in it.
- **`openDesktopProjectRecords`** (`desktop/src/main/desktopProjectRecords.ts:50-105`): the remembered and recent lists are one stored value, so a close that changes both is one write; the module takes only harness types so the e2e seed can bundle it. LS-4b keeps it and deletes only the tag in front of it.
- **The run progress renderer's class** (`cli/src/runtime/headless/runProgressRenderer.ts:86-`): a small interface (`attach`, `clear`, `preserve`, `suspend`) over throttling, the heartbeat fiber, the prompt hold count and terminal width. Deep; LS-5 removes only the interface restated above it.
- **`withPerKeyLane`** (`harness/src/utils/core/perKeyQueue.ts:42`) and **`definePlugin`** (`harness/src/tools/plugins.ts:177-182`): one-line interfaces over real behavior (a keyed semaphore; a checked `ROut` erased in one place). `definePlugin` is an identity at runtime by design: its parameter type is the check.

## Considered and left alone

- **Entry exports with one app consumer.** 216 names re-exported from the harness entries have exactly one production importer outside `packages/harness/src` (schemas 96, host 39, plugins 36, transcript 32, node 10, index 3), for example `jitteredExponentialBackoffMs` (`texra/src/tools/github/poller.ts`), `withRequestTimeout` (`tools/zotero/bbtClient.ts`), `replayTrace` (`controllers/server/serviceSession.ts`). The published surface is the work of `.agents/docs/proposed/architecture/2026-10-21-harness-general-package-design.md` and round 3's Q (`Q-public-surface.md`); the retry helpers are in Q, M and H. A one-consumer SDK export is not a defect by itself: the consumer is the app the SDK was cut for. Owner work, not this lens.
- **Entry type exports with no app consumer** (`ProcessLayerOptions`, `DefineToolOptions`, `ChildRunsShape`, …): types of exported signatures, which the declaration build and the API reports need. #14956 took the value exports with no consumer.
- **One-expression exported functions with at most one consumer** (about 70 found by a scan of `export const f = (…) => g(…)` and `return g(…)` bodies): almost all name a key, a constant or a path (`getFirstRunDone`, `mcpConfigPathOf`, `isTexFile`, `exposeApiKey`), the rule `2026-11-08-design-red-flags-lenses-2/README.md` §6 applied. The GitHub event formatters (`tools/github/format*Event.ts`, 19 functions, one consumer each) are each a message template; L2-6.1 took the two that only forwarded.
- **Context tags provided by plugin factories from a host value** (`InlineComments`, `SetupHost`, `EditorHost`, `HostCapabilities` in `texra/src/tools/registry.ts:171-277`; `ValidationModel` in `harness/src/agent/runtime/modelAccess/routeDecision.ts:39`): each is a port a host or a validation build fills and a tool reads behind the plugin boundary, so the tag is the boundary. Unlike LS-2 and LS-4 the provider and the reader are not in one program.
- **Single-caller `buildX` helpers inside one file** (the `build*Sections` of `harness/src/shared/transcript/toolRowSections.ts`, `buildWebviewHtml` in `extension/src/common/webview/BundledViewContentProvider.ts:32-69`): each is a named case of a table or a step of more than ten lines; inlining them would grow one function. Not the banned "single-caller extraction", which is about shared helpers.
- **Small one-importer files** (`texra/src/ui/copy/taskAgent.ts`, `taskApproval.ts`, `tools/documents/runOutputs.ts`, `agent/output/selectAutoOpenFinalOutput.ts`, `cli/src/runtime/gitOps.ts`, `cli/src/runtime/models/validationSwitch.ts`): each holds one fact with its own owner (copy, the Pack destination, the auto-open policy shared by two hosts, the validation switches that scripts and the e2e fixture also import).
- **`ProcessCatalog`** (`harness/src/tools/sessionTools.ts:87`, one implementation at `tools/liveTools.ts:181`) and **`AgentTrace`** (one production implementation, `agent/trace/TraceEmitter.ts:43`): the first is the record one module hands another, the second a plugin-facing interface with a test implementation (`src/test-kernel/support/noopTrace.ts:21`).
- **Found by this round's other slices, not repeated:** `renderRunProgress` and `shouldRenderRunProgress` (CR-4), `resourcesPath` threading (TC2-1), the desktop's structural interfaces for absent tests (DK-5), the sign-in presenter port (DK-2), the `toolAvailability?` process option (round 5, `2-code-for-tests.md:72`).

## Summary

| Id    | Title                                                                                                   | Package       | Flags                                                                                  | Size                  | Owner decision? |
| ----- | ------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------- | --------------------- | --------------- |
| LS-1a | Harness exports that nothing imports, in production or tests                                            | harness       | overexposure; export with no consumer                                                  | 6 lines, 5 files      | no              |
| LS-1b | App exports that nothing imports (one dead type, ten file-local symbols)                                | texra         | overexposure; export with no consumer                                                  | 12 lines, 6 files     | no              |
| LS-1c | CLI and llm exports that nothing imports                                                                | cli, llm      | overexposure; export with no consumer                                                  | 6 lines, 5 files      | no              |
| LS-2  | Two desktop services exist to carry two arguments across one call                                       | desktop       | shallow module; pass-through; one-implementation interface                             | ~25 lines, 3 files    | no              |
| LS-3  | Four formatter files of one function or one type, each with one consumer                                | texra         | shallow module; single-caller extraction                                               | ~80 lines, 9 files    | no              |
| LS-4a | `ServiceControl` carries one record from the line that builds it to the one layer that reads it         | texra         | shallow module; pass-through; one-implementation interface                             | ~15 lines, 2 files    | no              |
| LS-4b | `DesktopProjectRecords` is provided twice, each time to the one call on the next line                   | desktop       | shallow module; pass-through                                                           | ~15 lines, 3 files    | no              |
| LS-5  | The headless presentation host: one-implementation interfaces, optional members always set, chat holds all for `emit` | cli | one-implementation interface; overexposure; non-obvious code                           | ~35 lines, 5 files    | no              |
