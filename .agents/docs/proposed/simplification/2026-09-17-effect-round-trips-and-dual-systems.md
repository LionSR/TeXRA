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

## Status (2026-09-19)

Written back against `origin/main` at `b133beba3c`, two days after the ledger
merged (#12681), and extended at `ca4e74a597` with wave 5. The clean-up ran as
five waves: this ledger's own R and D lanes, three censuses of what they left,
and the final re-survey. 116 PRs merged between #12693 and #12828, three of
them dependency bumps. Each row names the PR that carried the lane; "thin
folds" are the single-file items section 3.1 said would ride whichever lane
opened the file.

### Landed

Waves 0 and 1 are the lanes this ledger itself named.

| Lane | PR                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | #12695                                                                                                                                                                                                                                                                                |
| R2   | #12693                                                                                                                                                                                                                                                                                |
| R3   | #12694                                                                                                                                                                                                                                                                                |
| R4   | #12711                                                                                                                                                                                                                                                                                |
| R5   | #12760                                                                                                                                                                                                                                                                                |
| R6   | #12729                                                                                                                                                                                                                                                                                |
| R7   | #12739                                                                                                                                                                                                                                                                                |
| R8   | #12706                                                                                                                                                                                                                                                                                |
| R9   | #12724; the channel's error typing finished in #12740, #12748, #12752                                                                                                                                                                                                                 |
| R10  | #12719 (runner face), #12726 (Effect-typed controller)                                                                                                                                                                                                                                |
| R11  | #12702                                                                                                                                                                                                                                                                                |
| R12  | #12715                                                                                                                                                                                                                                                                                |
| R13  | #12731                                                                                                                                                                                                                                                                                |
| R14  | #12736, after the dead-field prep in #12718                                                                                                                                                                                                                                           |
| R15  | #12728                                                                                                                                                                                                                                                                                |
| R16  | #12747 (folded into the D19 root threading, as planned)                                                                                                                                                                                                                               |
| R17  | #12716                                                                                                                                                                                                                                                                                |
| R18  | #12722                                                                                                                                                                                                                                                                                |
| R19  | #12734 (`openExternal`, `openPath`); the third member closed in #12786                                                                                                                                                                                                                |
| D1   | #12705                                                                                                                                                                                                                                                                                |
| D2   | #12696; the ratchet row retired for good in #12700                                                                                                                                                                                                                                    |
| D3   | #12697                                                                                                                                                                                                                                                                                |
| D4   | #12701                                                                                                                                                                                                                                                                                |
| D6   | #12701                                                                                                                                                                                                                                                                                |
| D7   | #12701                                                                                                                                                                                                                                                                                |
| D8   | #12711                                                                                                                                                                                                                                                                                |
| D9   | #12708                                                                                                                                                                                                                                                                                |
| D10  | #12698                                                                                                                                                                                                                                                                                |
| D11  | #12719                                                                                                                                                                                                                                                                                |
| D12  | #12703                                                                                                                                                                                                                                                                                |
| D13  | #12703                                                                                                                                                                                                                                                                                |
| D14  | #12727                                                                                                                                                                                                                                                                                |
| D15  | #12707                                                                                                                                                                                                                                                                                |
| D16  | #12704                                                                                                                                                                                                                                                                                |
| D17  | #12704                                                                                                                                                                                                                                                                                |
| D18  | #12712                                                                                                                                                                                                                                                                                |
| D19  | #12737 (memory, agent directory, pasted image; deletes `GlobalStorageFS`), #12742 (workspace root as data; deletes the `WorkspaceFS` static), #12744 (path location), #12747 (storage root through run storage; deletes the `StorageFS` statics)                                      |
| D20  | #12749, #12754, #12758: the `src/latex`, `src/tools`, settings-view, `src/agent` and `src/utils` `AbsoluteFS` consumers move onto the Effect `FileSystem`                                                                                                                             |
| D21  | #12771: `BaseFS`, `AbsoluteFS`, `FileSystemProvider`, `nodeFilesystem` and `Platform.fs` deleted                                                                                                                                                                                      |
| D22  | #12774: the workspace-roots `AsyncLocalStorage` carrier and `runInSession` deleted, with `RunContext.ts`; no `new AsyncLocalStorage` remains in production                                                                                                                            |
| D23  | #12774: `AgentRun.inScope` and `ToolCall.inScope` deleted with the carrier                                                                                                                                                                                                            |
| D24  | #12699, by deletion: the stage scope was never entered in production, so it went rather than moving onto `Context.Reference`                                                                                                                                                          |
| D27  | #12738                                                                                                                                                                                                                                                                                |
| D28  | #12714                                                                                                                                                                                                                                                                                |
| D29  | #12717                                                                                                                                                                                                                                                                                |
| D30  | closed by ruling in #12700: the two remaining catches (`packages/desktop/src/main/index.ts`, `src/tools/github/PollingSourceBase.ts`) are named permanent beside the row, which stays at its floor as the hard allowlist; #12709 and #12713 deleted the redundant catches around them |
| D31  | #12720                                                                                                                                                                                                                                                                                |
| D32  | #12743                                                                                                                                                                                                                                                                                |
| D33  | #12704                                                                                                                                                                                                                                                                                |
| D34  | #12725                                                                                                                                                                                                                                                                                |
| D36  | #12720                                                                                                                                                                                                                                                                                |
| D37  | #12721                                                                                                                                                                                                                                                                                |

Thin folds that landed on their own: #12735 (three dead leftovers), #12746
(`releaseToolEdit` as an Effect, dead `approvePendingForRun`), #12750 (the
`HostInteractions` plane's `emit`, replay and dispose as Effects; the session's
teardown list replaces the `DisposableStore`), #12751 (the LaTeX-diff commands
as one Effect program each), #12755 and #12756 (the `openRunStorage` rename and
the "task storage" noun sweep), #12762 (workflow file actions; run storage off
the Promise tier), #12763 (`texra doctor` as one Effect program). The settings
and config funnel D22 needed landed as #12759, #12761, #12769, #12770 and
#12772: explicit stores, `writeSettingTo`, and `workspaceRootPath` retired.

