---
created: 2026-10-21
status: proposed
---

# The harness as a general package: surface first, two structural moves

Baseline: `main` at `08455c8` for the audits, re-checked against `1a553be`.
Line references point into that tree, except the lane 4 re-check, which reads
`6e5b262`. The durable doc is
[`2026-10-02-durable-harness.md`](./2026-10-02-durable-harness.md) (accepted);
the split doc is
[`2026-10-02-harness-package-split.md`](./2026-10-02-harness-package-split.md).

## Summary

The owner wants `@texra-ai/harness` to be a general package, as usable as
pi-durable, with TeXRA as one app on it. Seven read-only audits of the tree and
a four-design comparison came to one diagnosis: the rooms are right and the
doors are wrong. The ten invariants of the core-concepts note hold in the
kernel. What lags is the package around it: what its entries export, how much
TeXRA vocabulary it still carries, and a layout that splits one concept across
several directories.

The design keeps the package set and most of the tree. It closes the gaps by
changing the entries, injecting TeXRA's vocabulary as data, and naming two
ports. It adds exactly two structural moves, each
buying something a surface change cannot: one `session/` directory, and a
`builtins/` directory that may import only public entries. In total about 136
files move, about 1,500 import lines change, one row field is added, and about
3,300 lines and 210 baseline rows go. No new test file is needed.

## What the audits found

### What holds

- **Every forbidden import edge is zero.** harness→app, harness→host,
  llm→repo and texra→host all measure zero over about 1,400 source files at
  `08455c8`. ESLint, the
  deep-import baseline and the architecture tests agree with one another.
- **The writer core is clean.** There are three commit doors, all on the one
  publisher (`agent/runtime/SessionEvents.ts:224-341`). No app or host file
  writes rows. The loop holds no shadow of the fold. Requests have one answer
  path and runs have one input queue.
- **The crash-point suite** checks I1 to I9 at every commit point, under the
  built-ins and under TeXRA's plugins. pi-durable has no equivalent.

### Behind pi-durable

| Gap                           | Today                                                                                                                                             | pi-durable 1.3.0                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Storage                       | `controllers/session/Database.ts:18` imports `SqliteClient` and builds it at `:241`, `:246`, `:1032`; `:68-69` import the plugin table            | `Storage` port, five backends, `registerStorageConformance` |
| Execution                     | `ChildProcessSpawner` is process-wide (`platform/processRuntime.ts:103`)                                                                          | `ExecutionEnv` per conversation, `registerEnvConformance`   |
| Edge                          | Effect only. A follow-up is `session.request({ kind: 'followUp.send' })`, and streaming text means pairing `stream.start` ids with `stream.chunk` | `await Harness.open()`, `submission.wait()`, `watchEvents`  |
| Quickstart                    | 30 lines, two directories, five peers in patch lockstep                                                                                           | 12 lines, `MemoryStorage`, no peers                         |
| Spec, examples                | design spread over internal notes; two packed examples that call no model                                                                         | one `docs/spec.md`, 32 numbered examples                    |
| Publication                   | not on npm                                                                                                                                        | released 2026-10-01                                         |
| Deferred tools, durable sleep | none                                                                                                                                              | `/tool-search`; `sleeping` with host wake                   |

### Behind our own design

- **Semantic leaks.** The audit counted eleven groups; the largest follow.
  Discipline teams are hardcoded in
  `shared/schemas/agentPresets.ts:62-145`. The settings catalog forces the
  `texra.` prefix (`shared/state/stateSettings.ts:858`), and `texra.` appears on
  about 100 lines across 29 harness files, comments included. TeX tool lookup
  sits in `utils/system/binaryResolver.ts` and the TeX Live and MiKTeX
  directories in `utils/system/platformPaths.ts`; both are exported from
  `./node`. The base system prompt asks for LaTeX math
  (`agent/prompt/PromptBuilder.ts:32`). `SettingHost` lists TeXRA's products
  (`stateSettings.ts:72`) and sits on `WorkspaceRoots` and `ITool`. The
  547-line canned validation model lives inside the run package. Icon names
  live in the wire layer.
