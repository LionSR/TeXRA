Read at `cb22acd`. Covered: `packages/texra/src/controllers/`, `hosts/`, `platform/`, `housekeeping/`, `telemetry/`, compared with `packages/extension/src/progressView/extensionHostRequests.ts` and `packages/desktop/src/main/desktopHostRequests.ts`.

Status: complete. TC2-1 to TC2-6 are the first auditor's, spot-checked (two line ranges corrected in TC2-2; TC2-4 is fixed by open PR #14953 and kept only so the ids stay stable); TC2-7 to TC2-13 continue the slice.

### TC2-1: The resources directory and the export's LaTeX preamble are process facts that each host threads through its window

- **Package:** texra (with extension, desktop)
- **Flags:** pass-through variable; repetition (a fact with two owners); information leakage
- **Evidence:**
  - Both hosts import the same file and hand it to the window: `packages/extension/src/progressView/extensionHostRequests.ts:48,450` and `packages/desktop/src/main/desktopHostRequests.ts:19,216` (`import latexPreamble from '@resources/templates/chatExport.tex'`). It then travels `GuiWindowHost.export.latexPreamble` (`controllers/session/openGuiWindow.ts:217-220`) → `exportTranscript` (`openGuiWindow.ts:420-429`) → `writeTranscript` options (`controllers/progressView/ChatExportController.ts:55`) → `formatChatAsLatex` (`:137`). The comment at `ChatExportController.ts:54` calls it "a host asset"; the two hosts hold the identical asset.
  - `resourcesPath` takes the same route (`openGuiWindow.ts:219,428`, `ChatExportController.ts:57,67`) to `traceHtml(session, runId, resourcesPath)` (`agent/export/standaloneTraceHtml.ts:75,87`). The process already holds it: `texraProcessLayer` takes `resourcesPath` (`controllers/texraProcessLayer.ts:54`) and builds `AgentDirectoryService`, whose `resourcesRoot` is public (`packages/harness/src/agent/index/AgentDirectoryService.ts:73,80`); the window's dispatch already yields `AgentDirectories` (`openGuiWindow.ts:669`).
  - The desktop carries the string through four files only for this: `desktopWindow.ts:85,218,228`, `desktopProjectBindings.ts:85,274`, `desktopProjectSurface.ts:55,200`, `desktopHostRequests.ts:47,217`. The extension joins `extensionPath + 'resources'` three times (`extension.ts:165`, `SettingsViewProvider.ts:103`, `extensionHostRequests.ts:451`).
  - Consumers of `latexPreamble` as a port: 2 hosts, 0 tests. T9 (round 3) covered the duplicated trace export between host families, not this threading.
- **Better design:** the export reads both from where the process keeps them. `traceHtml` and `writeTranscript` take the resources root from `AgentDirectories` (or a one-field `Context.Reference` served by `texraProcessLayer`), and the preamble is read from `<resources>/templates/chatExport.tex` beside the trace-viewer template, or imported once by `agent/export/chatExport/latexSpec.ts`. A host's `export` binding is then `pickFormat` and `openPath` only.
- **Deleted:** `GuiWindowHost.export.latexPreamble` and `.resourcesPath`, the two `writeTranscript` options, both hosts' `@resources/templates/chatExport.tex` imports, `resourcesPath` on `DesktopHostRequestsOptions`, `desktopProjectSurface`, `desktopProjectBindings` (if the settings IPC is its only other reader there, it stays in `desktopSettingsIpc.ts`).
- **Size:** about 60 lines, 9 files.
- **Risk / owner decision:** none for the path. Reading the preamble at run time instead of bundling it needs the desktop package to ship `templates/`; importing it once in the app needs the app's bundlers to keep the `.tex` text loader (both hosts already have it).

### TC2-2: The command directories are a service (`CommandDirs`) and also a module function ten sites call directly, over a module-level cache

