# Agent-SDK readiness re-check + R-b ratchet repair (agent core · model handler · logger · surface)

> **Status:** Audit note with one applied fix. Written 2026-08-05, all figures
> recomputed at HEAD `f8ca82a` (confirmed `== origin/main` after a fresh
> fetch). Continues the daily checkpoint series — read alongside the immediately
> prior [`2026-08-03-agent-sdk-readiness-checkpoint.md`](./2026-08-03-agent-sdk-readiness-checkpoint.md)
> and the verification pass [`../../proposals/2026-08-04-agent-sdk-readiness-review.md`](../../proposals/2026-08-04-agent-sdk-readiness-review.md) —
> under the plan of record [`../../proposals/2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md).
> Its job is to confirm whether the standing conclusions still hold and flag what
> has moved. Nothing here overrides a maintainer ruling.
>
> **Unlike every prior entry in this series, this one made a code change** — but
> not a structural refactor. It repairs a **broken `R-b` deep-import ratchet**
> that shipped to `main` (§1). The four audited areas are otherwise reconfirmed
> aligned; no abstraction was removed.

## Verdict

**Well-aligned, unchanged from the standing chain — with one real defect found
and fixed.** Agent core, model handler, logger, and the package surface remain
converged on the Claude-Agent-SDK shape by deliberate, documented work; no
structural refactor is warranted and none was made. The one genuinely actionable
finding this pass surfaced is not an abstraction to delete but a **guardrail that
had silently gone red**: PR #9724 added a new `@agent/*` deep import to the CLI
host without updating `config/ratchets/host-agent-import-baseline.json`, so the
`hostAgentDeepImportRatchet.vitest.ts` suite fails at HEAD. This checkpoint
reconciles the baseline with reality (§1). The remaining open work is the same as
the July/August chain named: the Tier-1 public manifest and bootstrap-tax
shrink — packaging, not internal complexity.

---

## 1. Applied fix — the `R-b` host deep-import ratchet is red on `main`

**Finding (verified by replicating the ratchet's own AST scan at HEAD).** The
`R-b` width ratchet
(`src/test-kernel/architecture/hostAgentDeepImportRatchet.vitest.ts`) asserts, per
host, that the count of distinct `@agent/*` deep-import specifiers does not exceed
the checked-in baseline. Recomputing the live sets with the same TypeScript AST
extraction the test uses (import/export/dynamic-import/require string literals
matching `^@agent/`, over `.ts/.tsx/.mts/.cts` minus `.d.ts`; there are **no**
`.mts/.cts` host files, so a `.ts/.tsx` scan is exact):

| Host      | Baseline (before) | Live at HEAD | State                                                            |
| --------- | ----------------- | ------------ | --------------------------------------------------------------- |
| cli       | 31                | **32**       | **RED** — `32 > 31`; test fails                                 |
| desktop   | 25                | 25           | green, but baseline membership stale (see below)                |
| extension | 39                | 34           | green, 5 stale entries of slack                                 |

Root cause of the red: `packages/cli/src/runtime/enabledModels.ts:10` imports
`resolveEffectiveHelperModel` from `@agent/runtime/helperModelName` (added by
#9724, `e31baa2`, which touched `enabledModels.ts` `+133` lines but did **not**
touch the baseline JSON). That specifier is **already baselined for desktop and
extension** — only the cli list was missing it. `resolveEffectiveHelperModel` is
not re-exported by the `@agent/index` barrel, so there is no non-deep path today.

Two adjacent inaccuracies the count-only ratchet did not catch:

- **desktop** silently _swapped_ one deep import for another — it dropped
  `@agent/storage/detectWaitingStreams` and added `@agent/runtime/textEnhancement`
  (`packages/desktop/src/main/desktopAgentExecution.ts:18`). Count stayed 25, so
  `25 ≤ 25` passed, but the baseline listed a phantom and omitted a real import.
- **extension** carries 5 baseline entries no longer imported anywhere in its
  source: `@agent/modelHandlers/openai/modelHandlerOpenAI`,
  `@agent/runtime/agentLoad`, `@agent/runtime/textConnection`,
  `@agent/storage/detectWaitingStreams`, `@agent/utils/agentConfigToTaskState`.
  The ratchet fails only on _growth_, so this slack is tolerated but lets 5 new
  deep imports slip in undetected.

**Fix applied (this checkpoint):** reconcile all three host lists in
`config/ratchets/host-agent-import-baseline.json` to exactly equal the current
live sets — cli `31→32` (unblocks the red suite), desktop `25→25` (swap phantom
for the real import), extension `39→34` (drop the 5 stale entries, tightening the
ratchet to zero slack). This is precisely the reconciliation the baseline's own
docstring invites ("a decrease … is welcome and should shrink this file"), keeps
the sorted-and-unique invariant the second `it` asserts, and widens nothing beyond
the already-merged cli import. Post-fix, every host baseline exactly matches live
(over = none, prunable = none), so the ratchet passes with no remaining slack.

> **Strategically-cleaner alternative, deferred (Tier-1 work, not this PR):**
> promote `resolveEffectiveHelperModel` behind the `@agent/index` (or a Tier-1)
> barrel and migrate cli/desktop/extension off the `@agent/runtime/helperModelName`
> deep import, which would _shrink_ all three lists instead of pinning the import.
> That is the north-star program (§3), not an autonomous ratchet repair.

---

## 2. Abstraction audit — reconfirmed, nothing redundant to remove

A fresh four-area sweep reached the same verdict as the `-05-30 → -08-04` chain.
Each layer a generic "collapse the wrappers" pass would flag was checked against
the repo's own guardrails (single-owner, anti-shim, "factories need multiple
callers") and is load-bearing.

### 2.1 Agent core & runtime — sound

Execution path is `runAgent → executeAgent → runFlowWithLifecycle → flow`
(4 hops), each owning a **distinct, non-overlapping** concern — no pass-through:

- `runAgent` (`runtime/runAgent.ts:73`) owns executionId assignment,
  fresh-vs-resume registration/lease, artifact-flush ordering, and multi-error
  finalize — not a thin wrapper over `executeAgent`.
- `executeAgent` (`runtime/executeAgent.ts:396`) owns launch-context construction,
  ambient `RunContext` install (ALS), category dispatch, and the WAITING guard.
- `runFlowWithLifecycle` (`runtime/AgentRunLifecycle.ts:409`) owns registry
  tracking, stream-status transitions, exactly-once terminal finalize, and
  disposal (~360 LoC of invariants).
- The `AgentFlowResult → AgentRuntimeFlowResult → AgentFinalResult` chain is
  progressive enrichment across three real boundaries (flow output / runtime
  result / delegation-stable result), each adding fields from a different source
  — not a redundant envelope.

Two **debatable** (not clear-cut) candidates, flagged honestly, neither a
must-fix:

1. `createRunScope` (`runtime/RunScope.ts:25`) — **1 production caller**
   (`AgentLaunchContext.ts:397`) over a one-line `Object.freeze`. Its value is the
   documented immutability invariant + a shared test constructor; the weakest-
   justified factory in the area.
2. The single-implementer `ExecutionHandle` interface
   (`runtime/ExecutionHandle.ts:30-36`) — the registry types its map/callbacks as
   `ExecutionHandle` but re-narrows to the concrete `AgentExecutionHandle` via
   `instanceof` at ~15 sites (`executionRegistry.ts`), so it is not currently
   earning polymorphism. Defensible as a decoupling seam; real but arguable.

### 2.2 Model handler — sound, with one delete-candidate port

`abstract class ModelHandler` (2018 LoC) is genuine provider polymorphism —
5 full concrete subclasses (anthropic/google/openrouter/vscodelm/openai), real
shared machinery delegated to collaborators (`MediaAttachmentProcessor`,
`ResponseTextProcessing`, `support/*`), and template-method hooks each overridden
by ≥2 providers. The OpenAI-compatible subclasses encode real wire-format
divergence (separate reasoning channels, thinking-param shapes, OAuth routing,
native tokenizers); only **DashScope** (14 LoC, one load-bearing boolean) is a
near-empty shim, and that is honest per-provider variation. Shared helpers all
have ≥2 callers. **Keep as-is.**

One narrow candidate worth a maintainer's eye (not applied here):

- **`IModelHandler` (`types/IModelHandler.ts`) is a `Pick<ModelHandler, …>` with
  2 production consumers (`ModelCell.ts`, `followUp/followUpMessages.ts`) and
  zero non-subclass implementers.** It is welded to the class by construction, so
  it buys no independent contract and no polymorphism. Its one genuine job is
  typing the optional feature-detected `createBatchedToolUseFollowUpMessages`
  (`:107`). That detection at `ToolUseDispatchNode.ts:615-621` is already
  belt-and-suspanders — it also gates on `requiresBatchedParallelToolResults`,
  and every class returning `true` there implements the method while the two that
  lack it inherit `false`. Declaring a gated base default for the method would let
  the 2 consumers type against `ModelHandler` directly and **remove `IModelHandler`
  entirely** (a 44-member `Pick`). Separately, the 44-member surface (mixing
  generation, credential routing, compaction state, streaming toggles) is _not_ a
  clean provider port; a real Agent-SDK provider interface, if wanted, should be
  authored top-down as a small hand-written contract, not `Pick`-ed off a
  2018-LoC base. **Recommendation, not applied** — a live consumer-facing decision,
  and touching it now is churn against the standing anti-refactor posture.

### 2.3 Logger / trace — sound; one thin dual-surface, one doc bug

There are **four** channels, separated by _scope_ and each load-bearing — not
four wrappers over one job:

| # | Mechanism                       | Scope             | Definition                          |
| - | ------------------------------- | ----------------- | ----------------------------------- |
| 1 | Channel-output logger           | text sink (bytes) | `src/logger/logUtils.ts`            |
| 2 | `AgentTrace` / `TraceEmitter`   | one agent **run** | `src/agent/trace/`                  |
| 3 | `SessionEventHub` / `SessionFact` | one **session** | `src/agent/runtime/SessionEventHub.ts` |
| 4 | `AppSignals`                    | **process** lifecycle | `src/eventBus/AppSignals.ts`    |

`platform().log` has **0** call sites under `src/agent`; `createChannelTrace`
spreads `noopTrace` and overrides only the four log methods — a minimal adapter,
not a policy layer. Two items worth noting:

1. **Doc bug (recommend fixing):** `CLAUDE.md:93` lists `log` as a `platform()`
   service — "(config, state, log, fs, workspace, storage, secrets)". There is
   **no `log` member** on the `Platform` interface (`src/platform/interfaces.ts`),
   and `src/platform/platform.ts:31-34` states the opposite outright ("the
   platform abstraction doesn't carry a log backend"; logging is `@logger/logUtils`
   wired via `setOutputChannelFactory`). An SDK integrator would trust that line
   and fail to find the service. One-word removal — left as a recommendation to
   keep this pass's applied change scoped to the red build.
2. **Non-urgent cohesion note:** two channel-log surfaces reach the same sink —
   the functional `warn(channel, …)` (`logUtils.ts`, 96 files) and
   `createChannelTrace(channel).warn(…)` (26 module-level sites). Defensible
   (the trace-shaped form lets module code be swapped for a live run trace), but
   the strongest single "two ways to do one thing" candidate if consolidation is
   ever wanted. Not a defect.

The one SDK-readiness asymmetry: the structured surfaces (#2 `trace.subscribe`,
#3 `SessionHandle.events`) are clean global-free DI seams an embedder injects
naturally, but the byte sink (#1) is redirected only through the
`setOutputChannelFactory` module singleton — the lone place logging is wired to
the host process rather than passed through platform/session objects. Documented
single injection point; noted for the eventual public-surface decision.

---

## 3. Surface & subagent boundaries — unchanged from 2026-08-04

The public run surface (`packages/agent/src/index.ts`, 301 LoC) already mirrors
the Anthropic `Query` pattern: one entry `runAgent(input): AgentRun`, one
observation rail (`AsyncIterable<AgentEvent>`) plus one terminal `result`, a
five-field `RunAgentInput`. The withheld interaction contract (approvals absent
until stable; `requestRetry` hard-denies) and disk-only definition loading are
**live rulings, not debt**. The gap to publication is packaging/legal, not API
shape.

Deep-import counts to shrink (post-fix, exact): **cli 32, desktop 25,
extension 34**. Highest cross-host overlap for Tier-1 fold-in, in priority order:
runtime control/lifecycle (`runtime/{agentShutdown, detachSubagentsOnStop,
SessionHandle, HostInteractions, ExecutionHandle, terminalResultToast}`), then the
all-three-host leaves `@agent/trace`, `@agent/storage`, `followUp/ToolUseFollowUp`,
`core/definition/AgentConfig`, then the resume/reattach cluster. The invariant
while doing this: **never widen a baseline** — each promotion shrinks the matching
host list.

**Subagent boundaries are already designed and shipped.** Dispatch is a clean
host-agnostic chain (`delegate_agent`/`delegate_workflow` →
`executeSubagent` → `createNativeSubagentStrategy` → `startChildRunLoop`, the
single driver for every child-run type, factored around `ChildRunStrategy`), with
single-owner teardown (`detachSubagentsOnStop`). Four units are already
independent-agent-shaped and need only barrel exposure: `src/tools/delegation/`,
`src/agent/review/` (review→fix pipeline), `agentCreator/` (own `AgentCreatorUI`
port), and the agent-CLI adapters. The units that genuinely _need work_ are the
two per-run flow engines (`reflection`, `tooluse`) and the `goal/` continuation —
in every case the blocker is the same `runtime/*` coupling the Tier-1 program
addresses, **not a separate refactor to invent here**.

---

## 4. Bottom line

The audited areas are aligned with the Agent-SDK direction and the standing
"no structural refactor warranted" conclusion holds unchanged. The one concrete
action this pass took was repairing a real regression — the `R-b` deep-import
ratchet had gone red on `main` (a new cli deep import from #9724 left un-baselined)
— by reconciling `host-agent-import-baseline.json` to current reality across all
three hosts. Everything else (the `IModelHandler` delete-candidate, the
`CLAUDE.md:93` doc bug, the logger dual-surface, `createRunScope` /
`ExecutionHandle`) is a documented recommendation, not applied, consistent with
the anti-churn posture. The strategic work remains packaging: the Tier-1 barrel
and bootstrap-tax shrink, shrinking the 32/25/34 deep-import counts as it lands.