- **The root entry is a host door.** It has 246 exports by `config/api-reports/harness.api.md`: 43 serve only TeXRA's
  hosts (`HostInteractions` with VS Code event names at
  `agent/runtime/runtimePresentationEvents.ts:20-26`, presets,
  `WorkspaceAgentsController`, `decideRunModel`) and 37 are internal plumbing
  (`setLogSink`, `withForkFailureReporting`, path helpers).
- **The plugin contract does not cover TeXRA's own plugins.** More than half
  of the 95 files in `packages/texra/src/tools` (55 to 58, depending on the
  alias set counted) import harness internals. `ALWAYS_AVAILABLE`,
  `ToolFact`, `PermissionPayload`, `ToolCard` and `Continuation` are not
  public. Built-ins get `Runs | RunCall | ScriptCalls | IssuingScript` through
  an unexported `defineBuiltinPlugin` (`tools/plugins.ts:182`). The
  continuation takes the internal `SessionHandle` (`tools/toolTable.ts:118-129`).
- **The layout hides the lifetimes.** The session plane lives in three
  directories (tags and folds in `shared/session`, SQLite layers in
  `controllers/session`, session-lifetime layers in `agent/runtime`), with six
  same-basename pairs. Plugins live in four homes and storage in four. The
  lowest layer imports upward (`platform/processRuntime.ts:27-42`), and the
  foundation directories cycle (`shared↔utils`, `common↔utils`).
- **Writers: no near-miss survived the re-check.** The audits listed five
  (activate's cancels, tool-card producers, grants derivations, `run.config`
  shapes, `followup.consumed` drafts). Re-checked at `6e5b262`, none is a
  defect. One guard is missing: `transcriptFold.ts`'s switch has no
  `satisfies never`; see lane 4.
- **The row-version freeze is unarmed until a release.** Its check returns
  early while `config/storage/frozen/` does not exist
  (`src/test-kernel/schemas/rowVersions.vitest.ts:104`). That is by design:
  `npm run storage:freeze` is a `releasing` step, so the first release that
  promises its rows writes the watermark.
- **Hosts.** `desktopHostRequests.ts` and `extensionHostRequests.ts` share
  about 400 lines of the same composition: 125 lines are byte-identical, and
  the rest make the same calls with host-specific ports. Three hosts repeat the agent-directories layer and
  the service reach. In total about 1,400 lines can go. The CLI TUI
  synthesizes transcript rows with `Date.now()`
  (`packages/cli/src/chat/tui/state/transcript.ts:78`).
- **llm.** The package is pure as claimed, except for TeXRA branding in five
  places (`originator: 'texra'`, `X-Title: 'TeXRA.ai'`, OAuth referrers).
  Twelve Zod `.catch` calls silently default OAuth token lifetimes.

## How the design was chosen

Four designs were written independently from the same evidence, each from a
different philosophy, and an adversarial judge scored them, spot-checking
claims against the tree:

| Design                 | Idea                                                         | Churn                                       | Score /40 |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------- | --------- |
| kernel and ports       | the smallest kernel, six ports, every built-in a plugin      | ~300 files                                  | 31        |
| three packages         | `@texra-ai/history`, `harness`, `host`; root aliases deleted | ~300 files plus app and test-kernel imports | 31        |
| minimal move (control) | entries, data injection and ports, with no regroup           | 28 files                                    | 30        |
| lifetime mirror        | the tree mirrors process ⊃ session ⊃ run ⊃ step ⊃ call       | ~410 files                                  | 28        |

The two restructures beat the control by one point, at ten times its churn.
All four agreed on the substance: a root of about 30 names, a public authoring
closure, methods on `Run`, a neutral host port, vocabulary as data, Storage as
an Effect `SqlClient`, the execution pair as a port, conformance from the
existing suites, the writer fixes (re-checked below: none remains) and the
freeze. This design is the control
plus the two moves that buy what the control cannot.

