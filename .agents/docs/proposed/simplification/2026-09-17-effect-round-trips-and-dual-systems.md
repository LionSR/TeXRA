# Effect round trips and the remaining dual systems: the 1.0 clean-up ledger

Date: 2026-09-17
Baseline: `main` at `0bfb72448c45d6ca3b80a3f1210d58bcb05fcd55`.
Origin: two adversarially verified surveys run the same day. The first mapped
every Effect run and every Promise-to-Effect lift in production from both
directions (110 run files, 159 lift files, 236 agents). The second audited the
six 1.0 architecture plans item by item against `main` and hunted dual systems
through ten cross-cutting lenses (126 agents). Every candidate below survived
two independent refuters; refuted candidates are listed at the end so nobody
re-mines them.

Owner direction this note serves: 1.0 ships completely clean. Every tech debt
is eliminated, not ledgered, and every dual system collapses to one mechanism.

## 1. What the surveys measured

### 1.1 Round trips

The effect-migration ratchet's `Effect.run*` row is empty, so nothing counts
the remaining Effect-to-Promise-to-Effect sandwiches: they hide behind
Promise-returning faces, not bare run calls. Measured on the baseline:

| Direction               | Count                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Run sites (hosts + SDK) | 551 in 110 files: 197 host entries, 116 pass-through runner faces, 72 detached forks, 6 named entries, 4 SDK                        |
| Lift sites              | 409 in 159 files: 168 foreign edges, 99 round trips, 84 Promise-native in-repo callees, 43 port members, 14 deliberate double wraps |
| Round-trip candidates   | 106, of which 100 confirmed and 6 refuted                                                                                           |

The 100 confirmed round trips are about twenty Promise faces lifted
repeatedly. Three faces account for a third of the list: the auth program edge
(`installAuthProgramEdge` / `runAuthProgram`), the host-request `handle` face
that `SessionBridge.handleHostRequest` forces on both graphical hosts, and the
desktop preview host's `openExternal` / `openPath` / `openBuildDisplay` fan-out.

### 1.2 Dual systems and plan drift

Of 75 open items across the six plans, most are stale rather than open. The
flow engine, the model-handler hierarchy, `KVStore`, the file-based execution
lease, `fileLocks`, native cleanup, the `ExecutionId` and `StreamTabId`
vocabularies, the ambient session fallback and the `p-queue` / `p-retry` /
`p-defer` family are all gone on `main`; the plans still describe several as
live. All of the one-run-model steps S0 to S6 landed.

Fifty-six lens findings deduplicated to 54 candidates; 21 confirmed, 33
refuted. What remains clusters in four places:

1. Three `AsyncLocalStorage` carriers beside Effect context. One of them,
   `RunContext`, is write-only: its store is entered at
   `src/agent/runtime/RunContext.ts:153` and read nowhere in the repo.
2. The Promise filesystem family (`BaseFS`, `AbsoluteFS`, `RelativeFS`,
   `WorkspaceFS`, `StorageFS`, `GlobalStorageFS`, the `FileSystemProvider`
   port and `Platform.fs`) beside Effect `FileSystem` and the rooted views. It
   holds ten of the thirteen remaining `platform()` calls and three ambient
   reads, and the `workspaceRoots` carrier cannot go until it does.
3. Two readers for a cataloged setting, and in the CLI a whole second config
   parser and precedence ladder beside `JsonConfigProvider`.
4. Run-tier mirrors: `AgentLaunchContext` re-declares twelve `AgentRun`
   facts, the `ActiveChildInfo` roster mirrors the fold's `childIds`, and the
   approval-bypass fact travels a durable row and a fire-and-forget port.

## 2. Rulings taken

The surveys raised open questions. Per the standing owner instruction, the
recommended option is taken and recorded here; a different answer reopens the
affected lane.

- **Preview host "permanent Promise face".** `src/hosts/uiHosts.ts:33` and
  `packages/desktop/src/main/desktopPreviewHost.ts:34` record an owner ruling
  that the desktop `openExternal` / `openPath` / `openBuildDisplay` fan-out
  stays Promise-shaped. Five confirmed round trips exist only because of it,
  and `ExternalOpener.openExternal` has since become an Effect-typed port
  (`packages/desktop/src/main/index.ts:1320`). Under the 1.0 clean rule the
  fan-out is an R1 adapter; it converts after the host-request lanes.
