# Agent-SDK readiness — re-verification pass, four-area deep audit, one landed increment (2026-08-15)

> **Status:** Verification + one landed increment, written 2026-08-15. The area
> metrics and abstraction audit below were measured at parent HEAD `ee56ceb`;
> §3's relocation increment lands on top of it (in this PR's head commit). A
> scheduled audit routine re-ran the standing question — "review the
> agent core, model handler, logger, and surface for unnecessary abstraction and
> unready surface; design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the two most recent passes
> ([`-08-12`](./2026-08-12-agent-sdk-readiness-reverify.md),
> [`-08-14`](./2026-08-14-agent-sdk-readiness-reverify.md)). This pass ran a
> fresh four-area deep audit (one focused reader per area) rather than only
> re-measuring, landed one small invariant-aligned cleanup, and catalogued the
> deep audit's new observations as tracked opportunities. Every claim carries a
> `file:line`, config path, or commit, checked at `ee56ceb` unless noted.

## 0. Verdict

**The standing verdict holds unchanged: the codebase is well-aligned with an
Agent-SDK shape, no structural refactor is warranted, and no genuinely redundant
abstraction was found to remove.** The four-area deep audit independently
re-derived that conclusion from source — it did not find a pass-through layer,
a redundant one-impl interface, or a create-run-interpret wrapper to delete in
any of the four areas.

What is new in this pass:

1. **All `-08-14` metrics re-verify at this HEAD** (§2), one day and a handful of
   converging cleanup commits later.
2. **One increment landed** (§3): relocating a provider-SDK-typed helper out of
   the shared `utils/` tree into its provider directory — a documented-invariant
   fix that also shrinks the provider-type-leak hazard surface.
3. **The deep audit surfaced a short list of genuine, small opportunities** (§4)
   that earlier measurement-only passes had not itemized — chiefly two logger
   observations (parallel module-logger factories; process-global sink state as
   one facet of the process-wide once-at-startup constraint) and one residual
   ambient-ALS read in a core cycle flow. Only L-3 (a dead redaction-options
   branch) is a small defect; the rest are opportunities. Each is dispositioned.
4. **Subagent boundaries remain already-drawn** (§5) — no boundary to newly
   invent; §5 names candidate carve-out starting points, each annotated with the
   concrete runtime coupling it would first have to convert to a port (none is a
   pure relocation).

---

## 1. Scope re-audited

| Area          | Entry points inspected                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Agent core    | `src/agent/core/{definition,state,usage,tools,flows}/`, `src/agent/node/index.ts`, `src/agent/implementations/flows/`        |
| Model handler | `src/agent/modelHandlers/**`, `src/agent/types/IModelHandler.ts`, `ModelHandler.ts`, `src/agent/runtime/ModelFactory.ts`     |
| Logger        | `src/logger/{logUtils,redaction}.ts`, `src/agent/trace/channelTrace.ts` + `AgentTrace`, `src/transcript/StreamLog*.ts`       |
| Surface       | `packages/agent/src/{index,node,schemas}.ts`, `src/agent/runtime/**` (~50 flat files), the `@agent/runtime` barrel + ratchet |
| Subagents     | `src/tools/delegation/`, `src/agent/runtime/childRunLoop.ts`, `executeAgent.ts`, `helperModel.ts`, `resolveAndResumeStream`  |

## 2. Re-verification — every `-08-14` metric still true at HEAD `ee56ceb`

| Metric                                                      | `-08-14`       | HEAD `ee56ceb`                                            |
| ----------------------------------------------------------- | -------------- | --------------------------------------------------------- |
| SDK package `@agent/*` deep-import specifiers               | 7              | **7** (`config/ratchets/host-agent-import-baseline.json`) |
| Host specifier width (cli / desktop / extension)            | 18 / 13 / 17   | **18 / 13 / 17** — frozen, not slipping                   |
| `RuntimePresentationEventPayloads` arms (0 phantom)         | 5              | **5** (`runtimePresentationEvents.ts:17-21`)              |
| `platform().log` call sites under `src/agent`               | 0              | **0** (no host log port exists; see §4 L-2)               |
| Version (governs `runFact.` retirement, due v0.41)          | 0.40.3         | **0.40.3** — retirement not yet due                       |
| Logger core LoC (`logUtils` / `redaction` / `channelTrace`) | 250 / 117 / 82 | **250 / 117 / 82**                                        |

