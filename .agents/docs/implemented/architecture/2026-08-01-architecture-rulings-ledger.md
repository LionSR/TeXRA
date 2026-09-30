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

## ModelCell — the run's binding and its lifetime

**Question.** Who owns a run's model binding, and when is a replaced binding
released? (Rewritten 2026-09-27 for move 8 of the session-core plan: the
`ModelCell` class and the files the earlier ruling cited, merged in
[#9547](https://github.com/LionSR/TeXRA/pull/9547), are deleted.)

**Ruling.** The run's `AgentRun` service owns the binding, in `run.model`,
and `run.swapModel` is its one writer:

- Each binding is bound into its own scope, forked from the run's scope.
  A swap binds the replacement into a fresh fork and closes the retired
  binding's scope at once, which releases its WebSocket and ping fiber, an
  editor model, and its uploaded files. A failed or interrupted bind closes
  its fork and leaves the binding in force. Nothing retired waits for the
  run to end.
- A host-admitted model switch commits its rows (the `model-switch`
  compaction and the snapshot naming the new model) inside the swap, so the
  new binding is in force only once its rows are. A manual retry's rebind
  and the reacquisition of a failed WebSocket binding go through the same
  swap.
- The run's model is its latest snapshot's `modelId`. The switch does not
  restate it in `run.config`, which keeps the launch model; display reads
  project the change as `run.model` rows (`MODEL_ROWS`).

**Scope of supersession.** This ruling does **not** revive the retired
runtime gold-standard PRD as a plan; its other passages remain historical.

**Implementation evidence.** `src/agent/runtime/run/AgentRun.ts`
(`swapModel`), `src/agent/runtime/loop/modelSwitch.ts`,
`src/agent/runtime/ModelInvoker.ts` (`rebind`) and
`src/controllers/session/displayProjection.ts` (`MODEL_ROWS`).

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

| Family                       | Used for                                                                      | Stabilization or exit                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect/unstable/http`       | `HttpClient` on the auth, model and telemetry paths (27 sites)                | Stays; follows the module when Effect promotes it. Exit is `ky`, which still serves 8 tool and remote-agent call sites and is not being deleted yet. |
| `effect/unstable/process`    | Type-only, the two Lean direct-server files                                   | Stays type-only until the process edges convert (#12078). Exit is `execa`, which every other spawn site already uses.                                |
| `effect/unstable/sql`        | `SqlClient` under `@effect/sql-sqlite-node`, the one session database         | Stays; the repo already depends on the same RC line. Exit is the official Node SQLite driver directly, which the client only wraps.                  |
| `effect/unstable/reactivity` | `Reactivity.layer` behind the database's invalidation signal (`Database.ts`)  | Stays with `sql`; it is that client's own invalidation contract. Exit is an in-repo emitter over the committed-wake levels the layer already owns.   |
| `effect/unstable/encoding`   | `Sse.makeParser` for provider token streams (`packages/llm/src/transport.ts`) | Stays; it replaced a hand-rolled SSE parser. Exit is restoring that parser, which is a single function over one `Stream`.                            |

**Evidence.** `rg "effect/unstable/"` returns exactly these five families and
no others. Every exit named above is a path the repository has already walked
or is still standing on, so none of them is speculative.

**Forbids.** A sixth family without its own row here. Adopting one of these
for a second purpose without checking that the exit still holds. Treating
"unstable" as a reason to keep a duplicate in-repo implementation warm beside
it; the exits above are what happens if a module is withdrawn, not a system
maintained in parallel.

**Amendment (owner decision, 2026-09-24; plugin architecture).** Effect
unstable modules are allowed for the plugin work. `effect/unstable/process` is
no longer type-only: the MCP plugin (#13092) spawns its stdio servers through
it at runtime (`src/tools/mcp/mcpServer.ts`). The exit named in the table is
unchanged. See the [plugin architecture note](./2026-09-24-plugin-architecture.md).

## Per-session `LayerMap`, per-run `Layer.effect`: decision 8's "one provide at the process entry" is amended (ruled 2026-09-18)

**Question.** Decision 8 of the
[Effect-4 PRD §15](../../archived/architecture/2026-08-26-effect-4-runtime-migration.md#15-open-decisions-for-ratification)
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

**Amendment (2026-09-23).** A fourth lifetime, the composition, now has its
carrier row in §8.1: a `Compositions` `LayerMap` entry keyed by composition
hash, held by the runs that pinned it (see the composition ruling below).

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
- ~~`src/platform/defaults/lifecycleHost.ts` — the shutdown phase deadline,
  which fires after the runtime's own fibers are gone, so there is no fiber
  left to interrupt.~~ Retired 2026-09-26: shutdown became a scope's close
  (`closeAllSessions` as its first finalizer, bounded by
  `SESSION_CLOSE_DEADLINE_MS` through `Effect.timeoutOption`), the lifecycle
  host was deleted with it, and the row fell to three files. The ruling
  stands for the three.
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

## Runtime threading: each composition root holds its `ManagedRuntime` in a local (ruled 2026-09-18; answers [Effect-4 PRD §15](../../archived/architecture/2026-08-26-effect-4-runtime-migration.md#15-open-decisions-for-ratification) decision 2)

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

## Settings dispatch has one native execution boundary (revised 2026-09-22)

**Question.** The 2026-09-19 ruling retained Promise-shaped registry arms
because each was already a host boundary. Does that forbid replacing the whole
backend dispatcher with programs executed once at the incoming host message?

**Ruling.** No. The owner's
[explicit revision in #13009](https://github.com/LionSR/TeXRA/pull/13009#issuecomment-5779248081)
preserves one execution boundary and rejects duplicate dispatch machinery;
it does not require a boundary in every registry arm. This supersedes the
Promise-shape requirement above and the instructions in #12880/#12884 to remove
the settings-dispatch slice. The ruling is a design decision, not a claim that
#13009 has merged or completed validation.

**Evidence.** `src/controllers/settingsView/settingsViewDispatch.ts` owns the
one backend selector, `settingsViewProgram`, over the already-validated
inbound union. Its two consumers are the extension's
`SettingsViewMessageHandler.handleMessage` and desktop's
`createDesktopSettingsIpc`; each supplies Effect-valued handlers and executes
once at its native message entry. The old inbound Promise dispatcher,
per-handler runners and runner ports are removed together. Exhaustive
`HandlerRegistry` typing and its `unsupported(reason)` markers remain shared;
the same markers derive frontend capabilities.

The remaining `createDispatcher` instantiation is
`dispatchSettingsViewOutbound` in
`src/shared/settingsView/settingsViewMessages.ts`. Its sole production caller
is `SettingsApp.messageListener`, shared by the VS Code webview and Electron
renderer. Every arm in frontend `messageDispatcher.ts` updates browser state
synchronously; none returns a Promise or starts an Effect. The shared generic
handler type supports these values without importing the backend runtime into
the browser graph. Parse, missing-handler and unsupported-command failures
reach the frontend error callback; a synchronous handler defect propagates
to the browser event boundary. There is no asynchronous renderer rejection
left for a generic Promise dispatcher to observe.

**Failure ownership.** Both native host entries observe complete Effect causes,
including defects; interruption-only causes stay silent. Unsupported commands
show their reason. The extension logs failures of error presentation or the
subsequent refresh. Desktop routes both action and presentation failures to
its final `onError` sink, unwrapping `NotificationFailed.cause` there. Provider
key failures retain their write-versus-refresh distinction until host
presentation. Scoped cleanup remains part of the program's exit.

**Forbids.** Retaining the old backend dispatcher beside this selector;
per-host copies of the selector; Effect-to-Promise adapters around individual
arms; executing backend programs below the native entry. Asynchronous browser
work must observe its failure at its own entry rather than being silently
returned from a synchronous state handler. No compatibility dispatcher or
second schema is required by the old ruling.

## A cancelled CLI loopback sign-in reports as interruption (ruled 2026-09-19; landed in [#12821](https://github.com/LionSR/TeXRA/pull/12821))

**Question.** Before #12821 the loopback sign-in's Promise face re-awaited the
callback server on a fresh fiber when a storage commit had already begun, and
returned the session despite the cancellation. #12821 made cancellation plain
fiber interruption. Should the old recover-the-session semantics be restored?

**Ruling.** No. Declined; interruption is the reported outcome. The lane that
asked stands as landed.

**Evidence.** Effect 4 rc.115 gives a fiber no way to observe its own external
interruption as a value: `Effect.exit`, `Effect.result` and
`Effect.uninterruptibleMask` all propagate it, each probed in the lane. So the
old recovery is expressible only behind a Promise face, that is, a restored run
edge, which is what this campaign deletes. No production caller ever read the
recovered session: the one caller that passes a cancellation signal wrapped the
call in `Effect.tryPromise`, which abandons a late resolution on interrupt.
What the recovery actually bought now lives in the release half of the
`Effect.acquireRelease` around the loopback server in
`packages/cli/src/runtime/supabaseAuth.ts`, which waits out
`server.commitStarted`'s in-flight `waitForSession` before closing the server;
a release runs uninterruptibly, which is the property the old edge borrowed.

**Forbids.** Restoring a Promise face on the loopback sign-in path, and
re-proposing the recovered-session semantics as something a fiber can observe
in-fiber. A cancelled sign-in that must still be honoured is a change to the
release half of that scope or nothing.

---

## The process-roots holder is retired, and the `working_directory` gate moved with it (ruled 2026-09-19)

**Question.** "The process-roots holder is the one named ambient singleton"
above named the exit — `SessionHandleInit.roots` becomes required — but left
two of the four reads without a threading answer:
the pre-initialization logger read, and the delegation tools' static
`working_directory` Zod transform, whose move into `execute` that entry
forbade as a threading change. Does the holder survive them?

**Ruling.** No: the holder is deleted, and both reads got an owner rather than
a fallback.

- `SessionHandleInit.roots` is required. `openSessionEffect` snapshots the
  record structurally and the owner keys the session by it, as before; there is
  no `?? processWorkspaceRoots()`.
- `initializeDefaultSession` / `teardownDefaultSession` move beside the session
  owner in `sessionGraph.ts` and record the storage root the default session
  was opened over, so `tryDefaultSession` names it without a process-wide
  roots record.
- `getConfigBeforePlatformInit` is deleted. `@logger/logUtils` still owns the
  `texra.logger.debugMode` key and default, now over a `ConfigProvider` the
  composition root installs (`setDebugModeConfig`), read per entry as before;
  a process whose root has not installed one logs as if debug mode were off,
  which is exactly what the absent-roots branch did. **(Superseded
  2026-09-21 by the synchronous-facades design: the producer-side gate that
  read the setting is deleted, so `setDebugModeConfig` and the module slot
  went with it and no ambient carrier was substituted — the setting is read
  at transcript-fold time from the roots the view's owner already holds, and
  each host's log surface owns its own level. This satisfies the entry's
  Forbids clause by leaving nothing to carry.)**
- `processSettingsStores` is deleted. The CLI answers catalog rows from the
  roots its own init built, and a process whose platform another root
  installed without publishing roots is a composition defect that fails loudly
  instead of reading a process-wide record.
- The `working_directory` worktree gate moves into `DelegateAgentTool.execute`.
  This reverses the "wants its own change" clause above **deliberately**, as
  the price of the holder's last reader: a disabled-worktree
  `working_directory` is now a tool error rather than a schema rejection, and
  the gate answers for the project the call is on (`call.roots`) rather than
  for whichever workspace the process came up in. The refusal text is
  unchanged.
- The `ambient:asyncLocalStorage` row is deleted from
  `config/ratchets/effect-migration-baseline.json` and its id added to
  `RETIRED_ROW_IDS`; the survey and its reader lists stay, so a reintroduced
  carrier fails as a new file.

The test harness keeps an installed-roots accessor of its own
(`@test/support/testWorkspaceRoots`, installed by `installFakeHost`): a suite
is its own composition root, and its assertions and seeding happen outside any
session. That is test scaffolding, not a production carrier, and the ratchet's
scope excludes `src/test-kernel/`.

**Forbids.** Reintroducing a process-wide roots record, in production or in a
host, including as a field on `Platform`. Making `SessionHandleInit.roots`
optional again. Moving the `working_directory` gate back into the schema.

---

## A `SESSION_EVENT_FORMAT` bump is taken only when a real change forces one, and a forced bump carries the queued dead arms (ruled 2026-09-19; deferred in [#12858](https://github.com/LionSR/TeXRA/pull/12858), taken in [#12866](https://github.com/LionSR/TeXRA/pull/12866))

**Question.** `src/test-kernel/schemas/sessionEventFormat.vitest.ts`
fingerprints the JSON-schema shape of `SessionEventSchema`, and `Database`
clears every store stamped with another version at open. So any deletion inside
that schema costs every user their session history. May a deletion that buys no
behavior buy its own bump?

**Ruling.** No. A format bump is taken only when a change users actually get
forces one. A deletion that cannot pay for a bump of its own is recorded with
its evidence and rides the next forced bump, and the forced bump then takes
every queued cut in a single move of the constant.

**Evidence.** #12858 built the deletion of the two `StateOperation` arms
(`delete` and `append`, never produced: `rg "op: '(delete|append)'"` over the
tree and `rg '"op"\s*:\s*"(delete|append)"'` over every `.json`, `.jsonl` and
`.ndjson` outside `node_modules` both return zero, so no stored row can carry
either) and **dropped the commit**, recording the evidence under its `Left out`
section. #12866 retired four never-read `UserVars` template names, which moves
the same fingerprint through `StateSlicesSchema.userChannels`, and took both
cuts on the single move from 5 to 6. The gate is mechanical: shape moved,
version moves; what it cannot judge is whether the shape had to move at all.

**Forbids.** Bumping `SESSION_EVENT_FORMAT` for a behavior-neutral deletion on
its own. Taking a forced bump without folding in the cuts already queued
against it. Working around the fingerprint suite instead of bumping when a real
change does move the shape.

---

## `defineTool`'s default `R` is frozen SDK surface, not a simplification target (ruled 2026-09-19; [#12862](https://github.com/LionSR/TeXRA/pull/12862))

**Question.** A wave-8 lane proposed folding `definition.ts` into `define.ts`
and changing `defineTool`'s default `R` while unifying the tool run guards. May
a simplification lane change it?

**Ruling.** No. `packages/agent` is the frozen SDK surface and `defineTool`'s
default `R` is an owner decision left open, so `definition.ts`, `define.ts` and
`packages/agent/src/index.ts` stay untouched by simplification work. The lane
landed its run-guard unification without opening them.

**Evidence.** The SDK surface is built and fenced, not published: ESLint
forbids production `src/**` and `packages/agent/src/**` from importing host
layers, and `config/ratchets/host-agent-import-baseline` freezes the remaining
edges. Publication is held until a named external consumer exists, which is
exactly the point at which the default `R` stops being a free choice. Changing
it before then would be a contract move made by a lane that had no stake in the
contract.

**Forbids.** Retyping `defineTool`'s default `R`, or merging its declaration
and implementation modules, as part of a simplification, refactor or
consolidation lane. That change needs its own owner decision and its own PR.

**Amendment (owner decision, 2026-09-23; "tools as data" PR).** The owner
lifted this freeze for the plugin architecture: the SDK tool contract may
change, and `definition.ts`, `define.ts` and `packages/agent/src/index.ts` are
open to that work. Net-negative LOC is not the gate for this line of work. The
first change under the amendment makes `defineTool` return a plain tool object
carrying `execute` instead of a class to subclass: `BaseTool`
(`src/tools/core/base.ts`) is deleted, every class-based tool and the
structured-output terminal tool are tool objects, the registry lists them by
value, and the SDK exports `DefinedTool` in place of `DefinedToolClass`. The
freeze's premise still holds for unrelated lanes: a simplification lane does
not retype the tool contract on its own initiative.

---

## The pandoc scratchpad conversion tier is retired; there is one conversion path (ruled 2026-09-19; [#12863](https://github.com/LionSR/TeXRA/pull/12863))

**Question.** `src/utils/text/xmlConversion.ts` carried two converters for one
string: a first tier that probed for a `pandoc` binary, spawned it, and rewrote
pandoc's three reference shapes back to `\ref{}` / `\eqref{}` / `\cref{}`, and
a second tier of Turndown plus a replacement table that ran when pandoc was
absent. Keep the optional tier?

**Ruling.** No. The pandoc tier is retired. `formatContent` is an ordinary
synchronous function over Turndown and the LaTeX replacement table.
`OutputFormat`, `detectInputFormat`, `isPandocAvailable`, `convertWithPandoc`,
`PANDOC_REFERENCE_REWRITES`, `normalizePandocReferences`, the `pandoc`
`TOOL_CONFIGS` entry and `PANDOC_INSTALL_GUIDE` are deleted.

**Evidence.** The tier made the product's output depend on what was installed
on the machine: a developer with pandoc rendered differently from CI, which
only ever pinned the fallback, so the fallback is the behavior the project
actually tests and ships. Markdown scratchpads, the overwhelming majority,
short-circuited past both tiers already. A machine without pandoc re-spawned
`pandoc --version` once per reflection round, because the cached negative from
[#12805](https://github.com/LionSR/TeXRA/pull/12805) had a zero TTL. Pandoc
appears nowhere in `docs/` or `packages/extension/resources/`; its only
user-facing mention was a 0.x changelog bug-fix line. The full record is
[`2026-09-19-retire-pandoc-scratchpad-tier.md`](../simplification/2026-09-19-retire-pandoc-scratchpad-tier.md).

**Forbids.** Reintroducing an external-binary conversion tier for the model
scratchpad, or any second converter selected by what the host machine happens
to have installed. A conversion improvement is a change to the one path.

---

## The session close chain takes no `AbortSignal` (ruled 2026-09-19; [#12855](https://github.com/LionSR/TeXRA/pull/12855))

**Question.** `SessionOwner.close`, `sessionGraph.closeSession`,
`sessionLayer.closeSession`, `Sessions.close` and the `packages/agent`
`closeSession` each took an optional `signal?: AbortSignal`, adapted into the
drain by `aborted(signal)`. Keep the parameter on the SDK surface for an
embedder who might want it?

**Ruling.** No. `signal` is dropped from the whole close chain,
`packages/agent` included, and `aborted(signal)` is deleted with it. A caller
who needs to give up on a drain interrupts the fiber.

**Evidence.** No external consumer exists: the package is built and fenced but
deliberately unpublished until a named external consumer appears, so the
parameter was speculative generality on a surface with no second party. No
in-tree caller passed a signal. The drain itself is an Effect program, so fiber
interruption is the cancellation mechanism the rest of the runtime already
uses, and keeping a parallel `AbortSignal` channel would be a second
cancellation vocabulary on the one path that most needs a single owner. The
four permanent `AbortController` residents named in the ratchet are foreign
contracts (execa, the Codex SDK, the Claude Agent SDK); a session close is not
one of them.

**Forbids.** Re-adding an `AbortSignal` parameter anywhere on the session close
chain, on any host or on the SDK surface. Cancelling a drain by any mechanism
other than interrupting the fiber that awaits it.

---

## The agent SDK's public surface is Effect; R1 boundary kind (c) is retired (ruled 2026-09-21)

**Question.** Rule R1 of the Effect migration
(`.agents/docs/archived/architecture/2026-08-26-effect-4-runtime-migration.md`
§7) admitted three boundary kinds; kind (c) was "the SDK's public Promise API
in `packages/agent/src`": the root entry `packages/agent/src/index.ts`
rendered the package's Effect services as `runAgent` / `closeSession` /
`AgentRun` Promises and AsyncIterables, and `/effect` carried the services.
With kind (b) already retired (#12337), does kind (c) still stand?

**Ruling.** No. The root entry **is** the Effect surface: `Sessions`,
`Session`, `Run`, the tagged errors and the tool-definition helpers, with the
`/effect` subpath deleted. The Promise rendering — `runAgent`,
`closeSession`, `AgentRun`, `RunAgentInput`, the module-level composition
cache and the shutdown-hook wiring — is deleted, not relocated. Nothing in
the package calls `Effect.runPromise` / `runSync` / `runFork`; a Promise-land
embedder runs `Effect.runPromise(program)` at its own entry point.

**Evidence.** (1) `effect` was already a mandatory exact-pin peer dependency
of the **whole** package — the root bundle imported `effect` at runtime — so
the Promise entry spared no consumer the Effect install it existed to hide.
(2) The package is unpublished and the Promise entry had zero consumers: only
the README and an archived doc imported `runAgent` from `@texra-ai/agent`,
and the one consumer-shaped artifact (`packages/agent/example/`) already used
`/effect`. (3) TeXRA 1.0 keeps no parallel or compatibility surfaces, and a
Promise rendering beside the Effect surface is exactly one. `Sessions.layer`

- `Effect.scoped` already implement everything the composition cache did
  (per-scope hold, `PlatformConflict`, finalizer release), so the change is
  deletion plus repointing, with the `AgentPackage.vitest.ts` Promise-surface
  cases retired with the implementation.

**Forbids.** Reintroducing a Promise-shaped entry, a dual root/`/effect`
split, or a `runAgent`-style wrapper whose body only runs the Effect
services. The SDK is no longer an R1 boundary: `packages/agent/src/**` runs
no `Effect.run*` at all.

---

## Provider-hosted web tools are ruled out of 1.0; the local web tools are the one system (ruled 2026-09-22)

**Question.** The llm hardening note's second change
(`.agents/docs/proposed/architecture/2026-09-20-llm-package-hardening.md` §3):
OpenAI `web_search` and Anthropic search and fetch worked on the deleted
model handlers, but the codecs never grew them — the Anthropic codec answered
a hosted-tool receipt with an explicit "hosted-tool accounting is not
supported" failure, and a Responses `web_search_call` output item has no arm
and fails the output-item schema as a parse error. Implement the hosted tools
inside the codecs with their usage accounting, or rule them out of 1.0 and
delete the dead arms?

**Ruling.** Ruled out. 1.0 ships without provider-hosted tools: the run's
local `web_search` (`src/tools/web/WebSearchTool.ts`) and `web_fetch`
(`src/tools/web/WebFetchTool.ts`, both registered in
`src/tools/registry.ts`) are the one system for web search and fetch, and a
provider-hosted execution of the same capability would be a second system for
it. The two dead accounting arms in the Anthropic codec are deleted, so the
codecs stop advertising a capability they refuse; nothing else changes,
because the codecs never requested a hosted tool in the first place. A stream
that carries hosted execution still fails loudly — the hosted blocks fail the
event schema as malformed output — and the standing boundary keeps its name:
a paused hosted turn fails as unsupported through the existing `pause_turn`
arm. Hosted tools may return later, but only as a properly scoped lane whose
spec is both halves together: usage accounting folded through `providerUsage`
like every other provider-side receipt, AND the `pause_turn` continuation
protocol.

**Evidence.** The hardening note's own recommendation on file was exactly
this ruling (§5, option 2: deletion-shaped, removes an explicit failure path
from the codecs' resting state, and the capability can return with the
accounting it needs). The capability already ships locally, so a codec
restore would duplicate it — the no-dual-systems mandate. And a bare codec
restore would not just be redundant but incomplete: Anthropic pauses hosted
execution (`stop_reason: pause_turn`) when a server tool's result set grows
large, and continuing a paused turn needs a continuation protocol that
resumes the partial turn — a runtime-loop seam, not a codec patch. Hosted
`web_search` without that continuation breaks in practice on exactly the
result sets it exists for, which is why the `pause_turn` arm stays in the
codec as the named seam a future hosted-tools lane must implement, alongside
the `providerUsage` accounting, before either ships.

**Forbids.** Requesting a provider-hosted web tool from any codec in 1.0 (an
Anthropic `web_search`/`web_fetch` tool entry, a Responses `web_search`
tool), and re-adding a hosted-tool accounting arm for one. Reintroducing
hosted web tools without BOTH the usage accounting folded through
`providerUsage` and the `pause_turn` continuation protocol. Shipping a second
web-search or web-fetch system beside the local `web_search` and `web_fetch`
tools.

## Post-auth cache invalidation is a permanent host boundary; only the sign-out catalog refresh is shared (recorded 2026-09-23; moved here from the deleted `src/auth/authFlowEffects.ts` by [#13054](https://github.com/LionSR/TeXRA/issues/13054))

**Superseded 2026-09-30 by D1** (below, "1.0 identity, account and
telemetry"): TeXRA sign-in leaves all three hosts, so the TeXRA-account
transitions this entry rules on go with it, and its one shared step,
`invalidateRemoteAgentsAfterSignOut`, was already deleted with the remote
agent catalog (#13442). Provider OAuth (ChatGPT/Codex, Grok/xAI) stays, but
the code runs no post-sign-in invalidation sequence for it: each host's
sign-in writes the subscription preference through
`src/controllers/modelAccess/subscriptionProviders.ts`
(`setPreferSubscription`) and model options are recomputed from the stores
on read. Nothing of this boundary survives for provider OAuth. The text
below is the record.

**Question.** Should the post-sign-in and post-sign-out cache-invalidation
sequence that each host runs be collapsed into one shared coordinator?

**Ruling.** No. The one shared step is the best-effort remote-agent-catalog
refresh after sign-out, owned by `invalidateRemoteAgentsAfterSignOut`
(`src/agent/index/agentRegistry.ts`), which absorbs every failure, defects
included, so a stale local catalog never blocks sign-out. Everything around it
stays per host.

**Evidence.** The extension invalidates its long-lived model cache before
publishing a session event. Desktop routes the same transition through its
settings-IPC refresh chain because that chain also republishes model and
profile state; agent-catalog publication normally follows there, except that
team sign-in defers it to the team resolver, and the desktop session-change
handler refreshes onboarding separately. Ordinary CLI login and logout
commands exit without consuming model options; persistent CLI callers own
their transition before reading credential-dependent state (onboarding
invalidates its model-options cache, the orchestration launcher its model
list, the chat TUI its subscription-preference views), and setup-agent team
sign-in refreshes and rereads the remote catalog before applying the team.
Collapsing these effects would either omit host refresh work or repeat it.

**Forbids.** A shared post-auth invalidation coordinator across hosts, and a
second guard around `invalidateRemoteAgentsAfterSignOut` at a call site.

---

## A run pins one composition from a process `Compositions` `LayerMap`; plugins may own layers (ruled 2026-09-23)

**Superseded 2026-09-27 by #13364.** `Compositions`, the `Composition` value and
the run-lifetime pin are deleted: a step pins a generation of the live
catalog, and a plugin's layer is one refcounted `RcMap` entry shared by the
generations that hold it. "Plugins may own layers" stands, and the entry
below it ("Plugins own typed tables at their seams") records where they live.
Its Forbids clause "a child re-resolving its parent's plugin set" also stands.

**Question.** The plugin architecture (the owner decision of 2026-09-23 in the
`defineTool` amendment above) makes a run's toolset a composition value
(`src/tools/composition.ts`). How long does a composition live, who holds
it, and where may a plugin's resources live?

**Ruling.** A composition is a fourth lifetime, carried by one process
service: `Compositions` (`src/tools/compositions.ts`), a `LayerMap` keyed by
composition hash and provided with the `ToolRegistry` by
`installProcessRuntime`. A run pins its composition in its own layer scope
(`resolveAgentTools`, from `AgentRun`) and holds it for its lifetime; a
delegated child (LLM delegation, workflow-script `agent()`, the native
subagent strategy) joins the key its parent pinned, passed through the
child's launch options beside the approval gate, instead of resolving the
switches again. A resumed run resolves its own under the recorded-toolset
rule. A composition whose switches differ builds beside the one in use; an
entry closes when the last run holding it ends (reference counting, no idle
retention); a failed build caches nothing. An entry holds the plugin table
restricted to the composition's plugins and the services of those plugins'
layers, which reach the run's tool calls. A plugin that owns resources
declares `layer` in the manifest and its layer is one object in the
`@tools/registry` table, so every entry builds through the map's one
`MemoMap` and compositions that share a plugin share one build of its layer.

**Evidence.** The prototype check built one plugin layer once across two
compositions, rebuilt only the changed plugin on a new key, and closed each
plugin layer with the last composition holding it. The toolsets offered by
every shipped tool-use agent across hosts, switches, the approval gate and
both families were unchanged by the move (the behavior dump in the PR that
landed it). The Lean
server pool stays a process service: its port differs by host (the VS Code
bridge against the direct pool), the Tools dashboard and the lean4 probe read
it outside any run, and the probe decides whether lean4 is in a composition
at all, so the pool cannot live inside the entries it gates.

**Forbids.** A second composition cache, an idle-time-to-live on the map
standing in for the holders' count, `Layer.fresh` on a plugin layer, a
plugin layer constructed per composition (its identity is what makes it
shared), and a child re-resolving its parent's plugin set.

---

## Plugins own typed tables at their seams; the SDK's setup platform is core's empty one (ruled 2026-09-28)

**Question.** The plugin note (`2026-09-24-plugin-architecture.md`) ruled
that "plugins own no durable state and no event channel" and that "prompt
sections are core", and `2026-09-24-one-run-program.md` kept the continuation
seam agent-runtime code. The tree no longer matches either. Which stands, and
what does the embedding package owe a plugin it does not compose?

**Ruling.** Amend all three, and keep everything else in those notes.

- **Static in-tree plugins own typed contributions, one fixed table per
  seam, keyed by plugin id and checked with `satisfies` against the manifest
  flag that declares it.** The tables are `PLUGIN_TOOLS`,
  `PLUGIN_CONTINUATIONS`, `PLUGIN_PROMPT_SECTIONS`, `PLUGIN_PROCESS_LAYERS`
  and `PLUGIN_SESSION_LAYERS` in `src/tools/registry.ts`, and
  `PLUGIN_EVENT_ARMS` in `src/tools/pluginArms.ts`. The manifest imports no
  tool implementation, and there is no plugin object.
- **Plugin state is a typed arm of the one closed event schema**, written as
  a `plugin.fact` through the one publisher (`SessionEvents`). "No event
  channel" stays true: a plugin has no channel of its own, and the union is
  closed and composition-independent, so a row decodes and folds whether or
  not its plugin is on. A build that lacks an arm keeps its row unread.
- **A plugin in the pinned composition may contribute one prompt section**,
  `(ctx) => string`, consulted only for plugins the step pinned
  (`memory-workflow` today). Plugins do not read each other's sections.
- **The continuation seam is a plugin table.** `PLUGIN_CONTINUATIONS` holds
  goal mode's policy, pinned by the step (#13387). The after-turn output seam
  stays agent-runtime code.
- **The embedding package composes no setup platform.** Setup capabilities
  belong to a host with an editor: `installProcessRuntime` defaults `setup` to
  `{}`, which is what the CLI and desktop previously passed explicitly, and the three setup tools
  that need a host command, extension or terminal already fail naming its
  absence (all three are unavailable on `sdk`). The package's own refusing
  `SetupPlatform` and the `command-unavailable` failure reason existed for a
  call no tool can reach; both are deleted.

**Evidence.** #13364 (tables on the Registry, `Compositions` deleted),
#13387 (`PLUGIN_CONTINUATIONS`), #13420 (goal grant in core approval state,
`GoalGrants` deleted), and the `plugin.fact` arm, `PLUGIN_PROCESS_LAYERS`
(GitHub subscriptions, drained by the shutdown protocol) and
`PLUGIN_SESSION_LAYERS` (Codex and Claude registries) already on `main`.
`InvokeCommandTool`, `InstallVscodeExtensionTool` and `SendToTerminalTool`
each read the absent member and return a `ToolError`, so nothing read
`PACKAGE_SETUP`'s throwing `terminal` getter.

**What this forbids.** A plugin object with optional slots; a driver table
(none, decided 2026-09-27); a plugin-composed event union (rows must decode
with the plugin off); a second write path for plugin rows; a host-specific
refusing `SetupPlatform` in the embedding package.

**Not moved, and why.** `run.fact` todos and plan stay core rows: the
work-plan is core loop state (`WorkPlanState`, rehydrated from the run
snapshot and announced by the loop's own update callbacks), `run.fact` is its
display mirror, and the Codex adapter writes it too, so it has no single
plugin owner. Inquiry and workflow-checkpoint rows are aggregate kinds the core
`SessionRequests` and resume paths read, and `InquiryRecords` stays core. The
SDK's plugin set (`TexraProcessOptions.plugins`) lands with the process layer
graph (move 4).

---

## Rulings from the 2026-09-30 decision board (ruled 2026-09-30)

The owner took every decision on the board as recommended. Each entry below
is closed; its reopen trigger names the one event that reopens it.

### 1.0 identity, account and telemetry (D1-D3)

**Ruling.** 1.0 is a self-improving harness with a theorist bundle. The
theorist is the first plugin bundle (agents, skills, presets, hooks); the
software-engineering surface ships as a separate bundle; the CLI and SDK are
the primary headless host.

- **D1.** TeXRA sign-in is removed from all three hosts (the Account tab,
  `texra login`, the host sign-in UI). Provider OAuth (ChatGPT/Codex
  subscription, Grok/xAI) and API-key providers (OpenRouter among them) are
  not the TeXRA account and stay. The
  hosted server stays until its sunset.
- **D2.** Telemetry is anonymous metadata, on by default, with a random
  install ID: a UUIDv4 persisted in each host's global state, never derived
  from hardware, hostname, account, email or a provider login, not created or
  sent while any opt-out is active, and reset by deleting the state key.
  A one-time first-run notice says an anonymous install ID is sent. Opt-out
  is the setting, `TEXRA_NO_TELEMETRY`, `DO_NOT_TRACK` (already honoured) and,
  in the extension, `vscode.env.isTelemetryEnabled`. Metadata only: agent,
  model id, token counts, outcome, duration, host and version, from the
  run-end summary; no content, paths or error text.
- **D3.** No OpenTelemetry export in 1.0.

**Why.** The account gated nothing the bundled agents needed, and a sign-in
surface on three hosts is a fourth owner of identity. Usage counts still
answer which agents and models get used. Peers use a random install uuid
(aider, Goose, Zed) or a machine id (Cline); a random ID carries no hardware
identity, which is why the owner chose it over a machine id.

**Reopen.** A named consumer needs a TeXRA identity (billing, sync), or a
stable ID becomes derivable from something other than the random key.

### No daemon; several processes on one store (D4)

**Ruling.** There is no daemon. The CLI or SDK process is the unattended
runner. The permanent shape is several processes on one store, each aggregate
held by one claim (single owner).

**Why.** A daemon moves the run loop out of every host and calls host-only
capabilities back across a process boundary
(`2026-09-26-session-database-off-host-thread.md` §6); claims and the
`data_version` poll already give three hosts one store.

**Reopen.** A run that must outlive every host process and cannot be a CLI
or SDK process.

### Run directory contents (D5)

**Ruling.** A run's retained outputs live in SQLite. Files hold compiler
scratch only. Format work belongs to the storage lanes.

**Reopen.** A retained output that measurably cannot live in a row or blob.

### Approval rows and web_fetch posture (D6-D7)

**Ruling.** Approval settings are never read from the committed project
config file, so a repository cannot grant its own approvals; users keep
project scope through a user-level override (D6).
`web_fetch` has no per-host prompt, grant or allowlist (D7, reversed
2026-09-30: over-built for a small team). SSRF and redirect hardening, which
refuses non-public addresses on every hop, is the whole of its posture.

**Reopen.** A signed or trusted-project mechanism exists that D6 can defer to.
For D7, a concrete exfiltration incident through `web_fetch`; any prompt then
belongs to a network guard kind on `ToolGuard` (D8) under the existing approval
policy, not to a per-host grant of its own.

### The `defineTool` freeze admits guard kinds (D8)

**Ruling.** Amends the freeze entry above ("`defineTool`'s default `R` is
frozen SDK surface"): the tool contract may carry guard kinds for network,
process and MCP calls, so external tool calls stop being approved as shell.
The rest of the freeze stands; move 9 of the session-core note records it.

**Reopen.** A guard kind is proposed that no tool family needs.

### Plugin gating, presets with an optional root, no "roster" (D9-D10)

**Ruling.** Plugin skills and agents are gated by the plugin switch (D9),
reversing the plugin note's "not gated" line once the code lands. Custom
teams stay presets: saved switches plus an optional root agent, because one
switch should hide everything a plugin contributes and a second team concept
is a dual system. The words
"roster" and "multi-agent preset" retire (D10).

**Reopen.** A team needs state a preset cannot hold.

### SDK and typed-RPC deferral (D11)

**Ruling.** Hooks and data plugins are the extension mechanism. Typed-RPC
code plugins, `History.writer`, the open schema registry and `PluginModule`
are not built until a named plugin cannot be MCP + hooks + data. The SDK is
not advertised until a consumer is named.

**Reopen.** That named plugin or consumer exists.

### `config.json` is additive-only (D12)

**Ruling.** From 1.0 a key may be added and a released key keeps its meaning.
No retired-key list, no rewrite of old files (AGENTS.md "Compatibility and
format retirement").

**Reopen.** A released key cannot keep its meaning without a security cost.

### Context overflow and journey checks (D13-D14)

**Ruling.** A context overflow in a tool-use run becomes a forced compaction
retry, not a failed run (D13). Nightly and label-triggered journey checks run
on cheap models only, `deepseek41T` and `glm53` (D14).

**Reopen.** A forced retry loops without shrinking the context (D13); a
journey needs a model the cheap tier cannot drive (D14).

### Considered and refused

The survey's four candidates are refused; do not re-propose them as
specified.

- **The daemon build**, for the reasons under D4.
- **A merge queue.** Main failed validation twice in 56 completed runs, both
  the dead-code ratchet after two PRs combined badly, each fixed in about an
  hour. At about 8 minutes per entry and 50 to 60 merges a day, a queue is
  about 8 hours of serial time a day, re-runs the macOS jobs billed at 10x
  Linux, and adds per-PR latency against merge-on-green. Reopen: main breaks
  from combined merges often enough that the fixes cost more than the queue.
- **The survey's C2, one plugin switch table (kind, id, scope) replacing the
  five on/off stores** (`DISABLED_TOOLS`, `DISABLED_SKILLS`,
  `DISABLED_SKILL_SOURCES`, `INSTALLED_PLUGINS.enabled`,
  `HIDDEN_CUSTOM_AGENTS`). State keys are already rows in `current_value`, so
  the merge is a re-layout, not a deletion, and it would split
  `InstalledPlugin.enabled` from the trust record it shares a row with.
  Reopen: a switch family is needed for a reason other than tidiness and can
  keep enable and trust in one row.
- **An effects taxonomy.** D7 ships as SSRF and redirect hardening only (no
  per-host prompt or allowlist), and memory-write gating is dropped, so nothing
  reads a taxonomy. Reopen: a tool family needs an effect
  class no guard kind can express.
