## TeXRA concept audit against origin/main @ 4311c54

This was read-only: no edits, pushes or comments. I exported the tree to a scratch folder, and all paths below are relative to the repo root. Six parallel audits covered the concepts, and I re-read the headline items myself.

The PR #13350 note is pinned at 3efffcc, and several of its claims have drifted; they are listed at the end. Re-checked on a53db0e, which contains #13348 and #13359. #13348 has merged: `FollowUps` is no longer a context service, and `toolUse.ts:150` now reads `rounds ? null : yield* claimFollowUps(run, ledger)`. Items those merges fixed are marked "Fixed by #…" and kept as history; the rest are reworded or carry updated line numbers.

Tags: [v] means read in the code; [i] means inferred (traced, not reproduced).

**Terms used below**

| Term           | Meaning                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| Publisher      | The `SessionEvents` inbox, the one intended writer of the session event table                           |
| Display view   | `SessionView` / `runView`, the fold the UI reads                                                        |
| Pin / snapshot | The composition and definition a run holds; the opening `flow.snapshot` row records what it was offered |
| Bypass         | The in-memory "approve all" flags per run (`SessionApprovals`, `byRun`)                                 |
| Lease          | A follow-up queue lease (kinds flow, child, recovery)                                                   |
| Terminal       | Writing `run.end` (via `finalizeRun`)                                                                   |
| Move N         | A numbered proposal in the #13350 note                                                                  |

### Summary

| Concept      | Owner today                                                                                                                                         | Violations | Worst violation                                                                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process      | `installProcessRuntime`, which is in `src/controllers/session/sessionLayer.ts:1154-1273`, not `processRuntime.ts`; owner slot `sessionGraph.ts:185` | 12         | The SDK skips `bootstrapHost` (`packages/agent/src/effect/runtime.ts:228`), so the host identity gives three answers, and there is no long-stream transport, no skills and no plugin agents                       |
| Session      | `Sessions` LayerMap `sessionLayer.ts:785-799`; `SessionHandle.ts:309-346`                                                                           | 8          | Hosts find sessions for resume their own way (`extension.ts:208-216`, `desktopAgentResume.ts:60-62`, CLI slots) although `hostRunActions.ts:625-629` already holds the session                                    |
| Log          | Publisher `src/agent/runtime/SessionEvents.ts:162-397`                                                                                              | 10         | `Database.removeRun` appends `run.removed` itself (`Database.ts:1045,1080`), so the publisher's arm at `SessionEvents.ts:183` never fires                                                                         |
| Fold         | `runStateFold.ts:783`, `sessionFold.ts`, `transcriptFold.ts`, shared `runRows.ts`                                                                   | 14         | Runtime decisions read the display view: follow-up admission `runRegistry.ts:376-401`; goal check-then-act `goalRows.ts:78-80`                                                                                    |
| Run          | `runToolUse`, `loop/toolUse.ts:126-756`                                                                                                             | 11         | Three release rules for one lease (Run 2). Fixed by #13348: a workflow child inherited its parent's `FollowUps` from context and its `settleRun` released the parent's lease (Run 1)                              |
| Plugin       | Manifest `pluginManifest.ts:43-452`; `registry.ts:110-195`; `continuationPolicy.ts:88-120`                                                          | 15         | Plugin resources are merged unconditionally into `ProcessServices` (`sessionLayer.ts:1181-1199`), and core shutdown names GitHub (`sessionLayer.ts:1258`)                                                         |
| Composition  | `src/tools/composition.ts:24-104`; `compositions.ts:52-221`; built at `agentToolResolution.ts:188-433`                                              | 8          | The availability input comes from a module cache with `?? []` (`toolAvailability.ts:174,347`), so hashes are non-deterministic                                                                                    |
| Pin          | `AgentRun.ts:229-360` (one activation only)                                                                                                         | 6          | Nothing is pinned across resume: `executeAgent.ts:393` passes `composition: resumed ? undefined`, so the composition is re-resolved live; the definition is also re-read live                                     |
| Continuation | `PLUGIN_CONTINUATIONS` `continuationPolicy.ts:88-120`                                                                                               | 7          | Children, `stopAfterCycle` and `rounds === null` decide idle outside the table (`toolUse.ts:534-537,623-645`)                                                                                                     |
| Request      | `SessionRequests.decide` `:203-277` → `SessionHandle.decideRequest` `:798-826`; `openRequest` `:712-784`                                            | 22         | The policy for plan, proposal, retry and question is decided only in the CLI (`packages/cli/src/runtime/approval/settleApprovals.ts:42-153`) and SDK (`sessionPrograms.ts:102-142`); the GUI hosts always present |
| Host         | Shared bodies `hostRunActions.ts`, `SessionRequests.ts`, `sharedHostRequests.ts`                                                                    | 20         | Five decisions differ per host: resume, own-key retry, approve-all cascade, follow-up after Ctrl-C, approval policy                                                                                               |

### Process

1. [v] **SDK skips `bootstrapHost`** (`packages/agent/src/effect/runtime.ts:228`).
   - What it loses: the undici dispatcher (`hostBootstrap.ts:74`), account probes, skills (`runtimeSkills.ts:48-52`), plugin agent dirs, and `seedDisabledToolDefaults`.
   - On the SDK path the host identity gives three answers: `'vscode'` (`platformSettings.ts:40`), `undefined` (`:48`, read at `AgentRun.ts:242`), and a throwing `SetupPlatform.host` (`runtime.ts:89`). Changed by #13359: `bootstrapHost` now takes the host from context (`initProcessSettingHost((yield* SetupPlatform).host)`, `hostBootstrap.ts:77`) and secrets from `Secrets` (`:81`), so on the three hosts the slot and `SetupPlatform.host` agree.
   - Fix: call `bootstrapHost` with an explicit `storageDir` (move 4 PR 1).
