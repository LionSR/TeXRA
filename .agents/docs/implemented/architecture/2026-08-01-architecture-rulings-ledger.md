# Architecture Rulings Ledger

Status: implemented

**Status:** Living. Each entry is a **closed** question — a decision that has
already cost an audit round to reach and must not be re-litigated. Add an entry
when a recurring audit question is settled but has no natural home in a plan
doc; when it does have a home (a numbered disease, a tiered item), record it
there and leave a one-line pointer here instead.

**Format:** one heading per ruling, stating the question, the decision, the
evidence that forces it, and what the decision forbids. Anchor evidence on
symbol and clause text, not line numbers — line cites in this repo drift under
shared-checkout churn.

---

## D1/T9 — persisted `result.outcome` stays; the read-time projection is final

**Question.** Drop the persisted `result.outcome` field now that `meta.outcome`
is the durable writer of "how did this run end", or accept the landed read-time
projection as the final design?

**Ruling.** Close as superseded. The read-time projection is final, and the
persisted `result.outcome` field **stays**. No field drop, no migration.

**Evidence.** `applyExecutionOutcome` (`src/agent/storage/resultMeta.ts`) is the
one projection, and its own contract comment records why the two values are not
redundant: a durable `completed` is **never** projected, because the result
envelope's producer may already have downgraded a nominally completed flow that
reported an application-level error. That downgrade is
`buildSubagentFailureResultMeta` (`src/tools/delegation/subagentResults.ts:553`), called from
both delegation strategies (`nativeSubagentStrategy.ts`,
`inBandSubagentExecution.ts`) and pinned by `SubagentResultMeta.vitest.ts`. So
`result.outcome` carries a producer-side subagent-failure downgrade that
`meta.outcome` does not, and a naive drop would silently flip failed child runs
to `completed` at every read — the exact wrong-but-quiet class the repo treats
as a defect.

**What this forbids.** Do not re-propose dropping the field, and do not add a
second writer of `result.outcome` at read time. The projection stays one
function with one direction: `meta.outcome` narrows the envelope, never widens
it to `completed`.

**Home.** The disease this closes is D1 in
[`2026-06-10-lifecycle-status-ownership.md`](../../archived/architecture/2026-06-10-lifecycle-status-ownership.md).

---

## D7/T14 — no PersistedState one-instance-per-key registry

**Question.** Build a registry that guarantees one `PersistedState` instance per
storage key, so two instances (each with its own cached `state`) cannot
overwrite each other's writes?

