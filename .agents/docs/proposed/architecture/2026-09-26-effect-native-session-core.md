# Effect-native session core: seven moves after scope-owned lifetimes

Status: proposed

Origin: the owner asked, after #13340 (scope-owned lifetimes for runs,
sessions and shutdown), for a deep survey of what is core and what is a
plugin, which areas are leftovers from earlier generations, and how the
runtime, the session handle, the transcripts and the folds talk to each other,
before deciding what to make Effect-native and hot-pluggable. The owner also
said the SDK does not have to keep its synchronous design: an Effect-native
SDK is acceptable.

Pin: `main` at `3efffcc` (#13340). Thirteen read-only audits ran against that
commit: six area surveys (plugins and core, launch paths, the data plane,
process lifetimes, session handling, host transport), then seven
adversarial checks of the structural moves below. Each check was told to
refute its move against the code, the
[rulings ledger](../../implemented/architecture/2026-08-01-architecture-rulings-ledger.md)
and `config/ratchets/refuted-candidates.json`. The claims marked _confirmed_
were re-read in the code by the author of this note.

Relation to the owners in [INDEX.md](../../INDEX.md): this note owns no topic.
Each move names the owning note it amends, and a move that lands updates that
owner rather than this note.

## Thesis

Most of the redundancy in the session plane has one of five causes. There is
no single state that runtime decisions read. Plugin state and resources have
no owner of their own. Three run programs each own their own claim and
terminal. The process is a runtime plus about fifteen module slots. Each host
repeats decisions the core should make.

The first drafts of these moves were larger than the code supports. The
adversarial checks refuted five of their claims (listed under
[Withdrawn](#withdrawn)), and what remains below is the shape that survived.
Measured net deletions are modest, roughly 2k production lines across the
programme. The gain is ownership: one reader of state for runtime decisions,
typed plugin services at the lifetimes that already exist, one launch
surface, one process graph, one behaviour per user decision on every host,
and a trace whose stages, streams and cards close with their scope.

## Defects to fix first

These do not depend on any architectural decision. Each is one small PR.

| Defect                                                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Fix                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop **Resume** on a halted workflow run turns it into a failed run _(confirmed)_        | `HostRunActions.resume` passes `{config, runId}` to the host's `runValidated` (`src/controllers/session/hostRunActions.ts:625-632`). The desktop always wraps it as `kind:'fresh'` (`packages/desktop/src/main/desktopAgentRun.ts:196`), so `runAgent` registers again, `loadRun` refuses with "already has ledger state" (`src/agent/runtime/loop/runProgram.ts:159-165`) and the lifecycle writes `run.end FAILED`. The defect is desktop-only: the extension maps the id to `kind:'resume'` (`extensionHostRequests.ts:215-222`) and resumes correctly. Its workflow resume still bypasses `resumeRun`, the route tool-use runs take, so it drops the persisted `modelCompatibilityKey` (`resumeRun.ts:260-266`) and refuses a run another process holds through the claim acquisition rather than `resumeRun`'s owned-elsewhere marking. | Send workflow runs through `AgentResume.tryResumeRun` too (tool-use runs already go there; `resumeRun` has the workflow branch). Then remove `runId` from `RunRequest`/`ValidatedRunRequest`, so `runValidated` is fresh-only on both hosts and the desktop's hard-coded `fresh` is correct by construction. |
| The SDK never runs `bootstrapHost` _(confirmed)_                                            | `packages/agent/src/effect/runtime.ts:228` calls `installProcessRuntime` directly. `bootstrapHost` (`src/controllers/hostBootstrap.ts:77-115`) installs the long-stream dispatcher, so embedders get undici's 300 s body timeout instead of 30 min and no proxy. The setting host defaults to `'vscode'` while the tool gate reads `undefined` and `PACKAGE_SETUP.host` throws.                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Make `storageDir` explicit (today it defaults to the real `~/.texra`), derive the MCP config path from it, and add a `modelTransport` option that defaults to `'none'` for embedders. The full fix is [move 4](#move-4-the-process-is-one-layer-graph).                                                      |
| `run.removed` bypasses the publisher _(confirmed)_                                          | `Database.removeRun` appends it inside its own transaction (`src/controllers/session/Database.ts:1048`). The publisher's `run.removed` arm (`src/agent/runtime/SessionEvents.ts:183`) never fires, so its open-work and follow-up entries for removed runs are never pruned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Widen the publisher job to `(ops: { append; removeRun })` and route removal through `exclusive`. The dependent-closure transaction stays in SQL.                                                                                                                                                             |
| Tool cards opened by the Claude and Codex strategies are never swept on abort _(confirmed)_ | `toolLogRefs` in `src/tools/claudeAgent.ts:236` and Codex's `itemLogRefs` have no finalizer. `OpenWork` tracks stages, streams and workflow calls but not cards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Consume both SDKs' async iterators as Streams in a scope whose finalizer ends any open card (move 7, PR 1).                                                                                                                                                                                                  |
| Seven dead imports in `SessionHandle.ts`, one of them from #13340 _(confirmed)_             | `AgentTrace`, `finalizeRun`, `interruptedWorkflowCall`, `RUN_OUTCOME`, `RunOutcome`, `toErrorMessage`, `heldSessions` each appear only on their import line. `no-unused-vars` is off (`eslint.config.mjs:615`). The dead import hid that `heldSessions` and `SessionOwner.held` are test-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Delete them. Consider re-enabling unused-import detection.                                                                                                                                                                                                                                                   |
| Webview requests stay pending after close                                                   | `sessionTransport.ts:91,143-150,211-224`: the pending map is not keyed by session and `close`/`dispose` never settle it. Callers guard, so the effect is a leaked closure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Scope-owned `Deferred`s per session, interrupted on close (move 5, PR 1).                                                                                                                                                                                                                                    |

## The programme

| Move                                                                                     | Replaces                                                                                                                                     | Effort | Rulings to amend                                                                     |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| [1. Session kernel](#move-1-a-session-kernel-beside-the-run-fold)                        | runtime decisions reading `SessionView`; the publisher's private maps; the cold whole-session lineage fold; eight hand-kept event-type lists | L      | one-run-model §3.8; the current-value decision's shared format stamp                 |
| [2. Plugins as typed Layers](#move-2-plugins-are-typed-layers-at-the-existing-lifetimes) | plugin resources in `ProcessServices` and module WeakMaps; plugin schema arms in core modules; no SDK opt-out                                | L      | plugin note "no durable state", "prompt sections are core"; one-run-program line 366 |
| [3. One launch surface](#move-3-one-launch-surface)                                      | three claim/terminal wrappers, three "run started" hooks, two workflow resume routes, `AgentEngine`                                          | M–L    | none (lands the proposed runtime design's `Runs.launch`)                             |
| [4. Process Layer graph](#move-4-the-process-is-one-layer-graph)                         | `installProcessRuntime` + `bootstrapHost`, ~14 module slots, four shutdown chains, the SDK's join machinery                                  | L      | archived service-scope ledger D5; synchronous facades "one process is one host"      |
| [5. Wire realignment](#move-5-realign-the-wire-to-the-ratified-protocol)                 | host detours for decisions, per-host copies, Promise webview transport                                                                       | M      | none (returns to PRD one-fold §8)                                                    |
| [6. Session surface split](#move-6-split-the-session-handle-by-audience)                 | the 52-member `SessionHandle` bag, per-host session lookups for resume, the default-session machinery                                        | M–L    | none if names are kept (respects `SCOPE-held-sessions-as-effects`)                   |
| [7. Effect-native trace and SDK](#move-7-effect-native-trace-and-sdk)                    | `TraceEmitter`, split stage ownership, the SDK trace tap, the platform record                                                                | L      | none (the SDK-is-Effect ruling already requires it)                                  |

Dependencies: 1 before the tag half of 6. 4 before 7's `TexraAgent.layer`. 3 is
easier after 1 (lineage reads). 2, 5 and the first half of 7 are independent.

## Move 1: a session kernel beside the run fold

### Current state

One event table feeds three folds and one tracker, all sharing
`applyRunRow` (`src/shared/session/runRows.ts:171-289`):

- `foldRunState` (`runStateFold.ts:783`): strict, per run, the resume
  authority.
- `sessionFold.fold` (`sessionFold.ts:126`): the display fold. It contains an
  unnamed session kernel, `SessionIndexes` (`:277-296`: `listed`, `ended`,
  `byOwner`, `claims`, `rows`, `latest`, `local`, `head`).
- The publisher's `track` (`src/agent/runtime/SessionEvents.ts:167-224`) and
  `hydrateFollowUps` (`:360-384`): a third copy of open work and pending
  follow-ups, for aggregates this process claims.
- The transcript reducer is a sub-reducer of the display fold and is already a
  projection; export reuses it.

Runtime decisions read the display view: follow-up admission reads
`substate === RESUMING` (`runRegistry.ts:376-395`), `stopFolded` (`:447`),
`FollowUps.ts:201`, `childRunOutput.ts:45`, `SessionRequests.ts:218`,
`sweepLeftoverRuns.ts:16`, `waitCoordination.ts:29`,
`turnAttribution.ts:58`. Lineage is read twice with two answers:
`childRunOutput` reads the live view's `parentId`, while
`persistedParentRunId` (`runRecords.ts:105-117`) folds the whole session
listing cold on every launch and resume (`runAgent.ts:146,206`,
`resumeRun.ts:418`, `executeAgent.ts:541`).

The event-type taxonomy is kept by hand in `listingTypeOf`
(`sessionEvent.ts:643-692`, "Not compiler-enforced"), `LISTING_TYPES`,
`inputTypes`, fourteen SQL literals, `SHARED_RUN_ROW_TYPES`,
`IGNORED_ROW_TYPES`, the arms of `track`, and the chunk-drop list in
`sessionLayer.ts:660-680`.

### Target

Two kernel folds, because they answer different questions (one-run-model R1:
"Two folds are legitimate only when they answer different questions over the
same rows"):

- `RunState` stays the strict per-run authority for resume.
- A tolerant `SessionKernel` answers admission, lineage, stop, requests,
  follow-ups and open work for the whole session.

`SessionView` becomes a presentation fold that calls the kernel's reducer and
adds display fields. It still runs in every process that shows a session,
because the transport carries the fold's input (one-view-state §2), so the
kernel reducer lives in browser-safe `src/shared/session/`.

```ts
// src/shared/session/sessionKernel.ts (pure, browser-safe)
export type RunKernel = RunRows & {
  readonly seq: number;
  readonly parent: RunId | null;
  readonly detached: boolean;
  readonly phase: RunPhase | 'ready';
  readonly resuming: boolean;
  readonly removed: boolean;
  readonly openWork: ReadonlyMap<string, OpenWork>;
};
export type SessionKernelState = {
  readonly runs: ReadonlyMap<RunId, RunKernel>;
  readonly children: ReadonlyMap<RunId, readonly RunId[]>;
};
export function applyKernelRow(
  state: SessionKernelState,
  row: SessionEvent,
  read: 'whole' | 'partial',
): Result.Result<SessionKernelState, KernelContradiction>;

// src/agent/runtime/SessionKernel.ts (session-lifetime service)
export class SessionKernel extends Context.Service<
  SessionKernel,
  {
    readonly state: SubscriptionRef.SubscriptionRef<SessionKernelState>;
    readonly run: (id: RunId) => RunKernel | undefined;
    readonly hydrate: (
      id: AggregateId,
    ) => Effect.Effect<void, DatabaseReadFailed>;
  }
>()('@texra/session/SessionKernel') {}
```

The kernel has two writers inside the session: the publisher job applies the
rows it commits (replacing `track`, so a write is visible to the next job),
and one scoped fiber on the tail applies rows for aggregates this process does
not own. It hydrates from the listing at open and per aggregate when a claim is
acquired. It is never persisted, so it needs no format bump. Claims, the SQL
write invariants and GC stay in SQL; the SQL copy of the open-request rule
stays as the cold-listing index.

One record, total over the vocabulary, replaces the hand-kept lists:

```ts
export const EVENT_TIER: {
  [K in SessionEvent['type']]: {
    tier: 'display' | 'ledger' | 'record' | 'checkpoint' | 'state';
    listing: 'latest' | 'request' | 'followup' | 'lifecycle' | null;
    sharedRun: boolean;
  };
};
```

An architecture test forbids `runView(` and `getUnsafe(...view)` in
`src/agent/**` and `src/tools/**`.

### PRs

1. `EVENT_TIER` and the derived lists. No behaviour change, no format bump.
2. `removeRun` through the publisher.
3. Extract `sessionKernel.ts` from `SessionIndexes` and the publisher's
   open-work logic; `sessionFold` imports it.
4. The `SessionKernel` service; delete the publisher's maps.
5. Runtime reads move to the kernel; delete `persistedParentRunId`; add the
   architecture test.
6. Queue the de-duplication cuts (usage ×4, output ×3, `run.config` written
   on every activation) on the current-value format bump, and give
   `current_value` its own stamp so a session-vocabulary bump stops moving
   global state aside.
7. Optional, only if measured: one decoded tail feed per session replacing
   the 6+N private `readAll` decodes.

Estimated net: −200 to −350 lines. The main win is measurable: no cold
whole-session fold per launch or resume.

### Rulings

- **Argue against** one-run-model §3.8 ("backend readers take `SessionView`
  from the service"). §3.8 deleted a snapshot store that answered the same
  question as the view; the kernel answers a different one, which R1 allows.
- **Amend** the current-value decision's sentence that the mismatch
  transaction drops the new table along with the event tables.
- **Keep** the single-owner liveness note's "the DB claim is the only liveness
  authority" and the `SESSION_EVENT_FORMAT` bump ruling (step 6 rides an
  existing bump).
- **Keep** `RT-corrupt-record-tag`: `decodeEvent` stays the one decode site.

## Move 2: plugins are typed Layers at the existing lifetimes

### Current state

`PLUGIN_LAYERS` is empty by design and `PluginLayer` is `Layer<never>`
(`src/tools/registry.ts:191-195`). Resource-owning plugins sit in the
23-member `ProcessServices` union (`src/platform/processRuntime.ts:64-87`):
GitHub subscriptions, Lean, `InquiryRecords`, `SetupPlatform`. That is the
right lifetime (each has consumers outside any run) but the wrong owner. The
Claude/Codex session registries (`src/tools/agentCliSessionStores.ts:14`) and
goal grants (`src/tools/goal/goalAutoApproval.ts:25`) are session state held
in module WeakMaps. The SDK cannot opt out: `installProcessRuntime` always
merges `toolRegistryLayer`, and the package hand-builds a refusing
`SetupPlatform`.

About nine of ~50 session-event arms are plugin-owned (goal, inquiry,
workflow checkpoints, `run.fact` todos and plan), and `RunView` carries their
fields, so the plugin note's "plugins own no durable state" is already false
in the tree. "Plugin" names six different things: the tool-plugin table, CLI
installed Claude/Codex plugins, MCP servers, slash-command `pluginId`, model
provider plugins and skill sources.

The composition hash reads the availability probe's module cache and falls
back to `?? []` before the first probe (`src/tools/toolAvailability.ts:174`,
`agentToolResolution.ts:236-242`), so the same switches hash differently
before and after it. VS Code LM tools bypass compositions.

### Target

One static plugin table, checked with `satisfies` like `PLUGIN_TOOLS`. No
runtime registration.

```ts
interface Plugin<Id extends string, P = never, S = never, C = never> {
  readonly id: Id;
  readonly manifest: ToolPlugin;
  readonly tools?: Record<string, RuntimeTool<Error, ToolServices | P | S | C>>;
  readonly process?: Layer.Layer<P, never, CoreProcessServices>;
  readonly beforeSessionsClose?: Effect.Effect<void, never, P>;
  readonly session?: Layer.Layer<S, never, SessionServices | P>;
  readonly composition?: Layer.Layer<C, never, P>;
  readonly continuation?: ContinuationContribution<S>;
  readonly promptSections?: (
    plugins: ReadonlySet<string>,
    ctx: PromptContext,
  ) => readonly string[];
}
```

- `ProcessServices` is derived: `CoreProcessServices` plus the success types of
  the table's `process` layers. Tool `R` widens to the plugin's own services.
- `installProcessRuntime({ plugins })` takes the set; the SDK passes a
  core-only default and drops `PACKAGE_SETUP`.
- A plugin's `session` layer merges into the existing per-session `LayerMap`
  entry, so no lifetime is added.
- **Schema arms: a closed union with plugin-owned modules.** Each in-tree
  plugin owns `src/shared/schemas/plugins/<id>.ts`, and `sessionEvent.ts`
  spreads a static `PLUGIN_EVENT_ARMS` tuple into the one
  `discriminatedUnion`. Fold slices come from a static table checked for
  totality. Rows always decode and fold whether or not the plugin is switched
  on; a switch gates behaviour, never schema. Loaded plugins (MCP) own no
  durable state.

### Why not the alternatives

- A union built at composition time makes a store unreadable when a plugin is
  off (`decodeEvent` throws on an unknown arm, `Database.ts:229-233`), moves
  the format fingerprint with the plugin set, and loses `z.infer` totality.
- An untyped `plugin.fact` envelope needs a second decode site, against
  `RT-corrupt-record-tag`.

### Hot-plug semantics

Choose at run open. A switch applies to the next run, plugin resources come
up and go down by refcount at their own lifetime, and a child joins its
parent's pin. This already works between runs. Swapping inside a running run
would rewrite `offeredTools`, change the toolset hash and the prompt cache,
contradict the run-pin ruling (2026-09-23), and contradict SDK §8 ("hot
replacement must not advertise one implementation and execute another").

### Stays core

Child runs and the native strategy (the parent edge, `child.park`/`child.turn`,
the session budget); documents output and rounds (`RunView` is discriminated
on `AgentCategory`); the approval authority. UI renderers stay a static table
in `src/ui`, because webview frontends cannot import `@tools`.

### PRs

1. Deterministic probe input to the composition key; LM tools through a pin.
2. Typed plugin services and the process contribution; GitHub, Lean,
   Inquiry, Setup move; the GitHub drain becomes `beforeSessionsClose`; the SDK
   opt-out.
3. The session contribution; delete both WeakMaps.
4. Arm relocation, gated on the `sessionEventFormat` fingerprint staying
   byte-identical.
5. Request kinds and decision recorders as contributions, under the
   approval-authority ratchet.
6. Prompt sections and definition annotations as contributions;
   `availabilityCategory` leaves `ToolDefinition`.
7. Vocabulary: rename the CLI's installed "plugins" and slash-command
   `pluginId`, so "plugin" means the table.

### Rulings

- **Amend** the plugin note (`2026-09-24-plugin-architecture.md:211-236`):
  "Plugins own no durable state and no event channel" becomes "static
  in-tree plugins own arms declared in plugin modules of the one closed
  schema". "Prompt sections are core" becomes "a section that is a pure
  function of the composition's plugin set is a contribution", since the hash
  captures the set and the rendered prompt is recorded on the snapshot.
- **Amend** one-run-program line 366 for the continuation seam, which already
  moved to `PLUGIN_CONTINUATIONS`.
- **Keep** the run-pin ruling, the per-session `LayerMap` ruling (no new
  lifetime), and SDK §8 (every contribution point is a typed static table: no
  bus, no interception, no runtime registry).
- `beforeSessionsClose` is a named hook, which "no hooks" rules against. The
  alternative is a top drain layer in move 4's graph that asks each plugin's
  process service for its drain; choose one when move 2 PR 2 is written.

## Move 3: one launch surface

### Current state

Native fresh, resumed and child runs already share `runFlowWithLifecycle` →
`runToolUse`. Three wrappers each own a claim and a terminal: `runAgent`
(`runAgent.ts:177-311`), `resumeToolUse` with `resumeToolUseWithOwnedLease`
(`executeAgent.ts:527-666`), and `runWithLaunchGuard` plus the child-loop
tail (`childRunLoop.ts:715-762,1290-1320`). The resume builder skips
`ensureRunDirUnder`, description generation, the progress reveal and the
start hooks. Three hooks overlap: `onRunClaimed`, `onRunResolved`, `onRun`.
`onIdle` is dead on the fresh branch. The one-run-program note's PR 5 promised
workflow resume through `resumeToolUseFromResumeData`; it never landed, and
`executeAgent.ts:567-573` still refuses a non-tool-use resume _(confirmed)_.

There are twenty entry routes, fourteen of them starting at a host. `run.end`
has one writing function, `finalizeRun`, with eight callers: five inside a
run, three outside (ownerless stop, session close, CLI SIGINT drain).

### Target

```ts
type RunSpec =
  | {
      readonly _tag: 'Fresh';
      readonly config: AgentConfig;
      readonly runId?: RunId; // fixed id: a workflow-script journal re-run
      readonly driver: DriverKey;
      readonly parent?: { runId: RunId; composition: CompositionKey; mode: 'detached' | 'inband' };
      readonly launch: LaunchOptions;
    }
  | {
      readonly _tag: 'Resume';
      readonly runId: RunId; // only for drivers whose resume is 'ledger'
      readonly followUps?: readonly FollowUpQueueInput[];
      readonly recovery?: RecoveryContinuation;
    };

interface Run {
  readonly runId: RunId;
  readonly events: Stream.Stream<AgentEvent, RunFailure>;
  readonly result: Effect.Effect<AgentFlowResult, RunFailure>;
  readonly idle: Effect.Effect<void>;
  readonly interrupt: Effect.Effect<void>;
}

// on Runs (session-scoped)
run(spec: RunSpec): Effect.Effect<Run, RunLive | RunAdmissionClosed | LaunchError>;
```

`Runs.run` owns admission (the existing lane, which also replaces
`withInactiveRunStep` as the workflow-script launch gate), registration,
`holdRunClaim` in the run's scope, and one finalizer that runs
`finalizeRunTerminal`, `commitRunEnd` and the claim release. It returns the
`Run` once the handle is tracked, which replaces the three hooks. The run fiber
forks into the session scope, per the runtime design's tree rule; the caller's
scope governs only its `events` subscription. `Run` matches the SDK's Tier-1
`Run` (`packages/agent/src/effect/sessions.ts:59-89`) and keeps the name
`interrupt`.

Drivers stay a core static table keyed by `DriverKey`, supplied to
`RunRegistryInit` by the session layer. That deletes `AgentEngine` and
`resumeRun`'s import of `@tools/delegation`. The foreign drivers keep their
`AbortSignal` (ledger 2026-09-18, AbortController floor).

### PRs

1. The desktop resume fix (above).
2. Delete the fresh `onIdle` branch; fix the `withInactiveRunStep` doc.
3. Finish one-run-program PR 5: resume builds the fresh launch context, and
   workflows resume through `resumeToolUseFromResumeData`.
4. `Runs.run(spec)`; the three wrappers become calls to it; in-run callers of
   `finalizeRun` go from five to one.
5. Optional, only under the file-size budgets: the driver table and
   `AgentEngine` deletion (`childRunLoop.ts` is at its 1384-line budget).

Estimated net: about −380 production lines; test churn is heavy (`runAgent`
has 158 call sites in tests).

## Move 4: the process is one Layer graph

### Current state

Five composition roots install the process runtime (extension, desktop, CLI
`cliProcessRuntime.ts`, the SDK, and the test harness that 79 suites import).
`bootstrapHost` is a separate step the SDK skips. About fourteen Node-side
module slots live outside the runtime, including the `SessionOwner`, the
`AppSignals` hub (never shut down), the setting host, two account probes,
skill contributions, plugin agent directories, the agent catalog, rate
limiters, external roots (now two writers), `cliSecrets` (ignores later
roots) and the CLI log runtime. Process-lifetime `forkDetach` fibers outlive
`runtime.dispose` (the reprobe at `hostBootstrap.ts:112`, the extension's
remote catalog and welcome, `AgentDirectoryManager.ts:250`). Four
hand-registered shutdown chains repeat "close sessions first, runtime last".

### Target

```
ProcessLayer(ports: HostPorts)                 built bottom to top, finalized top to bottom
 ├ ShutdownDrain   finalizer: plugin drains, then Sessions.closeAll   (built last, runs first)
 ├ Bootstrap       seed defaults; forkScoped(reprobe); forkScoped(remote catalog)
 ├ Sessions        LayerMap per storage root (+ HeldSessions sync faces)
 ├ HostResources   desktop projects, recording, patch dirs; extension diff refresh
 ├ UsageLog, Lean, Compositions/ToolRegistry(mcpConfigPath)
 ├ Secrets, AppState, SupabaseAuth, LanguageModel, AgentResume, AgentDirectories, SetupPlatform
 ├ AppSignals      PubSub with a shutdown finalizer
 ├ BundledResources {skills, pluginAgentDirs, resourcesPath}
 ├ AccountProbes   {codexSignedIn, xaiSignedIn}
 ├ ModelTransport  acquireRelease(setGlobalDispatcher) | none
 ├ GlobalDatabase, ProcessIdentity, GlobalStorageFs
 └ diagnostics, Node platform, FetchHttpClient, ConfigProvider
```

Each root still calls `ManagedRuntime.make(ProcessLayer(ports))` into a local
(ledger, runtime threading). Shutdown is `runtime.disposeEffect` everywhere.
The host identity becomes a field of `SettingsStores`/`WorkspaceRoots`, data
rather than a tag, which is the synchronous-facades note's preferred shape.

For the SDK:

```ts
export interface TexraProcessOptions {
  readonly agentsDir: string;
  readonly workspaceDir?: string;
  readonly storageDir: string; // required: no silent ~/.texra
  readonly mcpConfig?: string | false; // default false
  readonly modelTransport?: 'process-global' | 'none'; // default 'none'
  readonly diagnostics?: Layer.Layer<never>;
}
export const TexraProcess: {
  layer(
    o: TexraProcessOptions,
  ): Layer.Layer<Sessions, PlatformConflict | DatabaseOpenFailed>;
};
```

Three things stay process-global by necessity, so "the SDK is the same graph
without a host" is true only up to them:

- **One graph per process.** The owner id is `[hostname, pid, processStart]`,
  so two graphs in one process cannot be told apart by the lease. A latch
  refuses the second graph; the alternative, a graph nonce in `OwnerId`, is a
  durable-format change.
- **The fetch dispatcher** is global in Node; hosts keep `'process-global'`.
  `packages/llm` already accepts `transport.fetch`, so LLM traffic can move to
  a bound fetch later.
- **A plain log writer** before and after the runtime (desktop installs its
  sink at module load; the extension logs after a failed activation).

### PRs

1. SDK defects (above).
2. Host identity as data; delete `installedHost`, `initProcessSettingHost`,
   `processToolHost`.
3. `AppSignals` as a service with a shutdown finalizer.
4. `BundledResources`, `AccountProbes` and the Bootstrap layer; delete
   `hostBootstrap.ts`.
5. `Sessions` as a service; delete the owner slot. Carries the D5 re-ruling.
6. `ProcessLayer`, `ShutdownDrain`, `ports.resources`; the four chains
   collapse.
7. A `CliPlatform` layer for the 38 `initCliPlatform` sites; delete the auth
   `runSync`.
8. `TexraProcess.layer`; the SDK's holds machinery becomes the latch.

Estimated net: about −300 production lines, fourteen slots and five detached
fibers gone, one bare-run site fewer.

### Rulings

- **Argue against** the archived service-scope ledger's D5 ("`SessionOwner`
  global onto a tag: `installedProcessRuntime()` must answer synchronously for
  `composeProcess`"). Its precondition is `composeProcess`'s synchronous join,
  which this move deletes with the SDK's join.
- **Argue against** synchronous facades' "one process is one host": it is
  false for the SDK today (three answers disagree). The fix adds no tag.
- **Record** that `RT-install-cli-process-runtime`'s precondition is stale
  (ten bare-run sites in nine files; citty actions go through
  `defineCliCommand`). This move does not contradict it:
  `ManagedRuntime.make` is synchronous.
- **Record** that `SCOPE-external-roots-standalone-service`'s "one writer" has
  drifted to two. Its conversion is still deferred.
- **Keep** "no temporary adapters": each slot is deleted in the PR that
  introduces its service.

## Move 5: realign the wire to the ratified protocol

### Current state

The PRD one-fold §8 protocol (six messages, three each way) is in place, and
29 of 37 host requests go through one shared body. The rest has drifted:

- **Tool-edit approve and reject** go through a `host.request toolEdit`
  detour on the GUI hosts (`ToolEditRequestPanel.ts:62-81`) because approve
  carries the content the user edited in the diff view. The TUI decides
  directly.
- **Own-key retry** has two implementations with opposite semantics: with no
  key entered, the GUI leaves the retry pending
  (`ProgressApiKeyRetryController.ts:62-71`), and the TUI denies it
  (`subscribeApprovals.ts:162-220`).
- **"Approve all delegated"** cascades onto pending requests only in the TUI
  (`approvalQueue.ts:446-476`); `policy.set` only flips the flag.
- **`HostRunActions.sendFollowUp`** bypasses `SessionRequests`.
- About sixty lines of tool-edit wiring are copied between
  `ProgressViewProvider.ts` and `desktopAgentRun.ts`.
- **The webview request side is Promise-based.** `SessionFrames` holds
  mutable state, and the pending map leaks (above).
- **The desktop routes by heuristic.** Session and `desktop:*` messages share
  one IPC channel, told apart by `'kind' in m && !('command' in m)`.

### Target

- `RuntimeRequest` gains `run.resume`, `run.new`, `run.compileFixer`,
  `draft.polish`, `media.store` and `run.setup`. `request.decide` covers
  tool-edit approve/reject on every host, reading the edited content from a
  session-scoped `StagedEdits` read port. `policy.set` enabling approve-all
  also decides that run's pending delegated requests, in `SessionRequests`.
- `HostRequest` shrinks from 37 to about 28 genuinely host-only arms, plus
  `storeApiKey` and the desktop file I/O that travels on `desktop:*` today
  (PRD 8.3 already names it a host request). After this move `desktop:*`
  carries only process resources such as terminals and the browser.
- `attachSessionHost(session, controller, extras): Effect<void, never, Scope>`
  builds the one `interactions.use()` record, drains `events.all` into the
  host controller and provides `StagedEdits`.
- The webview transport keeps its pending requests as scope-owned
  `Deferred`s per session, consumes frames through one fiber, and holds
  `SessionFrames` state in a `SubscriptionRef`.
- The desktop gives the session protocol its own IPC channel.
- `launch` stays a host arm: `prepareSurfaceLaunch` needs host dialogs
  mid-way.

### Rejected here

- **An RPC library.** `effect/unstable/rpc` requires Effect Schema: +231 KB
  minified, +71 KB gzipped per webview (measured). PRD §7.6 rules out Effect
  Schema, the ledger forbids a sixth `unstable/*` family, and SDK §5 says "do
  not create an SDK command bus".
- **Merging the settings protocol.** It would add a second dispatcher (ledger
  2026-09-22).
- **Changing NDJSON.** It is frozen by PRD decision 8.

### PRs

1. Transport lifetimes.
2. `attachSessionHost`.
3. Tool-edit decisions through `request.decide`.
4. Own-key retry: one semantic. Needs an owner decision.
5. The delegated cascade in `policy.set`. Needs an owner decision.
6. Session commands.
7. Desktop: file I/O moves off `desktop:*` onto `host.request`, and the
   session protocol gets its own IPC channel.

Estimated net: about −440 production lines.

## Move 6: split the session handle by audience

### Current state

`SessionHandle` has 52 public members: 17 synchronous values or objects, 11
synchronous functions, 22 Effect-returning, 2 Stream-bearing, 1 callback
registration. Seven are used only by `sessionLayer.ts` (`closeDoors`,
`receiveFoldedEvent`, `folded`, `publishApprovalPolicy`, `openWork`,
`borrowRunClaim`, `decideRequest`). About 22 are run-program plumbing, and
about 10 are what a host or the SDK needs. There are doubled doors
(`approvals` and `requests.approvals`; `setTranscriptSubscriptions` and raw
`subscriptions.set`, which bypasses the disposal guard) and fifteen host sites
of `SubscriptionRef.getUnsafe(session.view)`.

There are thirteen ways to acquire a session. The resume port is
process-scoped, so each host finds the session again in its own way (extension
`tryDefaultSession`, a desktop scan over every project, a CLI module
handler), and `hostRunActions.ts:628` holds the session yet asks the process
port.

### Target

The refuted candidate `SCOPE-held-sessions-as-effects` and its neighbours in
the archived service-scope ledger §3.3 measured a `Session` context tag at "+1
export and 0 deletions". That arithmetic still holds today, so this move does
not propose a tag. It splits the bag instead:

- `Session`: the host and SDK face, about ten members (`roots`, a read-only
  `state` with a synchronous `current()`, `runs`, `request`, `removeRun`,
  `setApprovalPolicy`, a scoped `subscribe`, a scoped `onResult`, and a
  session-bound `resume`). The SDK's `Session` is already this shape.
- `SessionPlane`: a service the run program takes from context. It replaces
  the `Runs` + ledger + session trio provided at seven sites
  (`executeAgent.ts:500,680`, `resumeRun.ts:129,164`,
  `SessionRequests.ts:110,132`, `registerLanguageModelTools.ts:116`), so it
  deletes provisions rather than adding one.
- Private internals, handed only to the session layer.

`open` stays a borrow and `close` stays explicit, per #11893
(`idleTimeToLive: Duration.infinity`: "no reader's detachment and no
reference count decides a session's end"). A scoped `Sessions.get` is
rejected.

### PRs

1. Hygiene: dead imports; delete `heldSessions`/`SessionOwner.held`,
   `teardownDefaultSession`, `SessionHandleInit.interactions`,
   `FileLister.refresh`, `requests.approvals`; fix the finalizer-order comment
   at `sessionLayer.ts:594-600`.
2. One scoped subscription door.
3. Owner-private members move to an internals record (not into
   `sessionLayer.ts`, which is at its file-size baseline).
4. Session-bound resume: `AgentResumePort` becomes per-session; delete the
   desktop scan and the extension's default lookup.
5. Retire the default session: `testDefaultSession` reads
   `owner.current(installedTestRoots.storage)` (one support file, not 351
   call sites); hosts hold the handle they opened.
6. `Session` and `SessionPlane`, **keeping member names** (renaming
   `settlePublications`, `publish`, `runs` or `approvals` repeats the budget
   failure that refuted the candidate).
7. After move 1 only: most of the plane dissolves into kernel commands (about
   30 of 52 members), and a tag becomes worth its export.

## Move 7: Effect-native trace and SDK

### Current state

There are 223 production trace call sites: 174 already inside Effect, 26 in
synchronous owned helpers, 23 reached from foreign callbacks (Claude, Codex,
workflow script). Delivery is already a queue (`SessionEvents.detach`) and
sinks are fixed at construction, so the delivery half of observability-plane
step 4 has landed. Lifecycles have not:

- **The root stage has two owners.** It is ended on failure in
  `AgentLaunchContext.ts:409-424` and on the verdict in `finalizeRunTerminal`.
- **The child session stage** is ended through `unwindSetup` or
  `childRun.finalize`. The trace closes through a `closeTrace` callback.
- **`ModelInvoker` streams** finalize only inside `finishAttempt`, so an
  external interrupt leaves them open.
- **Claude and Codex cards** have no sweep (above).

### Target

```ts
export class RunTrace extends Context.Service<
  RunTrace,
  {
    readonly runId: RunId;
    readonly emit: (e: AgentEvent) => Effect.Effect<void>;
    readonly events: Stream.Stream<AgentEvent>;
  }
>()('@agent/trace/RunTrace') {}
export const CurrentStage: Context.Reference<string | undefined>;
export const Trace: {
  stage<A>(
    label: string,
    o: StageOptions & { outcome?: (a: A) => RunOutcome },
  ): <E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | RunTrace>;
  openStage(
    label: string,
    o?: StageOptions,
  ): Effect.Effect<StageHandle, never, RunTrace | Scope.Scope>;
  stream(
    kind: StreamKind,
    o?: StreamOptions,
  ): Effect.Effect<StreamHandle, never, RunTrace | Scope.Scope>;
  card(
    toolName: string,
    input: unknown,
  ): Effect.Effect<CardHandle, never, RunTrace | Scope.Scope>;
};
```

`RunTrace` is provided per run (`runLayerFor` for root runs, the child's
launch scope for children). `CurrentStage` replaces 43 sites that thread stage
ids by hand; it stamps on the emitting fiber, which observability-plane §3.4
requires. The root stage wraps the run body, so it ends before
`finalizeRunTerminal`'s settle. Foreign loops become Streams
(`Stream.fromAsyncIterable`) inside a scope that also aborts the SDK's
controller. The 26 synchronous helpers return diagnostics as data and their
Effect callers emit them.

For the SDK, the 2026-09-21 ruling already makes the root an Effect surface
with no Promise entry. The changes:

- `run.events` is `RunTrace.events` ended by the run's exit: it fails with
  the run's `RunFailure` when the run fails, as the SDK's stream does today
  (`sessionPrograms.ts:263-265`), so it keeps the `Stream<AgentEvent,
RunFailure>` contract of move 3's `Run`. `RunTrace.events` itself stays
  infallible, because a trace has no verdict of its own. The `onTraceEvent`
  tap and its `tapping` flag go.
- The handoff stays bounded. The subscription is taken at admission, so a
  reader that attaches late misses nothing, but until a reader attaches it
  fills a buffer capped at `TRACE_HANDOVER_EVENTS` (512 today,
  `sessionPrograms.ts:87`). Past the cap the trace detaches with the same
  warning as today, and a run nobody reads retains nothing once it settles.
  A caller that awaits only `run.result` therefore costs at most the cap.
- `start` returns `Effect<Run, LaunchError, Scope>`. The scope bounds only
  the caller's event subscription: closing it detaches that reader, and the
  run keeps going. The run fiber belongs to the session scope, as in move 3,
  and only `run.interrupt` or closing the session stops it.
- Approvals as data: `session.requests: Stream<PendingRequest>`,
  `session.decide(req, decision)`, and an `Approvals` layer with exactly one
  authority per session: `denyAll` (the default, today's behaviour),
  `handler(f)`, or `manual`, which decides nothing on its own and leaves
  every request to the embedder's `decide` calls. A manual consumer needs
  `manual`: under `denyAll` its decisions would race the automatic denial.
  This closes Tier-1 manifest item §7.1.
- `TexraAgent.layer` and `NodePlatform.layer` replace the `AgentPlatform`
  record, closing manifest §7.4. Waits for move 4.

```ts
const program = Effect.gen(function* () {
  const session = yield* Sessions.open();
  const run = yield* session.start({
    agent: 'proofreader',
    instruction: 'Fix typos in main.tex',
  });
  yield* run.events.pipe(
    Stream.filter((e) => e.type === 'stream.chunk'),
    Stream.runForEach((e) => Effect.sync(() => process.stdout.write(e.text))),
    Effect.forkScoped,
  );
  yield* session.requests.pipe(
    Stream.filter((r) => r.runId === run.runId),
    Stream.runForEach((r) =>
      session.decide(r, { action: 'deny', reason: 'headless' }),
    ),
    Effect.forkScoped,
  );
  return yield* run.result;
}).pipe(Effect.scoped, Effect.provide(Approvals.manual)); // one authority: the loop above
```

### PRs

1. Foreign loops to Streams, with a card sweep.
2. Scoped stages (root, child session, workflow phases) over today's emitter.
3. `ModelInvoker` streams in a per-attempt scope.
4. `RunTrace` replaces `TraceEmitter` in one PR ("no temporary adapters"):
   174 mechanical rewrites, 26 helpers returning data, 46 test files onto one
   test layer.
5. SDK events from `RunTrace.events`.
6. Approvals stream, `decide`, the `Approvals` layer.
7. `TexraAgent.layer`, after move 4.

Estimated net: about −200 production lines plus four test fakes collapsed into
one layer. PRs 1–3 fix real lifecycle bugs before any API change.

## Withdrawn

These were in the first draft and did not survive the checks:

- **One kernel fold for everything.** Resume needs a strict per-run fold with
  full history; the session kernel is tolerant and hydrated from a lossy
  listing. The SSOT survey already rejects tying resume correctness to display
  policy.
- **Every write is a command.** Claims, GC and the SQL write invariants stay
  in SQL. Only session-event appends must go through the publisher, and
  `removeRun` is the only one that does not.
- **Plugin-supplied run drivers and plugin-owned documents or child runs.**
  The plugin note rules "no task kinds" in v1; child runs and the documents
  category are structurally core.
- **Mid-run or per-session hot-plug.** Contradicts the run-pin ruling and SDK
  §8, and would lose per-run narrowing.
- **A single writer of `run.end`.** A stop with no live fiber and a close past
  its budget have no run scope. The floor is one writing function with two
  callers.
- **A caller-scoped run.** A run outlives the host request that started it.
- **An RPC library for the wire**, and **a `Session` context tag now** (see
  moves 5 and 6).

## Decisions for the owner

1. May static in-tree plugins own durable state as arms of the one closed
   schema? Move 2 assumes yes.
2. Is `SessionKernel` the only thing runtime decisions read, with
   `SessionView` display-only? Move 1 assumes yes, against one-run-model §3.8.
3. Re-rule D5 and "one process is one host" for move 4, and choose between a
   one-graph-per-process latch and an owner-id nonce.
4. Own-key retry with no key entered: leave the retry pending (GUI today) or
   deny it (TUI today)?
5. Should "approve all delegated" also decide requests already pending, on
   every host?
6. `beforeSessionsClose` as a named plugin hook, or a drain layer in the
   process graph that asks plugin services for their drains?

## Suggested order

1. The defect PRs (days).
2. In parallel: move 7 PRs 1–3 (lifecycle bugs), move 6 PRs 1–3, move 5 PRs
   1–2, move 3 PRs 1–3, move 2 PR 1.
3. After decisions 1–3: moves 1, 2 and 4.
4. Then move 3 PR 4, move 6 PRs 4–6, move 7 PRs 4–7, move 5 PRs 3–7.
5. Last: move 6 PR 7, once the kernel has absorbed the plane.

## What is open

Everything in this note. No move has started.
