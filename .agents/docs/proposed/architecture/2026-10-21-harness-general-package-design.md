---
created: 2026-10-21
status: proposed
---

# The harness as a general package: surface first, two structural moves

Baseline: `main` at `08455c8` for the audits, re-checked against `1a553be`. Line
references point into that tree, except the lane 4 re-check, which reads
`6e5b262`. The durable doc is
[`2026-10-02-durable-harness.md`](../../implemented/architecture/2026-10-02-durable-harness.md);
the split doc is
[`2026-10-02-harness-package-split.md`](../../implemented/architecture/2026-10-02-harness-package-split.md).

## Summary

The owner wants `@texra-ai/harness` to be a general package, as usable as
pi-durable, with TeXRA as one app on it. Seven read-only audits of the tree and
a four-design comparison came to one diagnosis: the rooms are right and the
doors are wrong. The ten invariants of the
[core-concepts note](../../implemented/architecture/2026-09-26-core-concepts.md)
hold in the kernel. What lags is the package around it: what its entries export,
how much TeXRA vocabulary it still carries, and a layout that splits one concept
across several directories.

The design keeps the package set and most of the tree. It closes the gaps by
changing the entries, injecting TeXRA's vocabulary as data, and naming two
ports. It adds exactly two structural moves, each buying something a surface
change cannot: one `session/` directory, and a `builtins/` directory that may
import only public entries. In total about 136 files move, about 1,500 import
lines change, one row field is added, and about 3,300 lines and 210 baseline
rows go. No new test file is needed.

## What the audits found

### What holds

- **Every forbidden import edge is zero.** harness→app, harness→host, llm→repo
  and texra→host all measure zero over about 1,400 source files at `08455c8`.
  ESLint, the deep-import baseline and the architecture tests agree with one
  another.
- **The writer core is clean.** There are three commit doors, all on the one
  publisher (`agent/runtime/SessionEvents.ts:224-341`). No app or host file
  writes rows. The loop holds no shadow of the fold. Requests have one answer
  path and runs have one input queue.
- **The crash-point suite** checks I1 to I9 at every commit point, under the
  built-ins and under TeXRA's plugins. pi-durable has no equivalent.

### Behind pi-durable

| Gap                           | Today                                                                                                                                   | pi-durable 1.3.0                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Storage                       | `controllers/session/Database.ts:18` imports `SqliteClient` and builds it at `:241`, `:246`, `:1032`; `:68-69` import the plugin table  | `Storage` port, five backends, `registerStorageConformance` |
| Execution                     | `ChildProcessSpawner` is process-wide (`platform/processRuntime.ts:103`)                                                                | `ExecutionEnv` per conversation, `registerEnvConformance`   |
| Edge                          | Effect only. A follow-up is `session.request({ kind: 'followUp.send' })`, and `run.events.pipe(responseText)` streams the answer's text | `await Harness.open()`, `submission.wait()`, `watchEvents`  |
| Quickstart                    | 30 lines, two directories, four peers (three Effect packages in patch lockstep, and `@texra-ai/llm`)                                    | 12 lines, `MemoryStorage`, no peers                         |
| Spec, examples                | `packages/harness/docs/spec.md`; a ten-step `example/` ladder that CI runs from the packed tarballs                                     | one `docs/spec.md`, 32 numbered examples                    |
| Publication                   | not on npm                                                                                                                              | released 2026-10-01                                         |
| Deferred tools, durable sleep | none                                                                                                                                    | `/tool-search`; `sleeping` with host wake                   |

### Behind our own design

- **Semantic leaks.** The audit counted eleven groups; the largest follow.
  Discipline teams are hardcoded in `shared/schemas/agentPresets.ts:62-145`. The
  settings catalog forces the `texra.` prefix
  (`shared/state/stateSettings.ts:858`), and `texra.` appears on about 100 lines
  across 29 harness files, comments included. TeX tool lookup sits in
  `utils/system/binaryResolver.ts` and the TeX Live and MiKTeX directories in
  `utils/system/platformPaths.ts`; both are exported from `./node`. The base
  system prompt asks for LaTeX math (`agent/prompt/PromptBuilder.ts:32`).
  `SettingHost` lists TeXRA's products (`stateSettings.ts:72`) and sits on
  `WorkspaceRoots` and `ITool`. The 547-line canned validation model lives
  inside the run package. Icon names live in the wire layer.