- **Layers may capture their own runtime for an outbound foreign Promise
  contract.** `SupabaseAuth.onFlowState` owes `@supabase/auth-js` a Promise
  storage callback. `Effect.runtime()` inside the layer is the standard
  bridge, so the auth program edge can be deleted.
- **The auth probes need no workspace-roots frame.** `getCodexStatus` and
  `getXaiStatus` read no ambient roots (zero hits under `src/auth`), so the
  `inScope` wrap around them in `computeModelOptions.ts` is defensive and an
  Effect probe closed over the secret store needs no frame.
- **A host's webview inbound handler registry is an R1(a) terminal**, so
  `SettingsAgentActionsOptions.run` can be deleted and failure reporting moves
  to each host's registry; the `FAILURE_MESSAGES` text stays exported from
  the shared module.
- **`stream_id` stays frozen** in the log-usage edge function as the one
  permanently frozen external spelling of the run id, on the same
  minimum-supported-client basis already ruled for the usage-route tolerance.
  The rename in the one-run-model note is struck.
- **`texra tools list --json` and `texra skills list --json` change shape**
  when the CLI adopts the shared projections; the change is noted in the
  changelog because `texra-action` consumes CLI result JSON.
- **The CLI keeps its cheap built-in default model**; the constant is renamed
  to say it is a deliberate cheap-start choice derived from the shared table.
- **`AgentPlatform` re-declares `agentResume` and `languageModel`** so the
  embedder contract is unchanged while `Platform` loses both fields.

## 3. The lanes

Each lane is one PR: one worktree, one reviewer, one Promise face or one
vocabulary deleted together with all its consumers. Net-element estimates
are the surveys' and must be re-measured in the PR body (`## Net elements
(R6)`, `## Consumer counts (R8)`). Lanes marked "held" wait on the open PR
#12676 (`refactor/single-caller-and-deferred-cuts`), which edits
`computeModelOptions.ts`, `modelRoutes.ts`, `AgentLaunchContext.ts`,
`RunScope.ts`, `packages/cli/src/commands/workflow.ts`,
`ProgressViewProvider.ts`, `hostDraftRequests.ts` and `loopbackLogin.ts`.

### 3.1 Round-trip lanes (delete a Promise face)

