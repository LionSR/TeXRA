# R. Test infrastructure: design red flags (round 3)

Read at `main` commit `4e32bb921018ccb4626c0fb47b25a2c2d365b5f4`. Read-only.
Scope: `src/test-kernel/support/`, the helper modules elsewhere under
`src/test-kernel/` (`cli/fixtures/`, `agent/*TestUtils.ts`,
`shared/session/fanOutScenario.ts`), `vitest.config.mjs` and its tier
computation, the support modules under `packages/*/test` (there are none:
the 121 package suites import `@test/support/*`), the helpers in
`packages/desktop/tests/e2e/`, and the golden store generator
(`packages/cli/scripts/generate-golden-store.mjs`, `golden:store` at
`packages/cli/package.json:53`) with the scripted model it drives
(`packages/cli/src/runtime/validationModel.ts`).

Open PRs touching the area at this commit: **#14788** edits
`src/test-kernel/cli/fixtures/sessionViewFixture.ts`,
`support/sessionTestUtils.ts`, `support/crashConformance.ts` and
`loop/toolGuard.ts` (renames `followUpSupport` to `takesFollowUps`);
**#14741** edits `generate-golden-store.mjs`, `rowCodec.ts` and
`storeSchema.ts` (blob link kinds). R3 and R4 name them.

Already found and not repeated here: the 2026-11-04 store and test-support
note's C1–C8 (`.agents/docs/proposed/simplification/2026-11-04-store-and-test-support-debts.md`:
raw `event.data` reads in helpers, `crashConformance.ts` re-implementing
`storeFaults.ts`'s readers and waiters, `killedHost` duplicating
`validationHost`, `crashAt`'s table list and `aggregate_change`), K's
"validation model in the production tree" and `cliInitPlatformMock`
(`K-cli.md:383`, `:835`), H's `prPollingSourceState` builders
(`H-app-tools.md:232`), and the 2026-10-27 note's §4 plan
(`2026-10-27-tech-debt-target-designs.md:283-356`). Each is cited where a
finding borders it.

## Numbers

| Where                                                                                                                                                | Files | Lines |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----- |
| `src/test-kernel/support/`                                                                                                                           | 37    | 5,493 |
| helpers elsewhere in `src/test-kernel/` (`cli/fixtures/`, `*TestUtils.ts`, `fanOutScenario.ts`, `desktop/*`)                                         | 12    | 1,536 |
| support modules in `packages/*/test/`                                                                                                                | 0     | 0     |
| `packages/desktop/tests/e2e/` helpers (`electronApp`, `serviceFixture`, `workspaceStorageFixture`) + `scripts/desktop-package-smoke-environment.mjs` | 4     | 630   |
| `vitest.config.mjs`                                                                                                                                  | 1     | 254   |
| `generate-golden-store.mjs` + `validationModel.ts` (production, test scenarios)                                                                      | 2     | 2,031 |

Suites: 248 (127 under `src/test-kernel`, 121 under `packages/*/test`).
Simulating the config's own scan at this commit: 92 `pure`, 121 `kernel`,
35 `isolated`. `support/` exports 126 symbols.

Five largest: `generate-golden-store.mjs` 1,458; `support/crashConformance.ts`
1,419; `support/storeFaults.ts` 608; `validationModel.ts` 573;
`shared/session/fanOutScenario.ts` 520.

Comment share, worst five files of 200 lines or more: `support/testKernel.ts`
33% (110/333); `support/FakePlatform.ts` 29% (95/327); `vitest.config.mjs`
29% (75/254); `settings/litComponentTestUtils.ts` 21% (43/202);
`agent/progressTestUtils.ts` 19% (42/220).

Primitives in `support/`: `Scope.makeUnsafe()` 4 (3 never closed:
`testPluginServices.ts:62`, `nativeToolTestLayer.ts:63`, `:115`);
module-level `let` 2 (`setupPlatform.ts:86` the installed host,
`testKernel.ts:303`); `globalThis` caches 6 (`FakePlatform.ts:33-71`);
`vi.stubEnv` 3; polling loops 3 (`storeFaults.ts:481`,
`asyncTestUtils.ts:30-40`, and the scripted model's release-file gate,
`validationModel.ts:108-113`); `Effect.runFork` fire-and-forget 2
(`sessionTestUtils.ts:49`, `runHandleFixtures.ts:102`); `Object.assign`
over a production instance 1 (`storeFaults.ts`, `sessionStoreFaults`);
`as unknown as` 2 (`runHandleFixtures.ts:59,63`).

## What a new suite must learn

A new kernel suite that runs one tool call over a session, at this commit,
chooses among:

- **Its tier**, decided by a text scan it does not see: 21 `PURE_DIRS`, 3
  `DOM_DIRS`, 4 `NEEDS_OWN_REGISTRY` patterns and 11 `REACHES_A_HOST`
  module names (`vitest.config.mjs:50-93`). R7.
- **Its host and session**: 13 entry points: `FakeHost.layer`,
  `SessionGraph.layer`/`.hosted`/`.with`/`.runtime`, `texraHosted`,
  `TestSession.layer`/`.open`, `isolatedTestSession`, `persistentTestSession`,
  `validationHost`, `sessionHandleOf`, `parkedRunAfterCrash`; and whether
  it needs `HARNESS_APP`, `TEXRA_APP` or `storePluginsLayer`.
- **The host's lifetime rules**: the process is per block, the host per
  test, read through a module slot; `testWorkspaceRoots()` is a live view of
  that slot; the worker's fake root is emptied by every new host; a seed
  key is spelled `'/workspace/a.tex'` or `fakePath('workspace/a.tex')`
  (`FakePlatform.ts:109-132`). R6.