- **The root entry is a host door.** It has 246 exports by
  `config/api-reports/harness.api.md`: 43 serve only TeXRA's hosts
  (`HostInteractions` with VS Code event names at
  `agent/runtime/runtimePresentationEvents.ts:20-26`, presets,
  `WorkspaceAgentsController`, `decideRunModel`) and 37 are internal plumbing
  (`setLogSink`, `withForkFailureReporting`, path helpers).
- **The plugin contract does not cover TeXRA's own plugins.** More than half of
  the 95 files in `packages/texra/src/tools` (55 to 58, depending on the alias
  set counted) import harness internals. `ALWAYS_AVAILABLE`, `ToolFact`,
  `PermissionPayload`, `ToolCard` and `Continuation` are not public. Built-ins
  get `Runs | RunCall | ScriptCalls | IssuingScript` through an unexported
  `defineBuiltinPlugin` (`tools/plugins.ts:182`). The continuation takes the
  internal `SessionHandle` (`tools/toolTable.ts:118-129`).
- **The layout hides the lifetimes.** The session plane lives in three
  directories (tags and folds in `shared/session`, SQLite layers in
  `controllers/session`, session-lifetime layers in `agent/runtime`), with six
  same-basename pairs. Plugins live in four homes and storage in four. The
  lowest layer imports upward (`platform/processRuntime.ts:27-42`), and the
  foundation directories cycle (`shared↔utils`, `common↔utils`).
