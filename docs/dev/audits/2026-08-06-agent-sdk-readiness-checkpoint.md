# Agent-SDK readiness re-check (agent core · model handler · logger · surface)

> **Status:** Audit note. Written 2026-08-06, figures recomputed at HEAD
> `dfaae1b`. This is a _current-state_ re-measurement, not a new plan. It
> continues the daily checkpoint series — read alongside the prior
> [`2026-08-03-agent-sdk-readiness-checkpoint.md`](./2026-08-03-agent-sdk-readiness-checkpoint.md) —
> and sits under the plan of record
> [`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md)
> and the readiness review
> [`2026-08-04-agent-sdk-readiness-review.md`](../../proposals/2026-08-04-agent-sdk-readiness-review.md).
> Its job is to confirm whether those conclusions still hold and flag what has
> since landed or remains open — nothing here overrides a maintainer ruling.
>
> This pass re-audited the four named areas from scratch (four independent
> read-only sweeps: model handlers, logger/trace, runtime+core, and the
> ratchet fences) rather than trusting the prior verdict. The independent
> sweeps reproduced it. The abstraction inventory and subagent-boundary map in
> §7 are the additive content over the checkpoint series; the rest is
> confirmation.

## Verdict

**Well-aligned. No structural refactor is warranted, and none was made.** The
agent core, model handler, logger, and package surface are already converged on
the Claude-Agent-SDK shape by deliberate, documented work, and the guardrails
that hold them there — the `config/ratchets/` baselines and the free-zone
import fence — are still _tightening_, not slipping (§5). Four from-scratch
sweeps found **zero host coupling** (`vscode` / `packages/*`) in any of the
audited core directories and **no inline-worthy pass-through abstraction**. The
one abstraction nuance that surfaced (the `createChannelTrace` type carries a
mostly-noop event surface) was already considered and accepted as a "minimal
bridge" by the 08-03 checkpoint §4; it is a marginal cleanup, not a defect
(§8).

This matches the standing conclusion of the `-05-30 → -08-04` chain: the open
work is **deciding the product line and shipping the package** — the Tier-1
public manifest, gated on a real external consumer — **not untangling
abstractions**. Re-deriving that here would duplicate ~24 prior docs.

## 1. Surface — `@texra-ai/agent` (`packages/agent/src/index.ts`, 300 LoC)

The public run surface still mirrors the Anthropic `Query` pattern one-for-one:
a single `runAgent(input): AgentRun` (`index.ts:206`) returning an
`AsyncIterable<AgentEvent>` with `.result` and `.interrupt()`. Three entry
points (`.`, `./schemas`, `./node`); `schemas.ts` re-exports ~8 config/dataclass
schemas; `node.ts` supplies the minimal Node `Platform` (139 LoC). Package is
`v0.40.1`, built with `exports`/`files`, **not published** — the publish gate
(north-star Step 3: "a real external consumer exists AND R-a/R-b held") is
still closed by design. Documented limits (approval-requiring tools refused,
interactive retry hard-denies, no resume, no language-model port, local
`agentsDir` only) all degrade loudly, not silently. Clean.

## 2. Agent core + runtime (`src/agent/core`, `src/agent/runtime`)

Cohesive, non-redundant contract. `SessionHandle` is the run aggregate root;
`SessionEventHub` is a filtered one-way fact bus; `AgentRunHandle` is a narrowed
`Pick` view; `AgentFlowResult` is the Zod discriminated flow↔host result
contract. The launch split is **load-bearing, not pass-through**: `runAgent`
(`runAgent.ts:73`, ~8 production callers + the package facade) owns
executionId assignment, register-vs-resume-lease branching, failure
finalization, and artifact-flush/lease-release; `executeAgent`
(`executeAgent.ts:396`, **one** production caller — `nativeSubagentStrategy.ts`)
owns launch-context build + flow dispatch. `runAgentCreator` is correctly a
plain linear async function, not a PocketFlow, per CLAUDE.md. The two thin
category adapters inside `executeAgent` (`launchToolUseRun`, `runReflectionAgent`)
each carry real category-specific wiring and are single-site privates; inlining
would bloat the dispatch body more than it removes — leave unless the dispatch
is refactored anyway. Core dependency direction (`flows → state → definition`)
holds; zero `vscode` / `packages/*` imports.

## 3. Model handlers (`src/agent/modelHandlers`)

All handlers implement `IModelHandler`, a `Pick<>` off the abstract base
`ModelHandler` (16 abstract methods), so the port cannot drift from the base by
construction. The inheritance chain
(`ModelHandler → OpenAICompatibleModelHandler → ModelHandlerOpenAI →
ReasoningModelHandlerOpenAI → {GLM,DeepSeek,Kimi,MiniMax}`) is genuine
template-method with real per-provider content and multiple subclasses at every
level; `getClient → createOpenAIClient` is a legitimate override point
(XAI/Codex call `super`). Every suspected pass-through was grepped and found
multi-caller. The provider registry/`compatibilityKey` switch lives **outside**
the dir in `runtime/ModelFactory.ts`, so all provider branching is centralized
and the handler dir has no self-registration. Zero host coupling — `vscodelm`
reaches Copilot only through the `@platform/languageModel` port. No cleanup
warranted.

## 4. Logger / trace (`src/logger`, `src/agent/trace`)

Two tiers cleanly separated by thin adapters, unchanged since 08-03:

- **Sink tier** — `logUtils.ts`: channel management, redaction, functional
  `debug/info/warn/error` + `createChannelWriter`. Host-agnostic; sink injected
  via `setOutputChannelFactory` with a console fallback.
- **Run tier** — `AgentTrace` / `TraceEmitter`: the run-scoped structured event
  stream (`AgentEvent`), with per-instance `AsyncLocalStorage` stage scope and
  subscriber fault isolation — a genuine value-add, not indirection.
- **Adapters** — `createChannelTrace` (log-only trace over `noopTrace`) and
  `attachChannelSubscriber`. Minimal bridges.

The run-vs-session split is honored (run facts on `AgentEvent`/trace; session
facts on `SessionEventHub`; `src/eventBus/AppSignals` correctly disjoint). The
package's `AgentRunStream` (`index.ts:85`) consumes the **existing**
`SessionEventHub` rail — the same rail the CLI uses — and does not duplicate
`TraceEmitter`/hub machinery. Zero host coupling.

## 5. Fences — the frozen debt is still shrinking

`config/ratchets/` baselines (measured at HEAD):

| Baseline | Freezes | Current |
| --- | --- | --- |
| `host-agent-import-baseline.json` | Distinct `@agent/*` deep-import specifiers per host | **cli 31, desktop 25, extension 39** |
| `shared-schemas-deep-import-baseline.json` | Prod statements past the `@shared/schemas` barrel (forced vs gratuitous) | 746 lines — largest |
| `host-agent-mock-baseline.json` | Host test `mock()` sites pinning `@agent/*` layout | ~40 sites |
| `architecture-edges-baseline.json` | Directed `src/` subsystem import edges (value vs type-only) | ~97 edges |

`cli` sits at **31**, down from the 32 the 08-04 review pinned — the ratchet is
ratcheting down, no regression since 08-03. The de-facto public API remains the
**union of ~52 `@agent/*` deep specifiers** across hosts (16 reached by all
three hosts, `@agent/runtime/*` dominating at 22), against the **one** curated
public entry `runAgent`. That gap *is* the readiness work — and the invariant
holds throughout: **never widen a baseline; every future barrel promotion must
remove a host deep import, not add an unconsumed export.** The correct next
artifact is the Tier-1 manifest, not another lint rule.

## 6. What landed since the 08-03 checkpoint

The 20 commits between the last checkpoint and HEAD `dfaae1b` are UI /
progress-view / CLI / approval fixes plus one Zod-v4 idiom refactor (#9786) and
one launch-wire category unification onto `AgentCategorySchema` (#9740). **None
touches `packages/agent/`, widens a ratchet baseline, or alters the SDK
surface.** The readiness posture is unchanged from 08-03.

## 7. Subagent boundaries (additive — the task's step 4)

The runtime already exposes clean seams where a logical unit could run as an
independent agent. Each is bounded by an existing typed contract, so promoting
it needs no new abstraction — only a facade decision:

| Unit | Natural boundary contract | Notes |
| --- | --- | --- |
| **Flow execution** (`runToolUseFlow`, `runReflectionFlow`) | `AgentFlowResult` | Cleanest seam; the native subagent path (`nativeSubagentStrategy.ts:241`) already runs a flow as an independent agent behind `executeAgent`. |
| **Model handling** (`ModelFactory` / `ModelCell` / `ModelRetryGate`) | `IModelHandler`, injected via `RunContext.modelCell` | Self-contained; a natural standalone unit. |
| **Tool dispatch** (`core/flows/toolUseRound/ToolUseDispatchNode`) | `IToolRegistry` / `ITool` | Already a graph node bounded by the registry. |
| **agentCreator** (`runAgentCreator`) | `AgentCreatorUI` (injected) | Fully host-agnostic linear async unit; already runnable standalone. |

The recommended split point, if/when a subagent SDK surface is pursued, is the
**flow boundary** (`AgentFlowResult`): it is the widest already-uniform contract
and the path native subagents already travel. The model and tool boundaries
(`ModelCell`, `IToolRegistry`) are the next-cleanest and are already injected,
so they can be swapped per subagent without touching flow code. No boundary
requires new indirection — the seams exist; only the public facade is deferred.

## 8. The single cleanup nuance (optional, marginal)

`createChannelTrace` (`src/agent/trace/channelTrace.ts:31`) returns
`{ ...noopTrace, debug, info, warn, error }`, so each of its ~27 module-level
logger call sites nominally carries the full `AgentTrace` type (stages,
streams, subscription, status) while only the four log methods are live. A
`createChannelLogger` returning just `{ debug, info, warn, error }` would drop
the dead event surface from those sites with **no behavioral change**. The
08-03 checkpoint §4 already weighed this and classified `createChannelTrace` as
a "minimal bridge — no redundant layer"; the call depth is thin and the only
cost is type breadth, not runtime indirection. **Recommendation:** defer. It is
a legitimate but low-value tidy that touches ~27 sites for a type-narrowing
gain; it does not move the readiness needle and should ride along with an
unrelated `trace` change rather than be its own churn. Recorded here so the next
checkpoint need not re-derive it.

## Bottom line

Nothing to refactor. The four areas are already SDK-shaped; the guardrails are
tightening; the abstractions all earn their place. The open work is the Tier-1
public manifest and shrinking the frozen host-import list, both gated on a named
external consumer — a product decision, not a cleanup task.