Recent commits to the audited areas are all converging cleanup — retire
resume-blob compat arms (#10286), consolidate prompt-rendering ownership
(#10217), share truncated hex IDs (#10252), extract a shared per-stream
KV-store base (#10335). Nothing regressive touched the surface.

## 3. Increment landed this pass — relocate `openRouterReasoning` out of shared `utils/`

`src/agent/modelHandlers/utils/openRouterReasoning.ts` imported
`@openrouter/sdk/models` (`ReasoningDetailUnion`) while living in the tree the
README designates as "stateless **cross-provider** helpers"
(`modelHandlers/README.md`). Both its consumers are in `openrouter/`
(`modelHandlerOpenRouterNative.ts`, `openRouterStreaming.ts`). It was a
one-provider helper dragging a provider SDK type-import into the shared tree —
the closest existing thing to the provider-type-leak hazard the model-handler
audit flagged (§4 M-2).

**Change:** `git mv` it to `openrouter/openRouterReasoning.ts`; its two
consumers now import `./openRouterReasoning`; the moved file imports the
genuinely-shared engine as `../utils/reasoningDetailsText`. That engine
(`joinReasoningItemsText`) correctly **stays** in `utils/` — it is consumed
cross-family (`openai/modelHandlerMiniMax.ts:5` and the moved OpenRouter helper).

This is a **file relocation, not a new layer** — no wrapper, no re-export shim
(per the repo's anti-shim convention), behavior-preserving. The specifier is not
in any ratchet baseline, so no baseline moves. Touched files: the moved file plus
two import lines.

Verified: `tsc --noEmit` shows zero module-resolution errors across the moved
file and both consumers; the repo's own `npm run typecheck` (`tsc --checkers 8`)
could not run in this container (its pinned TS build rejects `--checkers`), so
verification used a direct `tsc --noEmit`, whose only two diagnostics are the
container's missing `@types/node` / `@types/vscode` type libs — pre-existing and
unrelated to this change.

## 4. New observations from the deep audit — opportunities, each dispositioned

None is a defect (one small exception, L-3). Each is a tracked opportunity, not
a change this pass makes.

### Core (`src/agent/core`, `src/agent/node`)

- **C-1 (highest-value core item): residual ambient-ALS read in the cycle flow.**
  `ResponseCycleFlow.ts:217` (`responseCycleToolsForModel`) still calls
  `useLaunchRunContext()` (ambient `AsyncLocalStorage`) directly. Per the `-07-27`
  checkpoint this is the last surviving ambient read in the **response-cycle**
  flow specifically (that path collapsed 11 → ~1); the **tool-use** flow is not
  ALS-free and its reads must be ported in the same work —
  `runToolUseFlow.ts:181-202` reads both tool-policy fields and
  `ToolUseWaitNode.ts:59` reads `stopAfterCycle` from `useLaunchRunContext()`.
  **The fix is not simply "read from `services.runScope`":** the two
  values the filter at `ResponseCycleFlow.ts:218-223` needs —
  `runtimeUnavailableTools` and `approvalPromptsUnavailable` — are
  `LaunchRunContext` fields (`RunContext.ts:16-18`), not `RunScope` fields
  (`RunScope.ts:13-22` carries identity/session/cancellation only). So C-1 means
  injecting those specific launch-context values as explicit immutable service
  fields (or a small injected tool-policy function), which would make the core
  cycle flow drivable without an ALS frame — the property an SDK embedder wants.
  **Disposition:** the one core item worth scheduling; small, but a real port
  addition, not a one-line substitution.
- **C-2: persisted-flow layer is storage-coupled.** The generic node engine
  (`node/index.ts`) is host-clean, but `node/persistedFlow.ts:8-9` imports the
  concrete `@agent/storage/ExecutionKVStore` and a `FlowTransition` enum value.
  An SDK-grade `PersistedFlow` would be parameterized over a minimal read/write
  port. **Disposition:** latent design note, single KV impl today — low urgency.
- **C-3: fat service bag, partially mitigated.** `AgentCore` (13+ fields) is
  spread wholesale into cycle/round nodes that read 3–9 fields each.
  `ModelInvocationNode` already models the fix (`InvocationServices = Pick<AgentCore,…>`);
  the narrowing is simply not applied to `CycleRunServices` /
  `ResponseCycleServices` / `ToolUseRoundServices`. **Disposition:** the leaky-DI
  surface an embedder feels; tracked in the standing DI-cleanup proposals, not a
  correctness issue.
- Confirmed load-bearing (do not re-flag): the `Node.exec()→createFlow()→run()`
  factories (`createResponseCycleFlow`/`createToolUseRoundFlow`, 1 prod caller +
  direct test consumers — the prescribed shape), `RoundPersistedFlow`,
  `IToolUseSession`, `MapToolRegistry` (public package export), and the
  `AgentCore`/`BaseFlowContextInit` split.

### Logger (`src/logger`, `src/agent/trace`)

- **L-1: two parallel module-logger factories for one need.** `createLog(name)`
  (`logUtils.ts:237`, ~50 callers) and `createChannelTrace(name)`
  (`channelTrace.ts:37`, ~28 non-test callers) both express "a module-level,
  run-less logger keyed by name," funnelling identically through `writeLine` to
  the same sink for the shared (`isAgent:false`) channel. `createChannelTrace` is
  `{...noopTrace, debug/info/warn/error→writer}` — a thin wrapper over
  `createChannelWriter` whose only added behavior is the `INTERNAL` drop. The
  channel abstraction earns its keep for the **agent-run** path
  (`attachChannelSubscriber`, per-run disposable output channel), but for the ~28
  module-level singletons it is `createLog` wearing an `AgentTrace` type.
  **Disposition:** a real duplication the earlier "minimal and single-owner"
  summaries did not itemize — but not a clean factory merge, and **not
  behavior-preserving if done naively.** The two have different return contracts
  (`createChannelTrace` returns a full `AgentTrace` — spreading `noopTrace`,
  suppressing `INTERNAL`, and used by some callers as an `AgentTrace`-typed
  fallback; `createLog` exposes four methods and routes through the module
  namespace so test spies can intercept module-level loggers). The sink is
  already shared through `createChannelWriter`, so the only safe move is
  narrowing the individual `createChannelTrace` callers that use log methods only
  onto `createLog` — a per-caller change, not a merge of the two factories. Low
  value; listed for completeness.
- **L-2: process-global sink state, one facet of the multi-tenancy constraint
  (SDK gap).** `logUtils.ts:50-53`: `channels`, `mainOutputChannel`,
  `outputChannelFactory`, `outputSinksTrusted` are module singletons;
  `setOutputChannelFactory` (`:183`) mutates them process-wide and disposes all
  sinks. Two isolated agent instances in one process cannot hold distinct log
  sinks or distinct trust policy. The trace layer itself is per-instance and
  clean; this is a logging-side instance of the broader once-at-startup
  constraint that also makes the platform/registry process-global (§6(b)) — not
  independently "the" blocker. It also confirms the standing note that **there is no
  `platform().log` port** (`platform.ts:31-34` documents channel logging as
  _not_ a platform member; hosts wire it via `logUtils.setOutputChannelFactory`).
  **Disposition:** a maintainer design decision (per-instance sink registry),
  not a churn PR — aligns with `-08-14 §9.2`; do not plan against `platform().log`.
- **L-3 (small defect worth a note): redaction options dropped at the log sink.**
  `createRedactingSink` (`logUtils.ts:63`) calls `redactSecrets(message)` with no
  `LogRedactionOptions`, so the `homeDir`/`workspacePath` path-scrubbing branch
  (`redaction.ts:90-114`) never fires for output-channel logs; only secret-
  pattern redaction does. The transcript path (`TexraTranscriptRecorder`) also
  passes no options. The path-redaction branch is effectively dead in-repo.
  **Disposition:** either wire the options through or delete the unreachable
  branch — a small honesty fix in the spirit of the repo's "silent degradation
  is a defect" rule, not a leak of live secrets (secret patterns still redact).
- Confirmed clean (do not re-flag): the three channels (`AppSignals`, run-scoped
  `AgentTrace`/`AgentEvent`, the `logUtils` sink) are genuinely distinct;
  `AgentTrace`/`TraceEmitter` are per-instance and SDK-clean; redaction is a
  single `redactSecrets` implementation, not duplicated logic.

### Model handlers (`src/agent/modelHandlers`)

- **M-1: landed this pass** (§3).
- **M-2: leak protection is load-bearing on two non-structural invariants.**
  `packages/agent/scripts/validate-artifacts.mjs:120-132` bans the four provider
  SDKs only from the declaration graph reachable from the main entry. The frozen
  surface stays clean because (a) nothing **main-entry-reachable** statically
  imports the provider handlers — the main-entry path reaches them only through
  dynamic `import()` in `ModelFactory`. (Host-only static value imports do exist
  — e.g. `src/tools/media/audio.ts:6` imports `ModelHandlerOpenAI` — but they sit
  outside the package's main-entry graph, which is exactly why the invariant is
  "absent from the main-entry-reachable graph," not "never statically imported.")
  And (b) `ModelHandler.ts` deliberately keeps itself SDK-free (using a
  `SdkErrorTagger` function type rather than importing SDK error classes). Any
  new static import of a `modelHandler*` file **into a main-entry-reachable
  module**, or a provider SDK type added to `ModelHandler.ts`/`IModelHandler.ts`/
  `ModelHandlerContracts.ts`, would leak and be caught only post-build.
  **Disposition:** enforcement fragility, not a current leak; the §3 relocation
  removed the closest existing hazard. A future lint edge (no provider-SDK import
  under the shared `utils/`/root tree) would harden this.
- **M-3: `ModelHandler.ts` is a ~2,000-line cohesive god-base** with ~30+ picked
  port members on `IModelHandler`. Genuinely shared behavior (compaction,
  continuation, media, usage), but the concentration is the main "smaller verb
  set" liability for an SDK-ideal port. **Disposition:** not a discrete removal;
  a long-horizon port-narrowing note. (An earlier draft suggested changing
  `support/sdkErrorMetadata.ts:9`'s `abstract new (...args: any[]) => Error` to
  `unknown[]`; that is **retracted** — the type is used only as an `instanceof`
  right-hand side, and `unknown[]` would make the concrete provider error classes
  non-assignable to it by constructor-parameter contravariance. `any[]` is the
  correct spelling here; there is no cleanup.)
- Confirmed load-bearing: `IModelHandler` as a `Pick<ModelHandler,…>` + one
  optional method (structurally cannot drift; erases the client generic to
  `unknown` via `RunModelHandler`), the four per-provider SDK-error taggers (each
  isolates its own SDK import), `OpenAICompatibleModelHandler` /
  `ReasoningModelHandlerOpenAI` intermediate bases, and `ModelFactory` (a real
  routing factory, not a pass-through).

### Surface (`packages/agent`, `src/agent/runtime`)

- **S-1 (retracted on the repo's own rule): `AgentRunStream`'s single-consumer
  queue reads as generic plumbing, but do not extract it.**
  `packages/agent/src/index.ts:101-214` (~110 LoC) multiplexes (1) interrupt/
  handle-attach latching, (2) start-**immediately** (the constructor calls
  `start(this)` at `:117-121`) with event _delivery_ beginning on the first
  `next()` — not lazy run start — plus failure propagation, and (3) a hand-rolled
  push→pull buffer (`events[]`/`readers[]`/`push`/
  `closeIterator`/`end`). Concern (3) _looks_ like a standard async-queue, but it
  has exactly one consumer and is coupled to this class's iterator-failure,
  closure, and event-detachment state. Extracting it to a "reusable util" would
  create a single-use abstraction — precisely the extraction the repo bans
  (AGENTS.md "extract only when logic is repeated"; CLAUDE.md "single-caller
  extractions are banned"). **Disposition:** leave as-is; not a tracked
  opportunity. Retained here only as a note that the plumbing is inherent to the
  one consumer, not evidence of duplication.
- **T-1 (retracted — already the prescribed pattern): `AgentFinalResult` is not a
  re-declared parallel union.** A closer read corrects the earlier claim:
  `AgentFinalResult.ts:26-62` already _composes_ each branch from
  `WorkflowFlowResultSchema` / `ToolUseFlowResultSchema` via `.pick()` + `.extend()`
  and infers the type from the discriminated union — the repo's prescribed
  schema-composition pattern (CLAUDE.md Zod §). It deliberately omits the flow
  result's runtime-only fields and adds post-artifact ones (`diffs`, `cost`,
  `structured`) plus category-specific defaults and the `totalCostUsd`→`cost`
  projection. Recasting it as "`AgentFlowResult` ⊕ extension" would _reintroduce_
  the omitted runtime fields and lose those projections — a regression, not a
  consolidation. **Disposition:** no change; the current shape is correct.
  `AgentRunHandle` (`ExecutionHandle.ts:366`) is likewise a `Pick<…>`
  read-projection, not a duplicate result type.
- Confirmed clean: the `@agent/runtime` curated-barrel-vs-direct-import split
  (no `src/agent/**` file imports the barrel; all 57 importers are the three
  hosts + the SDK package), `node.ts`/`schemas.ts` (no incidental complexity),
  and the deliberate `AgentFlowResult`-from-module-path leak workaround
  (`index.ts:25`, documented; see `-08-14 §4` for why it is permanent).

## 5. Subagent boundaries — already drawn; no new boundary to invent

Unchanged from `-08-14 §8`. The dispatch boundary (`delegate_agent` /
`delegate_workflow` → `executeSubagent` → `createNativeSubagentStrategy` →
`startChildRunLoop`) is cleanly drawn and host-agnostic. The deep audit named the
candidate carve-out **starting points** — units that already expose a crisp
boundary. **None is a pure relocation:** every one still reaches concrete runtime
collaborators (storage, lease, delivery, persistence, lifecycle) and/or an
ambient `currentSession()` that a real carve-out must first convert to injected
ports. This section names the boundary and the specific coupling each would have
to port — it is a starting map, not a claim that any unit is extraction-ready
today:

- **`childRunLoop` (`startChildRunLoop`/`ChildRunStrategy`/`ChildRunPorts`)** —
  THE generic subagent-loop engine; consumers (`nativeSubagentStrategy`,
  `detachedChildRun`, `workflowScriptStrategy`, agent-CLI adapters) all live in
  `src/tools/`, though the loop sits in `runtime/`. Boundary: one turn's
  execution → turn result. **Coupling to port first (substantial):** it imports
  concrete `@agent/storage`, `executionLease`, `AgentRunLifecycle`,
  `executionOwnership`, `childRunDelivery` (`deliverChildRunFollowUp`), and
  `childRunDeliveryPersistence` helpers (`childRunLoop.ts:14-46`) and looks up
  `currentSession()` (`:668`). Storage, session, delivery, and lifecycle ports are
  all needed — not the cleanest relocation, the heaviest.
- **`executeAgent` / `resumeToolUseFromResumeData`** — the single-run primitive;
  boundary `(AgentConfig, ExecutionId, SubagentRunOptions) → AgentFlowResult`
  with an `onRun(AgentRunHandle)` hook. `SubagentRunOptions` is explicitly the
  shared subagent contract — the most options-shaped entry, though it too drives
  the runtime registry/lifecycle rather than pure injected ports.
- **Helper-model kit** (`helperModel.ts` `createHelperModelKit` /
  `runHelperModelCompletion`; consumers `sessionDescription`, `textEnhancement`/
  `polishModel`, `textConnection`, agent-creation) — near-isolated auxiliary-LLM
  unit; boundary `(userPrompt, systemPrompt) → text`. **Residual coupling to port
  first:** `createHelperModelKit` defaults its session to `currentSession()`
  (`helperModel.ts:35`) — the ambient default a carve-out must make explicit.
- **`resolveAndResumeStream`** — most of its host variation already lives in
  injected `ResumeStreamPorts`, but it is not yet a finished seam: it still calls
  the storage-coupled `retrieveSessionResumeData` directly
  (`resolveAndResumeStream.ts:102`), which a carve-out must move behind the ports.
- **`ExecutionSubscriptionBinder`** — observer with injectable `registry` /
  `releaseSource` options and a deliberate `currentSession()` fallback
  (`ExecutionSubscriptionBinder.ts:172-173`); boundary `bind(streamId,
executionId)`. **Residual coupling:** it hard-imports and calls `submitFollowUp`
  (`:20`, `:130`) and emits through `currentSession()` (`:139`) — the follow-up
  delivery path is the port still to inject.

## 6. Do not relitigate; the tracked structural blockers

- **No `runSession()` facade / SDK wrapper layer.** The `-08-12` "higher-level
  public-typed entry" proposal conflicts with north-star §5 and was corrected in
  `-08-14 §6`. The sanctioned mechanism is the barrel fold plus moving
  bookkeeping _into_ `SessionHandle`. Do not resurrect the wrapper.
- **TD-2(a) (`HostInteractions` request methods optional): the mechanical
  auto-conversion is retired; the contract decision stays open.** Two things must
  not be conflated. (1) Executing TD-2(a) _as a cleanup_ — flipping the request
  methods to required — is retired: `-08-03 §7` showed it would regress the
  package's tested minimal-host contract (`packages/agent/src/index.ts` attaches
  only 2 of 7 methods and relies on the other 5 gracefully declining), so it is
  not a mechanical churn edit to re-file. (2) The underlying contract-shape
  question is **still open**: north-star §3/§6 still targets converting 6 of 7 to
  required, `-08-14 §9.1` lists it as "Still open," and the runtime interface is
  still all-optional (`HostInteractions.ts:344-390`). That is a deliberate
  maintainer decision, not settled or abandoned here — don't re-file it as a
  cleanup PR, but don't read this doc as closing it either.
- **Two structural SDK blockers, distinct and both already tracked here — not one.**
  (a) The **layering/packaging blocker:** the `@tools/delegation ↔ executeAgent`
  cycle, papered by two lazy `await import('./nativeSubagentStrategy.js')` edges
  (`subagentExecution.ts:203`, `inBandSubagentExecution.ts:400`), ranked #1 in the
  live plan of record
  [`2026-08-14-delegation-flow-substrate-consolidation.md`](./2026-08-14-delegation-flow-substrate-consolidation.md);
  break it there, not here. (b) The **in-process multi-tenancy constraint.** Two
  isolated agent instances with _distinct_ platforms or agent registries in one
  process is **out of the current design**, not merely blocked by a fixable seam:
  `runAgent` documents the platform and agent registry as process-wide and throws
  if a second platform is introduced (`packages/agent/src/index.ts:219-220`,
  `:234-240`), and the platform lives in the module-global `_platform`
  (`platform.ts:59-66`) under the repo's once-at-startup composition rule. The
  process-global log-sink and trust-policy singletons in `logUtils.ts` (§4 L-2)
  are one instance of the same constraint. So the honest scope is: **concurrent
  runs sharing one platform** are supported; **isolated instances with distinct
  platforms** would require revisiting the once-at-startup rule — a deliberate
  architecture decision, not a cleanup. These are distinct from (a); neither is
  the sole "one blocker," and this pass resolves none of them.

## 7. Remaining open items (unchanged from `-08-14 §9`, none a defect)

1. **`HostInteractions` required/optional (north-star TD-2a)** — an open
   maintainer decision (§6): north-star §3/§6 still targets 6-of-7 required and
   `-08-14 §9.1` lists it open; what is retired is executing it as a mechanical
   cleanup, which would regress the package's minimal-host contract.
2. **Logger → event stream** — surfacing the package's bootstrap/model-routing
   logs to an embedder's `AgentRun` means _extending `AgentEvent`_ (routed through
   the event-channel ruling), a proposal not a churn PR. L-2 above is the same
   theme from the sink side.
3. **Further specifier reduction** is bounded by the provider-type-leak constraint
   (`-08-14 §4`) — the remaining 7 are near the realistic floor.
4. **Publication** remains gated on packaging/legal (license/history), not API
   shape.

The genuine small candidates a future pass can pick up one at a time — in the
same land-one-increment cadence this pass followed with §3 — are **C-1** (inject
the launch-context tool-policy fields so the cycle flow — and the tool-use flow's
own ALS reads — run without an ALS frame), **L-1** (narrow the individual
log-only `createChannelTrace` callers onto `createLog` — a per-caller change, not
a factory merge, since the two have different return contracts), and **L-3**
(wire or delete the dead redaction-options branch — the one small defect).
**S-1 and T-1 were retracted on inspection** (§4): S-1 would be a banned
single-use extraction, and T-1 misread an already-composed schema. The two
structural blockers (§6) — the delegation-layer cycle and the process-wide
platform/registry multi-tenancy constraint (of which L-2's logger globals are one
facet) — are maintainer-scoped design decisions, not mechanical increments.