2. [v] **Host identity has three homes:** the `installedHost` slot (`platformSettings.ts:33`), `processToolHost()` (`:48`) and `SetupPlatform.host`. Since #13359 the hosts no longer pass `host:`/`secrets:` literals to `bootstrapHost`, so the three disagree only on the SDK path, which still skips it. Host literals are also repeated in five settings-write ports. Fix: host as data on `SettingsStores`/`WorkspaceRoots`.
3. [v] **The runtime is read back from an ambient slot.** `installedProcessRuntime()` (`sessionGraph.ts:204`) is read at `runtime.ts:203` and `cliProcessRuntime.ts:201,313`, against `processRuntime.ts:8-12`. Fix: roots hold their runtime.
4. [v] **A second install silently replaces the owner** (`sessionLayer.ts:1244`); only the SDK guards against it. Fix: refuse when one is installed.
5. [v] **Process-global `disposal` latch** (`sessionLayer.ts:1290`). Fix: key it by runtime.
6. [v] **Default session is a second owner:** the `defaultSessionRoot` slot (`sessionGraph.ts:281`). Desktop keeps its own fallback instead (`desktopProjects.ts:210`). Fix: hosts hold the handle they opened.
7. [v] **`forkDetach` fibers that no runtime scope owns:** `hostBootstrap.ts:106`, `extension.ts:644,867`, `desktop/main/index.ts:409,1784`, and `AgentDirectoryManager.ts:196` (partly covered by VS Code disposables). Fix: `forkScoped`.
8. [v] **The `AppSignals` hub is never shut down** (`src/eventBus/AppSignals.ts:176`). Fix: a service with a finalizer.
9. [v] **Shutdown chains are restated per host:**
   - Extension: `extension.ts:268-276,685`.
   - Desktop: `index.ts:1627-1664`.
   - CLI: `initPlatform.ts:384-391`, `bin/texra.ts:61`, `commands/auth.ts:109`, `initPlatform.ts:167-189` and `sessionExitController.ts:145-243`.
   - SDK: `runtime.ts:253-264`.
   - Fix: one scoped shutdown owned by the graph.