**Ruling.** Close as superseded. **Do not build the registry.** It would add an
element without deleting a dual system: the construction sites are few, and each
production site that can be single-owner already documents itself as one — see
the in-file comment on `webviewStorage` in
`packages/extension/src/webview/frontend/persistence.ts` ("a second instance …
has no reason to exist").

**The narrower follow-up is blocked, and this is the record of why.** The
accepted residue was a ~40-line dev-mode duplicate-key assert in
`PersistedState`'s constructor. Re-verifying the sites at HEAD shows the
premise it rested on ("3 sites, each single-owner by construction") is stale.
There are **four** production sites, and the fourth is not single-owner:

| Site                                                                       | Key                                     | Single owner?                                     |
| -------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------- |
| `src/controllers/progressView/backend/ProgressViewState.ts`                | `WorkspaceStateKey.PROGRESS_VIEW_PREFS` | yes                                               |
| `packages/extension/src/webview/frontend/persistence.ts`                   | `'mainViewState'`                       | yes, documented in-file                           |
| `packages/extension/src/settingsView/frontend/components/history/state.ts` | `'historyView'`                         | yes                                               |
| `packages/extension/src/progressView/frontend/components/LogList.ts`       | `logListStateKey(streamId)`             | **no — one per stream, behind an evicting cache** |

`LogList.getOrCreateEntry` constructs a `PersistedState` per stream against a
module-level `webviewStorage`, and the entries live in an
`LRUCache({ max: MAX_CACHED_STREAMS })` that both evicts and `clear()`s. Revisit
a stream after its entry was evicted and the same `(storage, key)` pair is
legitimately constructed again. A constructor assert keyed on that pair would
therefore throw in dev/test (and warn in production) on ordinary navigation — a
false positive, which is its own defect, not a guard.

**What landing it would take**, if someone wants it later: a `dispose()` on
`PersistedState` that unregisters the key, the manager held on `LogList`'s
`CachedStream` rather than captured in a local closure, and the LRU's `dispose`
hook wired to release it. That is a change to the progressView webview render
path and needs to be scoped as such — it is not a drive-by on the shared state
helper.

**What this forbids.** Do not file the registry again. Do not land a
construction-time duplicate-key assert without the disposal path above; without
it the assert is knowingly wrong for `LogList`.

---

<a id="modelcell"></a>

## ModelCell — current ownership ruling supersedes only the retired prohibition

**Question.** Does the retired runtime gold-standard PRD's statement that
`ModelCell` “must not be implemented from this record” still prohibit the
`ModelCell` ownership primitive now present on `main`?

**Ruling.** No. The implementation merged in
[#9547](https://github.com/LionSR/TeXRA/pull/9547) is authoritative for the
narrow ownership and lifecycle guarantees below. It supersedes the retired
PRD's top-level [historical-status clause](../../rejected/architecture/2026-06-29-prd-runtime-gold-standard.md),
which says the listed designs “must not be implemented from this record,” and
its [§2 ModelCell text](../../rejected/architecture/2026-06-29-prd-runtime-gold-standard.md#2-modelcell-the-one-mutable-seam)
only where those passages deny that this primitive exists on `main`.

**Current guarantees.** The code, rather than the retired design, defines the
accepted shape:

- `AgentLaunchContext` constructs one `ModelCell` for the run from its launch
  handler and model id. Flow services and the tool-facing run context share that
  cell instead of copying a live handler/client pair.
- `ModelCell.swap` synchronously adopts the replacement handler and model id,
  clears the cached client, and disposes the distinct handler it retires. A
  lazily built client is reused until `rebind` or `swap`; build and rebind
  completion guards prevent a client produced for a retired handler from being
  published as current.
- A tool-use model switch persists `shared.modelId` and the run config before
  the live swap, then updates the launch-context mirrors through
  `onModelChanged`. Resume reconstructs the handler from that persisted model
  identity.
- The run lifecycle calls `ModelCell.dispose()` in its `finally` path. Thus the
  cell disposes handlers retired by successful swaps and the handler still live
  when the run ends. In the tool-use switch path, the runtime explicitly
  disposes a replacement candidate before ownership transfer only when the
  conversation-format check rejects it or either persistence write fails. This
  is not a blanket guarantee for exceptions from compatibility inspection,
  `setAgentCategory`, or `setLogger`. On success, `ModelCell.swap` adopts the
  replacement before disposing the distinct handler it retires.

**Scope of supersession.** This ruling does **not** revive the retired PRD as a
plan, make its unmerged `RunDescriptor` injection program authoritative, or
approve its `PendingRequests`, `RetryPolicy`, `RetryGate`, `HostUiBus`, stage
sequence, or concept-count claims. Those passages remain historical.

**Implementation evidence.** The accepted behavior is defined by
`src/agent/runtime/ModelCell.ts`,
`src/agent/runtime/AgentLaunchContext.ts`,
`src/agent/runtime/AgentRunLifecycle.ts`,
`src/agent/runtime/SessionResumeRetrieval.ts`,
`src/agent/runtime/executeAgent.ts`, and the model-switch path in
`src/agent/implementations/flows/tooluse/runToolUseFlow.ts`.

**Test evidence.** The focused coverage is in
`src/test-kernel/agent/runtime/ModelCell.vitest.ts`,
`src/test-kernel/agent/runtime/AgentRunLifecycle.vitest.ts`,
`src/test-kernel/agent/SessionResumeRetrieval.vitest.ts`,
`src/test-kernel/agent/runtime/ResumeToolUseCancellation.vitest.ts`, and
`src/test-kernel/agent/followUp/ModelSwitchState.vitest.ts`.

Future changes to model ownership must be justified against that current
implementation and test coverage, not by treating the retired gold-standard
program as normative.

## R-1 / Q1 — the filesystem: Effect's own `FileSystem`/`Path` (ruled 2026-09-13; supersedes the 2026-09-11 deferral)

**Question.** Replace `FileSystemProvider`/`nodeFilesystem` and the `BaseFS` static family
with Effect's own `FileSystem` + `Path` services (#12073 R-1 candidate B), or Effect-type
TeXRA's own rooted ports?

**Ruling.** Candidate B. On 2026-09-11 (#12247) the owner had declined the adoption "for
now" on the measured evidence (7.1–9.7× slower `readDirectory` walks because the service
returns names only, no `lstat`, `layerNoop` answering `exists` with `false`). On
2026-09-13 the owner ruled the other way — "adopt Effect's own file system as much as
possible" — and `Platform` is shrinking onto the Effect-native and TeXRA Context services:
#12364 (storage and toolAvailability ports retired), #12372 (globalState and secrets
ports retired), #12373 (the memfs fake deleted; the test harness runs the production
filesystem on a real temp root), #12374 (`FileSystem` and `Path` are `ProcessServices`
provided once by `installProcessRuntime`; `jsonStore` and the Lean adapter take them from
context). Slices 4b onward convert the filesystem consumers onto those services, with
the fs port last. AGENTS.md "Platform decoupling rules" item 4 records the direction.

