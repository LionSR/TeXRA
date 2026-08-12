# Agent-SDK readiness — scheduled re-verification pass

> **Status:** Verification / reconciliation, written 2026-08-12 at HEAD `a7b1a64`.
> This is **not** a new plan. A scheduled audit routine re-ran the "audit the
> core, model handler, logger, and surface for unnecessary abstraction and
> unready surface" question against the current tree and reconciled the answer
> with the standing plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the prior verification pass
> ([`2026-08-04-agent-sdk-readiness-review.md`](./2026-08-04-agent-sdk-readiness-review.md)).
> Every claim carries a `file:line` or config path, checked at this HEAD by two
> independent read-only audits (runtime/core; model-handlers/logger).

## 0. Verdict

**The `-08-04` verdict still holds: the codebase is already well-aligned with an
Agent-SDK shape. No structural refactor is warranted, and no genuinely redundant
abstraction was found to remove.** This routine performed **no code changes** —
the only structural open item (§3) is a human-review-gated public-API decision,
not an unattended mechanical edit.

Two things are genuinely fresh since `-08-04` and are the reason this note exists:

1. **The deep-import baselines have shrunk** — the Tier-1 program is progressing
   in the correct direction (§2), never widening.
2. **A logger observability gap** for SDK embedders was made concrete (§4). It is
   small and additive, not a defect in existing behavior.

---

## 1. Scope re-audited

| Area          | Entry points inspected                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Agent core    | `src/agent/runtime/{runAgent,executeAgent,SessionHandle,ModelCell,ModelFactory}.ts`, `src/agent/implementations/flows/` |
| Model handler | `src/agent/modelHandlers/ModelHandler.ts`, `src/agent/types/IModelHandler.ts`, provider subclasses                      |
| Logger        | `src/logger/{logUtils,redaction}.ts`, `src/agent/trace/{channelTrace,AgentTrace}.ts`                                    |
| Surface       | `packages/agent/src/{index,schemas,node}.ts`, `config/ratchets/host-agent-import-baseline.json`                         |
| Subagents     | `src/tools/delegation/`, `src/agent/{review,goal,roster}/`, `implementations/flows/agentCreator/`                       |

## 2. Surface drift since `-08-04` — baselines shrinking as designed

Distinct `@agent/*` deep-import specifiers per package
(`config/ratchets/host-agent-import-baseline.json`):

| Package     | `-08-04` | `-08-12` (now) | Δ   |
| ----------- | -------- | -------------- | --- |
| extension   | 39       | **34**         | −5  |
| cli         | 32       | **31**         | −1  |
| desktop     | 25       | **25**         | 0   |
| agent (SDK) | —        | **10**         | —   |