#### Wave 2: the acceptance re-survey's lanes

The first acceptance re-survey ran at `5a8b011f470d` and was not clean: 74
confirmed round trips (down from 100), collapsing to about 55 run sites behind
16 Promise faces and ports. It produced 16 lanes.

- Lane 1, the settings read ports on both hosts: #12775.
- Lane 2, `LifecycleHost` and `RuntimeShutdownHooks` as Effect across four
  hosts and the SDK: #12799, which adds `withProcessServices` and deletes
  `runSettlement`.
- Lane 3, `BuildDisplayFn` as a program end to end, with `inFlightActions`
  holding a `Deferred` and a `Fiber`: #12786. This also closes the third
  member of the R19 fan-out.
- Lanes 4 and 12, the CLI agent catalog and the platform bootstrap: #12788,
  which closes the six runs inside the init.
- Lane 5, the extension settings-view webview transport: #12790.
- Lanes 6 and 13, the diff-view host and the desktop file actions: #12793.
- Lane 7, the tool-probe layer: #12787, which deletes `fsCall` and the
  `AbortSignal` parameters.
- Lane 8, the four logged-notification helpers: #12810.
- Lane 9, `HostInteractions.emit` takes Effect-returning handlers: #12795. The
  port's `unknown` answer is gone; its `R` stays `never` and the extension
  discharges its services at its own boundary.
- Lane 10, the desktop composition root's host-request ports: #12797.
- Lane 11, the onboarding funnel ports on both hosts: #12791.
- Lane 14, the VS Code editor and diagnostics waits: #12785.
- Lanes 15 and 16, the agent-core callbacks and owner liveness: #12782.
- Transcript export as a typed channel end to end: #12784, where
  `getController` becomes `Effect.cachedWithTTL`.
- Run-record reads carry `DatabaseReadFailed` instead of squashing to `Error`:
  #12792, which also deletes a redundant `RunRecordSchema` re-parse.
- Small cuts: #12783 (the test-only workflow run-directory override; the review
  checklist's four deleted config accessors) and #12789 (two dead desktop
  exports, the warning-dialog parent lookup inlined).

#### Wave 3: the host-neutral census

Census at `5c33788d35`: 81 host-neutral files, 146 sites (100 convert, 28
foreign-once, 6 host-entry, 7 browser, 5 type-only), nine lanes.

