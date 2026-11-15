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

