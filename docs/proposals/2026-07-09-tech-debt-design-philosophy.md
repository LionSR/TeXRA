# Design-philosophy (APoSD) evaluation (2026-07-08)

> **Status:** Open tracking audit (2026-07-08). Companion to [`2026-07-09-tech-debt-audit-runtime-ui.md`](./2026-07-09-tech-debt-audit-runtime-ui.md) and [`2026-07-09-tech-debt-error-ownership.md`](./2026-07-09-tech-debt-error-ownership.md). Applies John Ousterhout's _A Philosophy of Software Design_ as an explicit rubric — module depth (deep vs shallow, Ch4/8), pass-through layers (Ch7), information leakage (Ch5), and combine/separate + deep-injection (Ch9) — over the same runtime/UI/data/flow/storage surface. Headline: the codebase is **not shallow-module-sick**; surviving items are transitional vestiges and single-field/literal duplications, every fix a single-digit-LoC net-deletion that narrows an interface. Re-verify every pin before acting.

---

## Part E — Design-philosophy evaluation (APoSD — A Philosophy of Software Design)

Six design verdicts survived adversarial verification across four APoSD lenses (two further findings, L1 and L2, were retracted 2026-07-10 as fabricated — see below, #7713). The headline: this codebase is **not shallow-module-sick**. The deep abstractions are genuinely deep (discriminated-union fact types, an ALS run-context bridge, a lifecycle-owning interaction slot), and the four largest info-leak smells from prior audits (L4–L7) have already been closed with real deepening, not band-aids. What survives is a thin residue of **transitional vestiges** (Stage-5 migration in flight) and **single-field/single-literal duplications** — every actionable fix is a net-deletion measured in single-digit LoC, and every one _narrows_ an interface toward what the code actually does. The one remaining medium-weight structural cost (fat services bag) is correctly non-actionable: its cure is deletion that hasn't landed yet, not a new abstraction.

### Module-depth scorecard

| Subsystem                                                                         | Depth           | Interface surface vs hidden complexity                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime** (`AgentRuntimeHost` emit contract, `SessionHandle`, `RunContext` ALS) | ok              | Deep ALS bridge + lifecycle core, but the host `emit<K>` port still advertises **6 approval events nothing emits** (`runtimeInteractionEvents.ts:19-40`) — dead interface surface, a Stage-5 vestige narrowing toward removal.                                 |
| **Interactions plane** (`SessionHostInteractions`, `ProgressInteractionHandler`)  | ok              | Thin forwarders that each do _real_ work — optional→total normalization + swap/restore/dispose lifecycle (`HostInteractions.ts:199-270`), a `#7363` disposed-guard (`ProgressBackend.ts:156`). Not pure indirection; one dead field + one inert field to trim. |
| **Facts plane** (`SessionFact`, `ToolResult`, `StreamPhase`, `runFact`)           | **deep**        | Fact-native discriminated unions replaced the old bus-vocabulary leaks (L4/L5/L6/L7 resolved). No surviving residue: `runFactEvents.ts` already routes facts as typed `AgentEvent` arms, no `'runFact.'` literal exists anywhere (L2 retracted, #7713).        |
| **FS/storage stack** (path resolution via ALS `RunContext`)                       | **deep**        | Every tool reads `workingDirectory` through **one** ALS reader; there is no dual bag field to begin with (L1 retracted, #7713). No surviving structural defect.                                                                                                |
| **PocketFlow flows** (ToolUse Prepare/Cycle/Wait, `ToolUseServices`)              | SHALLOW-leaning | Fat ~27-field services bag, ~74% unread per node (`ToolUseServices.ts:14-42`) — a genuine shallow/leaky parameter object. But the Prepare/Cycle/Wait temporal split + shared-store round-trip is **framework-idiomatic**; only a dead field is actionable.     |
| **Agents layer** (`AgentLaunchContext` assemble/bridge, YAML agents)              | **deep**        | Single-owner construction boundary: `agentContextToRunContext` resolves run-identity facts once into the ALS (`AgentLaunchContext.ts:138-163`). Protect.                                                                                                       |

---

### Shallow modules (Ch4/8)

**SHALLOW-1 — 6 `show*` approval events sit on the core `AgentRuntimeHost.emit` contract but are never emitted through it.** _(PLAUSIBLE, low, dead interface surface.)_

- **Verdict / measurement.** `runtimeInteractionEvents.ts:19-40` declares an 11-arm interface unioned into the `emit<K>` host port (`AgentRuntimeHost.ts:29-36`). A whole-repo non-test `.emit(` grep proves **zero** production emits of `showBashPermission / showPlanApproval / showAgentProposal / showRetryRequest / showUserQuestion / showExternalInquiry` — the tools that once emitted them now resolve via `HostInteractions` methods (`UserQuestionTool.ts:74`, `ExternalInquiryTool.ts:422`, `bashApproval.ts:102`, `PlanTool.ts:259`, `proposalFlow.ts:159`, `RetryState.ts:274`). Interface advertises 6 approval obligations; hidden production behavior is 0. An SDK embedder reading `emit` sees 6 events the runtime never produces.
- **Mechanism.** The approval _delivery_ path is being deprecated in favor of the `HostInteractions` port, but the emit arms remain on the SDK host contract. The event _vocabulary_ is legitimately shared — the CLI derives from it via `satisfies keyof RuntimeInteractionEventPayloads` (`approvalEvents.ts:6-30`), and the live headless dispatch keys on 4 of the names (`decideApprovalEvent<K>`, `approvalAdapter.ts:232-273` ← `runExecution.ts:170`).
- **Fix (net-delete, deepens).** Only the safe slice is a clean deletion **today**: drop the unreachable `showExternalInquiry` / `showUserQuestion` branches from `handleCliApprovalEvent` (`approvalAdapter.ts:294-321`, wired at `runtimeHost.ts:73-85`) — nothing emits them, human-input now flows through `HostInteractions.askUserQuestion/openExternalInquiry` (~−20 LoC). This narrows the emit contract toward what it actually produces. Otherwise **defer** to the in-flight Stage-5 migration that owns this surface (`df315c206` #7591, `1edb66c16`, `00738b544`, `fb6618f81` #7610 are all narrowing it).
- **REJECTED TRAP.** Do **not** "purely delete" the 4 decision arms from the core interface — the live headless `decideApprovalEvent<K extends CliDecisionApprovalEvent>(event, payload: RuntimeInteractionEventPayloads[K])` needs the event-name→payload-type map, so deletion forces a **CLI-local `CliApprovalEventPayloads`** map — the exact trap. The vocabulary stays shared, source-of-truth in `RuntimeInteractionEventPayloads`; it did not "leak up" from the CLI.

**SHALLOW-2 — `SessionHostInteractions` re-declares the `HostInteractions` surface as 9 one-line forwards.** _(PLAUSIBLE, low, documented-better-solution — defer.)_

- **Verdict / measurement.** `HostInteractions.ts:196-271`: 11 public methods, 9 single-line forwards; real logic only in `use()` (`:199-209`) and `dispose()` (`:267-270`). Interface width = full `HostInteractions`; apparent hidden logic = ~0 per forward. **But** the forwarding buys three real abstraction changes, not indirection: (1) **optional→total normalization** — interface methods are optional (`requestBashApproval?()`, `:151-183`), the class makes them total, which is _why_ 3 call sites call bare without optional chaining (`PlanTool.ts:259`, `proposalFlow.ts:159`, `RetryState.ts:274`); (2) a **stable readonly per-session slot** (`SessionHandle.ts:140`) hosts swap under via `use()` without callers re-fetching; (3) **swap/restore + dispose lifecycle**.
- **Fix.** **Defer** (the finding defers its own fix). Collapsing to a settable field would _net-add_ optional chaining to the 3 bare sites and re-implement swap-to-previous host-side — a net-add, not a deletion. Revisit post-migration; if the slot is no longer load-bearing, delete the forwarder and let callers hold `HostInteractions` with the noop default.
- **REJECTED TRAP.** Do **not** swap forwarding for a `Proxy` or a generic delegating base class (one indirection for another), and do **not** collapse it mid-migration — it is the documented device that avoids threading a mutable host callback through every run-construction path.

---

### Pass-through layers (Ch7)

**PT-2 — `SessionHandle.useHostInteractions` is a one-line pass-through that violates the class's own "no per-concern methods" contract.** _(CONFIRMED, low — clean net-delete.)_

- **Verdict / measurement.** `SessionHandle.ts:148-150`: `useHostInteractions(interactions){ return this.interactions.use(interactions); }` — identical param type, identical disposer return, identical abstraction as the delegate; nothing hidden. `interactions` is already a public readonly field (`:103`), so `session.interactions.use(...)` is directly reachable, and the class doc (`:4-7`) explicitly promises it "re-exposes no per-concern methods … `session.interactions.x(...)`". This is the **lone** violation — every other public method (`flushPendingTraces`, `onResult`, `attachRunTrace`, `publishRunEvent`, `dispose`) is genuine session-level logic. The real owner is `SessionHostInteractions.use` (`HostInteractions.ts:199-209`, real save/restore/dispose-stack semantics).
- **Fix (net-delete, deepens).** Delete the method; retarget all **13 callers** (4 prod: `ProgressViewProvider.ts:171`, `chatSessionController.ts:234`, `runExecution.ts:169`, `desktopAgentExecution.ts:255`; ~9 test) to `session.interactions.use(...)` — exactly the vocabulary the doc prescribes (today `.interactions.use(` has zero callers besides the wrapper). Net ≈ −3 LoC, −1 method, 0 net at call sites; makes the module self-consistent.
- **REJECTED TRAP.** Do **not** "fix" the inconsistency by adding matching per-concern forwarders for `executions`/`status`/etc. — that grows the facade the doc warns against. Delete the one outlier.

**PT-1 — `ProgressBackend.handleInteractionEvent` → `ProgressInteractionHandler` is a same-signature hop with an inert registration field.** _(PLAUSIBLE, low — simplification, not a fold.)_

- **Verdict / measurement.** The hop `ProgressBackend.ts:157` → `ProgressInteractionHandler.handleInteractionEvent` is byte-identical in signature, **but the caller is not a null forward** — it adds a real `disposed` guard with a `#7363` rationale (`:156`). The class interface is genuinely small (ctor + 1 method; registration types at `:50/:62` are **unexported/internal**), so APoSD scores it deep-ish, not "large interface." The over-engineering is carried-over machinery: `module:'ProgressInteractionHandler'` on all 4 registrations (`:77,82,88,97`) is **identical to the `:117` fallback** (inert), and `ProgressViewProvider.interactionHandler` (`:84` decl, `:154` assign) is **never read**.
- **Fix (simplification-only, deepens).** Delete the inert `module` field from the 4 registrations and hardcode the constant at the dispatch site; delete the dead `ProgressViewProvider.interactionHandler` field (≈ −6 LoC, no structural change, no test rewrite). Keep the class, the disposed guard, and the exported `UICallbacks`/`ProgressBackendInteractionEvent`/payloads (hosts import them).
- **REJECTED TRAP.** Do **not** introduce a generic event-registry abstraction to "reuse" the registration+error-context pattern (a layer for 4 fixed events), and do **not** rush a full fold-back — it would reverse a deliberate one-day-old net-negative-LoC refactor (`82dfdc6ab` retired the 189-line `ProgressEventHandler`) and rewrite ~7 test spy sites on `backend.interactionHandler` for marginal gain.

---

### Information leakage (Ch5)

**L1 — RETRACTED — fabricated `workingDirectory` dual-carrier claim (#7713).**

- **Correction (2026-07-10, #7713).** This finding claimed `workingDirectory`
  was declared on both `AgentCore` (`BaseFlowServices.ts:45`) and `RunContext`,
  bridged by a manual copy at `AgentLaunchContext.ts:163/474`. Verified
  independently at HEAD: `BaseFlowServices.ts` is 35 lines total and its
  `AgentCore`/`BaseFlowContextInit` interfaces have no `workingDirectory` field
  — the field exists only on `AgentConfig` (`AgentConfig.ts:38`) and on
  `RunContext`/`RunScope` (`RunContext.ts:30,62`, `RunScope.ts:19`), not on the
  flow-services bag. There is no bag↔RunContext dual for this field and nothing
  to delete. Retracted in full — see `B2` in the companion runtime/UI audit
  for the (corrected) list of fields that genuinely are dual-declared on the
  bag.

**L2 — RETRACTED — fabricated `'runFact.'` domain-key protocol claim (#7713).**

- **Correction (2026-07-10, #7713).** This finding claimed `runFactEvents.ts:19`
  owns `RUN_FACT_DOMAIN_PREFIX='runFact.'` (with `toRunFactDomainKey`/
  `fromRunFactDomainKey` helpers at `:45-57`) and that `TexraTranscriptRecorder.ts:40`
  re-declares it. Verified independently at origin/main `4363b4089` (2026-07-10): `runFactEvents.ts` is 34
  lines, exports only `RunFactPayloads`/`RunFactEventName`/`emitRunFact`, and
  has no such constant, helpers, or `'runFact.'` string — its header comment
  says run facts "ride the run trace as explicit `AgentEvent` arms" and
  "producers no longer encode them through the `domain` escape hatch."
  `TexraTranscriptRecorder.ts:40` is `function asMessageType(...)`, unrelated.
  Retracted in full — see A13 in the companion runtime/UI audit for the same
  correction.

**L3 — temporal decomposition in the ToolUse node family (Prepare/Cycle/Wait share a nullable bag with a runtime `prepared` assertion; snapshot (de)serialization duplicated across siblings).** _(PLAUSIBLE, low — observation real, no clean fix.)_

- **Verdict / measurement.** `types.ts:45` `stateSlices: … | null`; `:105-111` `assertPreparedShared` throws "PrepareNode must run before CycleNode"; the workspace snapshot round-trip appears in `ToolUsePrepareNode.ts:166-170` (`toSnapshot`), `ToolUseCycleNode.ts:45-50` (`fromSnapshot`), `:167-174` (`toSnapshot`). The split-by-execution-phase and shared-knowledge smear are real.
- **Fix.** **None with net-negative confidence.** The proposed "`PreparedShared` flows into Cycle/Wait, remove the null arm + `assertPreparedShared`" is **not a deletion**: all three nodes are one uniform `Node<ToolUseRunShared>` graph (`runToolUseFlow.ts:378-385`), entered with `stateSlices: null` at `prepareNode` (`:312-317`); re-typing Cycle/Wait on `PreparedShared` needs a sub-flow split. `PreparedShared` already exists (`types.ts:90-92`) and `assertPreparedShared` narrowing **is** the idiomatic single-store handling. The snapshot round-trip is PocketFlow's serialize-between-nodes-for-resume design (`:399-403`), not smeared domain knowledge.
- **REJECTED TRAP.** Do **not** merge Prepare/Cycle/Wait into one node or add an orchestration layer (net-add, fights PocketFlow's per-node engine). Reject the stated fix as-is — it requires exactly that forbidden sub-flow split.

---

### Combine / separate + deep-injection (Ch9)

**DI-1 — flow service bags (`ToolUseServices` / `CycleServices` via `AgentCore`) are a fat, mostly-unread, leaky interface threaded through every node.** _(CONFIRMED, low. Overlaps the dual-state pass — see below.)_

- **Verdict / measurement.** `AgentCore` = 11 fields (`BaseFlowServices.ts:36-51`), `BaseFlowContextInit` adds 4 (`:59-64`), `ToolUseServices` adds 12 → **~27 fields** (`ToolUseServices.ts:14-42`). One wide immutable object is spread (`...this.services`, `ToolUseCycleNode.ts:83`) into each inner flow and handed unchanged to every node; each node reads a small, different subset (~74% unread per node). Interface exposed = ~27; per-node benefit = a handful. This is the standard shared-DI trade-off — a design **cost**, not a defect, and correctly downgraded to non-actionable except for one field.
- **Fix (net-delete only, deepens).** Delete `ToolUseServices.ts:24` `attachedMemoryMisses?` (never assigned to a production `ToolUseServices` — `runToolUseFlow.ts:176` builds via `...input`, and `RunToolUseFlowInput` `:61-87` has no such field; never read as `services.attachedMemoryMisses` — every real read is `ctx.attachedMemoryMisses` on `AgentLaunchContext`) and its now-unused import at `:7`. Optionally clean the stale test-cast at `ToolUseWaitNode.vitest.ts:49`. Net −2 lines, −1 exported field, −1 import.
- **REJECTED TRAP.** Do **not** introduce a single frozen `RunScope` object or ISP-narrowed per-node service interfaces (#6945-style). Both net-add types/construction, and `RunScope` is a new DI layer the maintainer has explicitly rejected (**No deep injection**). Confirmed correct to reject.
- **Overlap.** `dual_state: true` — the fat-bag/duplicate-carrier concern is shared with the dual-state pass; dedup there, keep the shallow/leaky-interface DESIGN framing here.

---

### Deep modules to protect (verified healthy — do not churn)

These carried the load in verification and must survive the fixes above:

- **`agentContextToRunContext` / `AgentLaunchContext` assemble-and-bridge** (`AgentLaunchContext.ts:138-163`) — the single-owner construction boundary that resolves run-identity facts **once** into the ALS; do not merge scopes into it.
- **`RunContext` ALS** (`RunContext.ts:221-227` `useLaunchRunContext`) — ambient tool context, a _distinct_ scope from the services bag. Tools reading `ctx.*` directly is correct, not a leak.
- **`SessionHostInteractions.use` / lifecycle** (`HostInteractions.ts:199-209,267-270`) — real save/restore/dispose-stack semantics; the total-method normalization is why 3 call sites drop optional chaining. Keep even while trimming the forwarders around it.
- **`hostInteractionResultMappers.ts`** (107 LoC) — the shared per-host result mapping, correctly deduped after the `*Coordinator` siblings were deleted (#7316; SHALLOW-3 resolved). Do **not** re-abstract the 3 genuinely-divergent per-host impls into a shared coordinator base.
- **`SessionFact` discriminated union** (`SessionEventHub`) — fact-native named payloads (`GoalStateChangedPayload`, `ClearMissingOutputsPayload`, …); zero `ProgressEventPayloads` leak remains (L4 resolved). Host projections derive from these names, never the reverse.
- **`ToolResultSchema` discriminated union** (`toolResult.ts:141-180`) — `status:'executed'` (error `z.undefined()`) vs `status:'error'` (error `z.string().min(1)`); the explicit discriminator is the deep fix for the old all-optional loose object (L5 resolved).
- **`StreamPhase` IPC projection** (`outbound.ts:117-122`) — the 5-value projection at the webview boundary replaced the 7-value `StreamStatus` leak (L6 lens-resolved; residual raw-enum frontend imports are a correctness-pass handoff, not a leakage-lens defect).
- **`runFactEvents.ts` encoder module** (34 lines) — run facts already ride the run trace as typed `AgentEvent` arms via `emitRunFact`; no `'runFact.'` string protocol exists to relocate (L2 retracted, #7713).
- **PocketFlow per-node prep/exec/post + shared-store serialize-for-resume model** (`runToolUseFlow.ts:378-403`; structural `kind:'round'` carried from `ToolUseCycleNode.ts:116-122`, L7 resolved) — the ToolUse temporal split is framework-idiomatic; the `PreparedShared` narrowing is the intended single-store idiom. Do not restructure into sub-flows.

---