- team-availability-choose: #12800.
- prompt-vars-and-skills: #12798.
- subscription-usage-fetch: #12794, which wraps the fetch inside its own
  callee.
- agent-config-and-lm-ports: #12801.
- agent-cli-turn: #12796, which composes the provider turn as one Effect.
- auth-when-ready, workflow-script-retry-fiber and workspace-info-and-dead-lift:
  #12802, as three small seams in one PR.
- Small cuts beside the wave: #12805, one shared in-flight pandoc probe through
  `Effect.cached`, plus a dead desktop-auth test stub.
- review-diff-simple-git was refuted at implementation; see below.

#### Wave 4: the host-package census

Census at `993e8d81ad`: 146 host files, 492 sites (316 convert, 124 host-entry,
48 foreign-once), ten lanes.

- cli-tui-submit-chain: #12816.
- cli-store-reader-commands: #12806.
- cli-prompt-commands: #12809.
- cli-workflow-output: #12807.
- cli-models-doctor-misc: #12808.
- cli-context-and-prompts: #12811.
- cli-tui-paste-and-approvals, with the `/config` writes and the retry key
  checks: #12812. The `ProviderApiKeyForm` thunk stays; see Open.
- desktop-controller-internals: #12813, with the startup re-probe forked on the
  runtime in #12817.
- extension-command-surface: #12818.
- Two defects these lanes introduced and their reviewers caught: #12814 (the
  resume preflight's reader and probe interleaving) and #12815 (an unparsable
  `package.json` candidate no longer fails CLI startup).

#### Wave 5: the final re-survey's host-package faces

Final re-survey at `b133beba3c`: 30 confirmed chains collapsing to 17 distinct
Promise faces, every one of them in `packages/cli`, `packages/desktop` or
`packages/extension`. The host-agnostic tree held no round trip left, only
Promise-native leaves that each Effect caller wrapped at its own site. Eight
PRs closed it.

- #12820, refactor(desktop): close four desktop round trips (shell open,
  project stop, prompts, catalog refresh). Deletes the Promise faces of
  `openWorkspaceFolder`, `stopProjectRuns`, `DesktopPromptController.request`
  and the two catalog-refresh ports, with `hostCall` and the project registry's
  `runtime` option; the prompt controller becomes `Effect.callback`, so an
  interrupted caller's resolver is removed by the finalizer instead of
  surviving to window teardown.
- #12821, refactor(cli): make the CLI Supabase sign-in an Effect program.
  `signInCliSupabase` becomes an `Effect.acquireRelease` over the loopback
  callback server, deleting four runs, three lifts and `CliLoginOptions.signal`.
- #12822, refactor(cli): close three small Promise faces (log flush, init
  config writes, resume TUI handoff). `LogSink.flush`, the init config writers
  and the resume command's TUI handoff become Effects, and
  `CliShutdownStepFailed` ceases to exist.
- #12823, refactor(extension): close the file-dialog and progress-view Promise
  faces. Thirteen Promise faces and nine lifts go across agent registration,
  `@frontend/ui/dialogs` and `ProgressViewProvider`, whose `attach` is now a
  program; net seven runs fewer, with the eight that remain at R1 host entries.
- #12824, refactor: close the last host-neutral Promise leaves (process
  identity, external-binary and SDK probes). `nodeProcesses` identity, the
  external-binary resolver and the Claude and Codex SDK importers become
  Effects, which collapses `ProcessRuntimeOptions.processStart`'s three-way
  union and deletes the `catch {}` that swallowed an unresolvable platform
  package.
- #12825, refactor(utils): make executeCommand Effect-native and convert its
  callers. `executeCommand` returns `Effect.Effect<ExecResult>`, fiber
  interruption replaces the hand-rolled abort, timeout and force-kill block,
  and fifteen lifts go; `options.signal` survives for background bash alone,
  which needs a result from a command its own stop signal terminated.
- #12826, refactor(desktop): close the desktop auth and settings-poster round
  trips. Sixteen Promise faces go with twenty-one runs and `runAsyncInPaper`,
  covering the ChatGPT sign-in chain, the auth-surface refresh,
  `signInAndWaitForSession` and the eight settings-view posters.