- **A temp directory**: five idioms (`useTempDirs`+`makeTempDir` 34 suites,
  `createTempDirPlatform` 6, `withTempDirEffect` 5, Effect's
  `makeTempDirectory` 5, raw `mkdtemp` 13 sites in 12 suites).
- **Rows**: seeded by `publishTestRows` (forked, unobserved), `seedRows`,
  `seedRunRecord`, `seedEditedFiles` or `holdTestRun`; read by six readers
  (C3/C4 of the 11-04 note, plus `recordSessionEvents` and the e2e copies).
- **A model**: six scripted models, none shared. R1, R5.
- **A tool call**: `nativeToolTestLayer`'s eight options, over a hand copy
  of the dispatch. R2.
- **The environment**: `vi.stubEnv` or `withEnv` (`testEnv.ts`). R5.

The rules in `src/test-kernel/AGENTS.md` are right; most of the learning
above is the cost of the support layer restating production (R1–R4) or
keeping two lifetimes in one record (R6).

## Findings

### R1. The run-loop suites fake the model one layer too high, by re-implementing `ModelInvoker`

**Flags:** a fake that is a second implementation of its port; two
representations of the write protocol; speculative generality (unused
script variants); repetition (six scripted models, five bindings, three run
builders).

**Evidence.**

- `scriptedRunLayers.ts:1-6` states the design: "the model faked at the
  `ModelInvoker` seam. The rows the fake writes are the production ones".
  `scriptedInvoker` (`:182-302`) writes them by hand: the `attempt` row with
  `request: '0'.repeat(64)` (`:248-258`), a `context.edit` (`:259-274`), the
  `response` with `dispatchFactsFor` (`:275-290`) and
  `positionRow(…, 'response.ready')` (`:291`) from a state read before the
  append (`:207`); a failure as a `failed` row whose `next` is always
  `{ kind: 'stop' }` (`:224-243`).
- Production writes those rows differently: an `identified` row when the
  provider names the response (`ModelInvoker.ts:275-293`), the response and
  its position from the state the cell holds when it appends
  (`cell.append((state) => …)`, `:382-396`), and `failedRows` whose `next`
  is decided by the budget the rows count (`:608-628`).
- The fake's outcome has fields the port's does not: `error` (`:241`) and
  `text` (`:296`), against `InvocationOutcome` (`ModelInvoker.ts:135-143`:
  "A failure's error is the run state's `lastError`").
- `ScriptedTurn`'s `compactTo` and `cancelled` variants (`:158-164`) have
  zero users; `summary` and `failWith` one suite each.
  `scriptedInvokerLayer` has 3 consumers (`ToolUseDispatchInterruption`,
  `ToolUseWait`, `ToolUseProgressEvents`, all in
  `packages/harness/test/agent/followUp/`).
- The better composition is already in the tree, local to one suite:
  `RetryState.vitest.ts:187-232` (a stub `Model`) and `:368-380` (the real
  `modelInvokerLayer()` over `UsageLog.disabled`, a `ModelAccess` override
  and `RouteRetries`).
- A scripted model is built six ways: `scriptedInvoker`;
  `validationModel` (`validationModel.ts:406-567`); `receiptModel`
  (`resumeRun.vitest.ts:341-410`); `stubModel` (`RetryState.vitest.ts:187`);
  `observingInvokerLayer` (`RunScopedToolOverlay.vitest.ts:71-80`);
  `countedModel` (`goldenStore.vitest.ts:683-704`). The invoker's rows are
  also hand-written in `ToolUseDispatchParallel.vitest.ts:262-300`
  ("exactly as `ModelInvoker` does", `:260`) and
  `runRecordSeeds.ts:56-107`.
- `BoundModel` is built by hand five times: `scriptedRunLayers.ts:74-105`,
  `RetryState.vitest.ts:233-261`, `ToolUseDispatchParallel.vitest.ts:163`,
  `pricing.vitest.ts:46,127`, and a cast in `nativeToolTestLayer.ts:59-65`.
- The run under test is built three ways, each with its own agent and
  defaults: `testAgentRun` (`scriptedRunLayers.ts:308-348`, which writes its
  `entry` literal twice, `:332-339` and `:393-403`, and its config decode
  twice, `:318-322` and `:380-385`), `createTestLaunchContext`
  (`agent/runtime/launchContextTestUtils.ts:22-55`), and the `toolRun` of
  `nativeToolTestLayer.ts:106-125` (agents `'chat'`, `'assistant'`,
  `'test'`).
- "One fake per port" (`src/test-kernel/AGENTS.md`) names the platform
  ports, which do have one fake each (one local `PlatformSecrets` fake in
  248 suites). `Model` has no shared fake, so it has the most local ones.

**The design decision behind it.** Where a run-loop test's model boundary
sits. The write points are the run's contract
(`packages/harness/AGENTS.md`, "Write points are the contract"), and the
invoker writes half of them. A fake above the invoker tests the loop against
the test's own copy of that contract, which has already drifted.

**The better design.** One `scriptedModel(script)` in `support/`: a `Model`
whose `streamTurn` serves `TurnResult | ModelError | 'hang'` in order (the
`AttemptOutcome` shape `RetryState` already uses), bound by one
`testBinding(model, over)`, and served by the real `modelInvokerLayer()`
composed as `RetryState.vitest.ts:368-380` composes it. One `testRun(over)`
replaces the three run builders. Deleted: `scriptedInvoker`,
`unreachedModelAccess`, `unusedModel`, the `compactTo`/`cancelled`
variants (0 users), `RetryState`'s local `stubModel`/`boundModel`/composition,
`ToolUseDispatchParallel`'s inert `boundModel`, `createTestLaunchContext`
(2 consumers), about 200 lines. The three follow-up suites and
`RetryState` write against `scriptedModel`.