**Forbids.** Adding fields to `Platform`; an "own port" Effect surface beside Effect's
`FileSystem` for the same operation; grafting an Effect surface onto the Promise `BaseFS`
while its callers stay Promise-shaped (the pass-through the 1.0 plan §5 bars). The
2026-09-11 evidence still binds the _mechanics_: consumers that need `lstat` type bits
(the `inspectRunStorageEntry` containment check, `XmlOutputManager`'s pre-write symlink
guard) and typed directory walks keep thin TeXRA helpers over the service rather than
losing the property. The `workspaceRoots` `AsyncLocalStorage` (injection carrier 5) and
the `inScope` re-entry on `AgentRun`/`ToolCall` retire as those slices land.

## No temporary adapters, and the `debtLanes` register is closed (ruled 2026-09-06; register deleted by #12277)

**Question.** May a subsystem convert to Effect behind a Promise-shaped adapter marked for
later removal, or take a `debtLanes` entry in the effect-migration ratchet so its new
`Effect.run*` site is admitted?

**Ruling.** No, on both. A converted callee's consumers convert upward to a real R1 boundary
kind in the same PR. `@adapter-until` markers fail ESLint (`no-warning-comments`). The
`debtLanes` register recorded debt that already existed when it was written and was never an
intake; #12277 deleted it. `scripts/check-effect-migration-ratchet.mjs --update` never adds
a file to a row.