- #12828, refactor(cli): make the CLI platform init an Effect program.
  `initCliPlatform` becomes `Effect.Effect<CliPlatformServices, Error>`,
  `initLocalCliPlatform` and `initInteractiveCliPlatform` are deleted, and
  every command entry installs or joins the process runtime once and runs one
  program on it.

### Refuted or declined at implementation

- **D5** (`SessionOwner` onto the `Sessions` tag): refuted by the call-site
  read in #12699's lane. The tag is module-private to `sessionLayer.ts` and
  reading it from `src/agent` adds the `agent -> controllers` edge the port
  exists to avoid; two of the five owner faces are synchronous and serve the
  process-shutdown sweep with no fiber to wait on; and
  `sessionOwnerInstalled()` is not `tryProcessRuntime() !== null`, because
  the SDK's `composeProcess` depends on the window between the two clears.
  The global is a port, not a second mechanism. Do not retry as specified.
- **D26** (`SessionHandle` `DisposableStore` onto a `Scope` finalizer):
  refuted in the same lane. The store is the synchronous early teardown the
  async Scope cannot express: `graph.close()` runs it inline before
  `release(key)`, so a borrowed entry stops admitting runs at once. Moving the
  registrations onto the Scope would defer that for the length of the borrow,
  and would lose the idempotent double unwind and the per-disposer catch.
  #12750 later made `unwind()` itself the program while keeping the inline
  ordering.
- **D25** (`AbortController` residents): conversions declined in #12700,
  which names the four residents beside the ratchet row. The child strategy
  `signal` feeds execa, the Codex SDK and the Claude Agent SDK, which require
  a real `AbortSignal`; `ChildRunInterruptible` to fiber interruption is an
  interrupt-contract change across `RunHandle`, `RunRegistry` and the
  strategies, not a row edit; `abortableSlashCommand` needs a forked fiber
  and `interruptUnsafe`, which #12675 rules out. Two of the four rows have
  since gone with their files; the other two stay at the floor.
