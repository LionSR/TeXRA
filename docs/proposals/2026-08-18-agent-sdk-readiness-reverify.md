# Agent-SDK readiness — re-verification pass, three-area fresh-eyes audit, structural blocker resolved upstream (2026-08-18)

> **Status:** Verification pass, written 2026-08-18, measured at HEAD `f027add`.
> A scheduled audit routine re-ran the standing question — "review the agent
> core, model handler, logger, and surface for unnecessary abstraction and
> unready surface; design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the most recent pass
> ([`-08-15`](./2026-08-15-agent-sdk-readiness-reverify.md)). This pass ran a
> fresh three-area deep audit (one focused reader per area: core, model handlers,
> logger+surface) rather than only re-measuring, re-verified the standing metrics
> at HEAD, and confirmed from source that two of the small candidates the `-08-15`
> pass teed up (L-3, and the §6(a) delegation-cycle blocker) have since landed.
> Every claim carries a `file:line`, config path, or commit, checked at
> `f027add` unless noted.

## 0. Verdict

**The standing verdict holds unchanged: the codebase is well-aligned with an
Agent-SDK shape, no structural refactor is warranted, and no genuinely redundant
abstraction was found to remove.** All three fresh-eyes area audits independently
re-derived that conclusion from source — none found a pass-through layer, a
redundant one-impl interface, or a create-run-interpret wrapper to delete.

What is new in this pass:

1. **A structural blocker resolved upstream since `-08-15`** (§3): the
   `@tools/delegation ↔ executeAgent` import cycle — ranked #1 in the plan of
   record and previously papered by two lazy `await import()` edges — is now
   severed at a single typed injected `AgentEngine` slot. This was `-08-15 §6(a)`.
2. **Both small candidates the `-08-15` pass listed have landed** (§4): L-3 (the
   dead redaction-options branch) is fully removed, and L-1 (parallel
   `createChannelTrace` module singletons) collapsed from ~28 callers to 8 — the
   remainder legitimately `AgentTrace`-typed.
3. **Host import-specifier widths shrank** (§2) while the SDK package stays at its
   floor of 7 — active convergence, not slippage.
4. **The fresh audit surfaced a short list of packaging-scoped observations** (§5)
   — all Tier-1-manifest work gated behind Step 3 of the north-star, none a
   defect, none a change this pass makes.
5. **No code increment landed this pass, by design** (§6): the clean
   invariant-fix increments the cadence would land have already landed this cycle
   (§3, §4), and every remaining candidate is either "leave it" or
   deliberately-gated Step-3 manifest work that must not be executed
   unattended per the north-star's explicit packaging gate.

---

## 1. Scope re-audited

| Area          | Entry points inspected                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Agent core    | `src/agent/core/{definition,state,usage,tools,flows}/`, `src/agent/node/index.ts`, `src/agent/runtime/executeAgent.ts`, `implementations/flows/` |
| Model handler | `src/agent/modelHandlers/**`, `src/agent/types/IModelHandler.ts`, `ModelHandler.ts`, `toolConversion.ts`, `support/`       |
| Logger        | `src/logger/{logUtils,redaction}.ts`, `src/agent/trace/channelTrace.ts`                                                    |
| Surface       | `packages/agent/src/{index,node,schemas}.ts`, `src/agent/runtime/**`, the `@agent/runtime` barrel + `config/ratchets/`     |
| Subagents     | `src/tools/delegation/`, `nativeSubagentStrategy.ts`, `executeAgent.ts`, `childRunLoop.ts`                                 |

## 2. Re-verification — standing metrics at HEAD `f027add`

