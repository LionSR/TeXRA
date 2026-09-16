# Agent-SDK readiness — re-verification pass (2026-09-16)

Status: implemented

> **Status:** Verification-only, written 2026-09-16 against branch HEAD
> `fc70d44` (package version `0.41.0`). The scheduled audit routine re-ran the
> standing question — "review the agent core, model handler, logger, and surface
> for unnecessary abstraction and unready surface; design subagent boundaries" —
> against the prior pass
> ([`-08-19`](./2026-08-19-agent-sdk-readiness-reverify.md)) and the TeXRA 1.0
> direction it now sits inside. This pass finds the alignment has **strengthened
> materially**: the single largest tracked structural item (the `ModelHandler`
> god-base) and the entire PocketFlow-derived flow-engine substrate are both
> **gone**, the version-gated `runFact.` retirement **landed on schedule**, and
> the frozen host→`@agent` deep-import width **nearly halved**. Every claim
> carries a `file:line`, config path, `grep` count, or commit, checked at
> `fc70d44`. **No abstraction to remove, nothing to land this pass.**

## 0. Verdict

**The standing verdict holds and has strengthened again: the codebase is
well-aligned with an Agent-SDK shape, no structural refactor is warranted, and
no genuinely redundant abstraction was found to remove.** Since `-08-19` the
tree has not merely held its shape — it has actively shed structure under a
continuous stream of converging simplification and Effect-native-conversion PRs
(e.g. #12623 "delete 24 zero-reference declarations", #12631 `-374` lines,
#12622 `-254` lines, #12620 `-253` lines). A speculative edit into this tree
with the verdict already green would be net-negative; this pass files no code
change.

## 1. What resolved / strengthened since `-08-19` (verified at `fc70d44`)

| Item | `-08-19` state (`391033e`) | `fc70d44` state |
| --- | --- | --- |
| **M-3 `ModelHandler.ts` god-base** | tracked as a ~2,032 LoC "cohesive god-base"; a long-horizon port-narrowing note | **eliminated.** No `ModelHandler` symbol or file exists anywhere in `src/` or `packages/` (`grep -rn "ModelHandler"` → 0 non-test hits; `find … -name ModelHandler.ts` → none). The model path now flows through the `packages/llm` `Model` bound by `runtime/run/modelBinding.ts` (1,010 LoC) and called through the single `runtime/ModelInvoker.ts` service (1,334 LoC), exactly as CLAUDE.md describes. The largest tracked structural item is closed. |
| **PocketFlow flow-engine substrate** | the 2026-09-06 studies proposed replacing the kernel (`src/agent/node/index.ts`), `ToolUseRoundFlow`, `BaseFlowServices`/`CycleServices`, and `runReflectionFlow` bundles with plain Effect programs | **landed.** `src/agent/node/` is gone; `ToolUseRoundFlow.ts`, `CycleServices.ts`, `BaseFlowServices.ts`, `runReflectionFlow.ts` are gone; `grep` for `PocketFlow`/`setServices` → 0 hits. `src/agent/core/` is now `definition/ state/ tools/` only, and `implementations/flows/` holds only `reflection/output/`. Matches the "There is no flow engine" ruling in CLAUDE.md and the [one-run-model](./2026-09-10-one-run-model.md) implemented note. |
| **C-1 `ToolPolicy` single authority** | `ToolPolicy` interface + `readonly toolPolicy` field on `BaseFlowServices` | **still closed, relocated.** With `BaseFlowServices` dissolved, `toolPolicy` is now threaded through the run runtime (`runtime/AgentLaunchContext.ts`, `executeAgent.ts`, `run/AgentRun.ts`, `ToolCall.ts`, `loop/toolUse.ts`, `loop/toolUseDispatch.ts`). Single-authority invariant intact (kernel ratchet `approvalPolicyAuthorityRatchet.vitest.ts` still pins it). |
| **`runFact.` retirement** | gated on v0.41, not yet due at v0.40.3 | **complete.** Version is now `0.41.0` and `grep -rn "runFact\."` → 0 non-test hits. The scheduled retirement landed on time. |
| **Frozen host→`@agent` deep-import width** | cli / desktop / extension = **12 / 10 / 13**; agent **7** | **nearly halved: 5 / 4 / 8**; agent still **7** (`config/ratchets/host-agent-import-baseline.json`). The stated open work — "shrinking the frozen lists" — has progressed hard; no baseline widened. |
| **L-3 dead redaction branch** | closed (`redactSecrets` single-arg) | **still closed.** `redactSecrets(text: string): string` remains single-arg with no options branch (`src/logger/redaction.ts:93`). |
| **L-1 log-only `createChannelTrace` tail** | down to ~7 non-test call sites | **unchanged at 7** (`grep` over `src/`+`packages/`, test-excluded). Still the only genuine small candidate; still low value. |

## 2. What is unchanged, and correctly so (deliberate design, not debt)

- **§6b in-process multi-tenancy.** `runAgent` still treats the platform and
  agent registry as process-wide, composed once at startup
  (`packages/agent/src/index.ts`). A maintainer architecture decision, not a
  fixable seam — do not relitigate.
- **L-2 process-global log sink.** The logger still has no `platform().log`
  port; the sink singletons in `src/logger/logUtils.ts` remain by design. One
  facet of §6b, not an independent blocker.
- **`ModelInvoker` / `modelBinding` size.** At 1,334 / 1,010 LoC these are the
  genuinely-shared model plumbing that absorbed the retired `ModelHandler`'s
  cohesive behavior; they are not pass-through layers and carry real logic
  (retry ownership, route binding, pricing, media). Not a removal candidate.
- **Baselined dead-export headroom.** `config/ratchets/knip-baseline.json`
  carries 181 accepted `production-dead` export findings; the ratchet freezes
  the count shrink-only. This is tracked, shrinking debt (see the recent
  delete-only PRs), not a new abstraction.

## 3. Surface area — tight and SDK-ready

The published Promise boundary `packages/agent/src/index.ts` (314 LoC) exports
exactly: `runAgent`, `closeSession`, `defineTool`, `MapToolRegistry`, the
`RunAgentInput` / `AgentRun` interfaces, and a handful of types. Its docstring's
claim — "the package's Promise surface, and nothing else," every
`Effect.runPromise`/`runFork` confined here — holds on inspection: the file
renders the Effect services in `./effect/*` and adds no domain logic of its own.
No surface-area simplification is warranted; the open surface work is the
forward-looking [Tier-1 public manifest](../../proposed/architecture/2026-09-10-agent-sdk-tier-1-manifest.md),
not a subtraction.

## 4. Subagent boundaries — still already drawn

Unchanged in spirit from `-08-19 §3`. The dispatch boundary
(`delegate_agent` / `delegate_workflow` → subagent execution →
`createNativeSubagentStrategy` → child run loop) remains cleanly drawn and
host-agnostic, and the §6a delegation-cycle lazy imports stay resolved
(`grep "await import(" src/tools/delegation/` → 0). The `runAgent` /
`executeAgent` split (358 / 825 LoC) is the intended launch-vs-owned-execution
seam. Each named carve-out starting point still reaches a concrete runtime
collaborator that a real carve-out would have to convert to an injected port
first — none is a pure relocation today. No new boundary to invent; the
in-flight Effect-native ownership work
([completion protocol](../../proposed/architecture/2026-09-15-effect-native-completion-protocol.md))
is where per-operation project/session/resource lifetimes get made explicit,
which is the prerequisite any future out-of-process carve-out needs.

## 5. Remaining open items (all pre-existing, none a defect)

1. **`HostInteractions` required/optional shape** — open maintainer contract
   decision, not a mechanical cleanup.
2. **Logger → event stream** — surfacing bootstrap/model-routing logs to an
   embedder means extending `AgentEvent`; a proposal, not a churn PR. L-2 is the
   same theme from the sink side.
3. **Further deep-import specifier reduction** continues (now 5/4/8; agent 7)
   but is bounded near the realistic floor by the provider-type-leak constraint.
4. **L-1 tail** — of the 7 `createChannelTrace` call sites, exactly **3** are
   pure log-only shadows that only ever call `.warn`/`.debug`/`.info` and could
   collapse onto `createLog` one at a time:
   `src/agent/runtime/waitingTermination.ts:21`,
   `src/agent/runtime/AgentRunLifecycle.ts:48`, and
   `src/tools/github/PollingSourceBase.ts:230`. The other 4 legitimately back an
   `AgentTrace`-typed field or fallback and are not reducible. Low value; the
   only genuine small candidate left, still not worth a dedicated PR, and
   `channelTrace.ts` documents the adapter as deliberately retained.
5. **`createRunScope` single-caller** (`src/agent/runtime/RunScope.ts:21`) — one
   production caller (`AgentLaunchContext.ts:553`), body is `Object.freeze({
   ...scope })`. Borderline on the single-caller-extraction rule, but the freeze
   enforces a real immutability invariant on an object shared widely
   (`RunContext`, `ToolCall`, delegation tools), so it carries captured intent.
   Optional inline at most; not recommended. Surfaced for completeness.
6. **Tier-1 public manifest** and **npm publication** remain the forward SDK
   work; publication is gated on packaging/legal, not API shape.

## 6. Bottom line for this pass

Nothing to refactor. Between `-08-19` and `fc70d44` the two largest structural
items the audit has tracked — the `ModelHandler` god-base and the PocketFlow
flow-engine substrate — were both fully dissolved by the maintainer's ongoing
Effect-native conversion, the version-gated `runFact.` retirement landed, and
the frozen host-coupling surface nearly halved. The deliberate design decisions
(§6b multi-tenancy, L-2 sink globals) are correctly untouched. This pass lands
no code change; the tree is converging on the SDK shape faster than a
speculative audit edit could help.