**Evidence.** Five prior conversions each left a `tryPromise` wall or a Promise facade so
the file would compile mid-migration; the 2026-09-07 promise-boundary audit classified those
as the debt being retired, not progress. R1's three boundary kinds are the only places a run
is not debt: `packages/{extension,desktop,cli,agent}/src/**` and (until #12337 retired it)
the tool `execute()` contract.

**Forbids.** A bridging module that reads a global and exposes it as a `Layer`; a Promise
method whose body only runs an Effect; a "release-N" compatibility column; a feature flag
selecting two engines; dual writes.

## Webview runtime entries are an R1 boundary, admitted by name (ruled 2026-09-14)

**Question.** The `Effect.run*` ratchet row counted the progress webview's transport
(`packages/extension/src/progressView/frontend/sessionTransport.ts`, 4 sites) and the Lit
signal bridge (`src/shared/signals.ts`, 2 sites) as below-boundary debt. Are those runs
debt to convert, or the webview's own entry?

**Ruling.** Boundary. A webview owns its own `ManagedRuntime`: `sessionTransport.ts`
installs and disposes it, so it is that webview's composition root, and `toSignal` is the
one documented meeting point between Effect and the components, running on the runtime its
caller passes. Both files are admitted by name in `BOUNDARY_RUNTIME_ENTRIES` in
`scripts/check-effect-migration-ratchet.mjs`, each with its reason.

**Forbids.** Admitting a directory: every other file under the webview frontends stays
fenced, and the self-tests pin a sibling on each side (`ProgressApp.ts`,
`sessionFold.ts`) as below the boundary. Adding an entry is a ruling, not a refactor, and an
entry must hold its runtime as a local or take it as a parameter; a module that reaches the
process-global `effectRuntime()` does not qualify.

## `effect/unstable/*`: five families are admitted, each with a stated exit (ruled 2026-09-18)

**Question.** The Effect-4 PRD's non-goal 4 and §11 bar `effect/unstable/*`
"without a separate decision naming its replacement or exit plan". Five
families are in the tree. Which decision admitted them, and what is each
one's exit?

**Ruling.** All five are admitted. The 2026-09-13 filesystem ruling ("adopt
Effect's own file system as much as possible") settled the general question
the PRD reserved; what was missing is the per-family record the PRD asks for,
and it is this:

| Family                       | Used for                                                                     | Stabilization or exit                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect/unstable/http`       | `HttpClient` on the auth, model and telemetry paths (27 sites)               | Stays; follows the module when Effect promotes it. Exit is `ky`, which still serves 8 tool and remote-agent call sites and is not being deleted yet. |
| `effect/unstable/process`    | Type-only, the two Lean direct-server files                                  | Stays type-only until the process edges convert (#12078). Exit is `execa`, which every other spawn site already uses.                                |
| `effect/unstable/sql`        | `SqlClient` under `@effect/sql-sqlite-node`, the one session database        | Stays; the repo already depends on the same RC line. Exit is the official Node SQLite driver directly, which the client only wraps.                  |
| `effect/unstable/reactivity` | `Reactivity.layer` behind the database's invalidation signal (`Database.ts`) | Stays with `sql`; it is that client's own invalidation contract. Exit is an in-repo emitter over the committed-wake levels the layer already owns.   |
| `effect/unstable/encoding`   | `Sse.makeParser` for provider token streams (`packages/llm/src/turn.ts`)     | Stays; it replaced a hand-rolled SSE parser. Exit is restoring that parser, which is a single function over one `Stream`.                            |

**Evidence.** `rg "effect/unstable/"` returns exactly these five families and
no others. Every exit named above is a path the repository has already walked
or is still standing on, so none of them is speculative.

**Forbids.** A sixth family without its own row here. Adopting one of these
for a second purpose without checking that the exit still holds. Treating
"unstable" as a reason to keep a duplicate in-repo implementation warm beside
it; the exits above are what happens if a module is withdrawn, not a system
maintained in parallel.

## Per-session `LayerMap`, per-run `Layer.effect`: decision 8's "one provide at the process entry" is amended (ruled 2026-09-18)

**Question.** Decision 8 of the
[Effect-4 PRD §15](../../proposed/architecture/2026-08-26-effect-4-runtime-migration.md#15-open-decisions-for-ratification)
ratified Effect's best-practice guides, including "one `provide` at the
process entry". The landed runtime provides services at three lifetimes, not
one. Is that a deviation to repair?

**Ruling.** No. The guide's sentence is about there being one composition
root, not one `provide` call. The landed shape is correct and is the
amendment: the process entry provides the process services once; each session
is a `LayerMap` entry keyed by session, built on that one `ManagedRuntime`
(`sessionLayer.ts`, `webviewSessionLayer.ts`); each run takes its services
from a `Layer.effect` scoped to the run (`run/AgentRun.ts`, `ModelInvoker.ts`,
`SessionEvents.ts`, `FollowUps.ts`, `RunLedger.ts`). A session's services
release when its `LayerMap` entry does, and a run's when its scope closes.

**Evidence.** `LayerMap` is what makes "one session, one owner" hold without a
global session registry: the desktop opens several sessions in one process,
and a single process-wide `provide` would give them one set of stores. The
same argument at the run lifetime is R3 of the PRD ("layers follow actual
lifetimes"), and §8.1's carrier table already names three lifetimes, so
decision 8 and §8.1 were in tension and §8.1 wins.

**Forbids.** Flattening the session or run layers into the process layer to
satisfy a literal reading of decision 8. A fourth lifetime without a carrier
row in §8.1. Reintroducing a process-global lookup for anything a session or
run layer already provides.

## The four permanent `AbortController` residents (ruled 2026-09-18; named in the ratchet by [#12700](https://github.com/LionSR/TeXRA/pull/12700))

**Question.** The `new AbortController(` ratchet row is a shrink-only count.
It has four files left. Are they debt to convert to fiber interruption, or
the floor?

**Ruling.** The floor. The four files are the adapters that stay, and the
row's counts are their allowlist: a fifth file fails as new debt. The reasons
are recorded in `scripts/check-effect-migration-ratchet.mjs` beside the row
and are each a foreign API that takes a controller rather than offering
cancellation:

- `src/tools/claudeAgent.ts` — the Claude Agent SDK takes a controller, not a
  signal.
- `src/platform/defaults/lifecycleHost.ts` — the shutdown phase deadline,
  which fires after the runtime's own fibers are gone, so there is no fiber
  left to interrupt.
- `src/agent/runtime/childRunLoop.ts` — the one signal every child-run turn
  runs under, handed straight to `execa`'s `cancelSignal`, the Codex SDK and
  the Claude Agent SDK. The loop's stop must not interrupt its fiber: the
  turn's settlement, parent delivery and finalization all run after it.
- `packages/cli/src/chat/tui/commands/handlers/slashContext.ts` — the chat
  TUI's busy-form abort, the one bridge from that synchronous abort into
  `runPromise`'s `signal` option.

**Evidence.** The row is at 4 files / 4 sites and has been re-measured at that
floor. The survey's D25 lane had proposed converting `childRunLoop` to fiber
interruption and `slashContext` to `Effect.abortSignal`; the third bullet
above is why the first half of that is wrong, and the fourth is why the second
half is not an improvement.

**Forbids.** Adding a fifth `new AbortController()` anywhere in production.
Deleting the row (the allowlist is the ruling, and a zeroed row would stop
naming these four). Building a second internal cancellation tree beside the
fiber's, which is what converting these to signals-of-signals would produce.

## Runtime threading: each composition root holds its `ManagedRuntime` in a local (ruled 2026-09-18; answers [Effect-4 PRD §15](../../proposed/architecture/2026-08-26-effect-4-runtime-migration.md#15-open-decisions-for-ratification) decision 2)

**Question.** Decision 2 asked whether the host managed runtime belongs
directly in each composition root or behind one host-neutral
`ApplicationRuntime` adapter. Decision 9 narrowed it ("whatever hosts the
managed runtime, it is not an adapter layer") without answering it.

**Ruling.** Directly in each composition root, held in a local and threaded as
a parameter where a callee genuinely needs it. There is no `ApplicationRuntime`
type, no host-neutral runtime module, and no process-global accessor below the
entries: code below a composition root runs as an Effect program that is
already on the runtime rather than fetching one.

**Evidence.** The `effectRuntime()` ratchet row is 0 files / 0 sites in
production (retired by #12507); the export survives only for
`packages/cli/scripts/tui-harness.tsx`, which is a script outside the survey.
The webview runtime-entry ruling above already requires an admitted entry to
"hold its runtime as a local or take it as a parameter", and says a module
that reaches the process-global `effectRuntime()` does not qualify. This
ruling is that rule stated for every host, not only the webviews. It
supersedes the disposition recorded for injection carrier 11 in
[the injection note](../../proposed/architecture/2026-09-10-effect-native-injection-context-pipelines.md)
§5, which reads as a pending conversion; the conversion is done and the answer
is the shape above.

**Forbids.** An `ApplicationRuntime` adapter layer, a host-neutral runtime
facade, and any new reader of the `effectRuntime` export. Reintroducing a
module-global runtime slot to avoid threading a parameter.

## Eight rulings from the 2026-09-17 round-trip and dual-system survey (recorded 2026-09-18)

**Question.** The
round-trip and dual-system survey (`.agents/docs/proposed/simplification/2026-09-17-effect-round-trips-and-dual-systems.md`,
[#12681](https://github.com/LionSR/TeXRA/pull/12681))
raised eight open questions across its lanes. Under the standing owner
instruction the recommended option is taken; this is the record so the lanes
do not re-open them.

**Ruling**, one line each:

1. **The desktop preview host's Promise face is an adapter, not a permanent
   boundary.** `src/hosts/uiHosts.ts` and
   `packages/desktop/src/main/desktopPreviewHost.ts` record an earlier ruling
   that the `openExternal` / `openPath` / `openBuildDisplay` fan-out stays
   Promise-shaped; under the 1.0 clean rule it is an R1 adapter and converts
   after the host-request lanes, which is also what `ExternalOpener` already
   did.
2. **A layer may capture its own runtime for an outbound foreign Promise
   contract.** `SupabaseAuth.onFlowState` owes `@supabase/auth-js` a Promise
   storage callback; `Effect.runtime()` inside the layer is the standard
   bridge, and the auth program edge that existed to avoid it can be deleted.
3. **The auth probes need no workspace-roots frame.** `getCodexStatus` and
   `getXaiStatus` read no ambient roots, so the `inScope` wrap around them in
   `computeModelOptions.ts` is defensive; an Effect probe closed over the
   secret store needs no frame.
4. **A host's webview inbound handler registry is an R1(a) terminal.** So
   `SettingsAgentActionsOptions.run` can be deleted and failure reporting
   moves to each host's registry; `FAILURE_MESSAGES` stays exported from the
   shared module.
5. **`stream_id` stays frozen** in the `log-usage` edge function as the one
   permanently frozen external spelling of the run id, on the same
   minimum-supported-client basis already ruled for the usage-route tolerance.
   The rename proposed by the one-run-model note is struck.
6. **`texra tools list --json` and `texra skills list --json` change shape**
   when the CLI renders the shared projections. The change is user-facing and
   goes in the changelog, because `texra-action` consumes CLI result JSON.
7. **The CLI keeps its cheap built-in default model.** The constant is renamed
   to say it is a deliberate cheap-start choice derived from the shared table,
   rather than deleted in favour of the shared default.
8. **`AgentPlatform` re-declares `agentResume` and `languageModel`** so the
   embedder contract is unchanged while `Platform` loses both fields (#12697).

**Evidence.** Each was verified against `main` by the survey's two
independent refuters before being recorded. Ruling 8 is visible in the tree:
`src/platform/platform.ts` declares only `fs`, `lifecycle`,
`agentDirectories` and `toolMissingHandler`, while
`packages/agent/src/effect/runtime.ts` declares both fields on
`AgentPlatform`.

**Forbids.** Re-opening any of the eight inside a lane. In particular: do not
propose renaming the edge function's `stream_id` column, and do not delete
`AgentPlatform`'s two fields on the grounds that `Platform` no longer has
them.

## The process-roots holder is the one named ambient singleton, and it retires with `SessionHandleInit.roots` (ruled 2026-09-19)

**Question.** [#12774](https://github.com/LionSR/TeXRA/pull/12774) deleted the
workspace-roots `AsyncLocalStorage` carrier, `runInSession`, `RunContext.ts`
and the `inScope` re-entry on `AgentRun`/`ToolCall`, so production holds no
`new AsyncLocalStorage`. Four reads of a process-wide roots holder survived.
Are they debt to be cleared by the next lane, or a named exception?

**Ruling.** A named exception, with one exit. `initProcessWorkspaceRoots` /
`processWorkspaceRoots` / `tryProcessWorkspaceRoots`
(`src/platform/workspaceRoots.ts`) stay as the campaign's one ambient
singleton, tracked by the `ambient:asyncLocalStorage` row of
`config/ratchets/effect-migration-baseline.json` at its floor of three files
and four sites. It retires when `SessionHandleInit.roots` becomes required,
which removes the last fallback read; the row is then deleted rather than
zeroed.

**Evidence.** The four sites each precede any caller that could hold roots.
`createSessionHandle` reads `init.roots ?? processWorkspaceRoots()`
(`src/agent/runtime/sessionGraph.ts`), so the fallback exists only for the
roots the four composition roots and about ten kernel support files do not yet
pass; `sessionGraph.ts` also reads `tryProcessWorkspaceRoots()` for the
graph-level lookup. `getConfigBeforePlatformInit`
(`src/utils/config/configUtils.ts`) serves a logger write that can precede any
session, and its own doc comment records that there is no caller to take a
configuration from. `processSettingsStores`
(`src/utils/config/platformSettings.ts`) has the two callers AGENTS.md already
documents as the standing exception: the CLI composition root
(`packages/cli/src/runtime/initPlatform.ts`) and the delegation tools'
`working_directory` Zod transform (`src/tools/delegation/inputFields.ts`),
which the tool facade parses before any per-call value exists.

**Forbids.** A new reader of the holder, in production or in a host; a second
ambient carrier reintroduced to avoid threading a parameter; widening the
ratchet row. Making `SessionHandleInit.roots` optional again after it is
required. Moving the `working_directory` gate into `execute` as a way to drop
the read: that turns a schema rejection into a tool error and is a behavior
decision of its own, not a threading change.