- **D35a** (inquiry metadata onto SQLite): already done before the ledger was
  written. Commit `090ce86bc4` (2026-09-09, "persist global inquiry records
  in SQLite") landed it; the ledger carried it forward from a stale plan row.
- **review-diff-simple-git** (wave 3): built, measured and removed from
  #12802. Wrapping `simple-git` once inside `reviewDiff.ts` deletes zero lifts,
  adds two runs (`AgentReviewService.executeReview` and the review options
  prompt) and costs +43 LoC against a predicted -6, because
  `Effect.all(..., { concurrency: 'unbounded' })` is longer than `Promise.all`
  at each of four fan-out sites. Retry only when `executeReview` is itself an
  Effect program; today the collection sits before the `try`/`catch` that
  restores the pre-run snapshot, so folding it in would move the collection
  inside that catch.
- **A corrupt-record tag on run-record reads** (#12792): refuted. `decodeEvent`
  (`src/controllers/session/Database.ts`) already folds a Zod fault into
  `DatabaseReadFailed`, so there is no second condition to name. The lane typed
  the channel and deleted the redundant `RunRecordSchema` re-parse instead. A
  per-row tag, if it is ever wanted, belongs in `decodeEvent` and is a change
  over every read of the store.
- **Cutting `src/auth/**` out of the SDK declaration graph** (#12789, #12805):
  refuted twice, with measurements. Deleting
  `packages/agent/src/effect/runtime.ts`'s `@auth/SupabaseAuth` import emits
  the identical 38 `dist/types/src/auth/**.d.ts` files: the real edges are
  `src/agent/runtime/modelRoutes.ts` (`@auth/codex`, `@auth/xai`) and
  `src/tools/setup/platform.ts`, which are model routing. The six tagged-error
  knip rows are load-bearing for that emit: un-exporting them fails the SDK
  build with twelve TS4023 errors, because the `Data.TaggedError` base carries
  a symbol TypeScript can only reference through the class's exported name.
- **The knip `unused` category is exhausted** (#12789): after two rows closed,
  the remaining ten are correct suppressions rather than debt. Six are the auth
  tags above; four desktop exports are reached by
  `src/test-kernel/desktop/loadSourceModule.ts`'s computed `file://` imports,
  which knip cannot follow statically, and one of them
  (`isAllowedExternalUrl`) is a security boundary whose only coverage is there.
  Do not re-mine.
- **`DesktopPtyHost.create` as an Effect** (#12813): built, measured, reverted.
  The file would become a runtime `effect` importer, which the
  `catch:effect-importer` row (frozen at two files) then requires to hold no
  catch site. Two of its five are irreducibly synchronous (`handle.resize`
  after process exit, `handle.dispose` over `child.kill()`), so they need
  `Effect.runSync` in a module that holds no runtime, widening
  `BARE_EFFECT_RUN_SITES`. Measured cost: +21 LoC for one lift removed. The
  node-pty dynamic import is already a foreign edge wrapped exactly once.
  Re-file once the host is handed a `ProcessRuntime`.
- **A typed failure on the subscription-usage fetch** (#12794): refuted at the
  call sites. `SubscriptionUsageHttpError | UnknownError` would reclassify a
  malformed body and a 401 as `request_failed`
  (`SubscriptionUsageService.ts`, and `authProgram.ts`'s `settleFailure`, which
  unwraps `AuthPortError` only), and handing the fetch the fiber's
  `AbortSignal` instead of the caller's `AbortSignal.timeout` would drop
  `requestTimeoutMs` entirely.
- **`initCliPlatform` and its two siblings** (#12788): declined at the time. Of
  their ~25 call sites, 22 are R1 citty actions or the Ink entry and only three
  re-lifted the promise. Retyping would ripple into ~20 command modules and ~12
  suites that stub it with `mockResolvedValue`, for one net lift removed; the
  lane closed the six runs inside the init instead. Superseded by #12828, which
  took the ripple as its whole subject and deleted both siblings.
- **`NdjsonStdoutSink.flush` and `writeRawAndWait`** (#12788, #12811):
  declined. `flush` has two genuine Promise consumers plus the shutdown hook,
  so converting adds two runs and changes the shared `LogSink` interface;
  `writeRawAndWait` runs after the process runtime is disposed, so its Effect
  form needed a bare `Effect.runSync` and was reverted. The raw write stays
  quarantined in the effect-free `bestEffortStreamWrite.ts`. #12822 later took
  `flush` after all, by retyping the `LogSink` member itself; `writeRawAndWait`
  stands refuted, and the evidence is below.
- **`readCliStdinText`** (#12811) and **`runResumeCommand`** (#12807): not
  round trips. `materializeStdinWorkflowInput` already wraps the
  `process.stdin` edge exactly once with no caller re-lifting it, and
  `resume.ts`'s citty `run(ctx)` awaits the promise at an R1 entry.
- **`models.ts` and `installGithubAction.ts` as one program each** (#12808):
  declined. Both would need a run where no runtime exists yet, which is a new
  `BARE_EFFECT_RUN_SITES` pin, so the init stays the Promise edge with one run
  per command after it.
- **`onApprovalPolicySelect` as an Effect** (#12816): declined.
  `src/shared/settingsView/handlers/stateSettingWrite.ts` calls it and discards
  the result, so an Effect there would silently never run and `/config`'s
  approval row would stop reaching the live session.
- **`installCliProcessRuntime` as a program** (#12828):
  refuted. `packages/cli/src/runtime/cliProcessRuntime.ts:92` is the true
  bootstrap edge, so there is no runtime to run it on, and an Effect face there
  forces a bare `Effect.run*` at every citty action: `BARE_EFFECT_RUN_SITES`
  would grow from 7 CLI entries to about 20. Its Promise face is what lets each
  command await the install and then run exactly one program. Its own internal
  run cannot move either until `installProcessRuntime` stops taking `appState`
  as a value (`src/controllers/session/sessionLayer.ts:1045`), which is a
  cross-host core change.
- **`defineCliCommand`'s `run`** (#12828): stays `Promise<number>`
  (`packages/cli/src/commands/_helpers/defineCliCommand.ts:27`). Effect-typing
  it would collapse about 15 entry runs into one, but it types 35 command
  handlers, two of which are entirely Promise-native; `installGithubAction.ts`
  has no `effect` import and does have `try`/`catch`, so pulling it in would
  trip `catch:effect-importer` for a file that lane had no business touching.
  Worth its own lane.
- **`processStart` does not collapse to `string | undefined`** (#12824). The
  survey asked for that; `composeProcess`
  (`packages/agent/src/effect/runtime.ts:180`) is a deliberately synchronous
  public composition root, so it cannot resolve the read.
  `Effect.Effect<string | undefined>` is the collapse actually available: one
  type, one layer construction, and the package's own call site unchanged.
- **`codexBinarySupportsXhigh`** (#12824, then closed by #12825): deferred, not
  refused. Its body is `executeCommand` and its in-flight dedup was a
  `Map<string, Promise<boolean>>` with no behavior-identical Effect spelling,
  so #12824 wrapped it once at its call site and #12825 converted it in place
  once `executeCommand` answered in Effect, with `withPerKeyLane` for the
  dedup. One delta is recorded there: where the probe is deliberately not
  cached (timeout, exit 127) a second caller now re-probes instead of sharing
  the first `false`, which is that branch's documented intent.
- **`DesktopSupabaseAuth.signOut` and
  `DefaultDesktopAgentSettingsController.runReported`** (#12826): not round
  trips. Nothing lifts either one. `signOut`'s whole consumer chain is Promise
  consumers, and converting it would drop the `settleFailure(cause)`
  translation its rejection carries at `desktopSupabaseAuth.ts:491`;
  `runReported`'s six callers are four registry arms and two `async` arm
  bodies, so an Effect face would move one run into six rather than delete any.
- **`pathExists`** (#12822): stays `Promise<boolean>`
  (`packages/cli/src/runtime/initConfig.ts:46`), so `commands/init.ts:159`
  keeps one `Effect.promise`. Its second caller,
  `packages/cli/src/commands/installGithubAction.ts:170`, sits inside a
  Promise-native citty action, where an Effect callee means a bare
  `Effect.run*` in a file the run-boundary allowlist freezes.
- **`writeRawAndWait` and `writeTextStderrAndWait`** (#12822): stay
  Promise-shaped (`packages/cli/src/runtime/logSinks.ts:170`, `:209`).
  `flushTextStderr` wraps that one `stream.write` callback edge once, which is
  what deletes the lift at the shutdown sequence; converting the primitive
  itself pulls in `runtime/interruptedResumeHint.ts:23`,
  `chat/tui/sessionExitController.ts:193`, `commands/workflow.ts:357`,
  `runtime/executeCli.ts:216` and three suites' mock bags, all Ink and SIGINT
  exit paths. That is a CLI teardown lane.
- **`createSampleProjectWithoutWorkspace`** (#12823): keeps its Promise face
  (`packages/extension/src/commands/system/sampleProjectCommands.ts:35`). It is
  registered directly as a VS Code command at `extension.ts:594`, so its single
  run is an R1 host entry, and converting it would push two runs into
  `extension.ts` to delete one. Its body is an `Effect.gen` that yields
  `selectFolder`.

### Open

Two owner rulings gate the rest.

- **Ruling wanted: the shared `MessageHandler` dispatcher contract**
  (`src/shared/utils/dispatcher.ts`). It is Promise-shaped and types a webview
  frontend as well as both graphical hosts, so it holds the desktop settings
  view's roughly 40 registry arms at one `runtime.runPromise` each and is the
  single largest adapter source left, around twenty of them. #12820, #12823 and
  #12826 each stopped at it by design. Changing it is a shared-contract
  decision, not a lane, and the webview side has to move with it.
- **Ruling wanted: whether a cancelled CLI loopback sign-in should recover the
  session** as it did before #12821. The ruling recorded in section 2 takes the
  recommended option, interruption, because a fiber cannot observe its own
  external interruption as a value in rc.115. Restoring the old semantics means
  restoring a run edge, that is, a Promise face, so it needs the owner's word
  before anyone builds it.

The rest are ordinary lanes.

- **The CLI config-forms remainder**: `ProviderApiKeyForm.onSave` and
  `ApiKeySaveHandler` leave one `runtime.runPromise` in `registerBuiltins.tsx`,
  and `ErrorHandler`'s `void | Promise<void>` ripples into `CliConfigForm`.
- **`shellRun`'s quiet parse failure** (`packages/cli/src/commands/tools.ts`):
  `Effect.orElseSucceed(() => null)` preserves the old `catch {}` exactly.
  Making it loud is a behavior change and needs its own PR.
- **`packages/cli/src/runtime/browser.ts`** (`tryOpenBrowser`) is deferred and
  spans five callers across the CLI commands and the GitHub token form.
- **Desktop host ports that are still Promise-shaped**: `onCredentialChanged`
  (`desktopCredentialSettingsController.ts:125`, lifted at `:372`) is a real
  round trip that fell between wave 5's two desktop lanes, each of which left
  it to the other; `confirmAcceptFile`, `showInstructionDialog` and
  `showErrorDialog` on `DesktopAgentRunHost`; and `DesktopSettingsUiHost`'s
  `revealRun`, `openExternal` and `confirmAction`, which are Promise-native
  rather than round trips. `getEnvironmentSummary` keeps one run behind the
  Promise-shaped workspace IPC port.
- **`window.showErrorMessage` is wrapped twice**: `VscodeMessageHost.notify`
  for the action-less toast and `VscodePromptHost.showMessage` for the
  answerable one, under different failure tags and return types. Collapsing
  them means merging the two ports, which is a `src/hosts/uiHosts.ts` decision
  with desktop and CLI implementations behind it.
- **`runGuardedLatexCommand`'s `operation`** stays `(guard) => Promise<void>`,
  lifted once, with eight `runtime.runPromise` calls inside the
  `vscode.window.withProgress` bodies it serves.
- **The progress view's catalog-refresh callback**:
  `runAfterAgentCatalogAuthRefresh` still keeps a `() => Promise<void>` queue
  fed by two view providers, and `ProgressViewProvider.ts:470` settles three
  programs in one `Promise.all` inside it. #12823 closed the sibling
  `refreshAfterCredentialChange` and left this one, because nothing lifts it
  and its signature belongs to the catalog module.
- **The process-roots holder**: `processWorkspaceRoots` and
  `tryProcessWorkspaceRoots` (`src/platform/workspaceRoots.ts`), read at four
  sites in three files (`sessionGraph.ts`, `configUtils.ts`'s
  `getConfigBeforePlatformInit`, `platformSettings.ts`'s
  `processSettingsStores`). It is the one named ambient singleton left after
  #12774 deleted the carriers, and it retires when `SessionHandleInit.roots`
  becomes required. Ruled and recorded in the architecture rulings ledger.
- **The `working_directory` worktree gate**
  (`src/tools/delegation/inputFields.ts`) is a static Zod `.transform` reading
  the process slots. Moving it into `execute` turns a schema rejection into a
  tool error, so it is a behavior decision rather than a threading change.
- **D35b and D35c**: a durable owner for run-directory removal, and the
  reflection recovery digest. Design, unstarted.
- **No re-survey since wave 5.** The final re-survey at `b133beba3c` is what
  produced wave 5; the tree at `ca4e74a597` has not been measured again, and
  the acceptance criterion below asks for exactly that.

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
- **Cancelling a CLI loopback sign-in reports as interruption** (2026-09-19,
  #12821). The old Promise face re-awaited `callbackServer.waitForSession` on a
  fresh fiber when a storage commit had already begun and returned the session
  despite the abort. A fiber cannot observe its own external interruption as a
  value in rc.115 (probed against `Effect.exit`, `Effect.result` and
  `uninterruptibleMask`), so only a run edge turns that interrupt into data.
  What the recovery actually bought moves into the `acquireRelease` release
  half, which waits for an in-flight commit before closing the loopback server;
  the recovered-session semantics live in the release half or not at all. No
  production caller ever observed the old recovery, because the one caller that
  passed a signal wrapped the call in `Effect.tryPromise`, which abandons a late
  resolution on interrupt.
- **The desktop OAuth callback deadline starts when the wait program runs**
  (2026-09-19, #12826). `waitForCompletion` still installs its `Deferred` and
  the attempt's settle hook where the attempt is claimed, so an early callback
  still resolves it, but the 10-minute `AUTH_CALLBACK_TIMEOUT_MS` clock no
  longer runs concurrently with `signInWithOAuth`, `openExternalUrl` and the
  "Complete sign-in in your browser" dialog. The concurrency-exact version was
  built and backed out: `Effect.forkChild` does not start eagerly in rc.115
  (measured), so it neither preserved the old start point nor survived the
  fake-timer assertion. Revisit only if a user reports a stale deadline.

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
| D35 | Storage and file-ownership remainders                              | #11867 | A durable owner for run-directory removal; reflection recovery digest. (Inquiry metadata was already SQLite rows before this ledger was written: `090ce86bc4`, 2026-09-09.)                                         | design                                       | after D19                                                  |
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
  retirement targets; §7's issue dispositions are stale. Its two
  inquiry-metadata rows (the `writeAtomic` caveat and step C) are struck as of
  2026-09-18: inquiry records have been SQLite rows since `090ce86bc4`
  (2026-09-09), so `writeAtomic`'s caveat covers memory files and CLI input
  history only.
- `2026-09-15-effect-native-completion-protocol.md`: `platform()` was 4 files
  / 13 sites, ambient 18 / 26, catch 2 / 2 when this ledger was written, and is
  3 / 3, 3 / 4 and 2 / 2 as of 2026-09-19; `currentSession` and
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

**Measured outcome (2026-09-19, after wave 5).** Lines were not the win;
elements were. Across waves 2 to 5, `git diff --shortstat
9bd6f99dd4..origin/main -- src packages` reports 367 files changed, 14,111
insertions and 12,170 deletions, a net of +1,941 lines; over the whole campaign
(`0bfb72448c..origin/main`) it is 810 files, 32,316 insertions and 29,591
deletions, a net of +2,725. The pattern held per lane: roughly +10 to +90 lines
for `Effect.fn` and `Effect.gen` bodies and for typed failure channels, against
ports, wrappers and Promise faces that ceased to exist, so the surveys' LoC
estimates were unreliable while their element claims held. Wave 5 is the
clearest case: #12828 is +263 lines and deletes a Promise face, two exported
wrappers, one pinned bare run, six lifts and four `try`/`catch` blocks.

What shrank is the element count and the ratchets.
`config/ratchets/effect-migration-baseline.json` went from five rows to four:
`import:async-mutex` was deleted with `src/utils/core/keyedMutex.ts`,
`platform()` fell from 4 files / 13 sites to 3 / 3, `ambient:asyncLocalStorage`
fell from 18 files / 26 sites to the 3 files / 4 sites of the process-roots
holder, and `new AbortController()` fell from the four named residents to two.
`node scripts/check-effect-migration-ratchet.mjs` at `ca4e74a597`, over 1,402
production files, reports every one of its eight tracked patterns at its
baseline with no headroom (the baseline file carries rows only for the four
that are not empty):

```
platform()                3 files / 3 sites (baseline 3 files / 3 sites)
ambient:asyncLocalStorage 3 files / 4 sites (baseline 3 files / 4 sites)
new AbortController()     2 files / 2 sites (baseline 2 files / 2 sites)
import:p-queue            0 files / 0 sites (baseline 0 files / 0 sites)
import:p-defer            0 files / 0 sites (baseline 0 files / 0 sites)
import:async-mutex        0 files / 0 sites (baseline 0 files / 0 sites)
Effect.run*               0 files / 0 sites (baseline 0 files / 0 sites)
catch:effect-importer     2 files / 2 sites (baseline 2 files / 2 sites)
```

`Effect.run*` stays empty, which is the point: the runs wave 5 moved all sit
in the host packages and the SDK, which are boundary kinds rather than debt.
`catch:effect-importer` held at its two named permanent residents through eleven
files that newly import `effect` at runtime and reach zero raw catches in the
same PR (`desktopPromptController.ts`, `initConfig.ts`, `register.ts`,
`progressNavigation.ts`, `SettingsViewProvider.ts`, `nodeProcesses.ts`,
`claudeAgentImport.ts`, `codexImport.ts`, `execUtils.ts`, `codexConfig.ts`,
`models.ts`). `Platform` is down to `lifecycle`, `agentDirectories` and
`toolMissingHandler`, and production holds no `new AsyncLocalStorage`.

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