- **Package:** texra (with extension, desktop)
- **Flags:** repetition (one fact, two access paths); shared mutable state; a hand-written version of what Effect provides
- **Evidence:**
  - `texraProcessLayer` serves the function as the harness's `CommandDirs` reference (`controllers/texraProcessLayer.ts:123`), and the harness offers `withCommandDirs(env)` (`packages/harness/src/utils/system/platformPaths.ts:112-115`).
  - Ten call sites in eight files skip the service and import `commandDirs` from `platform/defaults/commandDirs.ts`: `tools/media/audio.ts:183`, `tools/agentCli/vendorPackages.ts:231`, `tools/setup/ProbeEnvironmentTool.ts:123`, `utils/system/binaryResolver.ts:78,101`, `utils/system/toolChecks.ts:196`, `packages/desktop/src/main/desktopPtyHost.ts:119`, `packages/extension/src/frontend/setup.ts:28`. Four of them write `withExtendedPath(env, commandDirs())`, which is `withCommandDirs(env)`.
  - The function memoizes in `let cachedExtraDirs: string[] | null = null` (`commandDirs.ts:17,79-82,261-262`): module-level mutable state with no reset handle, returned unfrozen across the module boundary. G11h (round 2) named the two caches in `binaryResolver` and `toolChecks`; this one feeds both and was not listed. `warnSkippedDir` (`:25-27`) writes the log sink directly because "there is no fiber to log from", which is a consequence of the same choice. (LR's desktop `pathFix` finding is a third PATH writer beside this owner; this finding is the owner's own two access paths.)