Movement is entirely downward (last touched by #9951, 2026-08-11), which is the
invariant CLAUDE.md pins: _never widen a baseline._ The SDK package's own list is
**10** specifiers, of which — per the runtime audit — **5 are genuine public
contract already re-exported through the barrel** (`AgentConfig`, `AgentDataclass`,
`ToolTypes`, `AgentFlowResult`, `@agent/trace`) and **5 are incidental internal
wiring reached only inside the `runAgent` wrapper body**
(`@agent/index/agentRegistry`, `runtime/SessionHandle`, `runtime/runAgent`, and the
`type`-only `runtime/HostInteractions` + `runtime/ExecutionHandle`,
`packages/agent/src/index.ts:2-12`). Four of those five could be sealed by giving
the runtime one higher-level, public-typed entry that resolves the agent by name,
owns the session, and returns/accepts only public types. That is the concrete
shrink target, unchanged from the north-star.

## 3. Abstraction audit — still nothing redundant to remove

Every layer a generic "collapse the wrappers" pass would flag was checked against
the repo's own guardrails and found load-bearing:

- **Runtime layering `runAgent` → `executeAgent` → `SessionHandle` is earned.**
  `runAgent` (`runAgent.ts:77-225`) assigns `executionId`, registers the run,
  holds the execution lease, and opens workflow output — not a pass-through.
  `executeAgent` has ≥3 distinct production entries (runAgent, subagent
  delegation `nativeSubagentStrategy.ts:39`, CLI resume `executeAgent.ts:499`).
  `SessionHandle` is a composition record that self-documents as _not_ a facade
  (`SessionHandle.ts:3-30`).
- **`ModelHandler` is a genuine provider port**, consumed as the drift-proof
  `Pick<ModelHandler, …>` narrowing `IModelHandler` (`IModelHandler.ts:34`), with
  a real inheritance tree whose 14–55-line leaf subclasses (DashScope, GLM) prove
  the shared logic is reused, not copy-pasted. No unmerged parallel code.
- **The one arguable single-caller extraction**, `applyHelperModelPreference`
  (`helperModelPreference.ts:24`, one production caller `runAgent.ts:101`), carries
  real capability/availability branching and its own vitest — earned under the
  "single-caller extractions banned _unless real logic_" rule, barely. Watch, do
  not rewrite.
- **One borderline indirection to watch, not touch:** the routing round-trip in
  `createModelHandlerForResolvedCompatibilityKey` (`ModelFactory.ts:591-662`)
  re-reads `PROVIDER_HANDLER_ROUTES` that the pure key predicate already consulted.
  The code documents _why_ (`:411-421`: keep pure routing and effectful
  instantiation from drifting) and the async Codex/Kimi overrides can't live in the
  pure predicate. Defensible-but-not-free; revisit only if that cluster is edited
  for another reason.

## 4. Fresh finding — SDK logger observability gap (small, additive)

For an SDK embedder the in-run contract is clean and singular: `AgentRun extends
AsyncIterable<AgentEvent>` (`packages/agent/src/index.ts:69`), one `for await`
over `AgentEvent`. That part is well-aligned.

The gap: **anything logged outside a live run's `AgentTrace` never reaches that
stream.** The logger's sink/redaction layer is coherent and single-owner
(`logUtils.ts:79`, `redaction.ts:86`), but emission is split into the per-run
`AgentEvent` stream vs a process-wide static sink, and several SDK-relevant logs
live only on the sink:

- The package's **own** bootstrap logger is log-only:
  `createChannelTrace('agentPackage')` (`packages/agent/src/index.ts:75`) — its
  release-failure diagnostics (`:278-297`) are invisible to the consumer's
  `AgentRun`.
- **Model-handler routing decisions** log via `@logger/logUtils` directly
  (`ModelFactory.ts` reasoning-override, Codex-subscription, "Using Handler") — an
  embedder iterating `AgentEvent` sees none of the provider-selection reasoning.
- All **28 `createChannelTrace` singletons** in `src` are log-only
  (`channelTrace.ts:37-47`, built on `noopTrace`).

Reachable today only by installing a host `OutputChannelFactory` via
`setOutputChannelFactory` (`logUtils.ts:182`) — a global side-channel, not part of
the per-run stream. **Note:** `platform().log` is _not_ a real surface (grep of
`src/platform/platform.ts` finds no `.log` member); do not plan against it.

Whether embedder-visible bootstrap/routing logs _should_ join the `AgentEvent`
stream is a surface decision for the Tier-1 program, not a defect to hot-fix.

## 5. Subagent boundaries — unchanged from `-08-04` §4

The dispatch boundary (`delegate_agent`/`delegate_workflow` → `executeSubagent` →
`createNativeSubagentStrategy` → `startChildRunLoop`) is already cleanly drawn and
host-agnostic. Already-independent units to promote as-is: `src/tools/delegation/`,
`src/agent/review/` (review→fix pipeline), `agentCreator/agentCreatorFlow.ts`, the
agent-CLI adapters. The two per-run engines (`runReflectionFlow`, `runToolUseFlow`)
and the `goal/` loop remain runtime-coupled — isolating them behind the barrel _is_
the §2 Tier-1 work, not a separate refactor. No change since `-08-04`.

## 6. Actionable items (all pre-existing; none performed by this routine)

1. **Tier-1 barrel, incrementally** (north-star; §2). The barrel
   (`packages/agent/src/index.ts`) is untouched since `-08-04`, so the §3-cluster
   fold-in has not started _in the barrel_, even though other refactors have shrunk
   the host lists. One cluster per PR, shrink the matching baseline. Human-review
   gated — deliberately left to a maintained PR, not an unattended edit.
2. **Stabilize the withheld interaction contract** (`index.ts:42-47`, hard-deny
   `requestRetry` `:234-240`). Unchanged; the next surface decision.
3. **Decide the logger→stream question** (§4). New, small, additive; belongs to the
   Tier-1 surface decision, not a standalone churn PR.

Nothing here is a defect. Items 1–2 are the already-planned north-star work with
current line references; item 3 is this pass's only fresh addition.