| #   | Lane                                 | Files                                                                                                                             | Shape                                                                                                                                                                                                                          | Net                                               | Order                       |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | --------------------------- |
| R1  | accepted-file-target ports           | `src/latex/acceptedFileTarget.ts`, `compareCommands.ts`, `desktopProgressFileActions.ts`                                          | Delete the four Promise fs members of `CommitAcceptedFilePorts` / `AcceptEditedFileReplacePorts`; the programs read `FileSystem.FileSystem` from context. Both hosts implement all four as `runtime.runPromise(fs.<op>(...))`. | 4 port members, 9 closures, ~-50 LoC              | launched                    |
| R2  | desktop host-request dispatch        | `desktopHostRequests.ts`                                                                                                          | `dispatch` becomes one `Effect.gen`; `handle` runs it once instead of lifting it with `tryPromise` and running it again. Delete `rejectRequest`.                                                                               | 14 runs, 1 double wrap, ~-30 LoC                  | launched                    |
| R3  | resume hooks                         | `src/agent/runtime/resumeRun.ts`, four providers                                                                                  | `ResumeRunOptions.executeWorkflow` and `onResumeResolved` become Effects; all four providers already hold one.                                                                                                                 | 2 hooks, 2 lifts, 3 runs, ~-20 LoC                | launched                    |
| R4  | signed-in probe                      | `signedInProbe.ts`, `codexSignedIn.ts`, `xaiSignedIn.ts`, `installTexraAccountProbes.ts`, `computeModelOptions.ts`                | `SignedInProbe` returns an Effect; `runAuthProgram` leaves the installer.                                                                                                                                                      | 4 lifts, ~-27 LoC                                 | held (#12676)               |
| R5  | CLI model-access chain               | `packages/cli/src/runtime/modelAccess.ts`, `runModel.ts`, `doctor.ts`, callers                                                    | Convert the four-deep Promise chain over `readModelAvailabilityInputs` to Effect; the only runs left are the citty actions and the Ink form load.                                                                              | 4 exports retyped, ~-20 LoC                       | held (#12676)               |
| R6  | subscription usage service           | `SubscriptionUsageService.ts`, `apiStatus.ts`, two host constructors                                                              | `defaultCredentials` and the adapter members become Effects; `getUsage` is an Effect program with a keyed `Deferred` for coalescing.                                                                                           | flat LoC; unblocks R7                             | after R1 to R3              |
| R7  | auth program edge delete             | `src/auth/authProgram.ts`, `SupabaseAuth.ts`, two status composers, three host installs                                           | Delete `AuthProgramEdge`, `installAuthProgramEdge`, `runAuthProgram`, `rethrowPortCause`; `onFlowState` captures its runtime.                                                                                                  | 3 exports, 1 process-global slot, ~-50 LoC        | after R4, R6                |
| R8  | extension host-request handle        | `extensionHostRequests.ts`                                                                                                        | Twin of R2: the body becomes `Effect.gen`; the `runCommand` foreign wraps stay.                                                                                                                                                | ~-5 LoC; setup for R9                             | after R2                    |
| R9  | SessionBridge host-request port      | `SessionBridge.ts`, both hosts, `ProgressViewProvider.ts`                                                                         | `SessionBridgeOptions.handleHostRequest` becomes an Effect; both hosts' Promise `handle` faces and their last runs go.                                                                                                         | 2 faces, 2 runs, ~-10 LoC                         | after R2, R8; held (#12676) |
| R10 | settings agent-directory actions     | `SettingsAgentActions.ts`, `SettingsAgentControllerFactory.ts`, `agentHandlers.ts`, `desktopAgentSettingsController.ts`           | Delete the `run` runner-face member and retype seven Promise members; delete the four host lambdas that demote `AgentDirectoriesPort` to Promise.                                                                              | 1 member deleted, 7 retyped, ~-25 LoC             | after R6                    |
| R11 | extension SupabaseAuthProvider       | `SupabaseAuthProvider.ts`, `authCommands.ts`                                                                                      | Delete `settleAuthEffect`; `waitForSession`, `afterLocalSessionCleared`, `clearStoredSession`, `removeStoredSession` compose as Effects. Only the `vscode.AuthenticationProvider` contract keeps a Promise face.               | 1 helper, 5 lifts, ~-25 LoC                       | independent                 |
| R12 | subscription sign-in presenter       | `subscriptionProviders.ts`, `loopbackLogin.ts`, `desktopCredentialSettingsController.ts`, desktop `index.ts`                      | `presentSignInUrl` and `openBrowser` become Effects, bound to the existing Effect-typed `ExternalOpener`. Preserve the open-before-wait ordering and the transport-unavailable typing.                                         | ~-18 LoC                                          | held (#12676)               |
| R13 | runAgent host hooks                  | `runAgent.ts`, `executeAgent.ts`, `AgentRunLifecycle.ts`, five providers                                                          | `openWorkflowOutput`, `beforeLeaseRelease`, `onRun` become Effects in one PR (same interface).                                                                                                                                 | flat LoC; boundary correctness at the loop's edge | held (#12676)               |
| R14 | tool-edit approval host              | `ToolEditApprovalController.ts`, `toolEditApproval.ts`, `latexPreview.ts`, both host previews                                     | Delete the `runPreview` runner-face member; the hand-rolled settle promise becomes a `Deferred`. Split the `Deferred` change out first.                                                                                        | 1 member, 5 runs, ~-35 LoC                        | held (#12676)               |
| R15 | CLI chat run-claim slot              | `chatSessionController.ts`, `sessionRunState.ts`, `cliAgentResume.ts`, `runChatTui.tsx`                                           | `TuiSession` holds a `Deferred` or `Fiber` instead of a `Promise<void>`; `tryResumeRun` becomes the Effect its port declares and the `CliResumeHandler` indirection goes. Dogfood via `texra-local` before merge.              | 6 runs, 3 lifts, ~-35 LoC                         | after R3, R5                |
| R16 | run-storage fs readers               | `runStorageFs.ts`, `AcceptRunFilesTool.ts`, `ExecutionsTool.ts`, `childRunOutput.ts`, `runOutputFiles.ts`, `runWorkspaceFiles.ts` | The Promise readers become Effects over the `FileSystem` service; `executionsRead` and `ExecutionsReadFailed` go.                                                                                                              | 1 helper, 1 class, 5 lifts, ~-20 LoC              | folds into D19              |
| R17 | draft-request media                  | `src/tools/media/audio.ts`, `hostDraftRequests.ts`, `pastedImageUtils.ts`                                                         | The recording state machine becomes an Effect with `Effect.timeout` and a `Ref`; the result object becomes a failure channel.                                                                                                  | ~-15 LoC                                          | held (#12676)               |
| R18 | CLI shutdown and presentation detach | `executeCli.ts`, `logSinks.ts`, `sessionProgressSubscription.ts`, `cliPresentationHost.ts`                                        | The three local helpers become Effects (`Effect.cached` for the memo); keep the post-dispose stderr fallback in `writeRawAndWait`.                                                                                             | 4 lifts, 3 run pairs, ~-25 LoC                    | independent                 |
| R19 | preview-host fan-out                 | `desktopPreviewHost.ts`, five desktop callers                                                                                     | Under the refreshed ruling in section 2, the fan-out becomes Effect-typed and the five remaining round trips go.                                                                                                               | 5 round trips                                     | after R9                    |

Thin single-file round trips that fold into whichever lane opens the file:
`AgentDirectoryManager.runSettledEffect`, `desktopProjects.stopProjectRuns`,
`register.ts` `promptToAddAgentToConfig`, `instruction.ts` dialogs. The
`showLoggedErrorMessage` duplicate wraps are a notification-consolidation
item, not a round trip.

### 3.2 Dual-system lanes (delete a vocabulary or mechanism)

| #   | Lane                                                               | Owner  | Shape                                                                                                                                                                                                               | Net                                          | Order                                                      |
| --- | ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| D1  | Delete the write-only `RunContext` carrier                         | #12025 | `withRunContext` becomes `runWithWorkspaceRoots(session.roots, fn)`; delete `createRunContext`, `withLaunchRunContext`, seven types; regenerate the ratchet.                                                        | ~-190 LoC, 5 exports, 1 of 3 ALS instances   | held (#12676 edits `AgentLaunchContext.ts`, `RunScope.ts`) |
| D2  | One per-key lane                                                   | #12072 | `KeyedMutex`, `lakeCommands.serializeOnWorkspace`, `runApprovalQueue.laneOf` collapse onto `withPerKeyLane`; drop `async-mutex` from both manifests and delete the ratchet row.                                     | ~-65 LoC, 1 class, 1 dependency              | independent                                                |
| D3  | Delete `Platform.agentResume` and `Platform.languageModel`         | #12073 | Zero production readers; each root registers the same port twice. Re-declare on `AgentPlatform`.                                                                                                                    | ~-30 LoC, 2 fields off the frozen `Platform` | independent                                                |
| D4  | Delete the `<latex_document>` extraction tier                      | new    | A compatibility reader with no writer since #7094.                                                                                                                                                                  | ~-30 LoC, 1 union member                     | independent                                                |
| D5  | `SessionOwner` global onto the `Sessions` tag                      | #12424 | Delete `sessionGraph.ts:189-220` and `initSessionOwner`.                                                                                                                                                            | ~-35 LoC, 1 global                           | independent                                                |
| D6  | One `exitCode` field on the tool row                               | new    | Emitters write `exitCode` once; delete `normalizedExitCode`, `EXIT_CODE_PROSE` and three synonym reads.                                                                                                             | ~-35 LoC                                     | independent                                                |
| D7  | Carry Copilot route access once                                    | new    | Fold the three `copilot-*` availability kinds onto `LanguageModelAccessState`.                                                                                                                                      | ~-40 LoC, 2 enum members                     | independent                                                |
| D8  | Delete two zero-reader capability vocabularies                     | new    | `LanguageModelPortError` + its code table; `OpenAIResponseProviderCapabilities` (8 of 9 fields unread).                                                                                                             | ~-90 LoC, 3 exports                          | independent                                                |
| D9  | One channel for approval-bypass state                              | new    | Delete `setApprovalBypassState`, its relay, the CLI NDJSON table; the `approval.policy` row is the fact.                                                                                                            | ~-65 LoC                                     | independent                                                |
| D10 | Delete the `ActiveChildInfo` roster                                | #11861 | Re-source `run.children` from `childIds` plus each child's `RunView`; delete the listener, emit, roster and drain apparatus.                                                                                        | ~-155 LoC                                    | independent                                                |
| D11 | Inline the desktop settings pass-through ports                     | #12661 | Two single-implementer ports over already-shared functions.                                                                                                                                                         | ~-45 LoC, 2 interfaces                       | independent                                                |
| D12 | One reader for a cataloged setting                                 | #12424 | `getValidatedConfig` / `readValidatedConfig` / `readToggle` collapse onto `readSetting`; fixes the global-versus-merged divergence on `modelProviderToggle` rows.                                                   | ~-80 LoC                                     | independent                                                |
| D13 | Single-source approval-policy normalization                        | new    | Delete the `normalizePersisted` hook; one lenient input schema on the approval-policy module.                                                                                                                       | ~-25 LoC, 1 contract field                   | independent                                                |
| D14 | Collapse the CLI config stack                                      | #12424 | `cliConfig.ts` reads through `JsonConfigProvider` and catalog rows; deletes three vocabularies and a divergent ladder; fixes `/config` writes ignored at startup.                                                   | ~-300 LoC net                                | after D13                                                  |
| D15 | Delete two CLI re-derivations of shared projections                | new    | `CliToolStatusRecord` and `CliSkillRecord` render the shared items.                                                                                                                                                 | ~-150 LoC                                    | independent                                                |
| D16 | Catalog rows for desktop-only commands                             | new    | Ten rows with a host marker; one unbranched menu map.                                                                                                                                                               | ~-35 LoC                                     | independent                                                |
| D17 | Strip PocketFlow from live review automation                       | new    | Four `.github/prompts` files, the simplifier agent, `debt-audit.js`; extend `GUIDANCE_DIRS`.                                                                                                                        | 1 false review invariant                     | independent                                                |
| D18 | Rooted filesystem prep                                             | #12421 | Add `GlobalStorageFs`; delete dead `createReadStream` / `createWriteStream`; move `fsEntryType` consumers onto `File.Type`.                                                                                         | ~-64 LoC                                     | independent                                                |
| D19 | `WorkspaceFS` / `StorageFS` consumers onto rooted services         | #12421 | 42 call sites in three commits (memory, agent directory, path-only).                                                                                                                                                | ~-160 LoC, 3 classes                         | after D18                                                  |
| D20 | `AbsoluteFS` / `RelativeFS` consumers onto Effect `FileSystem`     | #12421 | 56 call sites; `runOutputFiles` takes `readDirectoryTyped`.                                                                                                                                                         | ~-85 LoC, 2 classes                          | after D18                                                  |
| D21 | Delete `BaseFS`, the filesystem port and `Platform.fs`             | #12421 | Terminal slice; `platform()` row 13 to 3.                                                                                                                                                                           | ~-570 LoC, 4 files                           | after D19, D20                                             |
| D22 | Delete the `workspaceRoots` carrier and the process-roots fallback | #12421 | Convert 14 readers to explicit roots; delete `rootsScope`, `processRoots`, six exports; collapse `roots.globalState` onto `AppState` (landable first).                                                              | ~-120 LoC, 1 ALS instance                    | after D21, D12                                             |
| D23 | Delete `AgentRun.inScope`                                          | #12025 | Nothing left to enter.                                                                                                                                                                                              | ~40 call sites simplified                    | after D1, D22                                              |
| D24 | `TraceEmitter` stage scope onto `Context.Reference`                | #12025 | The third ALS instance and a `Promise.resolve` bridge.                                                                                                                                                              | ~-20 LoC                                     | independent                                                |
| D25 | Retire the `AbortController` residents                             | #12422 | `childRunLoop`'s `ChildRunInterruptible` becomes fiber interruption; `slashContext` becomes `Effect.abortSignal`; `claudeAgent` and `lifecycleHost` are named permanent in a hard allowlist and the row is deleted. | ~-30 LoC, 1 row                              | independent                                                |
| D26 | `SessionHandle` `DisposableStore` onto a `Scope` finalizer         | #12422 | One session lifetime, one finalizer stack.                                                                                                                                                                          | ~-20 LoC                                     | independent                                                |
| D27 | Thread the `ManagedRuntime` from each root                         | #12073 | Delete the `effectRuntime` export and the module global after nine readers take the runtime.                                                                                                                        | ~-20 LoC, 1 global                           | independent                                                |
| D28 | Loop collaborators as Effects                                      | #12070 | Nine internal Promise adapters in `toolUse.ts` / `reflection.ts` and `hostRunActions.loadModelOptions`.                                                                                                             | ~-150 LoC                                    | independent                                                |
| D29 | Collapse `AgentLaunchContext` into `AgentRun`                      | #12025 | Twelve facts declared twice; fold `RunScope` in.                                                                                                                                                                    | large share of 717 LoC                       | after D1                                                   |
| D30 | Effect-importer catch row to zero                                  | #12073 | Two sites, then delete the row; batch the `catchTag` exhaustiveness audit (#12612).                                                                                                                                 | 1 row                                        | independent                                                |
| D31 | Retire the promise-boundary audit note; record five rulings        | #12073 | Fold its four live rows into #12421, #12078, #12422; write the `effect/unstable` module decisions and the runtime-threading answer into the rulings ledger.                                                         | 1 stale ledger                               | docs                                                       |
| D32 | Finish the project rename                                          | new    | Mechanical `task` to `project` in the desktop shell and run storage, no aliases.                                                                                                                                    | 0 net                                        | quiet window                                               |
| D33 | Render the run label in the goal list                              | new    | `GoalTab.ts:125` shows bare hex.                                                                                                                                                                                    | ~+15 LoC                                     | independent                                                |
| D34 | Close the 1.0 release gates                                        | #12168 | Prerelease-admitting publish path; user-facing note that 0.40 state is not imported.                                                                                                                                | shipping blocker                             | independent                                                |
| D35 | Storage and file-ownership remainders                              | #11867 | Inquiry metadata onto SQLite; a durable owner for run-directory removal; reflection recovery digest.                                                                                                                | design                                       | after D19                                                  |
| D36 | Measure the acceptance gates or strike them                        | #12076 | One measurement record for cold open, stop latency, commit latency; strike the rest.                                                                                                                                | docs                                         | independent                                                |
| D37 | Shrink the test-tier baselines                                     | #12528 | `host-agent-mock` tuples out via per-test layers; test-runtime hygiene.                                                                                                                                             | baseline shrink                              | independent                                                |

## 4. Plan corrections to write back

- `2026-09-10-collapse-duplicate-concepts.md` §3: the survivor is `RunId`, not
  `ExecutionId`; the blast-radius counts are all zero on `main`;
  `CLI_LOCAL_STREAM_ID` was deleted, not retyped; §7 pins rc.112 (main pins
  rc.115); §8's `p-queue` defect is repaired, but `CLAUDE.md` still blesses
  "the existing per-key ordering helper", which D2 retires.
- `2026-09-10-one-run-model.md`: S3 is not pending; all steps landed. §3.10's
  target is `AgentRun`, and `RunContext` is a deletion, not a merge. The
  `normalizeToolUseData` row over-promised; only the exit-code synonym repair
  (D6) is debt. The `stream_id` rename is struck (section 2).
- `2026-09-09-texra-1-0-implementation-plan.md` §2 and §3 describe a runtime
  that no longer exists; the compatibility-key and compaction rows are not
  retirement targets; §7's issue dispositions are stale.
- `2026-09-15-effect-native-completion-protocol.md`: `platform()` is 4 files
  / 13 sites, ambient 18 / 26, catch 2 / 2; `currentSession` and
  `defaultSession` do not exist in production, but `packages/agent/dist/types`
  still advertises them (rebuild).
- `2026-08-26-effect-4-runtime-migration.md`: §15 decisions 4 and 5 shipped;
  R1's boundary kind (b) is dead twice over (the tool method is `call` and
  returns an Effect; the ratchet records the kind as retired by #12337).
- `2026-09-07-promise-boundary-audit.md`: retire (D31).

## 5. What we give up

- The synchronous run-claim handshake in the CLI TUI (R15) becomes a
  fiber-scoped claim. The synchrony is load-bearing against two concurrent
  launches only if the resume path and the launch path can race; the lane
  must prove which before choosing `Deferred` over a `Ref`-guarded claim.
- The `ActiveChildInfo` roster (D10) reported `running` one commit before the
  fold reads `ready`; the `run.children` record widens its status literal by
  `ready` rather than restating the one-commit-early rule.
- An interactive TUI run with `--output-format ndjson` loses three
  approval-bypass records (D9); that path is undocumented and
  self-contradictory, and the loss is stated rather than hidden.
- `texra tools list --json` and `texra skills list --json` change shape
  (D15, section 2).
- The desktop settings suites that inject fakes through the deleted ports
  (D11) move to an Effect `Context` service seam.

## 6. Acceptance criteria

- No production Promise-returning function whose body only runs an Effect;
  no port member kept Promise-shaped because its port was Promise-shaped. The
  round-trip survey's method (both directions, then verify) re-run on the
  finished tree returns zero confirmed round trips outside the R1 boundary
  kinds and the named runtime entries.
- One `AsyncLocalStorage` instance at most in production, and only if a dated
  ruling names it; the `ambient:asyncLocalStorage` ratchet row is deleted,
  not zeroed.
- `platform()` retains only `lifecycle`, `agentDirectories` and
  `toolMissingHandler`; `Platform.fs`, `Platform.agentResume` and
  `Platform.languageModel` are gone.
- `async-mutex` is absent from every manifest; `import:async-mutex` and
  `new AbortController()` rows are deleted with their permanent residents
  named in the script's hard allowlist.
- The six plan documents either match `main` or are retired; no proposal
  carries a census more than one release stale.
- Every ratchet baseline shrinks or is deleted; none widens.

## 7. Risks

- **Bare `vi.fn()` host doubles.** Every port that becomes Effect-typed makes
  a bare `vi.fn()` double return `undefined` where an Effect is required, and
  vitest fails at runtime, not typecheck. Each lane greps its suites first.
- **`Effect` is not thenable in rc.115.** `await effect` resolves to the
  Effect object. Every touched `await` is checked.
- **Collisions.** #12676 is open and conflicting; the held lanes wait for it.
  R6, R10 and R12 share `desktopCredentialSettingsController.ts` and
  `desktopAgentSettingsController.ts` and run serially. D1, D29 and R13 all
  touch the run-tier files and run in that order.
- **Silent forked failures.** #12675 records that unhandled forked fiber
  failures are silent; no lane introduces a new `runFork`.
- **The CLI shutdown flush.** R18 must keep the post-dispose stderr fallback
  in `writeRawAndWait`, or the CLI drops its last stderr line.

## 8. Refuted candidates (do not re-mine)

Round trips: `executeCommand` (56 files; a program, not a lane);
`checkToolInstalled` / `runToolWithCheck` (gated on it); `renderPrompt`
(repo-wide); `LifecycleHost.onShutdown` (four-host port flip, SDK is R1(c));
the `packages/llm` interruption double wraps (deliberate); `StateStore.update`
(no Effect on its path); the five refuted lifts over `withProgress`, Ink
`waitUntilExit`, `vscode.commands.executeCommand`.

Dual systems: the two host-request routers (one union, two hosts, settled
layout); `LifecycleHost` versus the `ManagedRuntime` scope (A composes B);
the child run's `AbortController` (three of five strategies need a real
signal); Memento versus SQLite app state (one port, two adapters; the raw
Memento bypass is the smaller real item); `SettingSlots`; `classifyRun`
versus `resolveRunLiveness`; the docs-action channels; the seven
`openExternal` declarations; the `*_SETTING` descriptors; `SettingsStatePorts`;
the three workspace-file write vocabularies; the approval-policy host
mirrors; the trace domain escape hatch (only the `missingOutputs` double emit
is real); launch failure through three channels (ruled); refusal as failure
versus throw; failure classification markers; `ModelError` class-name
sniffing (the residue is precedence, not a dual); retry-policy synonyms (only
the duplicated jitter `Schedule` is real, and it must move to a host-neutral
module); the TUI `Surface` twin (only `expandedRuns`, five lines; belongs to
#11861); the GitHub-token flow (raise the desktop `promptForSecret` copy under
#12428); the onboarding and bypass copy; two subscription catalogs (the
browser-safe contract forbids merging; a third copy of display names is the
residue); availability versus usage route (the real item is a GLM display
bug: no availability arm, so the picker shows full price while the run bills
zero); `ModelCompatibilityKey` versus `TurnProtocol`; zero-cost route price
override; `BoundModel` mirrors (only `contextWindow` is derivable);
`stream_id` at the usage boundary (ruled permanent); the trace-viewer dual
load; the double-ledgered run boundary; the double `shared -> agent` gate;
the two test process-runtime installs (#12529).
