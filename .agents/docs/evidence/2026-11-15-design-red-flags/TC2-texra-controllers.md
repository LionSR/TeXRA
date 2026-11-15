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

### TC2-7: The launcher's file catalogs are a host port both hosts fill with the same call, and `commit: ['HEAD']` is a placeholder written three times and overwritten once

- **Package:** texra (with extension, desktop)
- **Flags:** an option for a special case (a port with one implementation); pass-through method; repetition
- **Evidence:**
  - `HostSnapshotSourceOptions.fileOptions()` (`controllers/session/hostSnapshotSource.ts:99-103`) is documented as a host injection (header, `:8-9`: "the host injects its file lists"). Both hosts inject the same function over the same root: `fileOptions: () => workspaceFileOptions(roots.workspace)` (`packages/extension/src/progressView/ProgressViewProvider.ts:232`) and `fileOptions: () => files.fileOptions()` (`packages/desktop/src/main/desktopProjectBindings.ts:249`), which is `workspaceFileOptions(workspaceRoot)` (`packages/desktop/src/main/desktopFileSelection.ts:64`) over `project.root` (`desktopProjectBindings.ts:204`), the same folder as `project.roots.workspace` that `openGuiWindow` hands the source as `root` (`openGuiWindow.ts:296`). `workspaceFileOptions` has 2 production consumers (those two), 0 tests; `DesktopFileSelection.fileOptions` (`desktopFileSelection.ts:29-36`) has 1.
  - `FileOptions.commit` is filled with `['HEAD']` by `workspaceFileOptions` (`controllers/session/workspaceFileOptions.ts:57,63`) and by the source's initial inputs (`hostSnapshotSource.ts:236`), and `snapshotOf` replaces it with `['HEAD', ...s.commits.commits]` (`:455-458`). The producer's `commit` is never read.
- **Better design:** the source lists the files itself: `loadFiles` is `workspaceFileOptions(options.root)` and `Inputs.fileOptions` holds `{ baseFile, editedFile }`; the commit list is made only where the snapshot is mapped. The wire's `FileOptionsSchema` (`shared/session/hostSnapshot.ts:47-51`) keeps `commit`.
- **Deleted:** `HostSnapshotSourceOptions.fileOptions`, `DesktopFileSelection.fileOptions` and its doc, the two host bindings, the exported `workspaceFileOptions` (becomes file-local or inlined in `hostSnapshotSource.ts`), three `commit: ['HEAD']` placeholders.
- **Size:** about 30 lines, 5 files.
- **Risk / owner decision:** none. `workspaceRoots()` and `missingTools()` beside it stay host ports: the hosts answer them differently.

### TC2-8: The team planner's "ports" are a constant and a service in every production caller, bundled by hand at seven sites

- **Package:** texra (with cli)
- **Flags:** an option for a special case; pass-through variable; repetition
- **Evidence:**
  - `TeamRunOptions` (`packages/texra/src/agent/teams/teamPlan.ts:63-77`) takes `resolveAgent` and `rootAgentNames`. Every production caller passes `rootAgentNames: BUILTIN_TEAM_ROOT_AGENT_NAMES` (`controllers/mainView/teamCatalogPorts.ts:18`, `teamPlan.ts:158`, `packages/cli/src/commands/team.ts:74,101`) and `resolveAgent: AgentCatalog.get` (`teamCatalogPorts.ts:17`, `team.ts:73,100`, `settingsAgentCommands.ts:442`, `tools/setup/ApplyTeamTool.ts:59`; the doc comment at `teamPlan.ts:65-66` says "`AgentCatalog.get` in production"). The one other `rootAgentNames` is `[]` in a test of a custom team (`src/test-kernel/shared/TeamLaunch.vitest.ts:47`), whose root does not read the list ("A custom team is led by its first delegating member", `teamPlan.ts:70-72`).
  - `createTeamCatalogPorts(repoState)` (`teamCatalogPorts.ts:13-21`, the whole module) exists to bundle those two with `workspaceTeams(repoState)`. Its four consumers each spread it into the planner: `loadTeamOptions(yield* createTeamCatalogPorts(…))` at `hostSnapshotSource.ts:286-288` and `packages/cli/src/chat/tui/forms/AgentListForm.tsx:138-140`; `resolveTeamLaunch({ teamId, ...(yield* createTeamCatalogPorts(…)) })` at `MainViewRunLaunchController.ts:169-172` and `packages/cli/src/chat/tui/commands/handlers/agentModelCommands.ts:92-95`. `team.ts` builds the same record by hand twice. No earlier round or proposal lists this.