- **Writers: no near-miss survived the re-check.** The audits listed five
  (activate's cancels, tool-card producers, grants derivations, `run.config`
  shapes, `followup.consumed` drafts). Re-checked at `6e5b262`, none is a
  defect. The one missing guard, `transcriptUpdate.ts`'s switch with no
  `satisfies never`, is lane 4 (done, #14211).
- **The row-version freeze is unarmed until a release.** Its check returns early
  while `config/storage/frozen/` does not exist
  (`src/test-kernel/schemas/rowVersions.vitest.ts:104`). That is by design:
  `npm run storage:freeze` is a `releasing` step, so the first release that
  promises its rows writes the watermark.
- **Hosts.** `desktopHostRequests.ts` and `extensionHostRequests.ts` share about
  400 lines of the same composition: 125 lines are byte-identical, and the rest
  make the same calls with host-specific ports. Three hosts repeat the
  agent-directories layer and the service reach. In total about 1,400 lines can
  go. The CLI TUI synthesizes transcript rows with `Date.now()`
  (`packages/cli/src/chat/tui/state/transcript.ts:78`).
- **llm.** The package is pure as claimed, except for TeXRA branding in five
  places (`originator: 'texra'`, `X-Title: 'TeXRA.ai'`, OAuth referrers). Twelve
  Zod `.catch` calls silently default OAuth token lifetimes.

## How the design was chosen

Four designs were written independently from the same evidence, each from a
different philosophy, and an adversarial judge scored them, spot-checking claims
against the tree:

| Design                 | Idea                                                         | Churn                                       | Score /40 |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------- | --------- |
| kernel and ports       | the smallest kernel, six ports, every built-in a plugin      | ~300 files                                  | 31        |
| three packages         | `@texra-ai/history`, `harness`, `host`; root aliases deleted | ~300 files plus app and test-kernel imports | 31        |
| minimal move (control) | entries, data injection and ports, with no regroup           | 28 files                                    | 30        |
| lifetime mirror        | the tree mirrors process ⊃ session ⊃ run ⊃ step ⊃ call       | ~410 files                                  | 28        |

The two restructures beat the control by one point, at ten times its churn. All
four agreed on the substance: a root of about 30 names, a public authoring
closure, methods on `Run`, a neutral host port, vocabulary as data, Storage as
an Effect `SqlClient`, the execution pair as a port, conformance from the
existing suites, the writer fixes (re-checked below: none remains) and the
freeze. This design is the control plus the two moves that buy what the control
cannot.

## The design

### Concepts

The thirteen nouns of the core-concepts note keep their owners. The process
owner is `processLayer` in `effect/processLayer.ts`, which stays there (the 1.0 PRD's layout recommendation A keeps the ten directories). The
foundation order the code follows is declared in `packages/harness/AGENTS.md`
("Layer order") and ratcheted by `src/test-kernel/architecture/subsystemEdgeRatchet.vitest.ts`:
`logger < utils < shared < common < platform < …`, with `controllers` and `effect`
on top.

### Layout

| Target      | From                                                                                                                                                                                                | Files |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `sdk/`      | `effect/`, the entry files, `platform/processRuntime.ts`                                                                                                                                            | ~16   |
| `session/`  | `controllers/session`, `shared/session`, and the session-lifetime files in `agent/runtime` (`SessionEvents`, `RunHistory`, `SessionHandle`, `runRegistry`, `runs`, `FollowUps`, `HostInteractions`) | ~49   |
| `agent/`    | the rest of `agent/` (run ⊃ step ⊃ call)                                                                                                                                                            | ~105  |
| `tools/`    | the engine: `plugins`, `toolTable`, `liveTools`, `catalogEntries`, probes, approval, MCP, the `script` door and the delegation launch                                                               | ~25   |
| `builtins/` | every other built-in tool, importing only `@texra-ai/harness/*`                                                                                                                                     | ~53   |
| `shared/`   | schemas (a named manifest), transcript, runs, tools, state, config                                                                                                                                  | ~86   |
| `platform/` | ports, `logger/`, `eventBus/`, `types/`                                                                                                                                                             | 22    |

The 1.0 PRD's layout comparison (2026-10-30) keeps the ten directories: no `sdk/` and no `session/` for 1.0, and `builtins/` waits for a named embedder. The six pairs resolve as follows: `database`/`Database` become a log and a
store; `sessionEvents`/`SessionEvents` become an inbox and a publisher;
`runHistory`/`RunHistory` merge into one file; each `sessionInputs` and
`sessionView` pair splits into a fold and its layer; `WorkspaceRoots` merges
into one file.

Within `session/`, the storage half (row schemas and codec, versions, folds,
publisher, store) is a lint zone that imports nothing above it and passes its
own browser-safety check. It can become `@texra-ai/history` by a rename when a
second embedder appears, without a redesign.

Leaving the harness: presets, teams, icons and quota routes
move to `packages/texra/src/host/`, and the canned validation model moves to
`packages/cli`. Harness-internal aliases are declared only for the harness build
and the test kernel, so a deep import from the app or a host fails to compile.
`@common/webview` leaves the harness alias family (done: the alias is gone and
the two extension providers import `BundledViewContentProvider` relatively).

### Ports

| Port      | Contract                                                                                                                                                                                                                                                            | Default (`./node`)                  | Conformance (internal suites)                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Storage   | Deferred past 1.0 (re-check below): `openStore` is bound to a file, so a client from context cannot replace it                                                                                                                                                      | the Node SQLite file                | the golden store and crash suites as they are                                                         |
| Execution | the existing `FileSystem \| ChildProcessSpawner` pair, named on `AgentPlatform`; the settings reads in `utils/system/execUtils.ts` become arguments                                                                                                                 | the Node pair                       | the crash suite's command and file cases                                                              |
| Clock     | Effect `Clock`, `sleep` and `Schedule` only (R8); a timed wake is a follow-up held until its time (`followup.queued` gains `notBefore`), not a `run.position` field (re-check below); one scoped `Effect.sleep` per session to the earliest `notBefore` in the view | Effect's default                    | queue a timed follow-up, advance `TestClock`, assert the turn; then close, reopen, advance, assert it |
| Host      | `SessionHost`; its presentation keys are `openFile`, `requestShowInstruction`, `agentNotFound` and `requestShowError` (#14463 renamed two to fact names and kept two)                                                                                               | no-op                               | none; it decides no recorded fact                                                                     |
| Settings  | `settingsCatalog(rows, { namespace })`, prefixed at the store boundary, so stored keys are unchanged and nothing migrates                                                                                                                                           | `'harness'`; TeXRA passes `'texra'` | the existing catalog suites                                                                           |

The durable doc dropped "a storage contract suite parameterised by backend".
This design parameterises the suite by client of one dialect, not by backend,
and adds no new assertions. The suites stay in `src/test-kernel/`. A `./testing`
export of them waits for a named external consumer, as the durable doc rules
("Conformance").

### Public surface

The root entry holds what only an embedder needs, about 30 names:
`Sessions`, `Session`, `Run`, `StartInput`, `ResumeInput`, `OpenOptions`,
`SessionHost`, `ApprovalHandler`, `Outcome`, `AgentEvent`, `WorkspaceRoots`,
`AgentPlatform` and `defineTool`, plus the session's errors (`RunFailure`,
`ResumeRefused`, `PluginsRefused`, `LaunchRefused`, `ToolsRefused`,
`LaunchError`, `SessionOpenError`). A name lives on one entry: the request
vocabulary and the view types (`RuntimeRequest`, `RequestDecision`,
`PendingRequest`, `RunId`, the request errors) on `./schemas`, which a
browser surface can import, and `Plugin` on `./plugins` (round 3, Q6).

`Run` gains `text: Stream<string>`, `followUp`, `stop`, `decide` and
`transcript`, all thin methods over the existing request unions.

Superseded (2026-10-28, [Harness 1.0 release PRD](./2026-10-28-harness-1-release-prd.md)):
the PRD rejects methods on `Run` or `Session` that only forward to
`session.request`, which stays the one door; `Run` keeps `result` and the
view. The paragraph above records the option, not the plan.

The subpaths are: `./schemas` (a named manifest with storage and view sections,
and no `texra.*` constant), `./plugins` (the whole authoring closure), `./node`,
`./host` (host composition only), and `./promise`, refused for 1.0 (see
the note below).

```ts
import { Effect, Stream } from 'effect';
import { responseText, Sessions } from '@texra-ai/harness';
import { nodePlatform } from '@texra-ai/harness/node';
import { harnessBuiltins } from '@texra-ai/harness/plugins';
const platform = nodePlatform({
  agentsDir: './agents',
  storageDir: './.store',
});
const program = Effect.gen(function* () {
  const session = yield* (yield* Sessions).open(platform.roots, {
    persistent: true,
  });
  const run = yield* session.start({
    agent: 'polish',
    instruction: 'Tighten notes.md.',
  });
  yield* Stream.runForEach(run.events.pipe(responseText), (t) =>
    Effect.sync(() => process.stdout.write(t)),
  );
  return yield* run.result;
}).pipe(
  Effect.scoped,
  Effect.provide(Sessions.layer({ platform, plugins: harnessBuiltins })),
);
await Effect.runPromise(program);
```

The Promise entry argues against the 2026-09-21 ruling (rulings ledger, "The
agent SDK's public surface is Effect") and the owner's 2026-10-06 decision on
#13723 ("./promise: no implementation for now"). It is one named SDK entry file
of 60 to 120 lines, holding one `ManagedRuntime` and no logic. It is added to
the `Effect.run*` entry allowlist and recorded in `refuted-candidates`. If the
ruling holds, the file is deleted and nothing else changes.

Superseded: the 2026-09-21 ruling holds (rulings ledger, "The agent SDK's
public surface is Effect") and the 2026-10-06 decision on item 8 of the tracking issue #13723
("./promise ... no implementation for now") stands
([harness package split](../../implemented/architecture/2026-10-02-harness-package-split.md),
"There is no Promise API"); `./promise` is not built for 1.0; the subpath list above and lane 8 of the
lanes table below keep it as the refused option.

### Plugin contract

- The fields stay as they are. `availability` becomes optional, and
  `ALWAYS_AVAILABLE` is exported.
- The block reader is public (`agentBlockOf` in `./plugins`), so TeXRA's documents plugin is written
  the way an embedder's would be.
- `defineBuiltinPlugin` is deleted: every built-in is a `definePlugin` value
  on the one tool contract, `ITool<Error, PluginToolServices>`, and the
  engine tools stay in `tools/`, reading the session's runs off the engine
  door (`RunCallShape.session`, the session's services). A `builtins/` directory behind a lint fence
  waits for a named embedder that cannot write a built-in on the public
  surface; the app's own count is already zero
  ([the tool layer](../../implemented/architecture/2026-11-01-tool-layer-one-catalog-one-step.md),
  decision 4).
- `defineTool({ deferred: true })` builds on codemode's existing discovery.
- The built-in request kinds stay closed (ledger D11); a plugin opens requests
  in its own vocabulary through the generic `plugin` case
  (`shared/schemas/request.ts:119`).

## Deletion ledger

| What goes                                         | Count                                       |
| ------------------------------------------------- | ------------------------------------------- |
| Root exports                                      | 246 → 59 (what public signatures need)      |
| `export *` in `shared/schemas/index.ts`           | kept (re-check below)                       |
| `harness-deep-import-baseline.json` and its suite | kept as a guard; every host list is empty   |
| `architecture-edges` rows                         | 67 → ~45, harness only                      |
| `forgotten-exports` rows                          | 277 → 0, held at zero with no baseline file |
| Same-basename pairs                               | 6 → 0                                       |
| TeXRA code leaving the harness                    | ~1,650 lines                                |
| Duplicated host code                              | ~1,400 lines                                |
| OAuth `.catch` in llm                             | 12 → 0 (done)                               |

## Lanes

Each lane leaves `npm run gate` and `test:pure` green. The only row change is
the timed follow-up's `notBefore`, in lane 5, which the 1.0 PRD left out of the
format batch (decided 2026-10-30): a `remind` tool adds it as
`followup.queued` v+1.

| #   | Lane                                                                                                                                                                                                                                                                         | Effort | Files moved |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------- |
| 1   | Doors: the root holds what public signatures need (59 names), and `./host`, the `./schemas` manifest and the `./plugins` closure are done; left: alias scoping. `effect/` keeps its name and `Run` gains no forwarding methods (1.0 PRD)                                     | L      | 8           |
| 2   | Foundation order, done another way: `logger/` and `types/` stay layer 1 of the harness AGENTS.md layer order, there is no `eventBus/`, and the run-storage leaves went to `common/storage/` (#14550); the `@common/webview` alias removed (done, #14682)                     | M      | 11          |
| 2b  | Session merge, with the history lint zone: not for 1.0 (the release PRD's layout comparison: a `session/` directory removes no layer edge)                                                                                                                                   | M      | ~55         |
| 3   | Vocabulary as data: done (#14364, #14369), except llm branding as bind facts (the xAI referrer, the ChatGPT agent name and the Responses tool namespace)                                                                                                                     | M      | 9           |
| 4   | Done (#14211): `satisfies never` after `transcriptUpdate.ts`'s `record` switch; the writer items closed on re-check (below)                                                                                                                                                  | —      | 0           |
| 4b  | Built-ins fence, measured and redesigned as one tool contract in [the tool layer note](../../implemented/architecture/2026-11-01-tool-layer-one-catalog-one-step.md) (the fence itself is its decision 4)                                                                    | S      | 0           |
| 5   | The timed follow-up with its first consumer tool (not in the 1.0 format batch, decided 2026-10-30); `defineTool({ deferred: true })` when tool counts need it; the storage port only for a named second driver                                                               | M      | 0           |
| 6   | Freeze: `storage:freeze` at the first release (a `releasing` step, not a lane)                                                                                                                                                                                               | S      | 0           |
| 7   | Host dedup: the GUI hosts share one request body over `SharedHostRequestBindings` (`packages/texra/src/controllers/session/openGuiWindow.ts`), and `processLayer` builds the agent-directories layer from options; the CLI notices through `LocalSession.emit` are not built | L      | 0           |
| 8   | `./promise`: not built; the 2026-09-21 ruling holds                                                                                                                                                                                                                          | S      | 0           |
| 9   | Publish (the owner's `releasing` step); `docs/spec.md` and the numbered examples ladder are done (`packages/harness/docs/spec.md`, `packages/harness/example/`)                                                                                                              | M      | 0           |

### Lane 4 re-check (2026-10-21, at `6e5b262`)

Before lane 4 started, each item was read against the tree. None of the writer
items needs code; one guard does:

- **activate's cancels** (`agent/runtime/RunHistory.ts`, `activate`) are written
  in the claim's transaction, for exactly the requests the fold shows open and
  undecided (`unboundRequests`). `decisionRow`
  (`agent/runtime/requestPolicy.ts`) exists to settle a race between two
  answering surfaces; routing activation through it would add one read per
  request and close no race. `decide` is the one writer of a surface's answer;
  activation answers for a process that exited.
- **Card producers: one per run.** Deleting `agent/trace/toolUseHelpers.ts`
  moved its emission into `TraceEmitter.openToolCard`
  (`agent/trace/TraceEmitter.ts:139`). Its callers are the agent-CLI tools
  (`packages/texra/src/tools/claudeAgent.ts`, `codex.ts`,
  `claudeAgentBackgroundTasks.ts`), and they write on the trace of the child run
  that `launchAgentCliSession` registers through `ChildRuns.launchProcess`
  (`packages/texra/src/tools/agentCliShared.ts`), a run "outside the normal run
  loop", after the launching call's card has closed. A loop run's cards are the
  loop's; a process run's are `openToolCard`'s; no run has two writers. Moving
  them to `stream.chunk` on the launching card would drop them.
- **Grants**: `grantsKept`, `inheritedGrants` (`shared/approvalBypassKind.ts`)
  and `delegatedChildGrants` (`tools/delegation/subagentRun.ts`) are three rules (kept
  after a detach, inherited, a delegated child's birth grants), not one rule
  three times. `grantsKeptFromRows` already delegates to `grantsKept`.
- **`run.config`**: its three producers (registration, activation, and the
  loop's `configRow`, called from the loop, model switch and fork) differ on
  purpose: the binding exists only once the loop binds, and activation writes
  only a changed configuration.
- **`followup.consumed`**: the copies are three-line literals over different
  inputs (follow-up records, ids, filtered controls); one builder saves nothing.
- **`satisfies never`**: `applySessionFacts` in `sessionViewUpdate.ts` is partial by
  design (the run arm takes the rest) and stays so. `transcriptUpdate.ts`'s
  `record` switch covers all ten transcript event kinds today but has no
  `satisfies never`, so a new kind would compile and vanish from a durable fold.
  Lane 4 is that guard.
- **Cross-protocol switches**: `admitSwitch`
  (`agent/runtime/modelAccess/routeDecision.ts`) already refuses them
  (`DIFFERENT_FORMAT`). It compares backends, not protocols, which is stricter
  on purpose: a run keeps its backend (`shared/schemas/runFacts.ts`,
  `ModelBackendSchema`), and a stored Responses history replays its reasoning's
  `encrypted_content` (`packages/llm/src/api/openaiResponsesLower.ts`), which
  only the vendor that issued it accepts. Its refusal text says "conversation
  format" for both cases.

A timed wake (now the timed follow-up, see the 2026-10-28 re-check) and
`deferred` are features, not fixes, and move to lane 5.

### Re-check (2026-10-28, at `5d6fd81`)

A measured comparison against pi-durable 1.4.0 and DeepSeek Harness 0.2.2
re-read the surface and the ports. Where it changes this design:

- **Lane 1, the doors.** The root entry is 48 names (#14337) and no app or host
  `src/` file imports a harness internal. Five tooling and test files outside
  `src/` still do (`packages/cli/scripts/{tui-harness.tsx,service-host-harness.ts}`,
  `packages/desktop/design-harness/scenes/{desktop,extension}.ts`,
  `packages/desktop/tests/e2e/sessionLifecycle.spec.ts`); those that import
  `@shared/schemas` reach the internal barrel through the alias. `./schemas` is
  already a named list in `schemas.ts`; the 46 `export *` lines are that
  internal barrel, `shared/schemas/index.ts`, which no app or host `src/` file
  reaches. Naming its 367 exports, or importing leaves instead, adds about 519
  import lines, so the barrel stays. Of the 487 names on `./host` and
  `./schemas`, 114 have no consumer outside the harness, but the
  forgotten-exports rule keeps 108 of them because a consumed signature names
  them; #14371 removed five of the six that were free. Shrinking further means
  narrowing the root signatures (the run-lifecycle work in the 1.0 PRD) or
  moving app vocabulary: the team launch code moved to
  `packages/texra/src/shared/teamLaunch.ts` (16 `./host` names freed) and the
  picker wire types to `packages/texra/src/shared/pickerOptions.ts` (7
  `./schemas` names freed, `ModelAvailabilityKindSchema` added).
- **Lane 3, vocabulary.** #14364 made the namespace data and moved the
  presets, the LaTeX prompt, the TeX paths and the validation model to the app.
  #14369 replaces `ITool.unavailableHosts` with the host-capability check and
  deletes the code-mode `WeakSet`. `SettingHost` is gone from
  `WorkspaceRoots`, `SettingsStores` and the probes: the app reads a host's
  capabilities instead, and the setup probe its `SetupHost`.
  `defineBuiltinPlugin` went with lane 4b's one tool contract: the built-ins
  read the session's runs off the engine door, `RunCallShape.session` (#14546).
- **Lane 5, the clock.** A `run.position.wakeAt` field fits poorly: the loop
  rewrites positions at every boundary, so a user message drops the timer
  unless the loop restates it; a wake still needs input the parked run can
  read; only the loop writes positions, so a tool cannot set one; and the
  open-time scan in `tools/interruptedTasks.ts` does not run headless or in the
  SDK. A follow-up held until `notBefore` uses the existing inbox, wake and
  claim paths, and the view already lists every queued follow-up. It is a
  feature (about +105 lines with a first `remind` tool) and only its row field
  is cheaper before the freeze.
- **Lane 5, storage.** `openStore` checks stamps with a read-only probe, moves a
  damaged file aside by rename and reconnects, and copies a pre-1.0 store, so a
  ready-made `SqlClient` cannot stand in for it. A port would move about 40
  lines and add about 20, and the crash suite writes files directly, so it gains
  nothing from a client parameter. Browser and edge targets need more than a
  client (WAL, `data_version` polling, process-identity liveness,
  `BEGIN IMMEDIATE`). The 1.0 PRD excludes several backends; revisit on a named
  second driver.
- **Lane 5, deferred tools.** `OfferedTool.sent`, the script-only dispatch path
  and `searchTools` already exist; marking a tool deferred is about seven lines
  and changes no row, so it can follow the freeze.

### Sequencing with work in flight

On 2026-10-21 the owner set this order:

1. `fix/race-conditions-one-owner`. It edits session open and close, the inbox
   and `runRegistry`, so it lands before lane 2b. Merged (#14210).
2. `feat/script-launched-goal` (#14201, merged). It edits the goal plugin, which
   lane 4b moves.
3. The debt-cleanup branches (`claude/debt-*`), all merged or closed by
   2026-10-22. Item 2 (#14193) folded the llm OAuth files ahead of lane 3's
   `.catch` removal. Item 7 (#14191) changed `openSettings` in both GUI host
   request files. Item 5 (#14197) shrank the deep-import baseline. Item 8
   (#14198) was closed unmerged, so lane 1 moves its two imports (`AgentTrace`,
   `describeFollowUpFailure`) itself.
4. This design's lanes.

One later PR is not in the owner's order but also precedes the lanes whose files
it edits: #14199 (merged; fallback chains: `agent/runtime`, the llm OAuth files,
`claudeAgent.ts`) before lanes 2b and 3.

The "Pre-water night launch priorities" review (2026-10-21) ranked two items
first: finishing the move of tool-edit approval into the loop, and putting the
remaining built-ins on `ToolContext`. Its author corrected the first on
2026-10-22, after reading `main` at `1c68e67`. Tool-edit approval cannot move
into the loop as bash's did. The bash guard spells its command from the input
alone, but an edit's proposal is computed by the body, the person may change it
in the diff view, and the body writes what was approved. So the approval is
mid-body by necessity. `applyApprovedFileEdit` (`tools/fileEditFlow.ts`)
composes it for EditTool and WriteTool; the app's AcceptRunFilesTool composes
the same two primitives (`requestToolEditApproval`, `approvedWriteConflict`)
directly. The `presentToolEdit` port stays: it carries the original and proposed
content that the durable `request.opened` deliberately omits.

Lane 4b therefore starts with the fence itself. The two `tools/approval/`
modules stay in `tools/`, which the layout above makes the engine, and none
moves to `builtins/`: `toolEditApproval.ts` reads the session's `Approvals` and imports
`@agent/runtime/RunCall`, and `approvedWrite.ts` imports `@platform/rootedFs`,
which the fence's
public-imports rule forbids a built-in. `requestToolEditApproval` stays the one
request path for edits, which `applyApprovedFileEdit` and AcceptRunFilesTool
both call. No shared preamble is left to fold: the bash guard decides in the loop
(`agent/runtime/loop/toolGuard.ts`), and the edit path asks
`approvals.permission` (`toolEditApproval.ts:91`). Putting the other built-ins on `ToolContext` stays part of the fence.

## Risks and non-goals

- **The session merge collides** with open work on `runRegistry.ts` and
  `SessionEvents.ts`, the two most-edited files. That is why it follows the
  race-fix branch.
- **The fence may show that a built-in needs something no app plugin should
  have.** Such a tool is engine code: it moves to `tools/`, and no new export is
  added for it.
- **Alias scoping** must still serve `tsconfig.test-kernel.json`, which today
  extends the root `tsconfig.json`.
- **`./host`** is smaller but nothing forces it to shrink. Its api-report diff
  is the only check.
- **The timed follow-up's `notBefore`** needs a `followup.queued` version bump
  either way; after the freeze it costs one identity upcaster more (1.0 PRD,
  decided 2026-10-30).
- Non-goals: a second dialect, third-party code in process, a daemon, request or
  task kinds, in-process hooks, and cross-protocol history conversion. A model
  switch across protocols is refused early.

Still open after this design: about 350 lines of duplicated lowering across the
llm adapters; `sessionViewUpdate.ts` at 1,169
lines; the CLI approval stack versus the webview request panels; and four
CLAUDE.md rules with no check (the barrel ban, the single-caller ban, renderer
`Date.now()`, and silent degradation outside the harness and llm).

## Owner questions

1. **The Promise entry.** Ship it as the argued exception to the 2026-09-21
   ruling, or keep the Effect-only surface? _Recommend: ship it last; deleting
   it costs one file._ Answered: the Effect-only surface holds and `./promise`
   is not built (see the note under Public surface).
2. **`./host`.** Keep about 37 host-composition names on a subpath with no
   stability promise, or move them into `packages/texra`? _Recommend: the
   subpath now, and move them as the hosts' imports shrink._ Answered by the
   2026-10-28 re-check: the subpath stays; only the team launch code and the
   picker wire types are app vocabulary to move.
3. **History as a package.** Keep it as a lint zone in `session/` until a second
   embedder is named? _Recommend: yes; the rename stays cheap._ Not for 1.0: the release PRD's
   layout comparison keeps `controllers/` and builds no `session/` directory.
4. **The `texra.` namespace.** Prefix at the store boundary, with stored keys
   unchanged? _Recommend: yes; nothing migrates._ Answered by #14364: `settingsCatalog`
   takes a `namespace`, which the stores add (`shared/state/stateSettings.ts:665`).

## Verified

- Read `main` at `08455c8`, and re-checked the load-bearing claims at `1a553be`:
  `Database.ts:18`, `:68-69`, `:241`, `:246`, `:1032`;
  `processRuntime.ts:27-42`, `:97-120`; `stateSettings.ts:72`, `:858`;
  `PromptBuilder.ts:32`; `RunHistory.ts:365-377` against `SessionHandle.ts:316`;
  `tools/plugins.ts:182`; `runtimePresentationEvents.ts:20-26`;
  `rowVersions.vitest.ts:104`; and the line counts of `validationModel.ts`
  (547), `agentPresets.ts` (192), `common/teams` (372), `iconNames.ts` (138),
  `copilotRouting.ts` (225, since deleted with Copilot support) and
  `quotaFallbackRoutes.ts` (71, since deleted: its words moved to the app's
  copy).
- The import graph was computed by resolving every `tsconfig.json` alias over
  about 1,400 files and 10,000 import statements at `08455c8` (the exact figures
  depend on the file filter). The harness deep-import set matches
  `config/ratchets/harness-deep-import-baseline.json` exactly.
- The pi-durable comparison reads its `README.md`, `package.json` (1.3.0),
  `CHANGELOG.md` and `docs/spec.md` at `earendil-works/pi` main.
- Not run: any prototype, or any build or test of the proposed lanes.
