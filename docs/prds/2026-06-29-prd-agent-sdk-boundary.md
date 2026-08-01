---
created: 2026-06-29
updated: 2026-08-01
---

# PRD: The Agent-SDK Boundary - Publishing the Runtime the UIs Sit On

> **Historical status (2026-07-18): retired proposal.** This document is
> preserved from the unmerged `codex/decouple-ui-agent-core` branch and does not
> define a package or SDK boundary on `main`. Main instead folded the coordinator
> layer into `session.interactions` in [#7504], deleted the progress/process bus
> in [#7457] and [#7474], reduced the runtime boundary to the small
> `AgentRuntimeHost` event sink and its no-op headless implementation through
> [#7600], [#7602], [#7623], and [#7624], and enforced host-to-agent imports with
> ratchet tests and centralized baselines in [#7914] and [#8322] rather than a
> package fence. The proposed frozen `RunDescriptor` injection model,
> `ModelCell`, `PendingRequests`, `RetryPolicy`, `RetryGate`, and `HostUiBus` are
> retired and must not be implemented from this record. The later
> [narrow ModelCell ownership ruling][modelcell-ownership-ruling]
> governs only the current primitive on `main`; it does not revive this proposal
> or make its other retired designs authoritative. The `RunDescriptor` name
> on `main` denotes the unrelated persisted stream schema introduced in [#7164].
> The companion `2026-06-28-prd-architecture-patterns.md` record remains only on
> the source branch and is not part of this extraction; references to it below
> are historical context, not documentation present on `main`.

[#7164]: https://github.com/LionSR/TeXRA/pull/7164
[#7457]: https://github.com/LionSR/TeXRA/pull/7457
[#7474]: https://github.com/LionSR/TeXRA/pull/7474
[#7504]: https://github.com/LionSR/TeXRA/pull/7504
[#7600]: https://github.com/LionSR/TeXRA/pull/7600
[#7602]: https://github.com/LionSR/TeXRA/pull/7602
[#7623]: https://github.com/LionSR/TeXRA/pull/7623
[#7624]: https://github.com/LionSR/TeXRA/pull/7624
[#7914]: https://github.com/LionSR/TeXRA/pull/7914
[#8322]: https://github.com/LionSR/TeXRA/pull/8322
[modelcell-ownership-ruling]: ../proposals/2026-08-01-architecture-rulings-ledger.md#modelcell

Decided by an adversarial design pass (3 designs x 2 lenses, 2026-06-29). This is
the **published boundary** of the gold-standard runtime core
(`2026-06-29-prd-runtime-gold-standard.md`): what `@texra/core` exposes so the three
UIs (extension, desktop, CLI) become thin reference clients and an external consumer
can drive an agent run programmatically. The runtime is the SDK; this PRD is its
surface (Pattern 1: one core, many hosts behind a typed protocol).

The deliverable is **adopt + tier + fence**, not invent: the published in-process
API and the existing `texra run --output-format ndjson` subprocess protocol are the
_same contract_ (the same `runAgent` + `AgentRuntimeHost.emit` event stream, with
`writeNdjsonStdout` the only thing between them), so headless byte-parity becomes the
SDK's correctness guarantee by construction.

**Starting reality (verified in-tree):** `@texra/core` exists but is `private: true`,
ships TS source, and is imported by **zero** of the three UIs. The surface is
aspirational today; this PRD makes it load-bearing.

## The decision

Winner: **C-headless-first as the spine** (the published API == the headless NDJSON
contract), grafted with **A-protocol-discipline** (the runtime is _driven through a
protocol_, never _held as an object graph_ - so `runAgent` is the verb and
`onRun(handle)` exposes the handle; B's embeddable `session.run() -> for await`
centerpiece is rejected because `AgentTrace` is subscribe-only, not async-iterable)
and **B's session/preset primitives minus the leaks** (`SessionHandle` stays the
isolation owner passed via `{ session }`, not a `session.run` god-method).

### The five corrections every design needed (each re-verified in-tree)

1. **A flow-internal type already leaks through the published verb.**
   `RunAgentOptions.onBeforeWaiting: ToolUseBeforeWaitingCallback` is imported from
   `@agent/implementations/flows/tooluse/ToolUseServices` (`runAgent.ts:4,35`). The
   "small sealed verb" transitively re-exports a flow internal. **Re-type it** to an
   SDK-local value-only signature `(interimText?, touchedFiles?) => boolean | void |
Promise<...>`; the internal `runAgent` adapts.
2. **The port's type vocabulary lives in the module to be sealed.**
   `emit<K extends keyof ProgressEventPayloads>` imports `ProgressEventPayloads` from
   `@eventBus/ProgressEventBus` (`AgentRuntimeHost.ts:1`). You cannot publish the
   port and seal the module its types live in. **Promote the type map; seal the
   `bus` singleton.**
3. **Event tiering is doc-only, not type-enforced.** `keyof ProgressEventPayloads`
   publishes all keys including host-worded ones (`requestShowError` = "via VS Code
   notification"): 60 ProgressEventPayloads keys; ~37 Tier-1 runtime + the Tier-2
   host-UI set, split in SDK-1c. **Split the map at the type level.**
4. **`AgentRunHandle` still names `runtimeHost`** (`ExecutionHandle.ts:144-156` is a
   `Pick<...|'runtimeHost'|...>`). A host must not read its own port back off the
   handle. **Author a real interface that drops it.**
5. **The `bus` is dual-purpose with a load-bearing replay buffer**
   (`MAX_BUFFER_SIZE=1000` + replay, `ProgressEventBus.ts:61,294-334`). There is
   **one** `bus`, not two: run emissions go through `SessionHandle.hostChannel` (the
   F-1 fix), while the ~dozen non-run host signals stay on that same `bus` with its
   existing replay buffer. **Seal it by export-fencing** - never exported from any
   subpath, and `@eventBus` added to `check-runtime-boundaries.mjs`'s forbidden
   deep-imports so the run-driver tier cannot reach it. **No second `EventEmitter` /
   replay buffer** (`HostUiBus` is not introduced).

## Package shape

**`@texra/core` IS the SDK. Do not create a new package; do not rename the
workspace.** Renaming to `@texra/agent-sdk` is connascence-of-name churn the patterns
PRD forbids; alias at publish time if a public npm name is wanted. **One package,
layered by subpath `exports`** (every candidate is already in the host-agnostic
`src/` zone and shares one release cadence):

```jsonc
// packages/core/package.json
"exports": {
  ".":          "./dist/index.js",      // Tier 1: run-driver + discovery (semver-stable)
  "./commands": "./dist/commands.js",   // Tier 2: management protocol
  "./node":     "./dist/node.js"        // createNodePlatform preset (opt-in node coupling)
}
```

**Make it real:** drop `private: true`; emit `.js` + `.d.ts`. Because the barrel
re-exports across `@platform`/`@agent/*` path aliases, plain `tsc` won't rewrite
them - needs `tsc-alias`/`tsup`/`rollup-dts` (a concrete sub-task, not free).

**The promotion that unblocks "seal the bus":** move the type map
`ProgressEventPayloads` out of `@eventBus/ProgressEventBus` into a host-neutral
published module, **split into `RuntimeEventPayloads`** (Tier-1 essential streaming)
**and `HostUiEventPayloads`** (Tier-2 frontend-bound: `requestOpenFile`,
`requestShowError`, `requestEnsureProgressView`, `showAgentConfigBanner`,
`*SubscriptionsChanged`, `toolAvailabilityChanged`). The published port keys `emit`
over `RuntimeEventPayloads` only; hosts opt into Tier-2 via an **optional mixin on
the single `AgentRuntimeHost`** keyed over `RuntimeEventPayloads` (the type-map split
already does the tiering - a second named port would serve only `noop`). The runtime
`bus` singleton stays sealed. This converts the two-tier contract from a doc-comment
into a type-level boundary. The single `bus` keeps the ~dozen non-run UI signals with
its existing replay buffer - never exported from any subpath, so explicitly not SDK
surface; no second `EventEmitter` is introduced.

The gold-standard internals (`RunDescriptor`, `ModelCell`, `RoundFlow`, `runRun`,
`RetryPolicy`/`RetryGate`/`PendingRequests`, the routing index, `ToolRunContext`, the
node graph, category sub-schemas, the `bus` singleton) **never export, any subpath** -
matching the gold-standard PRD's internal markings exactly.

## The two halves (the precise type boundary)

A clean inversion of control: one method inbound, one verb outbound.

**Half 1 - what a HOST implements** (inbound sink):

```ts
interface AgentRuntimeHost {
  emit<K extends keyof RuntimeEventPayloads>(
    event: K,
    payload: RuntimeEventPayloads[K],
  ): void;
}
const noopAgentRuntimeHost: AgentRuntimeHost = { emit: () => {} };
```

One method. The type boundary is `RuntimeEventPayloads` (Tier-1, host-neutral - no
`vscode`/Electron/Ink types). A host wanting the frontend group opts into the
optional Tier-2 mixin on the same `AgentRuntimeHost` (no second named port).
`noopAgentRuntimeHost` is a valid host - **headless parity made structural**: the run completes identically with zero subscribers.
Approval/human-input is the outbound counterpart of the same channel: an interactive
host intercepts the `show*`/`resolve*` pairs inside its `emit` body and routes to
`humanInputCommands`/`approvalCommands`; a headless host drops them and policy
auto-decides upstream.

**Half 2 - what the SDK DRIVES** (the run engine):

```ts
runAgent(request: ValidatedExecutionRequest, options: RunAgentOptions): Promise<AgentFlowResult>
```

The SDK owns hops 2-5 (launch builds the internal `RunDescriptor` -> `runRun` ->
`RoundFlow` -> node); the launch vs runRun factoring is owned by the gold-standard
PRD section 6. The consumer touches hop 1 (`emit`) and the `runAgent` call;
everything below is sealed.
Two value-typed observation channels come back, never the machinery:
`AgentRunHandle.result: Promise<ResultEvent>` (**always resolves, never rejects** -
errors-as-values) and `AgentRunHandle.trace` (the `AgentEvent` stream, observed via
`.subscribe`, not `for await`). The handle is delivered via `onRun(handle)`.

Inputs are parsed values (`AgentConfig`, `ValidatedExecutionRequest`,
`RunAgentOptions`); outputs are parsed values (`AgentFlowResult` union, `AgentEvent`,
`ResultEvent`, `AgentRunHandle`). Anything carrying a live handler/client/socket
never crosses - the gold-standard `Svc`(non-serialized) vs `shared`(clone-safe) line
made into a package boundary.

## The published surface (Tier 1, enumerated and small)

```
// Configure / validate (host -> core request contract)
AgentConfigSchema, AgentConfig, AgentConfigPayload, AgentCategory, ExecutionId
validateExecutionRequest, ExecutionRequest, ValidatedExecutionRequest, ExecutionValidationResult
// Run - ONE verb
runAgent, RunAgentOptions
// The host PORT
AgentRuntimeHost, noopAgentRuntimeHost
// The published event TYPE map (Tier-1 streaming keys only)
RuntimeEventPayloads
// The telemetry CHANNEL
AgentTrace, AgentTraceSubscriber, AgentEvent, ResultEvent, TraceEmitter, noopTrace, AgentErrorKind, RunUsageTotals
// Terminal DTO (the union only; category sub-schemas private)
AgentFlowResult, AgentFlowResultSchema
// Control
AgentRunHandle, SessionHandle, defaultSession, SessionHandleInit
// Discover (Tier-1 root only)
loadAgents, getAgent, resolveAgent, getAgentsByCategory, AgentEntry, ResolvedAgent
// Compose (host-neutral only)
initPlatform, platform, tryPlatform, Platform
```

Three surgical edits to today's barrel: re-type `onBeforeWaiting` (correction 1);
author the real `AgentRunHandle` dropping `runtimeHost` (correction 4); do not export
`runAgentStream`/`executeAgent` (the internal dispatcher). **Tier 2**
(`@texra/core/commands`) is the management protocol the UIs lean on more than
`runAgent` itself, **curated not wholesale**: approval / humanInput /
runCoordinator / followUp / resume / history / goal / modelSwitch / a folded `stream`
group (stop / recover-persisted / is-active) / listExecutions / deleteExecution.
Dropped from the barrel (kept deep-importable): `progressViewCommands` (host-UI
surface), the app-feature modules (`textPolish`/`textConnection`/`agentCreator`).
`@texra/core/node` ships `createNodePlatform()` off the Tier-1 root so a
browser/webview embedder never drags node coupling.

## The 3 UIs as reference clients

All three already do the same five-step dance (boot platform -> build validated
request -> construct `AgentRuntimeHost` -> `runAgent` -> drive via `*Commands`).
Adoption = redirect imports to `@texra/core`, author a real `emit`, seal the one
`bus` (export-fence + `@eventBus` forbidden; no `HostUiBus`).

- **CLI - the reference client (least change).** `createCliRuntimeHost` (the `emit`
  switch: approval -> ndjson -> renderer -> logger) **is** the conformance example.
  Deletes the ~9 direct `@eventBus` reaches; routes approval/`ProgressEventPayloads`
  through the session channel and telemetry through `AgentTrace.subscribe` (the two
  vocabularies are disjoint - not a blanket bus->trace swap). Headless uses
  `defaultSession()`; swapping `runExecution.ts:155`'s `runAgent` is byte-neutral.
- **Desktop - the most SDK-correct client.** Per-window `new SessionHandle()` is the
  gold-standard pattern in production. Keeps `DesktopProgressEventBridge` as its
  `emit` transport; deletes residual `bus` touches and the dynamic
  `await import('@agent/runtime/runAgent')`; routes emission through
  `session.hostChannel` so window isolation is honest.
- **Extension (VS Code) - the biggest cleanup.** The headline leak:
  `extensionAgentRuntimeHost = { emit: (e,p) => bus.emit(e,p) }` - a no-op
  pass-through to a process-global, so the typed port carries **zero isolation**
  (two windows would cross-talk). Replace with a host whose `emit` routes to the
  webview transport via a per-session `hostChannel`, **preserving the replay buffer**
  (progress views opened mid-run rely on `MAX_BUFFER_SIZE` catch-up - verify the
  mid-run-open case before deleting the 24 `bus` subscriptions).

`@controllers/*` is reference-client view-orchestration used by only the two
webview/IPC hosts - a deferred `@texra/core/controllers` subpath, explicitly _not_
the SDK proper.

## External-consumer programmatic run

Byte-identical to the path `texra run --output-format ndjson` already uses:

```ts
import { initPlatform, validateExecutionRequest, runAgent } from '@texra/core';
import { createNodePlatform } from '@texra/core/node';

initPlatform(createNodePlatform({ agentsRoot })); // compose once
const v = validateExecutionRequest({ config }); // parse-don't-validate
if (!v.valid) throw new Error(v.message);
const result = await runAgent(v.request, {
  runtimeHost: { emit: (event, payload) => myTransport(event, payload) },
}); // AgentFlowResult
```

Streaming uses `onRun((handle) => handle.trace.subscribe(...))` +
`handle.result.then(...)` (subscribe, not `for await`). **Resource honesty:** a
published-npm consumer gets the barrel but no agent YAML (it ships under
`packages/extension/resources/agents/`), so `runAgent` resolves nothing unless
resources are provisioned. The surface owns this: `createNodePlatform({ agentsRoot })`
or bundle `resources/agents`; until then the "few lines" claim is scoped to a
monorepo/embedder with resources on disk.

## Versioning and the lint as a package-export fence

Tier-1 run-driver + `RuntimeEventPayloads` + Tier-1 DTOs are semver-stable;
`HostUiEventPayloads` is host-UI/unstable (the port doesn't key over it, so
headless/SDK consumers are unaffected by construction). DTOs evolve via Zod
union+transform (new format first, legacy transforms at one entry). **Invariant
across all versions: `config.agent` stays RAW** (the resume-id contract; see
sub-PRD 04).

`check-runtime-boundaries.mjs` is already the executable "host-agnostic = SDK-eligible"
fence (40+ forbidden deep-imports, ~30 deleted-export guards, the
`CORE_PUBLIC_SURFACE_*` check). Two checks the regex lint structurally cannot do,
plus a set of forbidden-specifier additions, turn it into a published boundary:

1. **ts-morph type-alias-leak rule (PREREQUISITE, not parallel).** The regex lint
   cannot see `export type RuntimeTaskState = TaskState` re-exporting an internal
   through an allowed path; **25 of 45 `Runtime*` exports are such aliases** (verified;
   e.g. `streamControl.ts:18`). This gates Tier-2 publication: convert the 25 aliases
   to real projections, and re-type `onBeforeWaiting`, **before** the barrel is
   load-bearing. Until it lands, the green lint is a fiction at the type level. Its
   value is contingent on SDK-1d actually shipping the package (a green alias-leak
   check guards a surface no one imports until then); consolidate its compiler-API
   (`tsc`) program with the boundary + serialization passes into one invocation to
   minimize CI spend.
2. **Import-direction (added to the existing lint, not a new rule/file).** The UIs'
   run-driver tier must import from `@texra/core`, not deep `@agent/runtime/*`; this
   is just **forbidden import specifiers added to `check-runtime-boundaries.mjs`**
   (`@agent/runtime/*` and `@eventBus` for the run-driver tier). Converts the barrel
   from aspirational (today: zero UI imports) to load-bearing.
3. **Serialization + event-tier contract test.** Enforces the gold-standard PRD's
   Svc/shared serialization invariant (its sections 1 and 11): the published wire
   types must be `structuredClone`-safe (no handlers cross). The NDJSON contract
   test (generalize `CliNdjsonRecordContract.vitest`) is the same artifact that
   proves headless parity - pinning the wire format pins the in-process event
   surface.

## Relation and sequencing vs the gold-standard PRD + SDK-7d

The SDK surface is the stable inputs/outputs; the gold-standard PRD churns the
internals behind them - **largely orthogonal and parallelizable.** The surface is
stable _through_ the internal migration (the PRD keeps `runAgent`, the host port, the
result union, the trace channel). Of the gold-standard's five sub-PRDs, only the
persistence-touching ones interact: **§1 `RunDescriptor` Step-1 phase gate IS the
SDK's serialization fence** (co-deliver with lint check 3); **§5 `FlowRecord`
versioning** does the published-DTO Zod union+transform in lockstep (one evolution
story for wire and disk); **§2 ModelCell, §3 retry/coordinators, §4 RoundFlow do NOT
gate the SDK** (sealed behind `modelSwitch`/`runCoordinatorCommands`/the result
union).

**SDK-7d (shipped, PR #5960) - do NOT redo:** it delivered the consolidated runtime,
`AgentRunHandle` (F-2 `onRun`), `defaultSession`, `SessionHandle.dispose()`. Two
inherited debts: **SDK-002 residual** (widen `RunAgentOptions` to the full
`ExecuteAgentOptions` so the one published verb serves the interactive chat path;
`executeAgent` becomes the internal dispatcher); **F-1 host-path session-resolution
trap** (5 host-path `bus.emit` sites fire outside any run ALS, resolving to the
process default session - multi-window residue; fix = `session.hostChannel`, but it
changes headless NDJSON and risks in-process inquiry RPC, so it is a release-noted,
byte-parity-gated, **declinable** decision).

### Sequencing

1. **First / independent of the gold-standard (1a-1c):** (a) the ts-morph
   alias-closure rule + convert the 25 `Runtime*` aliases + re-type `onBeforeWaiting`
   (the acceptance gate); (b) the import-direction specifiers added to
   `check-runtime-boundaries.mjs` + make the 3 UIs consume `@texra/core`; (c) promote
   `ProgressEventPayloads` -> `RuntimeEventPayloads`/`HostUiEventPayloads`, seal the
   one `bus` (export-fence + add `@eventBus` to `check-runtime-boundaries.mjs`; no
   `HostUiBus`), route run emissions through `SessionHandle.hostChannel`, keep non-run
   signals on the one `bus` with its existing replay. 1d (the real `.d.ts` package build via
   `tsc-alias`/`tsup`, drop `private`, subpath `exports`, `createNodePlatform()` at
   `@texra/core/node`, author `AgentRunHandle`) is sequenced last per EXECUTION.md.
2. **In lockstep with PRD Step 1 + Step 5:** the serialization fence + published-DTO
   versioning.
3. **Gated, last:** SDK-002 wrapper-widening (one verb) and F-1 `hostChannel`
   host-path routing - each behind the headless byte-parity gate, with the documented
   option to decline. **Ship single-session embeddable first** (extension/CLI already
   use `defaultSession`); the multi-session isolation _guarantee_ waits on F-1.

## Residual risks (ranked)

1. **Type-level no-leak guarantee is false until the ts-morph rule + `onBeforeWaiting`
   re-type land.** `RunAgentOptions` transitively re-exports a flow internal and
   25/45 `Runtime*` exports alias internals through allowed paths - the regex lint
   passes green while the type surface leaks. Alias-closure is a **prerequisite gate**
   for declaring Tier-1 frozen, not parallel work. Highest risk: it is the no-leak
   premise and it is currently violated.
2. **Bus-seal scope: one `bus`, export-fenced, not a second emitter.** Run emissions
   move to `SessionHandle.hostChannel` (F-1); non-run host signals stay on the one
   `bus` with its existing `MAX_BUFFER_SIZE` replay, reached through host-side wiring,
   not a deep `@eventBus` import from the run-driver tier. Verify progress-view-
   opened-mid-run before deleting subscriptions. Note `src/tools` has grandfathered
   direct `bus.emit` sites (until the gold-standard cleanup migrates them), so adding
   `@eventBus` to the forbidden list and step 1(c) are not fully independent of that
   work.
3. **F-1 multi-session correctness** is unsound until `session.hostChannel` wires the
   5 off-ALS emits; the fix changes headless NDJSON. Ship single-session first; gate
   the guarantee behind the byte-parity test, with the option to decline.
4. **Resource provisioning** for external published consumers (`runAgent` resolves no
   agents without the YAML root). `createNodePlatform({ agentsRoot })` or bundle.
5. **`platform()` process-global ceiling.** `SessionHandle` isolates run/coordinator
   state, not platform host services (`platform()` is singular). Document the ceiling
   next to the `SessionHandle` export. Inherited 7d debt.
6. **`.d.ts`-with-path-aliases build** needs `tsc-alias`/`tsup`; name it a concrete
   sub-task. Gates "real package," not the lint/adoption work.
7. **Tier-2 over-publication.** Curate the `*Commands` to the cross-host verbs all
   three UIs share; everything else stays deep-importable, unpublished.

## Relation to existing documents

- `2026-06-29-prd-runtime-gold-standard.md` - the internal core this publishes. Same
  boundary, opposite sides: the gold-standard deepens inward from `AgentRuntimeHost`;
  this publishes outward from it.
- `2026-06-28-prd-architecture-patterns.md` - the lens (Pattern 1 typed protocol,
  Pattern 3 published DTOs, the boundary lint as fitness function).
- `2026-06-27-prd-runtime-host-decoupling.md` - the boundary of record; this is its
  externalization as a versioned package.