- **Better design:** the planner reads the root names itself (`selectTeamRootAgent` takes `BUILTIN_TEAM_ROOT_AGENT_NAMES`), and the two reads hosts make become Effects over the catalog: `teamOptions(repoState)` and `resolveTeamLaunch(repoState, teamId)` read `workspaceTeams` and `AgentCatalog`; callers write one `yield*`. `planTeamRun`/`planTeamRuns` keep `resolveAgent` as their one parameter, so the planner stays pure for its suite.
- **Deleted:** `controllers/mainView/teamCatalogPorts.ts`, `TeamRunOptions.rootAgentNames` and its five literal passes, the four spreads, the `presets` field threaded through `loadTeamOptions` and `resolveTeamLaunch`.
- **Size:** about 70 lines, 9 files.
- **Risk / owner decision:** none. Sequence after PR #14955, which touches the imports in `MainViewRunLaunchController.ts` and `agentModelCommands.ts` (not the calls).

### TC2-9: A run held elsewhere (`RunActive`) is reworded three ways, because the host channel's refusal set leaves out one of the session's four request errors

- **Package:** texra (with cli)
- **Flags:** repetition (one wording, four owners); special and general code mixed; information leakage
- **Evidence:**
  - `Session.request` fails with `RequestError` = `RunActive | Unavailable | Cancelled | Rejected` (`packages/harness/src/shared/session/runtimeRequest.ts:264-272`; `effect/sessions.ts:226-228`). The host channel's `RequestRefusal` is the same set minus `RunActive` (`controllers/session/hostCallFailure.ts:34-44`), so the bridge kills a host request that fails with `RunActive` and answers `Internal` (`SessionBridge.ts:390-398`), although the wire's `BridgeErrorSchema` already carries `RunActive` on `host.response` (`shared/session/bridgeErrors.ts:22-27`) and the renderers word it once: "Another TeXRA window or process controls this task." (`ui/copy/requestErrors.ts:12-13`).
  - Every host-request handler that calls `session.request` therefore re-words it: `forkRun` maps it to `Unavailable` "The task could not be forked." (`controllers/session/runActionPolicy.ts:50-54`); `useOwnApiKey` to `Unavailable` "The retry could not be settled." (`controllers/progressView/ProgressApiKeyRetryController.ts:111-118`); the pack/clean action to `Rejected` "This run is running or held elsewhere." (`hostRunActions.ts:466-472`). The CLI's approval reader branches on the narrower set again (`packages/cli/src/chat/tui/state/subscribeApprovals.ts:131-133`).
  - Round 3 (Q, `Q-public-surface.md:368-412`) moved `RequestRefusal` into the app when it still had four members; the narrowing to three is what left these remaps.
- **Better design:** `RequestRefusal` is the session's `RequestError` (`typeof RequestErrorSchema.Type`), and `isRequestRefusal` is `Schema.is(RequestErrorSchema)`. A host request that meets a run held elsewhere answers `RunActive`, and every surface reads the one sentence.
- **Deleted:** the three re-wordings and their `mapError`/`catchTag` arms, the hand-listed `instanceof` triple in `isRequestRefusal`.
- **Size:** about 35 lines, 5 files.
- **Risk / owner decision:** **owner decision (wording):** three refusal sentences become `requestErrorText`'s one. `RequestRefusal` widens, so any exhaustive switch over its tags gains a case (none found in `packages/*/src`).

### TC2-10: Three settings-view messages are looser than the actions they name, so their controllers re-check at run time what the schema could reject