## The design

### Concepts

The thirteen nouns of the core-concepts note keep their owners. The process
owner is `effect/processLayer.ts:116`, which becomes `sdk/processLayer.ts`.
The foundation order is declared and ratcheted:
`utils < common < platform < shared < {agent, tools} < session < sdk`.

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

The six pairs resolve as follows: `database`/`Database` become a log and a
store; `sessionEvents`/`SessionEvents` become an inbox and a publisher;
`runHistory`/`RunHistory` merge into one file; each `sessionInputs` and
`sessionView` pair splits into a fold and its layer; `WorkspaceRoots` merges
into one file.

Within `session/`, the storage half (row schemas and codec, versions, folds,
publisher, store) is a lint zone that imports nothing above it and passes its
own browser-safety check. It can become `@texra-ai/history` by a rename when a
second embedder appears, without a redesign.

Leaving the harness: presets, teams, icons, Copilot routing and quota routes
move to `packages/texra/src/host/`, and the canned validation model moves to
`packages/cli`. Harness-internal aliases are declared only for the harness
build and the test kernel, so a deep import from the app or a host fails to
compile. `@common/webview` leaves the harness alias family.

### Ports

| Port      | Contract                                                                                                                                                                                                                                                                   | Default (`./node`)                  | Conformance (internal suites)                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Storage   | Effect `SqlClient` taken from context by `databaseLayer`; one dialect                                                                                                                                                                                                      | `sqliteStorage(path)`               | golden store and crash suites, parameterised by client layer                                          |
| Execution | the existing `FileSystem \| ChildProcessSpawner` pair, named on `AgentPlatform`; the settings reads in `utils/system/execUtils.ts:9` and `gitAuthorEnv.ts:15` become arguments                                                                                             | the Node pair                       | the crash suite's command and file cases                                                              |
| Clock     | Effect `Clock`, `sleep` and `Schedule` only (R8); `run.position` gains `wakeAt`; a live session keeps one scoped `Effect.sleep` to the earliest `wakeAt` and re-arms it on each new park, and the next `Sessions.open` scans for due runs a crashed or closed process left | Effect's default                    | park, advance `TestClock`, assert resume in the open session; then park, close, reopen, assert resume |
| Host      | `SessionHost` with neutral names (`openFile`, `showNotice`, `showError`, `focusSession`)                                                                                                                                                                                   | no-op                               | none; it decides no recorded fact                                                                     |
| Settings  | `settingsCatalog(rows, { namespace })`, prefixed at the store boundary, so stored keys are unchanged and nothing migrates                                                                                                                                                  | `'harness'`; TeXRA passes `'texra'` | the existing catalog suites                                                                           |

The durable doc dropped "a storage contract suite parameterised by backend".
This design parameterises the suite by client of one dialect, not by backend,
and adds no new assertions.
The suites stay in `src/test-kernel/`. A `./testing` export of them waits for a
named external consumer, as the durable doc rules ("Conformance").

### Public surface

The root entry has about 30 names: `Sessions`, `Session`, `Run`, `StartInput`,
`ResumeInput`, `OpenOptions`, `SessionHost`, `ApprovalHandler`,
`PendingRequest`, `RequestDecision`, `RuntimeRequest`, `Outcome`,
`SessionView`, `RunView`, `RunEndResult`, `AgentEvent`, `RunId`,
`WorkspaceRoots`, `AgentPlatform`, `AgentDefinition`, `Plugin` and
`defineTool`, plus the errors (`RunFailure`, `ResumeRefused`,
`TraceUnavailable`, `PluginsRefused`, `AgentNotFound`, `ToolsRefused`,
`LaunchError`, `RequestError`, `SessionOpenError`).

`Run` gains `text: Stream<string>`, `followUp`, `stop`, `decide` and
`transcript`, all thin methods over the existing request unions.