**What we give up.** A turn that compacts before it answers without a real
context limit (no user). A script choosing a failure's `next`: the invoker
decides it, so a scenario that wants a stop scripts a non-retryable
`ModelError`. The free attempt row: a real attempt commits its prepared
request, so a suite that pins whole row lists sees the extra rows. Each
turn now runs `prepareTurn` and a stream; `RetryState` shows the cost is
small.

**Change amplification.** "The invoker commits one more row per turn":
before, `ModelInvoker.ts`, `scriptedRunLayers.ts`,
`ToolUseDispatchParallel.vitest.ts` and `runRecordSeeds.ts` (4); after, 1.

**Depends on:** none. It only uses `modelInvokerLayer`; nothing under
`agent/runtime/` (package E's) changes.

### R2. A test tool call is assembled from a hand copy of the dispatch: its requests, its plugin services and its step

**Flags:** helpers restating production rules; information leakage (which
plugins carry session services); resources never released.

**Evidence.**

- `nativeToolTestLayer` (28 suites) builds the call's `requests` by hand
  (`nativeToolTestLayer.ts:177-219`). The dispatch builds them with the
  exported `callRequests` (`loop/toolGuard.ts:284-391`). The copy differs
  in several ways. Request ids are `${prefix}-${randomUUID()}` (`:178`)
  where production derives `callRequestId(at, opened + 1)`
  (`toolGuard.ts:323-332`). There is no standing re-entry and no
  `retireStanding`. No `hook` reaches `openRequest` (`toolGuard.ts:353`).
  `post` appends an undecoded payload (`:200-215`) where production decodes
  `PermissionPayloadSchema` (`toolGuard.ts:372-386`).
- The `RunCall` and `ToolContext` literals (`:135-156`, `:164-220`) restate
  `toolUseDispatch.ts:521-549`.
- `testPluginServices.ts:41-46` lists the plugin session layers by hand:
  `codeSandboxLayer`, `codexThreadsLayer`, `claudeAgentSessionsLayer` and a
  GitHub stand-in. Those are the plugins that declare `sessionLayer`
  (`builtinPlugins.ts:120`, `codexPlugin.ts:24`, `claudeAgentPlugin.ts:38`),
  which production builds from the plugin table (`sessionLayerOf`,
  `liveTools.ts:189`; `sessionTools.ts:287-293`). The copy is built into a
  `Scope.makeUnsafe()` that is never closed and cached per `Runs` in a
  module `WeakMap` (`:54-66`). `nativeToolTestLayer.ts:63` and `:115` leave
  two more scopes open.
- `resolveTestStep` (`stepToolsTestUtils.ts:23-63`, 1 consumer,
  `McpServerPlugin.vitest.ts`) restates `openStep` (`loop/step.ts:204-252`)
  and has drifted. It holds and pins on the session catalog where
  production pins `ProjectTools` with `{ installed: true, held }`
  (`step.ts:221-223`). It has no `liveToolGates` (`:224`) and no
  `hostCapabilitiesOf` (`:228`). It pins services for offered plugins only,
  where production also pins them for contributing ones (`:246-252`).
  `stepFor` (`step.ts:436`) is the exported production path.

**The design decision behind it.** Who builds a call's capabilities.
Production builds them in one place, the dispatch. The support layer builds
them again, so a test call is a call no production path makes.

**The better design.** Build the test call's requests with
`callRequests(toolRun, session, cell, cell.append, { responseId, callId,
attempt: 1 }, 0, null, '…')` over a `RunHistory.open(runId)` cell. Build its
plugin services from the process's plugin table (`ProjectTools.pin(…)` then
`.services(ids)`, as the step does), in the test's scope. Delete
`resolveTestStep`: its one suite opens a step with `stepFor` over R1's
`testRun`. Deleted: the 43-line `requests` copy,
`testPluginServicesLayer` and its list, `builtFor`, `noPluginHold`, the
`testModelCell` export (no outside consumer), `stepToolsTestUtils.ts` (63
lines), and three unclosed scopes.

**What we give up.** Random request ids (no suite reads them). The
"unread" GitHub `Proxy` (`testPluginServices.ts:16-37`), which keeps the
follow-up module out of the support files for `vi.mock` ordering: a suite
that mocks that module keeps a local stand-in, with the comment the
one-fake rule asks for.

**Change amplification.** "A new plugin with a `sessionLayer`": before,
the plugin and `testPluginServices.ts` (and forgetting the second fails
only the suites that call its tool); after, the plugin. "`callRequests`
gains a parameter": before, `toolGuard.ts` and `nativeToolTestLayer.ts`;
after, the same two files, but the second becomes one call site instead of
a 43-line copy.

**Depends on:** none. E11 (`callRequests`' eight parameters, root designs
"Findings by area", `:809`) would then reshape one more caller.

### R3. The TUI's hand-built `SessionView` restates the fold's rules, and has drifted from them

**Flags:** helpers restating production rules; two representations of one
fact (the fold's output and the fixture's); a cast hiding a missing field.

**Evidence.**

- `cli/fixtures/sessionViewFixture.ts:61-113` writes about 40 `RunView`
  fields by hand and casts the result (`} as RunView;`, `:113`). It leaves
  out six required `NullOr` fields of `RunViewSchema`: `output`, `lost`,
  `launchParentId`, `forkedFrom`, `forkPoint` and `parentCard`
  (`sessionView.ts:109,113,137,140,144,146`). They read `undefined`, a value
  no folded view holds.