| Metric                                                      | `-08-15`       | HEAD `f027add`                                            |
| ----------------------------------------------------------- | -------------- | --------------------------------------------------------- |
| SDK package `@agent/*` deep-import specifiers               | 7              | **7** (`config/ratchets/host-agent-import-baseline.json:45-53`) |
| Host specifier width (cli / desktop / extension)            | 18 / 13 / 17   | **12 / 10 / 13** — shrank, not slipping (same ratchet)    |
| `RuntimePresentationEventPayloads` arms (0 phantom)         | 5              | **5** (`runtimePresentationEvents.ts:18-24`)              |
| `platform().log` call sites under `src/agent`               | 0              | **0** (no host log port exists; see §5 logger notes)      |
| Version (governs `runFact.` retirement, due v0.41)          | 0.40.3         | **0.40.3** — retirement not yet due                       |
| Logger core LoC (`logUtils` / `redaction` / `channelTrace`) | 250 / 117 / 82 | **256 / 101 / 82** — `redaction` −16 is the L-3 removal (§4) |

The host-width shrink (cli 18→12, desktop 13→10, extension 17→13) reflects the
converging import-fold work; the SDK package stays at its 7-specifier floor,
which the `-08-15 §4` and the surface audit both confirm is near the realistic
minimum bounded by the provider-type-leak constraint.

## 3. Structural blocker resolved upstream — the delegation ↔ executeAgent cycle

`-08-15 §6(a)` named the `@tools/delegation ↔ executeAgent` cycle the #1
layering/packaging blocker, tracked in
[`2026-08-14-delegation-flow-substrate-consolidation.md`](./2026-08-14-delegation-flow-substrate-consolidation.md),
and noted it was papered at the time by two lazy `await import('./nativeSubagentStrategy.js')`
edges (then at `subagentExecution.ts:203`, `inBandSubagentExecution.ts:400`).

**At HEAD `f027add`, those lazy edges are gone.** `subagentExecution.ts:41` now
statically imports `createNativeSubagentStrategy` directly, and the recursion —
`registry → DelegationTools → proposalFlow → subagentExecution →
nativeSubagentStrategy → executeAgent → runToolUseFlow → registry` — is closed
instead at a single typed injection slot: `nativeSubagentStrategy.ts:72-90`
declares an `AgentEngine` interface (`executeAgent` /
`resumeToolUseFromResumeData` typed via `typeof import('@agent/runtime/executeAgent')`)
provided once by `@agent/runtime/executeAgent` at its own module load. The
inline doc (`nativeSubagentStrategy.ts:62-90`) states the rationale exactly:
"Agents launching agents is inherently recursive; this slot is the single, typed
point where that recursion closes at runtime."

This is the sanctioned resolution — an injected port at the one place the
recursion genuinely closes, not a lazy-import workaround. `grep` for
`await import(` under `src/tools/delegation/` returns nothing. The blocker is
**closed**; verification here, resolution landed in the consolidation work.

## 4. The `-08-15` small candidates have landed

- **L-3 (was the one small defect) — closed.** `-08-15 §4 L-3` flagged that
  `createRedactingSink` called `redactSecrets(message)` with no
  `LogRedactionOptions`, leaving a `homeDir`/`workspacePath` path-scrubbing
  branch (then `redaction.ts:90-114`) permanently dead. At HEAD, `redactSecrets`
  takes **no options parameter at all** (`redaction.ts:81`), and the dead branch
  is gone (`redaction.ts` is now 101 LoC, down 16). `createRedactingSink`
  (`logUtils.ts:61-75`) still calls the single-arg `redactSecrets(message)`, and
  secret-pattern + Bearer + provider-key redaction all still fire
  (`redaction.ts:82-100`). The honest "wire or delete" disposition resolved by
  deletion — the correct choice, since no caller ever supplied the options.
- **L-1 (parallel module-logger factories) — largely converged.** `-08-15 §4 L-1`
  counted ~28 non-test `createChannelTrace` callers duplicating the
  module-singleton role of `createLog`. At HEAD there are **8**
  (`grep createChannelTrace(` non-test). Of the 8, three are legitimately
  `AgentTrace`-typed and cannot narrow to `createLog`'s four-method view — they
  are `?? createChannelTrace(...)` fallbacks into `AgentTrace`-typed fields
  (`childRunLoop.ts:739`, `desktopAgentExecution.ts:208`, `desktopAgentResume.ts:33`).
  The remaining five are plain module singletons (`AgentRunLifecycle.ts:62`,
  `executionRegistry.ts:44`, `AgentLaunchResources.ts:6`,
  `PollingSourceBase.ts:193`, `ProgressViewProvider.ts:102`). L-1 was rated "low
  value; listed for completeness" and remains so — the residual five are a
  per-caller narrowing, not a factory merge, and not worth churn.

