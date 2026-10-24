# Architecture Rulings Ledger

Status: implemented

Living. Each entry is a **closed** question — a decision that has
already cost an audit round to reach and must not be re-litigated. Add an entry
when a recurring audit question is settled but has no natural home in a plan
doc; when it does have a home (a numbered disease, a tiered item), record it
there and leave a one-line pointer here instead. When a later owner ruling
reverses an entry, or the code it governs is deleted, remove the entry; git
history keeps it.

**Format:** one heading per ruling, stating the question, the decision, the
evidence that forces it, and what the decision forbids. Anchor evidence on
symbol and clause text, not line numbers — line cites in this repo drift under
shared-checkout churn.

---

## D7/T14 — no PersistedState one-instance-per-key registry

**Question.** Build a registry that guarantees one `PersistedState` instance per
storage key, so two instances (each with its own cached `state`) cannot
overwrite each other's writes?

**Ruling.** Close as superseded. **Do not build the registry.** It would add an
element without deleting a dual system: the construction sites are few, and
each is single-owner for as long as its owner lives.

**The narrower follow-up is blocked, and this is the record of why.** The
accepted residue was a ~40-line dev-mode duplicate-key assert in
`PersistedState`'s constructor (`packages/texra/src/shared/state/PersistedState.ts`).
Not every production site constructs its key once:

| Site                                                              | Key                    | Constructed once?                                      |
| ----------------------------------------------------------------- | ---------------------- | ------------------------------------------------------ |
| `packages/desktop/src/renderer/main.ts`                           | `'desktop.appearance'` | yes                                                    |
| `packages/desktop/src/renderer/main.ts`                           | `'shell'`              | yes                                                    |
| `packages/extension/src/progressView/frontend/sessionSurfaces.ts` | `` `surface:${key}` `` | **no — one per open session, rebuilt when it reopens** |

`sessionSurfaces`'s `open(key)` constructs a `PersistedState` per session
key, and `sync` deletes a closed session's entry from its `held` map and
opens it again when the session reappears, so the same `(storage, key)` pair is legitimately
constructed again. A constructor assert keyed on that pair would therefore
throw in dev/test (and warn in production) on ordinary navigation — a
false positive, which is its own defect, not a guard.

**What landing it would take**, if someone wants it later: a `dispose()` on
`PersistedState` that unregisters the key, called where `sessionSurfaces`
drops a held entry. That is a change to the progressView webview render
path and needs to be scoped as such — it is not a drive-by on the shared state
helper.

**What this forbids.** Do not file the registry again. Do not land a
construction-time duplicate-key assert without the disposal path above; without
it the assert is knowingly wrong for `sessionSurfaces`.

---

<a id="modelcell"></a>

## ModelCell — the run's binding and its lifetime

**Question.** Who owns a run's model binding, and when is a replaced binding
released?

**Ruling.** The run's `AgentRun` service owns the binding, in `run.model`,
and `run.swapModel` is its one writer:

- Each binding is bound into its own scope, forked from the run's scope.
  A swap binds the replacement into a fresh fork and closes the retired
  binding's scope at once, which releases its WebSocket and ping fiber, an
  editor model, and its uploaded files. A failed or interrupted bind closes
  its fork and leaves the binding in force. Nothing retired waits for the
  run to end.
- A host-admitted model switch commits its rows (the `run.config` naming the
  new model, whose fold drops the old model's continuation, and the
  requests' `followup.consumed`) inside the swap, so the new binding is in
  force only once its rows are. A manual retry's rebind and the reacquisition
  of a failed WebSocket binding go through the same swap.
- The run's model is its newest `run.config`. Display reads project the
  change as `run.model` rows.

**Implementation evidence.** `packages/harness/src/agent/runtime/run/AgentRun.ts`
(`swapModel`), `packages/harness/src/agent/runtime/loop/modelSwitch.ts`
(`applyPendingModelSwitch`), `packages/harness/src/agent/runtime/ModelInvoker.ts`
(`rebind`) and `packages/harness/src/controllers/session/projections.ts`
(the `run.model` projection).

## R-1 / Q1 — the filesystem: Effect's own `FileSystem`/`Path` (ruled 2026-09-13; supersedes the 2026-09-11 deferral)

**Question.** Replace TeXRA's own filesystem port and its `BaseFS` static
family with Effect's own `FileSystem` + `Path` services (#12073 R-1 candidate
B), or Effect-type TeXRA's own rooted ports?