- `makeRunView` then computes the actions with the fold's own rule
  (`runActions(run, false)`, `:58`), which tests `forkPoint === null`
  (`runActions.ts:49`) and `forkPoint !== null` (`:91`). So a default
  fixture run (held, plain agent, `turn: null`) is offered `compact` and
  `fork`. A folded run that has not started (`forkPoint: null`) is offered
  neither.
- `viewWith` (`:123-182`) restates three of the fold's derivations by
  comment and code: child order "in the fold's `runOrdering`" (`:118-121`,
  `:151`), approval "as the fold's aggregates derive it" (`:155-166`,
  against `sessionViewUpdate.ts:438`), and rollups "the way the fold does"
  (`:167-174`, against `:462`).
- Consumers: 5 suites (`makeRunView` in `ApprovalQueue` and
  `chatSessionController`, `viewWith` in 3). None asserts on `fork` or
  `compact` today, so the drift is latent.
- Open PR #14788 renames a `RunView` field and has to edit this fixture
  (`:86`, `followUpSupport` to `takesFollowUps`), beside the same edit in
  `support/sessionTestUtils.ts:74` and `support/crashConformance.ts:1389`.
- The tree already has the other way: `shared/session/fanOutScenario.ts:1-6`
  builds its views by applying rows through `makeSessionViewUpdater`
  (`:178`), "so the two can never drift". It has 2 consumers.

**The design decision behind it.** Who computes a view a TUI test renders.
The fixture says it states "the fold's output" (`:1-7`), and the fold
exists.

**The better design.** Build TUI fixture views by folding drafts, with
`fanOutScenario`'s updater, from a few row builders (`runStart(id, over)`,
`runEnd`, `requestOpened`). Delete `runViewFields`, `viewWith`'s three
derivations and the cast (about 95 lines). A field the fold adds then
reaches every fixture with its real value.

**What we give up.** A case that states a view the fold never produces,
such as a blank identity (`:54-57`). It is either dropped or kept as an
explicit override on a folded view.

**Change amplification.** "A new required `RunView` field": before,
`RunViewSchema`, the fold, and `sessionViewFixture.ts` (and forgetting the
third is silent under the cast); after, the first two.

**Depends on:** lands after #14788, which edits `sessionViewFixture.ts`.

### R4. The golden store generator re-implements the row codec

**Flags:** a second implementation; change amplification, shown by an open
PR.

**Evidence.**

- `generate-golden-store.mjs:1029-1070` holds `sha256`, `ZSTD_LEVEL_3`,
  `REF_SHAPED`, `renameKeys`, `inflate` ("the value the codec encoded
  (`rowCodec.ts`, `parseData`)") and `outline` ("The codec's encoding of a
  payload (`rowCodec.ts`, `encodeDraft`): each string of 4096+ characters
  outlined"). They mirror `rowCodec.ts:62` (ref-shaped keys), `:206-210`
  (the 4096 outline) and `:255-262` (`parseData`). `:1306-1316` restate the
  canonical context blob (`rowCodec.ts:189-194`). `:1298-1330` write blobs
  and links by SQL. The script has 15 raw-SQL sites over the store's tables.
- Open PR #14741 changes `encodeDraft` (a link now records whether it is
  `inline`) and has to patch the generator's insert to
  `INSERT INTO event_blob VALUES (?, ?, 1)`, with a new assumption in a
  comment: "the golden runs attach no media, which would link at 0".
- The repository already loads production TypeScript into an `.mjs`
  harness: `loadDatabaseFixture` (`scripts/desktop-package-smoke-environment.mjs:78-104`)
  bundles `databaseLayer`, `SessionEventSchema` and the rest with esbuild.
  `decodeRow` and `encodeDraft` are exported (`rowCodec.ts:182`, `:269`).

**The design decision behind it.** Who encodes the golden store's rows.
Every other store is written by the codec; the fixture meant to guard the
codec is written by a copy of it.

**The better design.** The generator bundles `rowCodec`'s `decodeRow` and
`encodeDraft` the way `loadDatabaseFixture` bundles the store, and
normalizes each row as decode, scrub, then `encodeDraft`, which recomputes
outlines, digests, link kinds and the canonical context blob. Deleted:
`sha256`, `ZSTD_LEVEL_3`, `REF_SHAPED`, `renameKeys`, `inflate`, `outline`
(about 45 lines) and the media assumption. The fixed-point digest rewrite
stays, because it belongs to normalization.

**What we give up.** The script becomes plain `.mjs` plus a bundle step (it
already runs `pnpm run bundle`, `:165-188`). A codec bug would now write the
fixture too. The guard against that is a fixture frozen at a release (C1 of
the 11-04 note, F14 of the store review), not a second codec.