The subpaths are: `./schemas` (a named manifest with storage and view
sections, and no `texra.*` constant), `./plugins` (the whole authoring
closure), `./node`, `./host` (host composition only), and
`./promise`, which ships last.

```ts
import { Effect, Stream } from 'effect';
import { Sessions } from '@texra-ai/harness';
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
  yield* Stream.runForEach(run.text, (t) =>
    Effect.sync(() => process.stdout.write(t)),
  );
  return yield* run.result;
}).pipe(
  Effect.scoped,
  Effect.provide(Sessions.layer({ platform, plugins: harnessBuiltins })),
);
await Effect.runPromise(program);
```

The Promise entry argues against the 2026-09-21 ruling (rulings ledger,
"The agent SDK's public surface is Effect"). It is one named SDK entry file of
60 to 120 lines, holding one `ManagedRuntime` and no logic. It is added to the
`Effect.run*` entry allowlist and recorded in `refuted-candidates`. If the
ruling holds, the file is deleted and nothing else changes.

### Plugin contract

- The fields stay as they are. `availability` becomes optional, and
  `ALWAYS_AVAILABLE` is exported.
- `Continuation` takes a public `RunPark` (run id, state, can-continue, ask)
  instead of `SessionHandle`. `recipeOf(block)` becomes public, so TeXRA's
  documents plugin is written the way an embedder's would be.
- `defineBuiltinPlugin` is deleted. The engine tools stay in `tools/`. Every
  other built-in is a `definePlugin` value in `builtins/`, which a lint fence
  restricts to public entries. The same fence on `packages/texra/src/tools`
  drives that count to zero.
- `toolUseHelpers.ts` is deleted. The agent-CLI tools report progress through
  `progress(text)`, which emits a transient `stream.chunk`.
- `defineTool({ deferred: true })` builds on codemode's existing discovery.
- Request kinds stay closed (ledger D11) until a named plugin cannot be MCP
  plus hooks plus data.

## Deletion ledger

| What goes                                         | Count                  |
| ------------------------------------------------- | ---------------------- |
| Root exports                                      | 246 → ~30              |
| `export *` in `shared/schemas/index.ts`           | 47 → 0                 |
| `harness-deep-import-baseline.json` and its suite | deleted                |
| `architecture-edges` rows                         | 67 → ~45, harness only |
| `forgotten-exports` rows                          | 277 → ~180             |
| Same-basename pairs                               | 6 → 0                  |
| TeXRA code leaving the harness                    | ~1,650 lines           |
| Duplicated host code                              | ~1,400 lines           |
| OAuth `.catch` in llm                             | 12 → 0                 |

## Lanes

Each lane leaves `npm run gate` and `test:pure` green. The only row change is
`wakeAt`, in lane 5, which lands before the freeze.

| #   | Lane                                                                                                                                                                                         | Effort | Files moved |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------- |
| 1   | Doors: the root to ~30 names, `./host`, the `./schemas` manifest, the `./plugins` closure, `effect/` → `sdk/`, alias scoping, the `Run` methods                                              | L      | 8           |
| 2   | Foundation order: `logger`, `eventBus` and `types` into `platform/`; the run-storage utils into `agent/storage`; the `@common/webview` alias removed                                         | M      | 11          |
| 2b  | Session merge, with the history lint zone                                                                                                                                                    | M      | ~55         |
| 3   | Vocabulary as data: namespace, `SettingHost` → probe, branding, the prompt section, data files to texra, the validation model to cli, llm branding as bind facts, the OAuth `.catch` removal | M      | 9           |
| 4   | `satisfies never` after `transcriptFold.ts`'s `record` switch; the writer items closed on re-check (below)                                                                                   | —      | 0           |
| 4b  | Built-ins fence                                                                                                                                                                              | M      | ~53         |
| 5   | Ports, and the conformance suites parameterised by layer (internal); `wakeAt` with the Clock port; `defineTool({ deferred: true })`                                                          | M      | 0           |
| 6   | Freeze: `storage:freeze` at the first release (a `releasing` step, not a lane)                                                                                                               | S      | 0           |
| 7   | Host dedup: `createGuiHostRequests`, one service reach, the agent-directories layer from options, the CLI notices through `LocalSession.emit`                                                | L      | 0           |
| 8   | `./promise`                                                                                                                                                                                  | S      | 0           |
| 9   | Publish, `docs/spec.md`, a numbered examples ladder                                                                                                                                          | M      | 0           |