- **Better design:** the directories are computed once by the layer that serves them (`Layer.sync`/`Layer.effect(CommandDirs)`, where the skipped-directory warnings are `Effect.logWarning`), and app code inside a fiber reads `CommandDirs` (`withCommandDirs`). The two host sites that run outside a fiber (`desktopPtyHost`, the extension's `setup.ts`) read the value from their process runtime.
- **Deleted:** `cachedExtraDirs`, `warnSkippedDir` and its direct `writeLogLine`, seven direct imports of `commandDirs`, four `withExtendedPath(…, commandDirs())` spellings.
- **Size:** about 80 lines, 9 files.
- **Risk / owner decision:** none. `binaryResolver` and `toolChecks` are synchronous today; they move with G11h or take the directories as an argument.

### TC2-3: A run's "may this action run" checks and wordings are written in both `hostRunActions` and `openGuiWindow`, and the file-actions controller is handed copies of what the window holds

- **Package:** texra
- **Flags:** repetition; conjoined methods; pass-through method; information leakage
- **Evidence:**
  - "The run is no longer open." is checked and worded twice: `controllers/session/hostRunActions.ts:488-493` (`runCompileFixer`) and `controllers/session/openGuiWindow.ts:621-625` (`exportTranscript`).
  - A run's rounds are read twice by the same two lines: `hostRunActions.ts:303-306` (`roundsOfRun`) and `openGuiWindow.ts:382-385` (the `rounds` port of `ProgressDocumentTaskFileActionsController`).
  - "No saved setup" has two readers and two wordings in one file: `savedTaskConfig` ("This run saved no setup to act on.", `hostRunActions.ts:311-324`) and `nativeAgentRun` ("This run's configuration was not saved.", `:327-339`).
  - The toolbar's latexdiff is two calls the caller must make in order: `runActions.documentTaskDiffRequest(runId)` then `latexdiff.run(runId)` (`openGuiWindow.ts:628-631`); the first exists only as the guard of the second (`hostRunActions.ts:431-436`, 1 consumer).
  - `documentTaskFileOperation` returns `{ result, inputFile }` (`hostRunActions.ts:65-68,479-485`) so that `openGuiWindow.fileOpResultMessage` (`:248-259`, `:634-642`) can word the notice; the status mapping (`done` → `success`) is in one file and the sentence in the other.
  - `ProgressDocumentTaskFileActionsController` (`controllers/progressView/ProgressDocumentTaskFileActionsController.ts`, 1 construction site, `openGuiWindow.ts:380-394`) takes `rounds`, `storageRoot` and `workspace` (`:61-71`), three projections of the `session` and `roots` its builder holds; builds `new RunFileService(runId, { storage, workspace: undefined })` twice (`:98-101`, `:167-170`); and `mergeFile(file, base)` only forwards to `runs.merge(base, file)` with the arguments swapped (`:140-142`).
- **Better design:** the run-action module owns every per-run guard and the sentence that follows the action: `latexdiff(runId)` and `exportTranscript(runId)` are run actions that check and then act, `packOrClean(runId, op)` returns the notice text, and one `requireOpen(runId)` and one `savedConfig(runId)` word the two refusals once. The file actions take `session` and `roots` (as `latexdiffVerbs` and `exportRunTranscript` already do, `openGuiWindow.ts:414-429`) and read the rounds themselves.
- **Deleted:** `documentTaskDiffRequest`, `DocumentTaskFileOperationResult`, `fileOpResultMessage` in `openGuiWindow`, the `rounds` / `storageRoot` / `workspace` deps, `mergeFile`, one of the two "no saved setup" sentences, one of the two "no longer open" checks.
- **Size:** about 120 lines, 3 files.
- **Risk / owner decision:** none; one refusal sentence changes wording. Sequence after PR #14953 and #14955, which change `ProgressDocumentTaskFileActionsController.ts` and `openGuiWindow.ts`.

### TC2-4: Each host re-tags a failed capability by hand where `hostFailure` is the one wording

- **Status:** fixed by open PR #14953 (`claude/optimistic-cori-q0n270`): it adds `hostFailed(member, cause)` to `hostCallFailure.ts` and uses it at all three sites (`git show origin/claude/optimistic-cori-q0n270:packages/desktop/src/main/desktopHostRequests.ts`, lines 189 and 201; the extension's `failed`, line 161). Drop it from the catalogue; kept here so the ids stay stable.
- **Package:** extension, desktop (the owner is texra's `hostCallFailure.ts`)
- **Flags:** repetition
- **Evidence:** `hostFailure(member, cause)` (`controllers/session/hostCallFailure.ts:45-52`) builds `new HostFailed({ member, message: toErrorMessage(cause), cause })` and keeps a refusal as itself. The same literal is written out at `packages/extension/src/progressView/extensionHostRequests.ts:139-144` (`failed`), `packages/desktop/src/main/desktopHostRequests.ts:184-190` (`openDiff`) and `:204-211` (`openPath`). The hand-written ones also wrap a `Rejected`/`Cancelled` the callee already worded, which `hostFailure` would pass through.
- **Better design:** the three sites call `Effect.mapError((cause) => hostFailure('openPath', cause))`.
- **Deleted:** three object literals, the `HostFailed` and `toErrorMessage` imports in `desktopHostRequests.ts`.
- **Size:** about 25 lines, 2 files.
- **Risk / owner decision:** none.

### TC2-5: "The first issue of a failed decode, as `Invalid … (path): message`" has two formatters in the launch path

- **Package:** texra
- **Flags:** repetition; a hand-written version of what the harness provides
- **Evidence:** `decodeLaunchConfig` formats with `SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues`, joins the path itself and falls back to `'unknown'` (`controllers/session/launchConfig.ts:20-23`). `buildLaunchConfig`, which calls it forty lines later, formats the options failure with the harness's `formatIssuesForDiagnostics` and falls back to `'options'` (`controllers/mainView/backend/MainViewRunLaunchController.ts:103-110`). `formatIssuesForDiagnostics` has 5 production files; `makeFormatterStandardSchemaV1` has 4.
- **Better design:** one `rejectedFor(label, error)` in `launchConfig.ts` over `formatIssuesForDiagnostics`; `buildLaunchConfig` decodes its options with `decodeUnknownEffect` and maps through it instead of a `Result` test.
- **Deleted:** the standard-schema formatter and path join in `launchConfig.ts`, the `Result` branch in `buildLaunchConfig`.
- **Size:** about 20 lines, 2 files.
- **Risk / owner decision:** none.

### TC2-6: `housekeeping/` exports an error only the extension raises, with comments that describe code that is gone

- **Package:** texra, extension
- **Flags:** a false comment; overexposure; an export with one consumer outside its package
- **Evidence:**
  - `GlobFailed` (`housekeeping/artifactFiles.ts:20-32`) says "The `glob` package rejects, and a housekeeping command reports that"; the module's own header says its listing is "never globbed" (`:83-85`) and nothing in the app raises the tag. Its one raiser is `packages/extension/src/commands/housekeeping/clean.ts:10,41`. G10 (round 2) counted its `catchTag` readers as 0 and proposed `HostFailed`; the class is still here, now with its explanation out of date.
  - `packLatexdiffvc.ts:18-19` cites "the housekeeping pack/clean commands (opResults.ts)"; there is no such file in the app (the only `opResults.ts` is the harness's exec-result schema).
  - `filesystemFor` names a workspace-relative path `workspaceRoot` (`artifactFiles.ts:52-66`).
  - `HISTORY_DIR` (`housekeeping/constants.ts:24`) has one reader, `tools/documents/runOutputs.ts:33`, outside housekeeping.
- **Better design:** the error lives beside the `glob` call that raises it (or that call fails with `HostFailed`, G10's answer); `HISTORY_DIR` moves to `runOutputs.ts`; the two comments say what the code does.
- **Deleted:** `GlobFailed` from the app, `HISTORY_DIR` from `constants.ts`, two false comments.
- **Size:** about 30 lines, 4 files.
- **Risk / owner decision:** none.