- **Package:** texra
- **Flags:** errors not defined out of existence; information leakage; special and general code mixed
- **Evidence:**
  - Provider keys: `providerCommand` types `provider` as any non-empty string (`shared/settingsView/settingsViewMessages.ts:499-504`) for set, remove and open-key-page (`:524-532`), although the file already imports `API_KEY_PROVIDER_IDS` (`:23`). So `SettingsProfileKeyController` takes `provider: string` and fails an unknown one inside each action (`secretNameFor`, `controllers/settingsView/SettingsProfileKeyController.ts:139-146`), and reads the display name three times per set (`:44`, `:92`, `:118`). Its other two callers already hold `ApiKeyProviderId` (`packages/cli/src/chat/tui/hosts/cliProviderKeys.ts:42,56`; the extension's `setApiKey`).
  - Plugins: `PluginActionMessageSchema` makes `name` optional for every action (`shared/settingsView/pluginMessages.ts:40-51`) though its own comment says only `install` and `openMcpConfig` name none; `settingsPluginCommands.ts:80-92` re-checks it and fails with `PluginRequestError` "The … action names no plugin.", and `:122` re-spreads the message to narrow its type.
  - GitHub subscriptions: `UNSUBSCRIBE_PR` carries `key` as a string (`settingsViewMessages.ts:657-660`); `unsubscribeGitHubKey` decodes it as `SubscriptionTargetPath` and turns a malformed key into "0 removed" (`controllers/settingsView/githubSubscriptions.ts:67-81`), which the page words "No active subscription for …" (`settingsGitCommands.ts:88-93`). `SubscriptionTargetPath` (`tools/github/subscriptionTarget.ts:52-58`) imports only `effect`, so the message schema can use it.
- **Better design:** the boundary decodes each once: `provider: Schema.Literals(API_KEY_PROVIDER_IDS)`; the plugin action a two-case union (`{ action: 'install' | 'openMcpConfig' }` and `{ action: 'enable' | 'disable' | 'update' | 'remove', name }`); `key: SubscriptionTargetPath`. The controllers take the decoded types; the profile controller reads the display name once per action.
- **Deleted:** `secretNameFor` and its unknown-provider error, the `name === undefined` branch and its `PluginRequestError`, the action re-spread and its `Exclude` type, the in-controller decode and its zero-removed fallback, two extra display-name reads.
- **Size:** about 50 lines, 6 files.
- **Risk / owner decision:** none. A webview message that fails the narrower schema is refused at decode, which `messageDispatcher`-side senders already satisfy (they send catalog ids and listed names).

### TC2-11: A service call that got no answer is worded per channel in `serviceSession`, by four classifiers over two hand-written `RpcClientError` shapes

- **Package:** texra
- **Flags:** repetition; special and general code mixed; non-obvious code
- **Evidence:** `callService` (`controllers/server/serviceSession.ts:77-85`) maps only the offline case, through a constructor each caller passes; each caller then classifies the transport failure itself:
  - `asked` (`:95-110`) prefixes both cases with `unanswered` ("The TeXRA service did not answer: …", `:89-90`);
  - `serviceProjectState.call` (`:126-149`) prefixes a transport failure but passes the offline reason bare (`:137`), over a structural `{ _tag: 'RpcClientError'; message }` type (`:132`);
  - `request` (`:414-435`) prefixes a transport failure, passes the offline reason bare (`:417`);
  - `start`/`resume` (`:598-617`) go through `refusedByService` (`:244-254`, a second structural `RpcClientError` type at `:250`), which words a transport failure "The TeXRA service could not start the task: …" on start and bare on resume, and the offline reason bare.
  So the same lost link reads four ways depending on which `Session` member met it. `RpcClientError.RpcClientError` is already imported in `client.ts:33`.
- **Better design:** `callService(link, failed, use)` maps both the offline link and an `RpcClientError` to one sentence (the link's `away` reason, or `unanswered(message)`) through `failed`; the callers keep only their own service errors (`ProjectStateFailed`, `Invalid`/`Internal`, `LaunchRefused`).
- **Deleted:** `asked`'s inner `mapError`, the `RpcClientError` cases in `call`, `request` and `refusedByService`, both structural types, `refusedByService`'s `prefix` parameter.
- **Size:** about 40 lines, 1 file.
- **Risk / owner decision:** none; three messages gain or lose the "did not answer" prefix.

### TC2-12: After EX-2, the app keeps an open-workspace guard no host sets: an option, an outcome kind, and two branches that word it

- **Package:** texra (with cli)
- **Flags:** an option for a special case; special and general code mixed; a rule decided per host
- **Evidence:** EX-2 (this round) deletes the extension's `requiresOpenWorkspace: () => !roots.workspace` (`packages/extension/src/settingsView/SettingsViewProvider.ts:159`), the option's only setter. The app side it leaves: `SettingsHostBindings.requiresOpenWorkspace?` (`controllers/settingsView/settingsHostBindings.ts:69-70`), forwarded by the body (`settingsViewBody.ts:277`) into `StateSettingUpdatePorts.requiresOpenWorkspace?` (`stateSettingWrite.ts:56-60`), the `workspace-required` result kind (`:46`, `:83-89`), the body's notice (`settingsViewBody.ts:285-288`) and the CLI's case for a kind it never receives (`packages/cli/src/chat/tui/forms/CliConfigForm.tsx:139`). The rule was the extension's alone even before: with no folder, the config store backs the workspace target with the internal store (`platform/defaults/nodeStores.ts:41-44,77-80`), so the desktop and CLI write there. `packages/harness/AGENTS.md` ("Configuration, storage, and workspace files") still describes the guard.
- **Better design:** `applyStateSettingUpdate(key, value, { host, stores })`; the store decides where a workspace-target value lives, for every host.
- **Deleted:** the binding member, the port member and its forward, the `workspace-required` kind, the body's branch and notice, the CLI's case, the AGENTS.md clause.
- **Size:** about 25 lines, 5 files.
- **Risk / owner decision:** none once EX-2 lands (its no-folder window builds no settings view).

### TC2-13: Batched thin items: a dead module, an export with no consumer, a check-then-write behind a false comment, a single-caller extraction

- **Package:** texra
- **Flags:** an export with no consumer; a comment that is false; a hand-written version of what the store provides; a single-caller extraction
- **Evidence:**
  - a. `packages/texra/src/platform/disposable.ts` (the `Disposable` interface, 7 lines) has no importer in `packages/*/src`, `packages/*/test` or `src/` (`grep -rn "disposable'"` finds none; the alias `@texra/platform/disposable` has 0 hits).
  - b. `followed` (`controllers/server/client.ts:522-527`) is exported; its one consumer is `linkOver` two lines below (`:556`).
  - c. `telemetryNoticeIfDue` reads `telemetry.noticeShown` and then writes `true` unconditionally (`telemetry/telemetryNotice.ts:29-30`), so two hosts starting together both print the notice; its doc says the flag is "marked shown as it is returned so exactly one host prints it" (`:21-23`). Three hosts call it at startup (`packages/cli/src/runtime/platform/initPlatform.ts:221`, `packages/desktop/src/main/index.ts:210`, `packages/extension/src/extension.ts:250`). `StateStore.modify` is the one-step read-modify-write (`packages/harness/src/shared/config/settings.ts:139-146`), as `readOrCreateInstallId` beside it uses (`telemetry/installId.ts:31-33`).
  - d. `unofferedError` (`controllers/server/windowHost.ts:105-106`) has one caller, `unoffered` on the next line.
- **Better design:** a. delete; b. file-local; c. one `state.modify(NOTICE_SHOWN_KEY.key, (shown) => shown === true ? Result.fail('shown') : Result.succeed(true))` and return the notice only on success; d. inline.
- **Deleted:** one file, one export, the separate read in `telemetryNoticeIfDue`, one helper.
- **Size:** about 20 lines, 4 files.
- **Risk / owner decision:** none.

## Good modules here

- `controllers/session/SessionBridge.ts`: one scope per port forked from the bridge's, a `FiberHandle` per replay, a `FiberSet` of requests the close waits for under the session deadline, and the release-before-interrupt order stated where it matters (`:155-163`). G7's fixes held.
- `controllers/session/SessionFramer.ts`: a pure `Stream` over a two-member source; `mapAccum` carries the cursor and `Stream.buffer({ strategy: 'suspend' })` is the back-pressure.
- `controllers/server/hostWindows.ts`: a call's window chosen and registered in one synchronous step inside `acquireUseRelease`, a typed failure for detached / no answer / failed, `RcMap` holding each session's surface while a window is attached. No call waits forever.
- `controllers/server/client.ts` `linkService`: the reconnect is `Effect.retry(RECONNECT)` over a `Schedule.min` of exponential and spaced, the link one `SubscriptionRef` its holder alone sets.
- `controllers/session/hostSnapshotSource.ts`: one `SubscriptionRef` of inputs, the snapshot derived, one lane per producer so an older read never lands last, and `Stream.buffer({ capacity: 1, strategy: 'sliding' })` coalescing signal bursts.
- `controllers/session/hostDraftRequests.ts`: the recorder's reservation, publication and hand-off made uninterruptible together, the take in its own fiber so a closing window cannot strand the microphone.
- No Promise orchestration is left in the slice: the only `tryPromise` sites are the lazy export import and `fromHost`, the one lift at the host edge.

## Considered and left alone

- `HostSnapshotSourceOptions.shows` (`{ apiKeyBanner, gettingStarted }`, constant per host): round 2 (`G-app-controllers.md:876`, R8) settled it as a required boolean; it is a product rule of each host.
- The setup launch's outcomes per host, `showConnectModel` clearing the skip in the extension only: item 3 of `.agents/docs/proposed/simplification/2026-11-15-host-rules-and-app-facts-with-two-owners.md`.
- `LatexToolingController`'s seven `*Path` fields: item 5 of the same note's app facts.
- `serviceSession.attach` refusing an approve handler: refuted (`refuted-candidates.json:515`).
- `subscriptionUsageParsing` alias lists and `stringField`/`numberField`: round 3 (`U-cross-package.md:572-575`) judged them a boundary of their own; round 2 listed the module as good.
- `subscriptionProviders.ts` (`isPreferSubscription`/`setPreferSubscription` forwarding to `SubscriptionPreference`), `modelSelection.ts`, `settingsViewBody.ts`, `stateSettingWrite.ts`: open PRs #14955 and #14949 rewrite them; re-read after they merge.
- `controllers/server/discovery.ts`, `protocol.ts`: open PRs #14959 and #14953.
- `UsageLogService`: G9 landed (#14810); `FLUSH_INTERVAL` is exported for its suite only, left as the suite's clock handle.
- `onboardingFunnel.ts`'s `cli.onboardingDeclined` key spelling: a persisted key keeps its spelling (root `AGENTS.md`, "Plain names and comments").
- `SettingsAgentCatalogController.ts:157-159` matching bare agent names: `agentMatchesIdentifier` is the harness's general identity rule (teams name bare members), not a legacy reader; its comment's "older workspaces" framing is for the harness slice.
- `ToolEditApprovalController`: G1 landed (#14784); the remaining shape (one scope per staged request, the approval forked uninterruptible in it) is sound.
- `openExternal` failures: the extension answers `Rejected`, the desktop presents a dialog and fails; each surfaces once, a host presentation choice, not a second owner.

## Summary

| Id | Title | Package | Flags | Size | Owner decision? |
| --- | --- | --- | --- | --- | --- |
| TC2-1 | The resources directory and the LaTeX preamble are threaded through each host's window | texra, extension, desktop | pass-through variable; repetition; information leakage | ~60 lines, 9 files | no |
| TC2-2 | `CommandDirs` is a service and also a module function ten sites call over a module cache | texra, extension, desktop | repetition; shared mutable state; hand-written version of Effect | ~80 lines, 9 files | no |
| TC2-3 | Per-run guards and wordings written in both `hostRunActions` and `openGuiWindow`; file actions handed copies | texra | repetition; conjoined methods; pass-through method; information leakage | ~120 lines, 3 files | no (one sentence changes) |
| TC2-4 | Hosts re-tag a failed capability by hand instead of `hostFailure` | extension, desktop | repetition | ~25 lines, 2 files | — fixed by open PR #14953; drop |
| TC2-5 | Two formatters for "first issue of a failed decode" in the launch path | texra | repetition; hand-written version | ~20 lines, 2 files | no |
| TC2-6 | `housekeeping/` exports an error only the extension raises, with false comments | texra, extension | false comment; overexposure | ~30 lines, 4 files | no |
| TC2-7 | The launcher's file catalogs are a host port both hosts fill identically; `commit` placeholder ×3 | texra, extension, desktop | option for a special case; pass-through; repetition | ~30 lines, 5 files | no |
| TC2-8 | Team planner "ports" are a constant and a service everywhere, bundled by hand at seven sites | texra, cli | option for a special case; pass-through variable; repetition | ~70 lines, 9 files | no |
| TC2-9 | `RunActive` reworded three ways because the host refusal set omits it | texra, cli | repetition; special and general mixed; information leakage | ~35 lines, 5 files | yes (wording) |
| TC2-10 | Three settings-view messages looser than their actions; controllers re-check at run time | texra | errors not defined out of existence; information leakage | ~50 lines, 6 files | no |
| TC2-11 | A service call with no answer is worded per channel by four classifiers | texra | repetition; special and general mixed; non-obvious code | ~40 lines, 1 file | no |
| TC2-12 | The open-workspace guard's app side outlives its only setter (remainder of EX-2) | texra, cli | option for a special case; rule decided per host | ~25 lines, 5 files | no |
| TC2-13 | Batched: dead `disposable.ts`, unused `followed` export, telemetry notice check-then-write, single-caller helper | texra | export with no consumer; false comment; hand-written version; single-caller extraction | ~20 lines, 4 files | no |