### Lane 4 re-check (2026-10-21, at `6e5b262`)

Before lane 4 started, each item was read against the tree. None of the
writer items needs code; one guard does:

- **activate's cancels** (`agent/runtime/RunHistory.ts`, `activate`) are
  written in the claim's transaction, for exactly the requests the fold shows
  open and undecided (`unboundRequests`). `decisionRow`
  (`agent/runtime/requestPolicy.ts`) exists to settle a race between two
  answering surfaces; routing activation through it would add one read per
  request and close no race. `decide` is the one writer of a surface's
  answer; activation answers for a process that exited.
- **Card producers: one per run.** Deleting `agent/trace/toolUseHelpers.ts`
  moved its emission into `TraceEmitter.openToolCard`
  (`agent/trace/TraceEmitter.ts:139`). Its callers are the agent-CLI tools
  (`packages/texra/src/tools/claudeAgent.ts`, `codex.ts`,
  `claudeAgentBackgroundTasks.ts`), and they write on the trace of the child
  run that `launchAgentCliSession` registers through `ChildRuns.launchProcess`
  (`packages/texra/src/tools/agentCliShared.ts`), a run "outside the normal
  run loop", after the launching call's card has closed. A loop run's cards
  are the loop's; a process run's are `openToolCard`'s; no run has two
  writers. Moving them to `stream.chunk` on the launching card would drop
  them.