## 5. Fresh three-area audit — observations, each dispositioned

None is a defect. Each is a tracked opportunity gated behind the north-star's
Step-3 packaging work (`2026-07-09-agent-sdk-north-star.md:141-147` — "gate: a
real external consumer exists AND R-a/R-b have held"), not a change this pass or
any unattended pass should make.

### Core (`src/agent/core`, `src/agent/node`, `runtime/executeAgent`)

- **Core-1 (borderline, low value): `runReflectionAgent` is a single-caller
  result-mapping wrapper.** `executeAgent.ts:246` (definition), called once at
  `executeAgent.ts:496`. It runs `runReflectionFlow` and maps the raw flow result
  into a `WorkflowFlowResult` — a create-input → run-flow → interpret-result
  shape the single-caller rule (CLAUDE.md; AGENTS.md "Flattening abstraction
  layers") nominally targets. **Disposition: leave.** Its tool-use sibling
  `launchToolUseRun` (`executeAgent.ts:130`) genuinely has two callers (fresh +
  resume) and must stay extracted; inlining only the reflection branch makes the
  two category branches structurally asymmetric, the mapping is real projection
  logic (not identity), and net LoC saved ≈ 0. If ever touched, it belongs in a
  dedicated `simplify:` PR with the repo's net-elements accounting, not a drive-by.
- Confirmed load-bearing (do not re-flag): the local flow engine
  (`node/index.ts`, 271 LoC — sole definition of `BaseNode`/`Node`/`Flow`, every
  override hook has real overriders), `RoundPersistedFlow` (substantive round-loop
  policy subclass), the launch/resume layering (`runAgent`→`executeAgent`→
  `resumeToolUseFromResumeData`, each owning distinct executionId/lease/lineage
  semantics), the three result envelopes (DRY-linked by `.pick()`/`.extend()`,
  each adding data the prior cannot yet have), and all `RunContext` accessors
  (each grepped to live consumers).

### Model handlers (`src/agent/modelHandlers`)

- **M-B1: `toolConversion.ts` is the single convergence point for all four
  provider tool-type surfaces.** `toolConversion.ts:14-30` imports tool/schema
  types from `@anthropic-ai/sdk`, `@google/genai`, and two `openai` submodules —
  all `import type` (erased at runtime), 7 legitimate callers, not
  main-entry-reachable. Not over-shared; flagged only as the highest-density
  provider-type file to keep out of the public declaration graph. **Disposition:
  no change; checklist note for the manifest cut.**
- **M-B2: the public-entry leak guard rests on a hand-documented fragile import.**
  `packages/agent/src/index.ts:18-25` sources `AgentFlowResult` from its module
  path rather than the `@agent/runtime` barrel to avoid pulling the barrel's
  `.d.ts` graph (model handlers → `@anthropic-ai/sdk`) into the published surface.
  Correct and currently holds; `validate-artifacts.mjs:120-132` is the backstop.
  **Disposition: latent tripwire for the packaging owner, not in-scope to fix.**
- **M-B3: `modelHandlerValidation.ts` ships a full canned-output handler in the
  bundle.** A complete ~340-line `ModelHandler` subclass
  (`modelHandlerValidation.ts:128`) routed by `ModelFactory`. A real production
  validation path today, but test-scaffolding-shaped for a *published* SDK.
  **Disposition: consider fencing it with tests when the Tier-1 manifest lands;
  low priority, needs the factory case updated.**
- Confirmed load-bearing: the OpenAI inheritance chain
  (`OpenAICompatibleModelHandler`→`ModelHandlerOpenAI`→`ReasoningModelHandlerOpenAI`→
  concrete, each layer with ≥2 real subclasses + shared logic), `IModelHandler`
  as a `Pick<ModelHandler,…>` erasing the client generic to `unknown` (leak
  prevention, SSOT), the four per-provider `*SdkError.ts` leaves (each isolates
  one SDK import behind the shared `matchMappedSdkError`), and `ModelFactory` (a
  real routing factory, not a pass-through). The `#7101` over-abstraction sweep
  (provider-identity getters removed, `ModelHandler.ts:777-782`) already ran.

### Logger + surface (`src/logger`, `packages/agent`, `src/agent/runtime`)

- **Logger is SDK-clean and not on the surface.** `packages/agent` imports
  `createLog('agentPackage')` for its own bootstrap (`index.ts:29,97`) but never
  re-exports the logger. Sink creation is host-injected
  (`setOutputChannelFactory`, `logUtils.ts:189`) with a `console.info` fallback
  (`logUtils.ts:79-83`) — zero `vscode` coupling; `architecture-edges-baseline`
  confirms `logger` reaches only `shared`+`utils`. The `createLog`
  namespace-indirection (`logUtils.ts:243`) exists to preserve a `vi.spyOn` test
  seam across ~174 sites — a load-bearing test affordance, not action.
- **S-F1 (cheapest available surface reduction, but Step-3-gated):
  `schemas.ts` over-publishes agent-authoring internals.**
  `packages/agent/src/schemas.ts:11-24` publicly exports the five
  `AgentDefinition`/`AgentPrompt`/`AgentSetting`/`AgentToolUseSetting`/
  `AgentWorkflowSetting` schemas + inferred types. The README's embedder story
  (`README.md:28-43`) resolves agents from a disk registry (`resolveAgent`) and
  never asks a consumer to construct an `AgentDefinition`; north-star §4 defers
  definitions-as-values until "a real external consumer asks." So these 10
  authoring symbols are speculative public surface. **Disposition: trim them to
  deep-importable-but-unpublished when the Tier-1 manifest is drawn — a pure
  surface removal on the separate `/schemas` subpath, but manifest work, not an
  unattended now-change.**
- **S-F2 (the only lever that shrinks the frozen 7 further):** a types-only
  `@agent/runtime` sub-entry whose `.d.ts` graph is severed from
  `ModelHandlerContracts` would let the package re-export `AgentFlowResult` /
  `AgentConfig` / `ToolTypes` / `trace` through one narrow public-types door and
  drop 3-4 of the 7 pinned specifiers. A `.d.ts`-graph refactor guarded by
  `validate-artifacts.mjs`; **Step-3 design work, not a churn PR.**
- **S-F3 (accepted, do not extract now): `AgentRunStream`.**
  `packages/agent/src/index.ts:107-223` is a hand-rolled push→pull async-iterator
  adapting `SessionEventHub.subscribe` (subscribe-only) into the public
  `AsyncIterable<AgentEvent>` shape — the sanctioned boundary adapter, covered by
  `AgentPackage.vitest.ts`. It hand-manages deferred promises where `p-defer` is
  already a dependency; but it has exactly one consumer, so extracting it today
  would be the banned single-use extraction (this is `-08-15 §4 S-1`, unchanged).
  **Disposition: when packaging lands, consider a named, independently-tested
  push→pull module using `p-defer`; not before.**

## 6. Increment disposition — none this pass, by design

The prior passes followed a "land one small invariant-aligned increment per pass"
cadence. This pass lands none, and that is the correct outcome, not an omission:

- The clean invariant-fix increments that cadence would target **have already
  landed this cycle** — the §6(a) delegation cycle (§3) and L-3 (§4) both
  resolved upstream since `-08-15`.
- Every remaining candidate is either **"leave it"** (Core-1 — asymmetric,
  net-zero, real logic) or **deliberately-gated Step-3 manifest work**
  (S-F1/S-F2/S-F3, M-B3) that the north-star explicitly holds behind a
  named-external-consumer gate (`2026-07-09-agent-sdk-north-star.md:141-147`) and
  a "no facade / no definitions-as-options before a consumer asks" trap list
  (`:149-159`). Executing any of them unattended would violate both that gate and
  the repo's churn discipline (CLAUDE.md "tests are a budget… churn is friction").

Forcing an increment to match a cadence artifact would be exactly the
manufactured-work the repo's design rules warn against. The honest disposition is
verify + record.

## 7. Subagent boundaries — already drawn; the dispatch seam is now cleaner

Unchanged in shape from `-08-15 §5`, and improved by §3. The dispatch boundary
(`delegate_agent` / `delegate_workflow` → `executeSubagent` →
`createNativeSubagentStrategy` → child-run loop) is cleanly drawn and
host-agnostic, and the two natural subagent boundaries are already first-class
delegation tools (`DelegationTools.ts:1-9`: `delegate_workflow` for workflow
agents, `delegate_agent` for tool-use agents). The §3 resolution makes the
runtime seam between the delegation layer and the execution engine an **explicit
typed injection point** (`AgentEngine`, `nativeSubagentStrategy.ts:72`) rather
than a lazy-import-papered cycle — a strictly cleaner carve-out boundary than the
prior pass could name. As `-08-15 §5` established, the candidate carve-out units
(`childRunLoop`, `executeAgent`/`resumeToolUseFromResumeData`, the helper-model
kit, `resolveAndResumeStream`, `ExecutionSubscriptionBinder`) each still reach
concrete runtime collaborators or an ambient `currentSession()` that a real
extraction must first convert to injected ports. **No new boundary to invent.**

## 8. Do not relitigate; the remaining tracked blockers

- **No `runSession()` facade / SDK wrapper layer** — north-star §5
  (`:154-157`); `-08-14 §6`; the sanctioned mechanism is barrel-fold plus moving
  bookkeeping into `SessionHandle`. Do not resurrect.
- **`HostInteractions` required/optional (north-star TD-2a)** — an open maintainer
  contract decision. Executing it as a mechanical cleanup is retired (it would
  regress the package's tested minimal-host contract, which attaches only 2 of 7
  methods); the contract-shape question itself stays open. Don't re-file as a
  cleanup PR; don't read this as closing it.
- **In-process multi-tenancy constraint (was `-08-15 §6(b)`) — still standing.**
  Two isolated agent instances with *distinct* platforms/registries in one process
  is out of the current design: `runAgent` documents the platform and registry as
  process-wide and throws on a second platform
  (`packages/agent/src/index.ts:228,244-248`); the platform lives in a
  module-global under the once-at-startup composition rule; the process-global
  log-sink/trust singletons (`logUtils.ts:54-57`) are one facet of the same
  constraint. **Concurrent runs sharing one platform** are supported; isolated
  distinct-platform instances would require revisiting the once-at-startup rule —
  a deliberate architecture decision, not a cleanup. With §6(a) now closed, this
  is the single remaining structural SDK blocker, and it is maintainer-scoped.
- **Publication** remains gated on packaging/legal (license/history) plus the
  named-external-consumer gate, not on API shape.

## 9. Summary

The four-area standing verdict is re-confirmed at `f027add` by three independent
fresh-eyes audits: **well-aligned, no structural refactor warranted, nothing
genuinely redundant to remove.** Net motion since `-08-15` is all convergent —
the #1 structural blocker (the delegation cycle) resolved to a typed injection
seam, the one flagged defect (L-3) deleted, L-1 collapsed 28→8, host widths
shrank, SDK package held at its 7-specifier floor. The remaining opportunities
(S-F1 schemas trim, S-F2 types-only sub-entry, M-B3 validation-handler fence) are
Tier-1-manifest work the north-star deliberately gates behind Step 3 and a named
external consumer — correctly not executed by this unattended pass.