10. [v] **About 28 core/SDK/CLI module slots hold process state** (the note's "about fourteen" is an undercount):
    - Agent catalog: `agentRegistry.ts:63-90`.
    - Plugin agent dirs: `BundledAgentDirectories.ts:25`.
    - Skills: `runtimeSkills.ts:48`.
    - External roots: `externalRoots.ts:68`, with two writers (`runtimeSkills.ts:235` and extension `setup.ts:49-112`). One project's skill roots widen the allowlist for every session [i].
    - Rate limiters: `rateLimiter.ts:27`.
    - GitHub budget: `annotationFetchBudget.ts:122`.
    - Coordinator WeakMaps: `sessionAccess.ts:59`.
    - PKCE semaphore: `supabaseSignIn.ts:46`.
    - Subscription probes: one `signedInProbes` slot (`src/model/subscriptionAccess.ts:41-44`, writer at `:88`). Changed by #13359, which deleted `codexSubscription.ts` and `xaiSubscription.ts` and their two slots.
    - Log sink: `logSink.ts:165` (five writers).
    - CLI: `initPlatform.ts:59-68,235`, `cliProcessRuntime.ts:76`, `supabaseAuth.ts:62`, `cliAgentResume.ts:23`. Fixed by #13359: the `cliSecrets.ts:141` slot (first root wins) is gone with `getCliSecrets`; `cliProcessRuntime.ts:216` builds `new CliSecrets(cliSecretsPath(storageRoot))`, and `initPlatform.ts:411-414` reads `Secrets` from the runtime.
    - SDK: `runtime.ts:147-159`.
11. [v] **Ambient reads of another concept's state:** `credentialReprobe.ts:35` (`listSessions` via the module owner), `AgentRun.ts:242`, `builtInToolUseRoots`, and the external-root readers `pathResolution.ts:117,147,222`, `userVars.ts:288`, `workspaceInfo.ts:152`.
12. [v] **No per-graph nonce** in the owner id (`nodeProcesses.ts:20-26`).

### Session

1. [v] **Two live-session registries:** the LayerMap RcMap (`sessionLayer.ts:815-866`) and the `held` Map (`:1215`, read at `:1249-1263`). They disagree while an entry is building or releasing. Fix: delete `held`.
2. [v] **Session state in module slots:** `sessionGraph.ts:185,281`, `sessionLayer.ts:1290`, CLI `initPlatform.ts:64,235`.
3. [v] **Per-host session lookup for resume:**
   - Extension: `tryDefaultSession` (`extension.ts:208-216`).
   - Desktop: scans every project's view (`desktopAgentResume.ts:60-62`).
   - CLI: its module slots.
   - `hostRunActions.ts:625-629` holds the session yet calls the process port.
   - Fix: a per-session `AgentResumePort`.
4. [v] **Desktop workflow Resume becomes a failed run.** `hostRunActions.ts:630-631` passes a `runId`, and `desktopAgentRun.ts:196` wraps every request as `kind:'fresh'`.
5. [v] **Doubled approval door:** `this.approvals = graph.requests.approvals` (`SessionHandle.ts:323`). The approval policy is handle-held mutable state (`:287,382-415`), and the log only receives snapshots of it.
6. [v] **Session-keyed state owned outside the session:**
   - `goalGrants` WeakMap (`src/tools/goal/goalAutoApproval.ts:25`).
   - `RunSubscriptionRegistry` is process-scoped and keyed by `SessionHandle` (`src/tools/github/RunSubscriptionRegistry.ts:64-73`).
7. [v] **Two subscription doors:** `setTranscriptSubscriptions` (`SessionHandle.ts:1153`) against raw `subscriptions.set` at `SessionBridge.ts:199`, `sessionPrograms.ts:348,420`, `sessionTransport.ts:206`.
8. [v] **Dead surface:** seven dead imports in `SessionHandle.ts`; `heldSessions` has no production caller; nothing passes `SessionHandleInit.interactions` (`:188`). `teardownDefaultSession` is not dead (`extension.ts:276`, `initPlatform.ts:344`), so the note's delete list is wrong on that one.

### Log

1. [v] **`removeRun` outside the publisher** (`Database.ts:1013-1083`). Callers: `SessionRequests.ts:310`, `sweepLeftoverRuns.ts:45`.
   - The tracker arm prunes only `aggregateId`, not `runIds`.
   - The local tail (`sessionLayer.ts:650-651,674`) handles only the target, so removed dependents keep ancestry, follow-ups and chunks [i].
   - Fix: add `removeRun` to the job ops via `exclusive`, and prune every id in `runIds` at all three sites.
2. [v] **App-state rows skip the publisher:** `appStateStore.ts:72-87` uses `database.appendAll`, and `Database.updateAppStateKey` (`:830-849`) calls `appendPrepared` directly. They share the session DB and use `borrowsClaim` (`:582,689,1223`). Fix: the `CurrentValues` table (move 12).
3. [v] **Global-DB writers use the same event machinery off the publisher:** `recordUpdateCheck` `:851-878`, `updateInquiryRecord` `:891-915`, `desktopProjectRecords.ts:52`. The desktop lists are two non-atomic writes.
4. [v] **Three claim doors, each calling `hydrateFollowUps`:** `sessionLayer.ts:354-373`, `:487-495`, `RunLedger.ts:284,315`. Fix: one claim door.
5. [v] **Usage stored four times:** `model.message` usage (`runLedgerEvent.ts:181`), the trace `usage` row (now `logger.emit({type:'usage'})` at `UsageMonitor.ts:175-181`, plus `agentCliShared.ts:547` for agent-CLI children, after #13359 retired the `TraceEmitter.ts:115-123` helper; the display fold reads it at `sessionFold.ts:978-986`), `run.end.usage` (`runLifecycle.ts:228-243`), and `UsageMonitor`'s in-memory totals.
6. [v] **Output stored three times:** `output.produced.rounds` (`documentRounds.ts:494`), `run.end.output` (`runRecords.ts:100`), `run.result.output` (`subagentResults.ts:256`, `bash.ts:335`, `cli/commands/workflow.ts:405`).
7. [v] **Config stored repeatedly:** `run.config` on every activation (`AgentRunLifecycle.ts:455-463`) and on model switch (`modelSwitch.ts:78`), plus the same fields in `run.record` (`runRecords.ts:21-24`).
8. [v] **Inquiry summary duplicated** into the session log (`inquiryActions.ts:113-119`, `ExternalInquiryTool.ts:336-343`); the global-DB record is the authority.
9. [v] **Durable `followup.queued.relation` (from #13306) is computed from the display view** (`ToolUseFollowUpQueueManager.ts:411-424` via `SessionHandle.ts:339-340`). The comment at `:409` claims it comes from committed state.
10. [v] **`collectDeletion` deletes log rows off the inbox** (`Database.ts:493-498`, 30-second loop at `deletionCleanup.ts:97`). The note rules that GC stays in SQL, so this is a sanctioned exception, listed for completeness.

### Fold

1. [v] **Pending follow-ups derived in six places:**
   - The publisher tracker (`SessionEvents.ts:179-194,357-385`).
   - The display fold (`sessionFold.ts:257,1120`).
   - A cold fold in admission (`QueueManager:550-553`).
   - A cold fold in resume (`resumeRun.ts:277-280`).
   - Queue entries (`QueueManager:147`).
   - Listings (`runListing.ts:50`, CLI `sessionCommands.ts:186`).
2. [v] **Open work derived three times:** the publisher `track` (`SessionEvents.ts:196-222`), the transcript slot (`transcriptFold.ts:118-127`), and the fold's stream close.
3. [v] **Parentage has five sources:**
   - The log (`run.start.parent`/`run.detach`).
   - The view's `parentId` (read at `childRunOutput.ts:45`, `SessionHandle.ts:339`, `runListing.ts`, CLI `transcript.ts:117`).
   - `persistedParentRunId`, which is `readView([])`, a whole-session cold fold (`runRecords.ts:113-117`). It is read twice in `runAgent.ts:146,206` (now deliberate: before and after the claim), plus `resumeRun.ts:420`, `executeAgent.ts:531` and `chatSessionController.ts:928`.
   - The approvals' `parentOf`/`childrenOf` (`runApprovalQueue.ts:255-275`).
   - `RunHandle.parentState` (`RunHandle.ts:29,61-109`).
   - Fix: one single-run lineage read from the run's own rows.
4. [v] **An evicting in-memory terminal set gates admission** (`QueueManager:148,398`). Once evicted, the gate forgets [i].
5. [v] **Cold and live folds mixed in one reader:** `runListing.ts:39,50`; `ExecutionsTool.ts:364,486,551,579,656,677`. Each `readView` re-folds the whole session.
6. [v] **Decision from the view:** follow-up admission reads `substate===RESUMING` (`runRegistry.ts:376-401`).
7. [v] **Decision from the view:** `stopFolded` reads view `CANCELLED` (`runRegistry.ts:447-449`).
8. [v] **Goal decisions from the view, check-then-act outside `exclusive`:** `goalRows.ts:78-80,94,126,146,161`, `continuationPolicy.ts:71`, `maybeBuildGoalContinuation.ts:31`, `PlanTool.ts:130,335,362`. RunState does not fold `goalStateChanged`. Fix: fold the goal into RunState.
9. [v] **Decision from the view:** `executions send` gates on it (`send.ts:43-58`, new in #13306).
10. [v] **Other view-sourced decisions:** `FollowUps.ts:195`, `waitCoordination.ts:29`, `turnAttribution.ts:58`, `sweepLeftoverRuns.ts:16`, `SessionRequests.ts:216-230`, `hostRunActions.ts:266,323`, `resumeRunPresentation.ts:29`, `settleRun` `sessionLayer.ts:920`. The liveness prober picks owners from the view (`sessionLayer.ts:207-247`), and that feeds admission (`SessionRequests.ts:162-170`).
11. [v] **`listingTypeOf` has an unchecked `default`** (`sessionEvent.ts:628-675`). App-state and `run.record`/`report`/`result`/`workspaceFiles` rows fall through into every listing [cost i].
12. [v] **Unchecked type lists:** the publisher `track` arms (`SessionEvents.ts:181-223`) and the chunk-drop list (`sessionLayer.ts:655-690`).
13. [v] **Module slots in the fold:** `sessionFold.ts:275,305`, `transcriptState.ts:143,200`.
14. [v] **A render-side producer:** CLI local notices with `Date.now()` and a synthetic `origin:'local'` (`cli/.../transcript.ts:54,79,104-120`).

### Run

1. [v] **Fixed by #13348: a run read another run's lease from context.** Kept as history. `toolUse.ts:149` uses `serviceOption(FollowUps)`; `launchWorkflowRun` (`executeAgent.ts:213-214`) provides none, so a workflow child inherits its parent's. `settleRun` (`toolUse.ts:748`) then releases the parent's lease, and `appendSynthetic` (`:203-205`) puts compaction turns on the parent's queue. #13348 replaced this with a per-run claim (`claimFollowUps`, `FollowUps.ts:112-138`, called at `toolUse.ts:150`), and `executeAgent.ts` no longer provides `followUpsLayer`.
2. [v] **Three release rules for one lease:**
   - Fresh root: `settleRun` (`runProgram.ts:252-256`).
   - Resumed root: `resumeRun.releaseRecovery` (`resumeRun.ts:374-386`). The run's own release is now the `release` that `claimFollowUps` returns (`FollowUps.ts:320-324`), a no-op when the claim holds no lease; there is no layer any more.
   - Child: always terminal (`childRunLoop.ts:795,1260`).
   - The CLI host also claims and releases (`chatSessionController.ts:458,749,897`).
3. [v] **The follow-up manager is a second in-process owner** (`ToolUseFollowUpQueueManager.ts:53-89`, 713 lines), with about 32 manual lease hand-offs in 6 files.
4. [v] **Three claim-and-terminal wrappers:** `runAgent.ts:177-312`, `executeAgent.ts:517-656`, `childRunLoop.ts:715-762,1290-1320`. `finalizeRun` has 8 callers.
5. [v] **Non-tool-use resume refusal** (`executeAgent.ts:557-563`). Workflow resume has two other routes: `HostRunActions.resume`, and the `executeWorkflow` port on four hosts.
6. [i] **A workflow child resumed via `resumeRun` has no driver,** so its result never reaches the parent (`resumeRun.ts:203-210,261-273`).
7. [v] **`onIdle` is dead on fresh launches** (`runAgent.ts:41`).
8. [v] **The resume launch context skips `ensureRunDirUnder`, the progress reveal and the start logs** (`executeAgent.ts:427-457` vs `535-578`).
9. [v] **A second idle/input loop for process children** (agent-CLI, background bash, workflow script): `childRunLoop.ts:1142-1230`.
10. [i] **`isChild()` reads the live handle** (`toolUse.ts:146`), so a mid-run detach flips its policy.
11. [v] **The CLI rewrites a run's outcome to FAILED** in `openWorkflowOutput` (`cli/commands/workflow.ts:375-414`), after the run's own terminal decision.

### Plugin

1. [v] **Plugin resources live in `ProcessServices`** (`processRuntime.ts:64-87`) and are merged unconditionally (`sessionLayer.ts:1181-1199`).
2. [v] **Core shutdown drains GitHub:** `sessionLayer.ts:1258`.
3. [v] **The SDK cannot opt out:** `toolRegistryLayer` is always merged (`:1194`), with a refusing `PACKAGE_SETUP` (`runtime.ts:88`).
4. [v] **Session state in module WeakMaps:** `agentCliSessionStores.ts:13-29`.
5. [v] **Goal grant WeakMap** (`goalAutoApproval.ts:25`), called from core (`continuationPolicy.ts:29,73`).
6. [v] **Continuation bodies live in core:** goal (`continuationPolicy.ts:56-80`) and rounds (`loop/rounds.ts`).
7. [v] **Plugin arms in the core schema:** `sessionEvent.ts:281,336,337,350,352,354-358,475-525`. `RunView` carries their fields (`sessionView.ts:198-216`).
8. [v] **Plugin skills and agents installed into slots**, with no fixed table (`BundledAgentDirectories.ts:25`, `runtimeSkills.ts:48`).
9. [v] **One switch, four readers with different semantics:**
   - Tools: `composition.ts:70-76`.
   - Agents: `BundledAgentDirectories.ts:44-67`.
   - Skills: `skillSources.ts:158-172`, using a different decoder.
   - A fourth enumeration that ignores the switch: the extension watcher (`packages/extension/src/frontend/agents/AgentDirectoryManager.ts:101-112`) calls `builtInToolUseRoots(dir)` with no disabled set, as does `SettingsAgentActions.ts:161`. Changed by #13359, which deleted the former fourth reader, `getAllLocal` (`AgentDirectoryService.ts:110`).
   - `getDisabledToolIds` does an unvalidated `get<string[]>` (`constants.ts:30,44-46`).
10. [v] **The toggle side effect is restated in two places** (three before #13359 deleted `desktopToolingSettingsController.ts`): the shared GUI body `src/controllers/settingsView/settingsToolCommands.ts:104-109`, used by extension and desktop through `sharedSettingsCommands.ts:140`, and the CLI `packages/cli/src/runtime/tools.ts:77-86`. Only the CLI checks `toggleable` (`tools.ts:81`).
11. [v] **"Plugin" names seven distinct things:** tool plugins, MCP loaded plugins, installed plugins, slash `pluginId`, provider plugins, skill sources, and plugin agent roots.
12. [v] **Two install records** (`~/.texra/mcp.json` and `texra.plugins.installed`), against the one-record ruling.
    - MCP servers have no switch.
    - An installed plugin loads only its skills (`cli/runtime/plugins.ts:1-3`).
    - An installed plugin's `enabled` flag uses `.default(true)` (`agentSkills.ts:46`).
13. [v] **VS Code LM tools bypass the composition** (`registerLanguageModelTools.ts:21,61`). No switch is bypassed today, but it is structural.
14. [v] **`resumeRun` hardwires `@tools/delegation`** (`resumeRun.ts:35`).
15. [v] **Plugin module caches:** `codexConfig.ts:26-27`.

### Composition

1. [v] **Availability comes from a module cache,** `?? []` before the first probe (`toolAvailability.ts:174,343-351`, read at `agentToolResolution.ts:239-241`). `'unknown'` counts as available, and `texra run` never probes.
2. [v] **The MCP revision is a per-process HMAC** (`mcpConfig.ts:70-74,201-203`). It feeds the `compositionHash` that the SDK and CLI output expose (`cliOutput.ts:75`), so the hash changes on every restart.
3. [v] **The host input is read from an ambient slot** (`AgentRun.ts:242`).
4. [v] **A child's key is its parent's** (`agentToolResolution.ts:250-252`). Its narrowing (`:261-363`) is not in the key, so its reported hash is wrong.
5. [v] **A resumed run (root or child) resolves its own composition, so it can widen,** bounded only by the recorded offered tools (`nativeSubagentStrategy.ts:49-53`, `AgentRun.ts:264-325`).
6. [v] **Second derivations of "which tools a run gets":**
   - Resume intersects the snapshot with a fresh resolve.
   - The `runTools`/`submit_output` overlay (`agentToolResolution.ts:408-418`).
   - Delegation annotations (`:387-407`, unhashed).
   - Workflow runs resolve a composition, then offer nothing (`AgentRun.ts:281-296`).
   - The dashboard's own "enabled" (`ToolDashboardData.ts:82-89,131-166`).
   - Skills and agents gates.
   - LM tools.
7. [v] **The composition is not in the log:** the snapshot has only `offeredTools` and `toolsetHash` (`runFlowState.ts:294-310`).
8. [v] **No presets exist,** only a comment (`composition.ts:10`).

### Pin

1. [v] **The composition is not pinned across resume** (`executeAgent.ts:393,547-550` → `AgentRun.ts:237-253`). Consequences:
   - The hash drifts.
   - Toggling goal mode between halt and resume changes the continuation.
   - A resumed child escapes its parent's pin.
   - Fix: record the `CompositionKey` on the opening snapshot and `pin(recorded)`.
2. [v] **Launch policy is not recorded:** `stopAfterCycle` and `approvalPromptsUnavailable` come from whoever resumes (`resumeRun.ts:405-408`, `executeAgent.ts:547`). An SDK headless run resumed from a GUI becomes interactive while its registration says `UNSUPPORTED` (`runAgent.ts:165-174`).
3. [v] **The definition is re-read live on resume** (`runAgent.ts:158`, `executeAgent.ts:535-540` → `agentLoad.ts:103-160`). Round mode re-renders the system prompt every round (`rounds.ts:188-195`), and the round total is read live on purpose (`rounds.ts:262-265`).
4. [v] **Settings are read mid-run:**
   - Every round: retry limit (`ModelInvoker.ts:1095-1100`) and compaction threshold (`compaction.ts:183`).
   - Every rebind: binding knobs (`modelBinding.ts:774-791,835,869-879`) and `modelRoutes.ts:368` ("read live" on purpose).
   - Workflow rounds: `documentRounds.ts:105`, `compileCheck.ts:72,130`, `LatexDiffManager.ts:244`.
   - Fix: capture them at open, or rule them live explicitly.
5. [v] **A fresh child can widen its injected tools** through a live `injectedWhen` read (`agentToolResolution.ts:201-213,325-336`). Fix: inherit the parent's `composition.injected`.
6. [v] **The probe cache as ambient input** (see Composition 1), which matters mainly through Pin 1.

### Continuation

1. [v] **Children skip the table:** `isChild() || continuation === null ? null` (`toolUse.ts:633-636`), and child fail versus root park is decided at `:623-624`.
2. [v] **`stopAfterCycle` finishes a run outside the policy** (`toolUse.ts:640-645,711-712`).
3. [v] **`/compact` on a round-mode run is dropped silently** (`toolUse.ts:534-537`) while the registry answers `requested` (`runRegistry.ts:366-371`).
4. [v] **"Takes input" is decided twice:** by category (`executeAgent.ts:465-476`) and by `continuation.rounds`. If they disagree, the run dies at `toolUse.ts:612` (before #13348 it could also trigger Run 1).
5. [v] **Category branches choose resume behaviour:** `executeAgent.ts:557-563`, `resumeRun.ts:203-210,257-273`, `hostRunActions.ts:627-631`, `AgentRun.ts:222-225,246,279`.
6. [v] **Goal prompt and builder are in core** (`bundledPrompts.ts:8-35`, `src/agent/goal/`).
7. [v] **The process-child loop makes its own park decision** (`childRunLoop.ts:1195-1230`).

### Request

**Second authorities and host decisions**

1. [v] **The CLI evaluates the policy** for plan, proposal, retry and question (`settleApprovals.ts:42-153`). Core opens those requests unconditionally (`PlanTool.ts:224`, `proposalFlow.ts:204`, `UserQuestionTool.ts:63`, `ModelInvoker.ts:984`). Fix: decide inside `openRequest`/`manualRetry` in the same commit.
2. [v] **The SDK denies every retry** regardless of policy (`sessionPrograms.ts:102-142`).
3. [v] **Approve-all cascade exists only in the TUI** (`approvalQueue.ts:447-476`), same run only. `policy.set` just flips the flag (`SessionRequests.ts:423-438`).
4. [v] **Own-key retry:** the GUI leaves it pending (`ProgressApiKeyRetryController.ts:66-71`); the TUI denies it (`subscribeApprovals.ts:162-220`).
5. [v] **The host orchestrates the Copilot fallback** by launching a replacement run and cancelling the retry (`hostRunActions.ts:427-561,685`). The TUI refuses the same offer.
6. [v] **The policy is a mutable field** (`SessionHandle.ts:381-394`), seeded by 9 host sites and never read back from rows.

**Bypass writers and grants**

7. [v] **Seven bypass writers:**
   - `SessionRequests.ts:428-434`
   - `MainViewRunLaunchController.ts:145`
   - `goalAutoApproval.ts:56,65`
   - `tools/approval/index.ts:35,41`
   - `chatSessionController.ts:649`
   - `runRegistry.ts:934`
   - `sessionLayer.ts:621,651`
   - The ratchet does not cover them.
8. [v] **`setDelegatedWorkBypasses(false)` writes an explicit `false`** (`runApprovalQueue.ts:340-348`).
9. [v] **A goal's restore clobbers a mid-goal user grant** (`goalAutoApproval.ts:54-66`).
10. [v] **The goal grant is lost on resume** (WeakMap, `:25`).
11. [v] **Every bypass is lost on resume in a new process.** Nothing hydrates `byRun` from the `approval.policy` rows; the only readers are `sessionFold.ts:935,1080`. The resume then republishes an empty snapshot over the durable row (`AgentLaunchContext.ts:378-391`). Fix: hydrate from the last row on acquire.
12. [v] **`SessionApprovals` is a synchronous mutable island** (`runApprovalQueue.ts:43-127,255-289`).

**Timing and atomicity**

13. [v] **Policy read at enqueue, bypass at dispatch** (`bashApproval.ts:80-86` vs `runApprovalQueue.ts:171-173`; `toolEditApproval.ts:247-262`).
14. [v] **Approve-for-session is two non-atomic requests** (`approvalDecision.ts:113-121`).

**Unrecorded decisions and missing gates**

15. [v] **Core auto-decisions leave no rows:** `bashApproval.ts:88-92`, `toolEditApproval.ts:264-268`, `runApprovalQueue.ts:172`, `proposalFlow.ts:188-202`. `ModelInvoker` does record its own.
16. [v] **Headless runs approve workflow-script proposals without a recorded decision.** `settleApprovals.ts:69-71` (and `approvalPolicy.ts:109-113` for headless `ask`) sets `approvalPromptsUnavailable`, and `proposalFlow.ts:200-202` then approves. The approval is deliberate: `proposalFlow.ts:192-199` explains that the proposal is a review surface rather than the security gate, `requiresApproval` delegation tools are already withheld, and bash and edits stay denied downstream. What remains wrong is item 15's: the automatic decision leaves no `request.opened` / `request.decided` rows.
17. [v] **Four `requiresApproval` tools have no call-time gate** and run unprompted on GUI hosts: `ConfigTools.ts:142`, `UnsetApiKeyTool.ts:85`, `InvokeCommandTool.ts:97`, `InstallVscodeExtensionTool.ts:87` (line numbers as of `d1bf738`; the audit's `a53db0e` pin cited them one line earlier each). **Fixed by #13363**: `toolGuard.ts`'s `guardRefusal` now asks at call time for every tool with `requiresApproval: true`, not only ones that also declare a `guard.bash`/`guard.writes`.
18. [v] **Five tools are approved as `bash`** (`toolGuard.ts:74-91` as of the audit's `a53db0e` pin; the same grant check is now `toolGuard.ts:99-106`): MCP, codex, claude_code, wolfram, send_to_terminal. Approve-for-session on any of them is blanket shell approval. **Fixed by #13363**: `requestBashApproval`'s `grant` is `'shell'` only for the `bash` tool itself; every other tool is asked per call, so approving one cannot become blanket shell approval.
19. [v] **Tool-edit approve/reject detour through `host.request`** (`ToolEditRequestPanel.ts:54-81`). The edited content is already in the `request.decide` payload (`request.ts:28`), so only the detour remains.

**Retry owners and extra writers**

20. [v] **Second and third retry owners:** `helperModel.ts:81-115` (its own schedule, ungated), and compaction (`compaction.ts:261-279`, no gate or pricing). The session-scoped gate (`sessionLayer.ts:588`) sits under account-wide credentials.
21. [v] **A failed manual rebind is only a warning,** but `declinedRoutes` still commits (`ModelInvoker.ts:1050-1066`).
22. [v] **`RunLedger.acquire` publishes `request.decided` cancels directly** (`RunLedger.ts:318-330`), bypassing `decideRequest`. It is a third decision writer.

### Host

1. [v] **Four resume implementations:**
   - Extension: default session only (`extension.ts:208-217`).
   - Desktop: scans every session (`desktopAgentResume.ts:56-65`).
   - CLI: only while the TUI is mounted (`cliAgentResume.ts:23-43`).
   - SDK: always false (`node.ts:69-71`).
2. [v] **The desktop Resume defect** (see Session 4).
3. [v] **`sendFollowUp` bypasses `SessionRequests`** (`hostRunActions.ts:582-618`, `forkDetach` at `:617`).
4. [v] **The CLI buffers follow-ups after Ctrl-C in memory** (`chatSessionController.ts:367-368,1006-1069`).
5. [v] **The CLI root-run slot machine:** the `rootRunId` signal plus five unsafe `Deferred`s (`cliState.ts:215`; `chatSessionController.ts:620,707,874,1026,1092`).
6. [v] **Own-key retry and approve-all differ per host** (Request 3 and 4).
7. [v] **Approval policy is evaluated in the CLI and SDK** (Request 1 and 2).
8. [v] **Tool-edit wiring is copied** (`ProgressViewProvider.ts:298-331,393-419` vs `desktopAgentRun.ts:132-182`), about 15 lines each now.
9. [v] **The tool-edit detour** (Request 19).
10. [v] **Hosts decide from the view:** a desktop-only `exportTranscript` refusal (`desktopHostRequests.ts:383`; the extension has none at `extensionHostRequests.ts:340`), plus `desktop/main/index.ts:1118,1124` and `ProgressViewProvider.ts:743,761,770`.
11. [v] **Desktop IPC routes by heuristic** (`hostBridge.ts:13-20`).
12. [v, child effect i] **Presentation runs inside the run:** `documentRounds.ts:390-420` has no root/child check, and each host supplies its own `openWorkflowOutput`.
13. [v] **The CLI ignores `agentOutputs.autoOpenFinal`**, although the setting declares `honoredBy: everyHost` (`stateSettings.ts:403-407`).
14. [v] **Static singletons:** `ProgressViewProvider._instance` (5 readers) and `SupabaseAuthProvider.instance`.
15. [v] **The `AgentDirectoryManager` singleton is imported ambiently by 2 modules** (`ProgressViewProvider.ts:49`, `SettingsViewMessageHandler.ts:20`; 6 before #13359) instead of the `AgentDirectories` service. The port is now `agentDirectoriesLayer` (`AgentDirectoryManager.ts:220`), which builds `AgentDirectoryService` directly over `AppState`.
16. [v] **Creator-agent roots are registered only by the extension** (`frontend/setup.ts:36-114`), so `userVars.ts:283-292` renders `''` elsewhere.
17. [v] **The CLI ignores the custom agents directory** (`cliProcessRuntime.ts:227`).
18. [v] **CLI `heldMessage`** (`modelConnection.ts:51-68`) exists only in the CLI.
19. [v] **Desktop window teardown is not awaited:** `Scope.close` is forked at `index.ts:323,935,1016,1527`, quit resumes at `:1558`, and there are 31 `runFork` calls in `packages/desktop/src/main` (19 in `index.ts`; 33 before #13359 deleted the tooling controller).
20. [v] **The webview pending map is never settled** (`sessionTransport.ts:91,143-150,221-224`).

### Missing concepts: verdicts

- **Agent definition / catalog → a separate concept.** It is what a Run pins.
  - Today it has 3 parses of the local format: the scanner `agentYamlScanner.ts:186,248-281`, the launch loader `agentLoad.ts:67-150` with its own inheritance walk, and the wizard validator `agentLoad.ts:32`. Remote is a fourth parse.
  - About 22 defensive `loadAgents` calls; module state in `agentRegistry.ts:63-90`.
  - `AgentDirectories` is built four ways; the SDK builds it with empty dirs (`packages/agent/src/node.ts:73-78`).
  - The watcher exists only in the extension.
  - A failed remote fetch is recorded as success (`remoteAgentList.ts:87-93`, `agentRegistry.ts:199-201`).
- **Model binding / route / credential → a separate concept,** with `ModelInvoker` as its only caller.
  - Invoker bypasses: compaction, `helperModel` (3 callers, own retry), the Copilot probe (`SettingsViewMessageHandler.ts:375-395`, now `completedTurn(model.streamTurn(...))` since `generateTurn` was retired) and voice transcription (`hostDraftRequests.ts:247-257`).
  - A global dispatcher, with no production `fetch` injection.
  - `LanguageModel` and `EditorModel` use two conventions for "absent".
  - Only 3 `ModelError` kinds are read; the rest is re-derived from `sdkError` (1,542 lines).
  - The retry _permit_ belongs to Request; the gate's scope belongs here.
- **Workspace roots / storage → part of Host (supplies roots) and Session (keyed by storage root).**
  - Two types are both named `WorkspaceRoots` (`src/platform/workspaceRoots.ts:17` vs `src/controllers/session/WorkspaceRoots.ts:19`); remove the collision.
  - Split application state out as its own concept (below).
- **Trace → part of Log/Fold.** Its facts are rows through the publisher. Handle lifetimes belong to the Run's scope. Current violations:
  - The root stage has two closers (`AgentLaunchContext.ts:409-424` and `finalizeRunTerminal` `AgentRunLifecycle.ts:157`, also driven from `childRun.ts:135`).
  - `ModelInvoker` streams are closed only in `finishAttempt` (`:443-462`) [interrupt effect i].
  - Claude and Codex item cards are never swept (`claudeAgent.ts:236`, `codex.ts:260`).
- **Claim / liveness → part of Log (write authority) plus Process (owner identity).**
  - Liveness is a kernel pid plus start-identity probe (`leaseOwnerLiveness.ts`); no presence sockets exist.
  - Second and third in-process owners: the follow-up leases with `adoptedClaim` (`QueueManager:60-89`) and `RunRegistry` activations (`runRegistry.ts:91-165`).
  - Three claim doors (Log 4).
- **Tool / tool call → a tool is part of Plugin (a contribution to the tool seam); a tool call is part of Run and Log.** `ToolCall.ts` is an invocation context, not a concept. Two argument-parse layers exist (`run/tools.ts:146`, `definition.ts:68-81`), and that is fine.
- **Child-run edge → part of Run**, as `run.start.parent`/`run.detach`.
  - `child.turn` is side-folded outside RunState (`runRecords.ts:57-73`).
  - The child budget is a Session resource.
  - Delete the derivations in Fold 3.
  - `sessionGraph.ts` is the session-owner port, not the #13306 graph. That graph is `runRelation.ts` plus the follow-up relation.
- **Output / artifacts → part of Plugin (`documents`) plus Log. Presentation is part of Host.** Output is stored three times (Log 6), `runRecords.writeWorkspaceFiles` (`:231`) is dead, and the CLI's outcome rewrite (Run 11) breaks "Run owns its terminal".

**Additions I recommend to the set:**

- **Follow-up / Inbox** (`followup.queued`/`consumed`, `src/agent/followUp/*`). This is the run's input and, since #13306, also inter-run messaging. It is distinct from Request.
- **Application state / settings** (the Zod catalog, `AppState`, `state.value.set`). One concept with 3 homes:
  - AppState: extension/CLI global DB, desktop profile DB (`desktop platform/index.ts:172`), SDK memory store (`node.ts:64`).
  - `WORKTREE_SHARED_KEYS` (now 12 keys): global DB, desktop profile DB, CLI project DB.
- **Approval policy / grant** as a named sub-concept of Request. It currently has 3 row writers and an in-memory owner.
- **Non-run aggregates** (`inquiry`, `workflow-checkpoint`, `app-state`, `session`, `desktop-projects`, `update-check`, `global-inquiry`; `sessionEvent.ts:117-126`). The set has no home for them.

**Folded into existing concepts:**

- Workflow scripts are a second loop under the child driver: part of Run, as a Plugin driver.
- Goals: part of Plugin plus Continuation.
- Skills and MCP servers: part of Plugin.
- Usage / pricing: part of Model binding, with the usage log as a Host sink.
- Accounts, secrets and `AppSignals`: part of Process.
- Inquiry: part of Request.
- Transcript export: part of Fold.

### Note claims that are stale on 4311c54

- **Fixed:** `writeApprovedContent` no longer overwrites; it fails with `ApprovedEditConflictError` (`approvedWrite.ts:111-118`). #13355 also made `mergeEditOnto` a bounded positional three-way merge.
- **Already landed:** the edited content is already in the `request.decide` payload (`request.ts:28`).
- **Partly fixed:** the "quadratic descendant walk" now has an inverse index; the O(subtree×depth) resolve in `setBypass` remains.
- **Wrong:** "workflow resume drops `modelCompatibilityKey`". The key is recovered from the snapshot (`AgentLaunchContext.ts:351-354`, `AgentRun.ts:327-335`).
- **Wrong:** move 11's "the composition is pinned" is false (Pin 1).
- **Describes a target, not the code:** move 3's "child workflow runs resumed by a driver" does not exist today.
- **Wrong place:** the goal-grant WeakMap is at `goalAutoApproval.ts:25`, not `AgentLaunchContext.ts:383-389`. `installProcessRuntime` is in `sessionLayer.ts`, not `processRuntime.ts`.
- **Undercounts:**
  - Module slots: about 28, not about 14 (about 30 before #13359).
  - "Plugin" names seven things, not six.
- **Should not be deleted:** `teardownDefaultSession` is live.
- **Changed since the note:** the `runAgent` double lineage read is now deliberate; `ToolUseFollowUpQueueManager.ts` is 713 lines, not 729; the tool-edit copy is about 15 lines per host, not about 60.
- **Line drift:** `Database.ts` decode is at `:162-185`; `sessionView.ts` at `:198-216`; `runApprovalQueue.ts` at `:340-348`; `cliProcessRuntime.ts` at `:227`; `runProgram.ts` at `:160-167`; `extension.ts` at `:846-847`.

### Found but not in the note

- **Process / Session:**
  - `installedProcessRuntime` ambient lookup; unguarded owner overwrite; global `disposal` latch.
  - Two live-session registries; `RunSubscriptionRegistry` holding session state at process scope.
- **Log / Fold:**
  - Three claim doors; config duplicated in `run.record`; inquiry duplication; the view-derived durable `relation`.
  - Six follow-up derivations; the evicting terminal set; goal check-then-act from the view.
- **Run / Pin / Continuation:**
  - Three lease-release rules; the parent-queue compaction leak (fixed by #13348).
  - The unrecorded launch policy; live mid-run settings reads; child injected-tool widening.
- **Plugin / Composition:**
  - A child's hash is its parent's; a resumed child can widen; one switch with four readers; two install records.
- **Request:**
  - The SDK retry-deny; the host Copilot fallback; every bypass lost on resume; the goal restore clobbering a mid-goal user grant.
  - Non-atomic approve-for-session; unrecorded core auto-decisions; CLI `never` auto-approving proposals; `RunLedger` cancel writer.
- **Host:**
  - The desktop-only export refusal; the CLI ignoring `autoOpenFinal`; the CLI outcome rewrite.
  - The `AgentDirectoryManager` singleton; external skill roots widening the allowlist across sessions [i].