- **Grants**: `grantsKept`, `inheritedGrants` (`shared/approvalBypassKind.ts`)
  and `delegatedChildGrants` (`tools/approval/index.ts`) are three rules
  (kept after a detach, inherited, a delegated child's birth grants), not one
  rule three times. `grantsKeptFromRows` already delegates to `grantsKept`.
- **`run.config`**: its three producers (registration, activation, and the
  loop's `configRow`, called from the loop, model switch and fork) differ on
  purpose: the binding exists only once the loop binds, and activation writes
  only a changed configuration.
- **`followup.consumed`**: the copies are three-line literals over different
  inputs (follow-up records, ids, filtered controls); one builder saves
  nothing.
- **`satisfies never`**: `applySessionSlices` in `sessionFold.ts` is partial
  by design (the run arm takes the rest) and stays so. `transcriptFold.ts`'s
  `record` switch covers all ten transcript event kinds today but has no
  `satisfies never`, so a new kind would compile and vanish from a durable
  fold. Lane 4 is that guard.
- **Cross-protocol switches**: `admitSwitch`
  (`agent/runtime/modelAccess/routeDecision.ts`) already refuses them
  (`DIFFERENT_FORMAT`). It compares backends, not protocols, which is
  stricter on purpose: a run keeps its backend (`shared/schemas/runFacts.ts`,
  `ModelBackendSchema`), and a stored Responses history replays its
  reasoning's `encrypted_content` (`packages/llm/src/api/openaiResponsesLower.ts`),
  which only the vendor that issued it accepts. Its refusal text says
  "conversation format" for both cases.

`wakeAt` and `deferred` are features, not fixes, and move to lane 5.

### Sequencing with work in flight

On 2026-10-21 the owner set this order:

1. `fix/race-conditions-one-owner`. It edits session open and close, the
   inbox and `runRegistry`, so it lands before lane 2b.
2. `feat/script-launched-goal`. It edits the goal plugin, which lane 4b moves.
3. The debt-cleanup branches (`claude/debt-*`). Their item 2 folds the llm
   OAuth files, so the `.catch` removal in lane 3 waits for it. Item 7 changes
   `openSettings` in both GUI host request files, so lane 7 waits for it.
   Item 5 (#14197) shrinks the deep-import baseline before lane 1 deletes
   it. Item 8 (#14198) was closed unmerged, so lane 1 moves its two imports
   (`AgentTrace`, `describeFollowUpFailure`) itself.
4. This design's lanes.

Two later branches are not in the owner's order but also precede the lanes
whose files they edit: #14199 (fallback chains; `agent/runtime`, the llm OAuth
files, `claudeAgent.ts`) before lanes 2b, 3 and 4, and
`claude/effect-native-replacements` (Effect `Clock`, `Cache` and `repeat` in
`agent/runtime`, `tools/bash.ts`, the CLI service) before lanes 2b and 5.

The "Pre-water night launch priorities" review (2026-10-21) ranked two items
first: finishing the move of tool-edit approval into the loop, and putting the
remaining built-ins on `ToolContext`. Both are prerequisites of lane 4b and
run as its first steps.

## Risks and non-goals

- **The session merge collides** with open work on `runRegistry.ts` and
  `SessionEvents.ts`, the two most-edited files. That is why it follows the
  race-fix branch.
- **The fence may show that a built-in needs something no app plugin should
  have.** Such a tool is engine code: it moves to `tools/`, and no new export
  is added for it.
- **Alias scoping** must still serve `tsconfig.test-kernel.json`, which today
  extends the root `tsconfig.json`.
- **`./host`** is smaller but nothing forces it to shrink. Its api-report diff
  is the only check.
- **`wakeAt`** is free only before the freeze.
- Non-goals: a second dialect, third-party code in process, a daemon, request
  or task kinds, in-process hooks, and cross-protocol history conversion. A
  model switch across protocols is refused early.

Still open after this design: about 350 lines of duplicated lowering across
the llm adapters and OpenRouter's hand-rolled transport; `sessionFold.ts` at
1,229 lines; the CLI approval stack versus the webview request panels; and
four CLAUDE.md rules with no check (the barrel ban, the single-caller ban,
renderer `Date.now()`, and silent degradation outside the harness and llm).

## Owner questions

1. **The Promise entry.** Ship it as the argued exception to the 2026-09-21
   ruling, or keep the Effect-only surface? _Recommend: ship it last;
   deleting it costs one file._
2. **`./host`.** Keep about 37 host-composition names on a subpath with no
   stability promise, or move them into `packages/texra`? _Recommend: the
   subpath now, and move them as the hosts' imports shrink._
3. **History as a package.** Keep it as a lint zone in `session/` until a
   second embedder is named? _Recommend: yes; the rename stays cheap._
4. **The `texra.` namespace.** Prefix at the store boundary, with stored keys
   unchanged? _Recommend: yes; nothing migrates._

## Verified

- Read `main` at `08455c8`, and re-checked the load-bearing claims at
  `1a553be`: `Database.ts:18`, `:68-69`, `:241`, `:246`, `:1032`;
  `processRuntime.ts:27-42`, `:97-120`; `stateSettings.ts:72`, `:858`;
  `PromptBuilder.ts:32`; `RunHistory.ts:365-377` against `SessionHandle.ts:316`;
  `tools/plugins.ts:182`; `runtimePresentationEvents.ts:20-26`;
  `rowVersions.vitest.ts:104`; and the line counts of `validationModel.ts`
  (547), `agentPresets.ts` (192), `common/teams` (372), `iconNames.ts` (138),
  `copilotRouting.ts` (225) and `quotaFallbackRoutes.ts` (71).
- The import graph was computed by resolving every `tsconfig.json` alias over
  about 1,400 files and 10,000 import statements at `08455c8` (the exact
  figures depend on the file filter). The harness deep-import set matches
  `config/ratchets/harness-deep-import-baseline.json` exactly.
- The pi-durable comparison reads its `README.md`, `package.json` (1.3.0),
  `CHANGELOG.md` and `docs/spec.md` at `earendil-works/pi` main.
- Not run: any prototype, or any build or test of the proposed lanes.