**Change amplification.** "A codec change to blobs or links" (#14741):
before, `rowCodec.ts` and the generator; after, `rowCodec.ts`.

**Depends on:** lands after #14741, which edits both files. It pairs with
C1/F14.

### R5. The validation model's switch is a protocol seven files restate, and in-process suites open it by patching the process environment

**Flags:** information leakage; a gate built for the shipped bundle used in
process (special case); two mechanisms for one fact (`vi.stubEnv` and an
env `ConfigProvider`).

**Evidence.**

- The owner is `validationModel.ts:29-32` (`SWITCH`, `FLAG`,
  `FLAG_CONTENT`), with the gate at `:380-404` and the per-turn scenario
  switches read from the environment at `:540-545`.
- The protocol (the switch, an absolute flag file, its sentinel, a fake key)
  is restated in `support/storeFaults.ts:376-380` and `:425-450` (four
  `vi.stubEnv`s, every `API_KEY_ENV_NAMES` blanked, the flag written),
  `goldenStore.vitest.ts:557-592`, `RunScopedToolOverlay.vitest.ts:125-136`
  (a file-wide `beforeAll`/`afterAll`), `e2e/serviceFixture.ts:106-115`,
  `generate-golden-store.mjs:132-133,203,324-326` and
  `validate-run.mjs:52-56`. The sentinel string appears in 7 files.
- No suite tests the gate itself (no suite matches "restricted to package
  validation" or "invalid validation flag"). The in-process suites open it
  only to reach the model.
- The layer-shaped way is in the tree: `resumeRun.vitest.ts:356-357`
  provides `Layer.succeed(ValidationModel)({ enabled: Effect.succeed(true),
  bind })`. The environment as a value is `testEnv.ts:9-16`
  (`ConfigProvider.fromEnvRecord`).
- The canned model recognizes the harness's own calls by restating three
  harness prompts: `validationModel.ts:34` and `:119` against
  `compaction.ts:46`, `:35` and `:298` against `run/tools.ts:113`, and
  `:123` against `sessionDescription.ts:48`. A rewording there silently
  sends the golden and crash scenarios down another branch.
- Held calls wait by polling a release file every 20 ms (`:108-113`). In
  process, that wait could be a `Deferred`.

**The design decision behind it.** What the environment gate guards. It
guards a validation build of the CLI bundle (`:1-11`). An in-process suite
already holds the `ValidationModel` port and needs no gate.

**The better design.** `validationModel.ts` exports the canned `bind` as
`validationModel(options)`, with the scenario switches (`golden`, `echo`,
`scriptFanout`, `historyQuery`, the release directory) as values.
`validationModelLayer` stays the bundle's gate and reads those values from
the environment once. In-process suites provide
`Layer.succeed(ValidationModel)({ enabled: Effect.succeed(true), bind:
validationModel({ … }) })`. `validationHost` loses its environment block,
`RunScopedToolOverlay` loses its hooks, and C5's merge of `killedHost`
becomes one line. The out-of-process callers (the generator,
`validate-run`, the e2e fixture) import one shared constant module instead
of restating the names. This leaves K's move of the scenarios into test
support open, and the three prompt prefixes stay a known leak until those
calls can be recognized by something other than their wording.

**What we give up.** Nothing a suite checks. The blanking of shell provider
keys stays where it is, because it is a separate concern.

**Change amplification.** "Rename or reshape the validation switch":
before, 7 files; after, the owner, the constant module, and the bundle-side
callers that set it (3).

**Depends on:** none. It borders K (`K-cli.md:835`) and C5 of the 11-04
note.

### R6. The fake host is one per-test record of process ports and workspace roots, read through a module slot over a worker-shared directory

**Flags:** state held in a module slot, read ambiently; comments
substituting for design; the ambient-roots fallback that production
refuses.

**Evidence.**

- `setupPlatform.ts:47-54`: one `FakeHost` record holds process-lifetime
  ports (`app`, `platform.agentDirectories`, `platform.shutdownScope`,
  `secrets`, `setup`) and session data (`roots`).
- The process is built once per block over the block's host
  (`testKernel.ts:161-167` reads `storageRoot`, `settings` and `plugins()`
  at build). Hosts change per test, so the slot (`setupPlatform.ts:86-94`,
  `let current` and `installedHost()`, which throws when empty) is read
  through five delegating views: `fakeHostSecrets`, `fakeHostAppState`,
  `fakeHostAgentDirectories` (`setupPlatform.ts:116-149`),
  `fakeSetupPlatform`'s getters (`texraApp.ts:21-37`), and the 8-getter
  `testWorkspaceRoots()` view (`testWorkspaceRoots.ts:19-51`). The same
  hand-off is explained six times (`FakePlatform.ts:258`,
  `setupPlatform.ts:83-84,118-121,138-140`, `texraApp.ts:22-25`,
  `testWorkspaceRoots.ts:11-14`, `testKernel.ts:186-195`).
- The ambient read is everywhere. `testWorkspaceRoots()` is used by 25
  suites and 13 times in 6 other support modules, as the default parameter
  of `TestSession.open` (`testKernel.ts:258`), `setTestApprovalPolicy`
  (`sessionTestUtils.ts:172`), `nativeToolTestLayer` (`:100`) and
  `persistentTestSession` (`storeFaults.ts:464`). `installedHost()` is
  called in 11 suites. Root `AGENTS.md` says: "Carry the workspace root as
  data from its holder … There is no ambient fallback." The support layer
  is the one place that keeps one.
- The worker-shared root (`FakePlatform.ts:59-82`) is emptied by every host
  build (`seedFakeRoot`, `:145-148`, which runs `rmSync` and then
  `mkdirSync`). Its stated reason, "so the thousands of per-test fake hosts
  do not each pay for a `mkdir`" (`:60-61`), does not hold for the root:
  each host already pays a remove and a `mkdir`. The cost is a usage rule
  in `src/test-kernel/AGENTS.md` ("touch it only under a host your block
  built"), and no block can run its tests concurrently (0 `concurrent`
  blocks).
- `fakePath()` (43 sites in 15 suites) reads that root with no host,
  including at module scope (`RunWorkspaceFiles.vitest.ts:12`,
  `TexTools.vitest.ts:26`).
- There are two answers to where a host's storage root is.
  `createTempDirPlatform` puts `globalStorage` under its own
  `<tmp>/storage` (`tempDirPlatform.ts:50-55`), while the record's
  `roots.storageRoot` stays the worker's (`FakePlatform.ts:294`), and that
  second one is what the process reads (`testKernel.ts:166`).

**The design decision behind it.** The two lifetimes production keeps
apart (process services in the runtime, roots carried by the session) are
one record here, so the per-block process must read a per-test record
through a global.

**The better design.**

1. The roots are data. A helper takes `roots`, or reads
   `(yield* FakeHost).roots`, so the requirement shows in its type.
   `TestSession.open`'s default is the context's host. This deletes
   `testWorkspaceRoots.ts` and its 8-getter view, which today is a second
   hand list of `WorkspaceRoots`' fields, as A6 of the 11-04 note found in
   production.
2. Each host owns its root. `FakeHost.layer` makes it with
   `fs.makeTempDirectoryScoped` and `realPath`, under the run's temp folder,
   and its release removes it. `fakePath` becomes a field of the host.
3. The few process ports that must follow per-test hosts (secrets, agent
   directories, setup) read one `Ref<FakeHost>` that the block's graph
   holds and each `FakeHost.layer` sets under `acquireRelease`. This
   replaces the worker-module slot and its throw with a typed,
   per-block requirement.

Deleted: `current`, `installedHost` (11 suites), `testWorkspaceRoots`
(25 suites, 13 support reads), the root-emptying seed path and its
worker-home check (`FakePlatform.ts:115-148`), and about 40 comment lines.

**What we give up.** Module-scope `fakePath(...)` constants: expected paths
become per-test values. Sync helpers lose their implicit roots. The churn
is about 45 files. Cost is about the same as today, one `mkdtemp` against
today's `rm` and `mkdir`.

**Change amplification.** "`WorkspaceRoots` gains a field": before,
`createFakeWorkspaceRoots` and the `testWorkspaceRoots` view (2); after, 1.
"Run a block's tests concurrently": impossible before; after, it needs only
a per-test graph.

**Depends on:** none. It is easiest after R2, which removes two support
readers of the slot. Large churn.

### R7. Tier membership is read from import spelling, and the `pure` tier runs with the real home

**Flags:** information leakage (a hand list of modules kept in the config);
special and general mixed (one classifier decides safety and speed).

**Evidence.**

- `REACHES_A_HOST` (`vitest.config.mjs:73-76`) names 11 support modules and
  `@platform/*`. It is matched against the suite's own text only
  (`:115-121`).
- `pure` has no `setupFiles` (`:167-174`). `HOME_SETUP_FILES` (`:126-129`)
  run only in `kernel` and `isolated` (`:181`, `:193`). So the
  classification also decides whether a suite runs with HOME pointed at the
  developer's home.
- Simulating the scan over the 248 suites at this commit:
  - 8 `pure` suites reach a listed module or `@platform/*` through a
    helper. For example, `shared/stateSettings.vitest.ts` reaches
    `FakePlatform` via `settingsStoresFake`, and `cli/Doctor.vitest.ts`
    reaches `@platform/defaults/memoryConfigProvider` via
    `cli/fixtures/cliContext.ts`.
  - 1 suite imports a listed module by a relative path the regex does not
    match (`controllers/settingsMemoryCommands.vitest.ts:14`,
    `../support/FakeHosts`).
  - 16 `pure` suites import `@texra-ai/harness/host` or `/node`, the public
    entries of the same host services that `@platform/*` names. The
    2026-10-30 codemod moved 238 imports onto those entries (10-27 note
    §A1), which moved suites between tiers without anyone deciding it.
- The list is also wrong the other way. `FakeHosts.ts` is listed but
  imports only `effect` and types (`FakeHosts.ts:1-12`). `FakePlatform.ts`
  is listed while its own comment says importing it "must stay free of
  process-wide side effects, so the pure test tier can reach it"
  (`FakePlatform.ts:62-63`).
- The kernel's one install is `installFakeHost` (`setupPlatform.ts:101-114`).
  A new support module that reaches a host is a silent wiring point in the
  config.

**The design decision behind it.** The tier conflates two facts: whether a
suite must be isolated from the real home (safety), and whether it can join
the fast `test:pure` loop (speed).

**The better design.**

1. `HOME_SETUP_FILES` in all three projects. Safety then no longer depends
   on the classifier. `isolateHome` swaps once per worker (`:122-125`), and
   the check loads two modules.
2. "Reaches a host" means the suite's import closure, over `@test/*` and
   relative specifiers, contains `support/setupPlatform.ts`. That is about
   15 lines in a config that already reads every suite's source.

Deleted: `REACHES_A_HOST` (2 patterns, 11 names) and its upkeep. Once (1)
lands, `PURE_DIRS` guards nothing and can follow.

**What we give up.** `pure`'s "no setup file" property: its loop gains two
setup files per file, and `isolateHome` is a no-op after a worker's first
file. Config load does a closure walk.

**Change amplification.** "A new support module that installs or reads a
host": before, the module and `vitest.config.mjs` (and forgetting the
second is silent); after, the module.

**Depends on:** none. It borders the 10-27 note's A5, which planned to
delete the `REACHES_A_HOST` entries along with the old setup modules. The
list outlived those modules as the speed classifier.

### R8. Smaller items, batched

Each item is one line of evidence and its fix. None depends on a root.

- **Dead and single-consumer support exports.**
  - `admitInterruptibleRun` (`runHandleFixtures.ts:95-109`) has 0
    references.
  - `testModelCell` (`nativeToolTestLayer.ts:59`) has no outside consumer.
  - These exports have one consumer each, which the "promote shared setup"
    rule and the single-caller ban both reject: `inquiryThreadRow`
    (`sessionEvents`), `seedReport` (`RunRecords`), `isStored`
    (`StateSettingWrite`), `testSkillRoots` (`RuntimeSkills`),
    `resolveTestStep` (R2), and `productionRoots`/`productionFilesUnder`
    (`rowVersions`).
  - No dead-code check covers `support/`.
  - Fix: inline each into its suite, and delete the dead ones.
- **A polling helper beside the rule against polling.** `waitForCondition`
  (`asyncTestUtils.ts:17-40`, a `Date.now()` loop with sleeps) has 5
  suites. Four of them poll a state that has a signal:
  `PlanToolWorkPlanState.vitest.ts:56` and
  `ToolEditApprovalGate.vitest.ts:237` poll for an opened request, which
  `holdTestRun`'s `SubscriptionRef.changes(view).pipe(Stream.takeUntil(…))`
  form (`sessionTestUtils.ts:100-105`) answers, and
  `ToolAvailabilitySeeding.vitest.ts:59` polls the scripted spawner's
  `calls`. `createDeferred` (`:43-49`) only forwards to
  `Promise.withResolvers` (4 suites).
- **Forked and unobserved seeding.** `publishTestRows`
  (`sessionTestUtils.ts:45-50`, 11 suites, plus 34 through
  `publishTestRunStart`) runs `Effect.runFork` with no scope, so a refused
  batch fails a fiber no one joins and shows up later as a missing row.
  `seedRows` (`:54-57`) is the Effect form; the fix is to yield it, or fork
  it into the caller's scope.
- **A global log sink restored by hand.** `captureLogEntries`
  (`logSinkCapture.ts:30-55`, 2 suites) installs with `setLogSink` and
  relies on the suite's `afterEach` to undo it. Fix: an `acquireRelease`
  that restores the previous sink.
- **Five temp-directory idioms.** See "What a new suite must learn".
  `withTempDirEffect` (`tempDirPlatform.ts:87-101`, written with
  `.then(`) is `FileSystem.makeTempDirectoryScoped` plus `realPath`. Keep
  `useTempDirs` for hook-style suites and that one for Effect suites.
- **A transcript replay restated.** `createTestRunTrace`
  (`sessionTestUtils.ts:128-165`, 2 suites) rebuilds `buildRunTranscript`'s
  work state and context (`transcriptUpdate.ts:382-404`) with
  `lifecycleToTaskGroups: true` hard-coded, where production derives it
  from the identity (`:397-400`).
- **An inert HTTP client that reads `globalThis.fetch`.**
  `testHttpClientLayer` (`fetchTestUtils.ts:21-28`, 7 suites) serves
  whatever `globalThis.fetch` is at call time, which is the seam for the
  global patch the guide forbids. 6 of its 7 consumers never answer HTTP;
  for them, `Layer.mock(HttpClient.HttpClient)({})` fails loudly if called.
  The seventh can provide `FetchHttpClient.Fetch` with its scripted
  function.
- **E2E helpers.**
  - `openWorkbench` and `setSettingsTab` (`electronApp.ts:257-320`) drive
    the renderer by `window.postMessage` with literal command strings
    (`'desktop:openWorkbench'`, `'desktop:openSettings'`, `'setTab'`). There
    are 14 such sites in 4 files, restating `DESKTOP_SHELL_MESSAGES`
    (`desktopShellMessages.ts:5`) where the E2E rule asks for user-visible
    roles.
  - `dismissOnboarding` swallows its own wait (`electronApp.ts:220`,
    `.catch(() => undefined)`; `:222`).
  - `proposalEdit.spec.ts:50-140` and `serviceClient.spec.ts:257-262` read
    the store with raw SQL over `withStoreCopy`, while
    `loadDatabaseFixture` already exports the production `Database`
    (`desktop-package-smoke-environment.mjs:84-86`), which
    `agentCatalog` and `sessionLifecycle` use. This extends C3 to the e2e
    tree.
- **Vague names.** `FakeHosts.ts` holds fake UI ports, not hosts.
  `ProgressControllerHarnesses.ts` holds one function, `asDocumentTask`.
  Fix: rename them for what they hold (`fakeUiPorts.ts`, `documentTask.ts`).

## Good modules in this area

- `childProcessTestLayer.scriptedSpawnerLayer` (`:69-119`) is a scripted
  fake at the real edge, built with the library's own `make` and
  `makeHandle`. It records `calls` and `killed` (a hang's finalizer), and
  has 6 suites. A shared `scriptedModel` (R1) should copy its shape.
- `storeFaults.sessionStoreFaults` (`:136-235`) injects faults into the real
  store: a fail or a hold on the next matching operation, the wrapping
  undone by `acquireRelease`, and every hold released when the scope
  closes. It is a deep interface over a small surface.
- `testKernel.ts`'s `FakeHost.layer`, `TestSession.layer` and
  `SessionGraph.runtime` follow the root rules: scoped layers, and only
  `Context.pick(...PROCESS_SERVICES)` travels (`:226-241`). The tag list is
  checked by the `satisfies` at `:237-241`.
- `FakePlatform.fakeConfig` and `FakeStateStore` (`:180-198`) are fakes that
  are not second implementations: production's `MemoryConfigProvider` and
  `MemoryStateStore`, seeded as a person's setting would be.
- `testTempRoot.ts`, `isolateHome.ts` and `homeIsolationCheck.ts` give a run
  one temp folder, removed at teardown and reaped after a killed run. The
  home swap runs before any repository module, and the check fails loudly.
- The e2e `rememberOpenProject` and `findWorkspaceStoragePath`
  (`desktop-package-smoke-environment.mjs:110-138`, `electronApp.ts:82-91`)
  seed and resolve through the production owners. `launchTexraApp` is a
  deep module.
- `fanOutScenario.ts` builds views from rows through the production updater,
  the pattern R3 asks the TUI fixtures to adopt.

## Already settled, left alone

- The store readers and waiters, the second `parkedAfter`, `killedHost`,
  `crashAt`'s table list and `aggregate_change`: C3, C4, C5 and C8 of the
  11-04 note. Two facts are added here only: `untilStored` copies the
  store and its WAL on every 20 ms tick (`storeFaults.ts:291-315,476-482`),
  and the e2e raw reads (R8).
- `validationModel.ts`'s scenarios living in the production tree:
  `K-cli.md:835`. `cliInitPlatformMock`: `K-cli.md:383`.
  `prPollingSourceState`: `H-app-tools.md:232`.
- `sessionStoreFaults` assigning over the shared `Database`
  (`Object.assign`): the store has no other seam (`ProjectDatabases` is an
  `RcMap` inside `processLayer`), and a production option to inject one
  would be a knob for tests ("No option for a special case"). It is scoped
  and restored.
- `PROCESS_SERVICES` as a value list (`testKernel.ts:127-150`): a
  `satisfies` against `ProcessRuntime` checks it at compile time.
- `nodeSpawnerLayer`'s `Effect.cached` plus `Effect.uninterruptible`
  (`childProcessTestLayer.ts:27-46`): one use, with a stated reason
  (`vi.mock` ordering, and a first spawn interrupted mid-build must not
  cache the interruption).
- `Effect.runSync` in `fakeConfig` and `setTestApprovalPolicy`: this runs
  at call time over in-memory providers; the support rule bans module-scope
  Effects only.
- The crash suite's shards and the golden generator's determinism
  (`--twice`): accepted by the 11-04 note.
- `vscode-mock.ts`: the module alias VS Code-coupled suites need.

## Effect-native mapping

| Finding | Primitive or structure that answers it                                                                                                                                                                                                                                                                                              | Declaration checked (`effect` 4.1.2, `@effect/vitest` 4.1.2)                                                                                                                                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1      | The real `modelInvokerLayer()` over a scripted `Model`: `Stream.fromIterable` of turn events, `Stream.fail` for a `ModelError`, `Stream.never` for a hang, `Stream.unwrap` per attempt; the binding in a `ScopedRef`; the layer built with `Layer.effect`                                                                           | `Stream.d.ts:846` (`fromIterable`), `:704` (`fail`), `:1412` (`never`), `:1436` (`unwrap`); `ScopedRef.d.ts:110` (`make`), `:83` (`get`); `Layer.d.ts:1166` (`effect`)                                                                                                                             |
| R2      | Production `callRequests` over a `RunCell`; plugin services from `ProjectTools.pin(…).services` built in the test's own scope (`Effect.scope`, or the scope `Layer.effect` provides), never `Scope.makeUnsafe()`                                                                                                                    | `Effect.d.ts:12527` (`scope`), `:12567` (`scoped`); `Layer.d.ts:1166`; `Scope.d.ts:274` (`makeUnsafe`, what goes)                                                                                                                                                                                  |
| R3      | No Effect primitive: the production fold (`makeSessionViewUpdater`) over drafts; a literal that must stay a literal decodes with `Schema.decodeUnknownSync(RunViewSchema)`                                                                                                                                                          | `Schema.d.ts:1529` (`decodeUnknownSync`)                                                                                                                                                                                                                                                           |
| R4      | No Effect primitive: an esbuild bundle of `rowCodec`'s `decodeRow`/`encodeDraft`, as `loadDatabaseFixture` bundles the store                                                                                                                                                                                                        | repository exports `rowCodec.ts:182`, `:269`                                                                                                                                                                                                                                                       |
| R5      | `Layer.succeed(ValidationModel)` with `enabled: Effect.succeed(true)` in process; the bundle's switches read once through the env `ConfigProvider` (`fromEnvRecord` for a record); a held call in process waits on a `Deferred`, not `Effect.repeat` with `Schedule.spaced` over a file                                             | `Layer.d.ts:839` (`succeed`); `ConfigProvider.d.ts:992` (`fromEnvRecord`), `:332` (`ConfigProvider` reference); `Deferred.d.ts:152` (`make`), `:126` (`makeUnsafe`); `Effect.d.ts:14660` (`repeat`, what goes)                                                                                     |
| R6      | Roots read from the `FakeHost` service; a per-host root from `FileSystem.makeTempDirectoryScoped` and `realPath`; the current host for process ports in one `Ref` the block's graph holds, set under `Effect.acquireRelease`; per-test graphs with `layer(…, { buildPerTest: true })` where a block needs them                      | `FileSystem.d.ts:169` (`makeTempDirectoryScoped`), `:254` (`realPath`); `Ref.d.ts:154` (`make`), `:181` (`get`), `:217` (`set`); `Effect.d.ts:12676` (`acquireRelease`); `@effect/vitest` `index.d.ts:302-307` (`layer` options `buildPerTest`, `excludeTestServices`)                             |
| R7      | No Effect primitive: Vitest `setupFiles` on every project and an import-closure walk in the config                                                                                                                                                                                                                                  | n/a (Vitest config)                                                                                                                                                                                                                                                                                |
| R8      | `FileSystem.makeTempDirectoryScoped` for `withTempDirEffect`; `SubscriptionRef.changes` with `Stream.takeUntil` and `Stream.runDrain` for `waitForCondition`'s polled states; `Effect.acquireRelease` for the log sink; `Effect.forkScoped`, or a yielded `seedRows`, for `publishTestRows`; `Layer.mock` for an inert `HttpClient` | `FileSystem.d.ts:169`; `SubscriptionRef.d.ts:134` (`changes`); `Stream.d.ts:9088` (`takeUntil`), `:16198` (`runDrain`); `Effect.d.ts:12676`, `:17216` (`forkScoped`); `Layer.d.ts:3626` (`mock`); `HttpClient.d.ts:114` (`HttpClient`), `FetchHttpClient.d.ts:29` (`Fetch`, a `Context.Reference`) |