**Ruling.** Candidate B, and it has landed. On 2026-09-11 (#12247) the owner
had declined the adoption "for now" on the measured evidence (7.1–9.7× slower
`readDirectory` walks because the service returns names only, no `lstat`,
`layerNoop` answering `exists` with `false`). On 2026-09-13 the owner ruled
the other way — "adopt Effect's own file system as much as possible". The
`Platform` object, the filesystem port, `BaseFS` and the memfs fake are gone:
`FileSystem` and `Path` are process services the composition root provides
once, and a session's roots are `RootedFileSystem` services
(`packages/harness/src/platform/rootedFs.ts`). AGENTS.md "Platform decoupling
rules" item 4 records the direction.

**Forbids.** Reintroducing a `Platform` object to hang fields on; an "own
port" Effect surface beside Effect's `FileSystem` for the same operation;
grafting an Effect surface onto a Promise filesystem helper while its callers
stay Promise-shaped. The 2026-09-11 evidence still binds the _mechanics_:
consumers that need `lstat` type bits (`XmlOutputManager`'s pre-write symlink
guard, the probes in `packages/harness/src/utils/files/fsEntryExists.ts`) and
typed directory walks keep thin TeXRA helpers over the service rather than
losing the property.

## No temporary adapters, and the `debtLanes` register is closed (ruled 2026-09-06; register deleted by #12277)

**Question.** May a subsystem convert to Effect behind a Promise-shaped adapter marked for
later removal, or take a `debtLanes` entry in the effect-migration ratchet so its new
`Effect.run*` site is admitted?

**Ruling.** No, on both. A converted callee's consumers convert upward to a real R1 boundary
kind in the same PR. `@adapter-until` markers fail ESLint (`no-warning-comments`). The
`debtLanes` register recorded debt that already existed when it was written and was never an
intake; #12277 deleted it, and the effect-migration ratchet itself was retired into the
`Effect.run*` lint block of `eslint.config.mjs` (#13573).

**Evidence.** Five prior conversions each left a `tryPromise` wall or a Promise facade so
the file would compile mid-migration; the 2026-09-07 promise-boundary audit classified those
as the debt being retired, not progress. R1's boundaries are the only places a run
is not debt: `packages/{extension,desktop,cli}/src/**`, the SDK entry files, and the named
runtime entries below.

**Forbids.** A bridging module that reads a global and exposes it as a `Layer`; a Promise
method whose body only runs an Effect; a "release-N" compatibility column; a feature flag
selecting two engines; dual writes.

## Webview runtime entries are an R1 boundary, admitted by name (ruled 2026-09-14)

**Question.** The `Effect.run*` ratchet counted the progress webview's transport
(`packages/extension/src/progressView/frontend/sessionTransport.ts`) and the Lit
signal bridge (`packages/texra/src/shared/signals.ts`) as below-boundary debt. Are those runs
debt to convert, or the webview's own entry?

**Ruling.** Boundary. A webview owns its own `ManagedRuntime`: `sessionTransport.ts`
installs and disposes it, so it is that webview's composition root, and `toSignal` is the
one documented meeting point between Effect and the components, running on the runtime its
caller passes. Both files, `packages/harness/src/platform/processRuntime.ts` and the code
sandbox's worker entry (`packages/harness/src/agent/codeSandbox/worker.ts`) are admitted by
name in `EFFECT_RUN_ENTRIES` in `eslint.config.mjs`. The exemption is whole-file: that a run
is on the entry's own runtime is enforced by review, not by the linter.

**Forbids.** Admitting a directory: every other file under the webview frontends stays
fenced. Adding an entry is a ruling, not a refactor, and an entry must hold its runtime as a
local or take it as a parameter; a module that reaches a process-global runtime does not
qualify.

## Effect submodules: each family is admitted with a stated exit (ruled 2026-09-18; paths updated for 4.0.0 stable 2026-10-01)

**Question.** The Effect-4 migration PRD's non-goal 4 and §11 bar `effect/unstable/*`
"without a separate decision naming its replacement or exit plan". Which decision admitted
the families in the tree, and what is each one's exit?

**Ruling.** The six below are admitted. The 2026-09-13 filesystem ruling ("adopt
Effect's own file system as much as possible") settled the general question
the PRD reserved; what was missing is the per-family record the PRD asks for,
and it is this. Effect 4.0.0 (stable) moved the modules out of the
`effect/unstable/*` paths, so the rows use the real subpaths. Every 4.0.0
module is still marked `@stability unstable` upstream, so the exits below
stay the plan if one is withdrawn.

| Family               | Used for                                                                                                    | Stabilization or exit                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `effect/http`        | `HttpClient` on the auth, model, tool and telemetry paths                                                   | Stays; follows the module's stability. Exit is Node `fetch` behind the same typed errors.                                           |
| `effect/process`     | `ChildProcess` and `ChildProcessSpawner` at every spawn site, MCP stdio servers included                    | Stays. Exit is `node:child_process` behind the same spawner service.                                                                |
| `effect/sql`         | `SqlClient` under `@effect/sql-sqlite-node`, the one session database                                       | Stays. Exit is the official Node SQLite driver directly, which the client only wraps.                                               |
| `effect/reactivity`  | `Reactivity.layer` behind the database's invalidation signal (`Database.ts`)                                | Stays with `sql`; it is that client's own invalidation contract. Exit is an in-repo emitter over the committed-wake levels it owns. |
| `effect/persistence` | `RateLimiter` over the memory store: the process-wide annotation-fetch budget (`subscriptionRegistries.ts`) | Stays; memory store only. Exit is a `Ref` token bucket behind the same claim effect.                                                |
| `effect/testing`     | Test clocks and schedulers in the Vitest suites                                                             | Test-only; stays. No production exit needed.                                                                                        |

Three more families are in use without a row: `effect/rpc` and `effect/socket`
carry `texra serve` (`packages/texra/src/controllers/server/`), which the
owner ruled on 2026-10-03 ("Effect RPC over a Unix socket"), and
`effect/workers` runs the code sandbox's QuickJS worker
(`packages/harness/src/agent/codeSandbox/`). Their exit rows are owed.

`effect/ai` is not used and has no row.

**Evidence.** `rg -oN "from 'effect/[A-Za-z]+" src packages/*/src` lists the
first path segment of every `effect/<subpath>` import: the six families
above, the three named after the table, and `PlatformError` and
`SchemaIssue`, plain core modules that need no row. Every exit named above is
a path the repository has already walked or is still standing on, so none of
them is speculative.

**Forbids.** A new family without its own row here. Adopting one of these
for a second purpose without checking that the exit still holds. Treating
"unstable" as a reason to keep a duplicate in-repo implementation warm beside
it; the exits above are what happens if a module is withdrawn, not a system
maintained in parallel.

**Amendment (owner decision, 2026-09-24; plugin architecture).** Effect
modules are allowed for the plugin work. `effect/process` is no longer
type-only: the MCP plugin (#13092) spawns its stdio servers through it at
runtime (`packages/harness/src/tools/mcp/mcpServer.ts`). The exit named in the
table is unchanged. See the [plugin architecture note](./2026-09-24-plugin-architecture.md).

## Per-session `LayerMap`, per-run `Layer.effect`: decision 8's "one provide at the process entry" is amended (ruled 2026-09-18)

**Question.** Decision 8 of the Effect-4 migration PRD (§15) ratified Effect's
best-practice guides, including "one `provide` at the process entry". The
landed runtime provides services at more than one lifetime. Is that a
deviation to repair?

**Ruling.** No. The guide's sentence is about there being one composition
root, not one `provide` call. The landed shape is correct and is the
amendment: the process entry provides the process services once; each session
is a `LayerMap` entry keyed by session, built on that one `ManagedRuntime`
(`packages/harness/src/controllers/session/sessionLayer.ts`,
`packages/texra/src/controllers/session/webviewSessionLayer.ts`); each run
takes its services from a `Layer.effect` scoped to the run (in
`packages/harness/src/agent/runtime/`: `run/AgentRun.ts`, `ModelInvoker.ts`,
`SessionEvents.ts`, `FollowUps.ts`, `RunHistory.ts`). A session's services
release when its `LayerMap` entry does, and a run's when its scope closes.

**Evidence.** `LayerMap` is what makes "one session, one owner" hold without a
global session registry: the desktop opens several sessions in one process,
and a single process-wide `provide` would give them one set of stores. The
same argument at the run lifetime is R3 below ("layers follow actual
lifetimes"), and the PRD's carrier table (§8.1) already named three lifetimes,
so decision 8 and §8.1 were in tension and §8.1 wins.

**Forbids.** Flattening the session or run layers into the process layer to
satisfy a literal reading of decision 8. A further lifetime without its own
ruling. Reintroducing a process-global lookup for anything a session or run
layer already provides.

**Amendment (2026-09-27, #13364).** Plugin layers are the further lifetime:
the tool catalog (`packages/harness/src/tools/liveTools.ts`) holds each one as
an `RcMap` entry in its lifetime's scope, a process layer once per process
and a session layer once per open session, up while the plugin is on or a
step pins it. See "Plugins are values" below.

## The permanent `AbortController` residents (ruled 2026-09-18; named in the ratchet by [#12700](https://github.com/LionSR/TeXRA/pull/12700))

**Question.** The `new AbortController(` count is shrink-only. Are the files
left on it debt to convert to fiber interruption, or the floor?

**Ruling.** The floor. The files are the adapters that stay, and since #13573 the
allowlist is the `residents` list of the `AbortController` selector in
`eslint.config.mjs`: a new file fails lint as new debt. Each is a foreign API
that takes a controller rather than offering cancellation:

- `packages/texra/src/tools/claudeAgent.ts` — the Claude Agent SDK takes a
  controller, not a signal.
- `packages/harness/src/agent/runtime/childRunLoop.ts` — the one signal every
  child-run turn runs under, handed to agent-CLI child processes, the Codex
  SDK and the Claude Agent SDK. The loop's stop must not interrupt its fiber:
  the turn's settlement, parent delivery and finalization all run after it.

Two former residents left without breaking the ruling: the shutdown phase
deadline (2026-09-26, shutdown became a scope's close bounded by
`Effect.timeoutOption`) and the chat TUI's busy-form abort in
`slashContext.ts` (#12816 made the submit chain Effect-native).

**Evidence.** The survey's D25 lane had proposed converting `childRunLoop` to
fiber interruption; the second bullet above is why that is wrong.

**Forbids.** Adding a new `new AbortController()` anywhere in production.
Deleting the list (the allowlist is the ruling). Building a second internal
cancellation tree beside the fiber's, which is what converting these to
signals-of-signals would produce.

## Runtime threading: each composition root holds its `ManagedRuntime` in a local (ruled 2026-09-18; answers Effect-4 PRD §15 decision 2)

**Question.** Decision 2 asked whether the host managed runtime belongs
directly in each composition root or behind one host-neutral
`ApplicationRuntime` adapter. Decision 9 narrowed it ("whatever hosts the
managed runtime, it is not an adapter layer") without answering it.

**Ruling.** Directly in each composition root, held in a local and threaded as
a parameter where a callee genuinely needs it. There is no `ApplicationRuntime`
type, no host-neutral runtime module, and no process-global accessor below the
entries: code below a composition root runs as an Effect program that is
already on the runtime rather than fetching one.

**Evidence.** The process-global `effectRuntime()` accessor had no production
reader by #12507 and is now deleted. The webview runtime-entry ruling above
already requires an admitted entry to "hold its runtime as a local or take it
as a parameter". This ruling is that rule stated for every host, not only the
webviews.

**Forbids.** An `ApplicationRuntime` adapter layer, a host-neutral runtime
facade, and a process-global runtime accessor. Reintroducing a module-global
runtime slot to avoid threading a parameter.

## Rulings from the 2026-09-17 round-trip and dual-system survey (recorded 2026-09-18)

**Question.** The round-trip and dual-system survey
([#12681](https://github.com/LionSR/TeXRA/pull/12681)) raised eight open
questions across its lanes. Under the standing owner instruction the
recommended option is taken; this is the record so the lanes do not re-open
them. Three of the eight (the Supabase auth storage callback, the auth
probes' workspace-roots frame, and `AgentPlatform` re-declaring the fields
`Platform` lost) governed code that is now deleted and are dropped here.

**Ruling**, one line each:

1. **The desktop preview host's Promise face is an adapter, not a permanent
   boundary.** `packages/texra/src/hosts/uiHosts.ts` and
   `packages/desktop/src/main/desktopPreviewHost.ts` record an earlier ruling
   that the `openExternal` / `openPath` / `openBuildDisplay` fan-out stays
   Promise-shaped; under the 1.0 clean rule it is an R1 adapter and converts
   after the host-request lanes, which is also what `ExternalOpener` already
   did.
2. **A host's webview inbound handler registry is an R1(a) terminal.** Failure
   reporting belongs to each host's registry (see "Settings dispatch has one
   native execution boundary" below).
3. **`stream_id` stays frozen** in the `log-usage` edge function as the one
   permanently frozen external spelling of the run id, on the same
   minimum-supported-client basis already ruled for the usage-route tolerance.
4. **`texra tools list --json` and `texra skills list --json` change shape**
   when the CLI renders the shared projections. The change is user-facing and
   goes in the changelog, because `texra-action` consumes CLI result JSON.
5. **The CLI keeps its cheap built-in default model**, named as a deliberate
   cheap-start choice derived from the shared table (`CLI_CHEAP_START_MODEL`
   in `packages/cli/src/runtime/cliConfig.ts`) rather than deleted in favour
   of the shared default.

**Forbids.** Re-opening any of these inside a lane. In particular: do not
propose renaming the edge function's `stream_id` column.

## The process-roots holder is retired, and the `working_directory` gate runs in `execute` (ruled 2026-09-19)

**Question.** [#12774](https://github.com/LionSR/TeXRA/pull/12774) deleted the
workspace-roots `AsyncLocalStorage` carrier, leaving a process-wide roots
holder (`initProcessWorkspaceRoots` / `processWorkspaceRoots`) as the one
named ambient singleton, read as a fallback by session open, by a
pre-initialization logger read, by the CLI's settings stores and by the
delegation tools' static `working_directory` Zod transform. Does the holder
survive them?

**Ruling.** No: the holder is deleted, and every read got an owner rather than
a fallback.

- `SessionHandleInit.roots` is required: the opener is the one caller that
  knows which project it opened.
- The pre-initialization debug-mode read is gone: `texra.logger.debugMode` is
  read at transcript-fold time from the roots the view's owner already
  holds, and each host's log surface owns its own level.
- The CLI answers catalog rows from the roots its own init built, and a
  process whose roots were never published is a composition defect that
  fails loudly instead of reading a process-wide record.
- The `working_directory` worktree gate (`rejectUnusableWorkingDirectory` in
  `packages/harness/src/tools/delegation/inputFields.ts`) runs in the tool's
  `execute`, where `call.env.roots` names the call's project, rather than in
  the static schema, which could only answer for whichever workspace the
  process came up in. A disabled-worktree `working_directory` is therefore a
  tool error rather than a schema rejection; the refusal text is unchanged.

The test harness keeps an installed-roots accessor of its own
(`src/test-kernel/support/testWorkspaceRoots.ts`): a suite is its own
composition root, and its assertions and seeding happen outside any session.
That is test scaffolding, not a production carrier.

**Forbids.** Reintroducing a process-wide roots record, in production or in a
host, including as a field on a platform object. A second ambient carrier
reintroduced to avoid threading a parameter. Making `SessionHandleInit.roots`
optional again. Moving the `working_directory` gate back into the schema.

---

## Settings dispatch has one native execution boundary (revised 2026-09-22)

**Question.** A 2026-09-19 ruling retained Promise-shaped registry arms
because each was already a host boundary. Does that forbid replacing the whole
backend dispatcher with programs executed once at the incoming host message?

**Ruling.** No. The owner's
[explicit revision in #13009](https://github.com/LionSR/TeXRA/pull/13009#issuecomment-5779248081)
(merged 2026-09-22) preserves one execution boundary and rejects duplicate
dispatch machinery; it does not require a boundary in every registry arm. This
supersedes the Promise-shape requirement and the instructions in
#12880/#12884 to remove the settings-dispatch slice.

**Evidence.** `packages/texra/src/controllers/settingsView/settingsViewDispatch.ts`
owns the one backend selector, `settingsViewProgram`, over the
already-validated inbound union. Its two consumers are the extension's
`SettingsViewMessageHandler.handleMessage` and desktop's
`createDesktopSettingsIpc`; each supplies Effect-valued handlers and executes
once at its native message entry. Exhaustive `HandlerRegistry` typing and its
`unsupported(reason)` markers remain shared; the same markers derive frontend
capabilities.

The remaining `createDispatcher` instantiation is
`dispatchSettingsViewOutbound` in
`packages/texra/src/shared/settingsView/settingsViewMessages.ts`. Its sole
production caller is `SettingsApp.messageListener`, shared by the VS Code
webview and Electron renderer. Every arm in frontend `messageDispatcher.ts`
updates browser state synchronously; none returns a Promise or starts an
Effect. The shared generic handler type supports these values without
importing the backend runtime into the browser graph. Parse, missing-handler
and unsupported-command failures reach the frontend error callback; a
synchronous handler defect propagates to the browser event boundary. There is
no asynchronous renderer rejection left for a generic Promise dispatcher to
observe.

**Failure ownership.** Both native host entries observe complete Effect causes,
including defects; interruption-only causes stay silent. Unsupported commands
show their reason. The extension logs failures of error presentation or the
subsequent refresh. Desktop routes both action and presentation failures to
its final `onError` sink, unwrapping `NotificationFailed.cause` there. Provider
key failures retain their write-versus-refresh distinction until host
presentation. Scoped cleanup remains part of the program's exit.

**Forbids.** A backend dispatcher beside this selector; per-host copies of the
selector; Effect-to-Promise adapters around individual arms; executing backend
programs below the native entry. Asynchronous browser work must observe its
failure at its own entry rather than being silently returned from a
synchronous state handler.

---

## `defineTool`'s default `R` is frozen SDK surface, not a simplification target (ruled 2026-09-19; [#12862](https://github.com/LionSR/TeXRA/pull/12862))

**Question.** A wave-8 lane proposed folding the tool definition modules and
changing `defineTool`'s default `R` while unifying the tool run guards. May a
simplification lane change it?

**Ruling.** No. `defineTool`'s default `R` is SDK surface and an owner
decision, so `packages/harness/src/tools/core/definition.ts` and its export
from `packages/harness/src/index.ts` stay untouched by simplification work.
The lane landed its run-guard unification without opening them.

**Evidence.** The SDK surface is built and fenced: ESLint forbids
`packages/harness/src/**`, `packages/texra/src/**` and `packages/llm/src/**`
from importing host layers, and `config/ratchets/harness-deep-import-baseline.json`
freezes the remaining edges. `@texra-ai/harness` is npm-releasable at 0.x, so
the default `R` is a published contract, not a free choice. Changing it would
be a contract move made by a lane that had no stake in the contract.

**Forbids.** Retyping `defineTool`'s default `R` as part of a simplification,
refactor or consolidation lane. That change needs its own owner decision and
its own PR.

**Amendment (owner decision, 2026-09-23; "tools as data" PR).** The owner
lifted this freeze for the plugin architecture: the SDK tool contract may
change for that work. Net-negative LOC is not the gate for this line of work.
The first change under the amendment made `defineTool` return a plain tool
object carrying `execute` instead of a class to subclass: `BaseTool` is
deleted, every tool is a tool object, and the SDK exports `DefinedTool`. The
declaration and implementation modules were later folded into
`definition.ts` (#13918). The freeze's premise still holds for unrelated
lanes: a simplification lane does not retype the tool contract on its own
initiative.

---

## The session close chain takes no `AbortSignal` (ruled 2026-09-19; [#12855](https://github.com/LionSR/TeXRA/pull/12855))

**Question.** The session close chain (`SessionOwner.close`, `closeSession` in
`packages/harness/src/controllers/session/sessionLayer.ts`, and the SDK's
session close) each took an optional `signal?: AbortSignal`, adapted into the
drain. Keep the parameter on the SDK surface for an embedder who might want
it?

**Ruling.** No. `signal` is dropped from the whole close chain, the SDK
included. A caller who needs to give up on a drain interrupts the fiber.

**Evidence.** No in-tree caller passed a signal, so the parameter was
speculative generality. The drain itself is an Effect program, so fiber
interruption is the cancellation mechanism the rest of the runtime already
uses, and keeping a parallel `AbortSignal` channel would be a second
cancellation vocabulary on the one path that most needs a single owner. The
permanent `AbortController` residents are foreign contracts (agent-CLI child
processes, the Codex SDK, the Claude Agent SDK); a session close is not one
of them.

**Forbids.** Re-adding an `AbortSignal` parameter anywhere on the session close
chain, on any host or on the SDK surface. Cancelling a drain by any mechanism
other than interrupting the fiber that awaits it.

---

## The agent SDK's public surface is Effect; R1 boundary kind (c) is retired (ruled 2026-09-21)

**Question.** Rule R1 of the Effect migration admitted three boundary kinds;
kind (c) was "the SDK's public Promise API": the root entry rendered the
package's Effect services as `runAgent` / `closeSession` / `AgentRun`
Promises and AsyncIterables, and a `/effect` subpath carried the services.
With kind (b) already retired (#12337), does kind (c) still stand?

**Ruling.** No. The root entry (`packages/harness/src/index.ts`) **is** the
Effect surface: `Sessions`, `Session`, `Run`, the tagged errors and the
tool-definition helpers, with no `/effect` subpath. The Promise rendering —
`runAgent`, `closeSession`, `AgentRun`, `RunAgentInput`, the module-level
composition cache and the shutdown-hook wiring — is deleted, not relocated.
The SDK's entry files call no `Effect.runPromise` / `runSync` / `runFork`; a
Promise-land embedder runs `Effect.runPromise(program)` at its own entry
point.

**Evidence.** (1) `effect` was already a mandatory peer dependency of the
**whole** package — the root bundle imported `effect` at runtime — so the
Promise entry spared no consumer the Effect install it existed to hide.
(2) The Promise entry had zero consumers. (3) TeXRA 1.0 keeps no parallel or
compatibility surfaces, and a Promise rendering beside the Effect surface is
exactly one. `Sessions.layer` and `Effect.scoped` already implement everything
the composition cache did (per-scope hold, `PlatformConflict`, finalizer
release), so the change was deletion plus repointing.

**Forbids.** Reintroducing a Promise-shaped entry, a dual root/`/effect`
split, or a `runAgent`-style wrapper whose body only runs the Effect
services.

---

## Provider-hosted web tools are ruled out of 1.0; the local web tools are the one system (ruled 2026-09-22)

**Question.** OpenAI `web_search` and Anthropic search and fetch worked on the
deleted model handlers, but the `packages/llm` codecs never grew them — the
Anthropic codec answered a hosted-tool receipt with an explicit "hosted-tool
accounting is not supported" failure, and a Responses `web_search_call`
output item has no arm and fails the output-item schema as a parse error.
Implement the hosted tools inside the codecs with their usage accounting, or
rule them out of 1.0 and delete the dead arms?

**Ruling.** Ruled out. 1.0 ships without provider-hosted tools: the run's
local `web_search` (`packages/harness/src/tools/web/WebSearchTool.ts`) and
`web_fetch` (`packages/harness/src/tools/web/WebFetchTool.ts`, both
contributed by the harness's built-in plugins in
`packages/harness/src/tools/builtinPlugins.ts`) are the one system for web
search and fetch, and a provider-hosted execution of the same capability
would be a second system for it. The two dead accounting arms in the
Anthropic codec are deleted, so the codecs stop advertising a capability they
refuse; nothing else changes, because the codecs never requested a hosted
tool in the first place. A stream that carries hosted execution still fails
loudly — the hosted blocks fail the event schema as malformed output — and
the standing boundary keeps its name: a paused hosted turn fails as
unsupported through the existing `pause_turn` arm
(`packages/llm/src/api/anthropicMessages.ts`). Hosted tools may return later,
but only as a properly scoped lane whose spec is both halves together: usage
accounting folded through `providerUsage` like every other provider-side
receipt, AND the `pause_turn` continuation protocol.

**Evidence.** The llm hardening note's own recommendation on file was exactly
this ruling (deletion-shaped, removes an explicit failure path from the
codecs' resting state, and the capability can return with the accounting it
needs). The capability already ships locally, so a codec restore would
duplicate it — the no-dual-systems mandate. And a bare codec restore would not
just be redundant but incomplete: Anthropic pauses hosted execution
(`stop_reason: pause_turn`) when a server tool's result set grows large, and
continuing a paused turn needs a continuation protocol that resumes the
partial turn — a runtime-loop seam, not a codec patch. Hosted `web_search`
without that continuation breaks in practice on exactly the result sets it
exists for, which is why the `pause_turn` arm stays in the codec as the named
seam a future hosted-tools lane must implement, alongside the `providerUsage`
accounting, before either ships.

**Forbids.** Requesting a provider-hosted web tool from any codec in 1.0 (an
Anthropic `web_search`/`web_fetch` tool entry, a Responses `web_search`
tool), and re-adding a hosted-tool accounting arm for one. Reintroducing
hosted web tools without BOTH the usage accounting folded through
`providerUsage` and the `pause_turn` continuation protocol. Shipping a second
web-search or web-fetch system beside the local `web_search` and `web_fetch`
tools.

---

## Plugins are values; their state is a typed arm of the closed event schema (ruled 2026-09-28; amended by the harness split 2026-10-02)

**Question.** The plugin note (`2026-09-24-plugin-architecture.md`) ruled
that "plugins own no durable state and no event channel" and that "prompt
sections are core", and the continuation seam was agent-runtime code. Which
stands, and what does the embedding package owe a plugin it does not compose?

**Ruling.** Amend all three.

- **A plugin is a `Plugin` value** (`packages/harness/src/tools/plugins.ts`),
  keyed by a stable id, whose optional members are its contributions: tools,
  availability probe, switch, continuation, prompt section, process and
  session layers, request-decision hook, row arms and agent-file block. The
  process is composed from a plugin list (#13643). This replaces the
  2026-09-28 form of this ruling (one fixed table per seam, "there is no
  plugin object"), which the owner's 2026-10-02 split direction, "everything
  is a plugin: `Plugin` values contributed to the Registry", reversed.
- **Plugin state is a typed arm of the one closed event schema**, written as
  a `plugin.fact` through the one publisher (`SessionEvents`). "No event
  channel" stays true: a plugin has no channel of its own, and a plugin's
  `arms` are read whether it is on or off, so a row decodes and folds
  whether or not its plugin is on. A build that lacks an arm keeps its row
  unread.
- **A plugin may contribute one prompt section** (`prompt`), consulted only
  for plugins the step pinned. Plugins do not read each other's sections.
- **The continuation seam is a plugin member.** Goal mode's policy is the
  goal plugin's `continuation` (`packages/harness/src/tools/goal/goalContinuation.ts`),
  pinned by the step.
- **A plugin's layers live in the tool catalog** as reference-counted
  entries, shared by every step that pins the plugin (see the `LayerMap`
  amendment above).
- **The harness composes no setup platform.** `SetupPlatform` is the app's
  (`packages/texra/src/tools/setup/platform.ts`), served by a host with an
  editor; the setup tools that need a host command, extension or terminal fail
  naming its absence.

**Evidence.** #13364 (the live catalog, `Compositions` deleted), #13387
(continuations a plugin seam), #13420 (goal grant in core approval state),
#13491 (the SDK composes no setup platform), #13643 (plugins are values),
#13918 (plugin arms).

**What this forbids.** A driver table (none, decided 2026-09-27); a
plugin-composed event union (rows must decode with the plugin off); a second
write path for plugin rows; a second plugin-layer cache, `Layer.fresh` on a
plugin layer, or a plugin layer constructed per step (its identity is what
makes it shared); a host-specific refusing `SetupPlatform` in the harness.

**Not moved, and why.** The `run.fact` plan row stays core: the plan tool is
the harness's (`packages/harness/src/tools/plan/PlanTool.ts`) and `run.fact`
is its display mirror.

---

## A child run is not bounded by its parent's tools (ruled 2026-10-24)

**Question.** Should a delegated child persona keep only the tools its
parent's step offered ("a child can only narrow its parent", #13154, merged
2026-09-25)?

**Ruling.** No; that ruling is withdrawn. A run is offered what its own
definition and launch declare, under the session's gates (plugin switch,
dependency probe, host, capability, approval prompts). What a child may do
with a tool is the approval policy's, which already reads the launch edge
(`resolveBypass`, `delegatedChildGrants`, `grantsKept`). Design and
evidence: [peer runs](./2026-10-24-peer-runs.md).

**Forbids.** Re-passing a parent's offered list into a child's launch
(`parentOffered` and its refusal were deleted), and any other launch option
that restates a fact the `run.start` parent edge already holds.

---

## Rulings from the 2026-09-30 decision board (ruled 2026-09-30)

The owner took every decision on the board as recommended. Each entry below
is closed; its reopen trigger names the one event that reopens it.

### 1.0 identity, account and telemetry (D1-D3)

**Ruling.** 1.0 is a self-improving harness with TeXRA as its app (the
2026-10-02 split: `@texra-ai/harness` and the app `@texra-ai/texra`, built
from first-party plugins); the CLI and SDK are the primary headless host.

- **D1.** TeXRA sign-in is removed from all three hosts (the Account tab,
  `texra login`, the host sign-in UI; #13565). Provider OAuth (ChatGPT/Codex
  subscription, Grok/xAI) and API-key providers (OpenRouter among them) are
  not the TeXRA account and stay. The hosted server stays until its sunset.
- **D2.** Telemetry is anonymous metadata, on by default, with a random
  install ID: a UUIDv4 persisted in each host's global state, never derived
  from hardware, hostname, account, email or a provider login, not created or
  sent while any opt-out is active, and reset by deleting the state key.
  A one-time first-run notice says an anonymous install ID is sent. Opt-out
  is the setting, `TEXRA_NO_TELEMETRY`, `DO_NOT_TRACK` and, in the extension,
  `vscode.env.isTelemetryEnabled`. Metadata only: agent, model id, token
  counts, outcome, duration, host and version, from the run-end summary; no
  content, paths or error text.
- **D3.** No OpenTelemetry export in 1.0.

**Why.** The account gated nothing the bundled agents needed, and a sign-in
surface on three hosts is a fourth owner of identity. Usage counts still
answer which agents and models get used. A random ID carries no hardware
identity, which is why the owner chose it over a machine id.

**Reopen.** A named consumer needs a TeXRA identity (billing, sync), or a
stable ID becomes derivable from something other than the random key.

### Several processes on one store (D4)

**Ruling.** The permanent shape is several processes on one store, each
aggregate held by one claim (single owner). D4's "there is no daemon" was
reversed by the owner on 2026-10-03: `texra serve` is one Effect-native
background service per user and machine (Effect RPC over a Unix socket,
`packages/texra/src/controllers/server/`), and its windows serve host-only
capabilities back over the connection.

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
refuses non-public addresses on every hop, is the whole of its posture. Under
a configured `HTTP_PROXY`/`HTTPS_PROXY` the proxy resolves names, so a
proxied request refuses only IP-literal hosts and name resolution is the
proxy's to police; a request the environment sends direct (`NO_PROXY`, or a
scheme no proxy variable covers) gets the resolver check.

**Reopen.** A signed or trusted-project mechanism exists that D6 can defer to.
For D7, a concrete exfiltration incident through `web_fetch`; any prompt then
belongs to a network guard kind on `ToolGuard` (D8) under the existing approval
policy, not to a per-host grant of its own.

### The `defineTool` freeze admits guard kinds (D8)

**Ruling.** Amends the freeze entry above ("`defineTool`'s default `R` is
frozen SDK surface"): the tool contract may carry guard kinds for network,
process and MCP calls, so external tool calls stop being approved as shell.
The rest of the freeze stands.

**Reopen.** A guard kind is proposed that no tool family needs.

### Plugin gating, presets with an optional root, no "roster" (D9-D10)

**Ruling.** Plugin skills and agents are gated by the plugin switch (D9).
Custom teams stay presets: saved switches plus an optional root agent, because
one switch should hide everything a plugin contributes and a second team
concept is a dual system. The words "roster" and "multi-agent preset" retire
(D10).

**Reopen.** A team needs state a preset cannot hold.

### Typed-RPC deferral (D11)

**Ruling.** Hooks and data plugins are the extension mechanism for plugins
outside the tree. Typed-RPC code plugins, `History.writer`, the open schema
registry and `PluginModule` are not built until a named plugin cannot be
MCP + hooks + data. (First-party plugins are code: durable-harness HQ1,
2026-10-02. D11's "the SDK is not advertised until a consumer is named" was
reversed by the owner's 2026-10-06 decision 9 and 2026-10-15 direction:
`@texra-ai/harness` and `@texra-ai/llm` are npm-releasable, and publishing is
the owner's manual step.)

**Reopen.** That named plugin exists.

### `config.json` is additive-only (D12)

**Ruling.** From 1.0 a key may be added and a released key keeps its meaning.
No retired-key list, no rewrite of old files (AGENTS.md "Compatibility and
format retirement").

**Reopen.** A released key cannot keep its meaning without a security cost.

### Context overflow and journey checks (D13-D14)

**Ruling.** A context overflow in a tool-use run becomes a forced compaction
retry, not a failed run (D13). Journey checks, run on demand by label or
dispatch (no schedule since 2026-10-02), use cheap models only:
`gemini38f`, `deepseek41T` and `glm53flash` (D14, model list per the
owner's standing rule).

**Reopen.** A forced retry loops without shrinking the context (D13); a
journey needs a model the cheap tier cannot drive (D14).

### Considered and refused

The survey's candidates below are refused; do not re-propose them as
specified. (The fourth, the daemon build, was taken up as `texra serve`; see
D4.)

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

## Effect migration design rules R1 to R10 (ratified 2026-08-26; amended 2026-09-06 and later)

The migration PRD that carried these rules is deleted (history keeps it). Live
notes cite the rules by number; this is their text.

- **R1.** Effect inside, Promises at the boundary. A boundary is a host entry a
  framework invokes (`packages/{extension,desktop,cli}/src`), the SDK's entry
  files, a named runtime entry (`EFFECT_RUN_ENTRIES` in `eslint.config.mjs`),
  or nothing else (the tool `call` contract is no longer a boundary, and the
  SDK's entry files run nothing; see the entries above). `Effect.run*` is
  forbidden below a boundary.
- **R2.** Services follow semantic boundaries. A service earns its place when it
  is independently implemented, acquired, scoped, or substituted in tests; plain
  inputs stay arguments.
- **R3.** Layers follow lifetimes: host process, session, agent run, call.
  Longer-lived layers may build shorter-lived ones, never the reverse. No
  `FooLayer` wrapper that only calls `Layer.succeed`.
- **R4.** The agent runtime is plain Effect: no state-machine framework, node,
  graph, cursor, or flow record. A run appends rows to the run history and folds them.
- **R5.** Interruption replaces internal abort choreography. `AbortSignal` only
  where an external SDK or host API requires one.
- **R6.** Scope owns resources (`acquireRelease`, scoped layers, finalizers).
- **R7.** Expected failures use the typed error channel, bugs are defects,
  cancellation is interruption, and domain decisions stay success values. One
  user-facing error taxonomy (`classifyAgentError`), no second presentation path.
- **R8.** One clock and one schedule model; tests advance the test clock.
- **R9.** `AgentTrace` and `AgentEvent` stay the product traces; Effect spans
  may enrich them, and no host UI reads generic Effect logs.
- **R10.** Replacement must delete: each PR states what became unreachable, what
  collapsed, what imports went, and the line and element delta. There are no
  temporary adapters and no retirement clock.

## Service scopes: ExternalRoots stays a module (ruled 2026-09-20)

`ExternalRoots` (`packages/harness/src/utils/files/externalRoots.ts`) is not
made a standalone service: one writer, four readers, keyed by kind, a sound
freeze rule; a service is +4 signatures for 0 deletions. Reopen when a
consumer needs it to be scoped per session. Pinned by
`SCOPE-external-roots-standalone-service` in `config/ratchets/refuted-candidates.json`.

`HeldSessions`, kept on the same date for its test churn, is deleted by owner
decision 19 (#13723, 2026-10-06): the hosts and the SDK compose one
`processLayer`, whose `SessionOwner` service owns the open sessions through
its `LayerMap` alone. The test kernel keeps its default session in
`src/test-kernel/support/sessionEnd.ts`.

## Cross-host Copilot OAuth is not approved (parked 2026-06-22)

A GitHub Copilot route over the device flow and the undocumented
`api.githubcopilot.com` backend (borrowed client id, editor-impersonation headers)
would work on all three hosts but runs against Copilot's Terms and carries
documented account-suspension risk. Do not build it without explicit maintainer
acceptance of that risk; the official `vscode.lm` route is the only sanctioned one.

## Adaptive document workflows are not planned (ruled 2026-09-06)

The owner does not want a model-chosen, candidate-file document workflow
replacing the fixed document workflow (today the documents plugin's recipe,
`packages/texra/src/agent/output/documentRecipe.ts`). Do not re-propose it as
specified.
