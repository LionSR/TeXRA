# Agent-SDK readiness — re-verification pass, four-area audit, one candidate refuted (2026-08-17)

> **Status:** Verification pass, written 2026-08-17. A scheduled audit routine
> re-ran the standing question — "review the agent core, model handler, logger,
> and surface for unnecessary abstraction and unready surface; design subagent
> boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the most recent pass
> ([`-08-15`](./2026-08-15-agent-sdk-readiness-reverify.md)). This pass ran two
> independent four-area deep readers, adversarially verified the one concrete
> increment they surfaced, and confirmed that two of `-08-15`'s named pick-up
> candidates have already closed or shrunk under the active consolidation
> program. **No code increment lands this pass** — the single candidate was a
> verified false positive, recorded below so a future pass does not re-derive
> it. Every claim carries a `file:line`, config path, or grep, checked on
> `claude/eager-noether-jx9blz` (tip `07781bb`).

## 0. Verdict

**The standing verdict holds unchanged: the codebase is well-aligned with an
Agent-SDK shape, no structural refactor is warranted, and no genuinely redundant
abstraction was found to remove in any of the four areas.** Two fresh
independent readers (one per side of the surface) re-derived that conclusion
from source: neither found a pass-through layer, a redundant one-impl interface,
or a create-run-interpret wrapper to delete in agent core, the model handlers,
the logger, or the runtime surface.

What is new in this pass:

1. **L-3 has closed since `-08-15`** (§2). The dead redaction-options branch is
   gone; path-scrubbing was relocated to the one host that owns `homeDir` /
   `workspacePath`, with a pinning test — the exact "delete the unreachable
   branch" disposition `-08-15 §4` offered.
2. **L-1 is shrinking on its own** (§2). The parallel `createChannelTrace`
   module-logger factory is down to **8** non-test callers (from ~28 at
   `-08-15`); the consolidation program is eroding it per-caller without a
   dedicated PR.
3. **One concrete increment was surfaced and refuted** (§3): folding the model
   handlers' `createBatchedToolUseFollowUpMessages` into the `ModelHandler` base
   so `IModelHandler` collapses to a pure `Pick`. It is **not** safe — three
   concrete handlers do not implement the method, so the base member cannot
   become abstract and the dispatch guard is load-bearing type-narrowing, not
   dead code. Recorded as do-not-refile.
4. **Subagent boundaries remain already-drawn** (§4). The one worthwhile
   promotion candidate remains `agentCreator` (a helper-model one-shot flow that
   bypasses the execution registry); it is a design decision with real coupling
   to convert, not a mechanical increment — unchanged from `-08-15 §5`.

---

## 1. Scope re-audited

| Area          | Entry points inspected                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Agent core    | `src/agent/core/{definition,state,usage,tools,flows}/`, `src/agent/node/index.ts`                                       |
| Model handler | `src/agent/modelHandlers/**`, `src/agent/types/IModelHandler.ts`, `ModelHandler.ts`, `src/agent/runtime/ModelFactory.ts` |
| Logger        | `src/logger/{logUtils,redaction}.ts`, `src/agent/trace/channelTrace.ts`                                                  |
| Surface       | `packages/agent/src/{index,node,schemas}.ts`, `src/agent/runtime/**`, the `@agent/runtime` barrel                       |
| Subagents     | `src/tools/delegation/`, `src/agent/runtime/{childRunLoop,executeAgent,helperModel}.ts`                                  |

## 2. Re-verification against `-08-15`

| Item                                                       | `-08-15`          | HEAD `07781bb`                                                                 |
| ---------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| Version (governs `runFact.` retirement, due v0.41)         | 0.40.3            | **0.40.3** — retirement still not due                                         |
| Host deep-import baselines (cli / desktop / extension)     | frozen            | **frozen** — no baseline moved (`config/ratchets/host-agent-import-baseline.json`) |
| **L-3** dead redaction-options branch                      | open (one defect) | **closed** — see below                                                        |
| **L-1** `createChannelTrace` non-test callers              | ~28               | **8** (`grep createChannelTrace`, non-test)                                    |

**L-3 closed.** `src/logger/redaction.ts` no longer takes a `LogRedactionOptions`
argument at all — `redactSecrets(text: string)` is the whole surface
(`redaction.ts:81`). The `homeDir`/`workspacePath` path-scrubbing branch that
`-08-15 §4` flagged as unreachable was deleted, and path redaction now lives in
the host that actually holds those values: the desktop main process scrubs paths
with `redactPathPrefixes(text, workspacePath, homedir())` **before**
`redactSecrets` (`packages/desktop/src/main/desktopAppLog.ts:168,176-180`). The
decision is pinned by a test that documents it in words —
"No production call site ever passed `LogRedactionOptions`, so … paths
separately via `redactPathPrefixes` before `redactSecrets`"
(`src/test-kernel/desktop/DesktopLogRedaction.vitest.ts:21-23`). This is the
"delete the unreachable branch" half of `-08-15 §4`'s two-way disposition,
executed cleanly — the honesty fix the "silent degradation is a defect" rule
asks for.

## 3. The one concrete candidate this pass surfaced — and why it is refused

A model-handler reader proposed the pass's only actionable increment:
`IModelHandler` (`src/agent/types/IModelHandler.ts:32-114`) is a
`Pick<ModelHandler,…>` view plus exactly one additive member —
`createBatchedToolUseFollowUpMessages?` (`:104`) — and its doc comment frames
that member as "the one thing this port expresses that the class doesn't." The
proposal: since every provider "implements it non-optionally," promote it to an
**abstract** member of `ModelHandler`, drop the second clause of the dispatch
guard at `ToolUseDispatchNode.ts:577`, and let the port collapse to a pure
`Pick` — a cleaner SDK contract.

**Refuted on verification. The premise is false.** The method is defined in only
five handler files — Anthropic, OpenAI, Google, OpenRouter, VscodeLm (grep). It
is genuinely **not** universal:

- `ModelHandlerOpenAIResponse` (`modelHandlerOpenAIResponse.ts:294`) extends
  `OpenAICompatibleModelHandler`, **not** `ModelHandlerOpenAI`, and
  `OpenAICompatibleModelHandler` defines the method **0** times. So
  `ModelHandlerOpenAIResponse` and its subclass `ModelHandlerCodex`
  (`modelHandlerCodex.ts:166`) do not implement or inherit it.
- `ModelHandlerValidation` (`modelHandlerValidation.ts:128`), the CI stub, does
  not implement it either.

Consequences that make the change unsafe, not just churn:

1. **The base member cannot become abstract.** Three concrete `ModelHandler`
   subclasses would fail to compile.
2. **The guard's second clause is load-bearing type-narrowing, not dead code.**
   Because the method is legitimately optional (`?`), TypeScript requires the
   truthiness check at `ToolUseDispatchNode.ts:577` before the call at `:580`;
   removing it is a `possibly-undefined` invocation error. The three
   non-implementers also do not override `requiresBatchedParallelToolResults`
   (base default `false`, `ModelHandler.ts:805`), so the first clause already
   excludes them — the two clauses are consistent and correct as they stand.

The additive port member and the feature-detect guard are therefore both
correct. **Do not re-file.** (This is the third such retraction in the model-
handler area — cf. `-08-15 §4`'s S-1, T-1, and the `sdkErrorMetadata` walk-back
— consistent evidence that the subtree is well-factored and that plausible
"collapse the port" edits do not survive an adversarial read.)

Everything else the two readers scrutinized cleared: the `runAgent`/`executeAgent`
split (two distinct caller populations — hosts vs. registry-owning subagent and
resume paths), the `AgentFlowResult`/`AgentFinalResult`/`AgentRunHandle` layering
(schema `.pick()` derivation + `Pick<>` interface segregation, not stacked
wrappers), `SessionHandle`/`SessionEventHub`/`HostInteractions` (three composed
concerns), the `ModelFactory`/`ModelCell`/`ModelRetryGate` trio (construction vs.
live handle vs. retry, each multi-caller with real logic), the provider subclass
hierarchy (`OpenAICompatibleModelHandler` 2 subclasses,
`ReasoningModelHandlerOpenAI` 4, each with shared behavior), and `toolConversion`
(seven single-purpose provider transforms, no pass-throughs).

## 4. Subagent boundaries — already drawn; agentCreator remains the one candidate

Unchanged from `-08-15 §5`. The dispatch boundary is cleanly drawn and
host-agnostic: `delegate_agent` / workflow `agent()` →
`createNativeSubagentStrategy` (`nativeSubagentStrategy.ts:181`) →
`executeAgent` with `isSubagent:true` → `startChildRunLoop`
(`childRunLoop.ts:724`), with the agent-launching-agent recursion closed at one
typed runtime slot (`provideAgentEngine`, `nativeSubagentStrategy.ts:89`).
Lineage/budget/lifecycle live in `executionRegistry.ts`, `childRunBudget.ts` (one
`PQueue` per `SessionHandle`), and `childRunLoop.ts`. A subagent is a full
`executeAgent` run — its own `executionId`, stream tab, result meta, cost
rollup, and registry-mediated cancellation.

The four helper-model one-shots below sit on the *other* side of that boundary
(`createHelperModelKit` → `runHelperModelCompletion`, `helperModel.ts:34,84` —
no `executionId`, no registry entry, no budget slot, fire-and-forget). Only one
is worth promoting:

- **`agentCreator`** (`agentCreatorFlow.ts` `runAgentCreator`) — the one clean
  candidate: already a multi-step flow, but it generates through the
  helper-model one-shot rather than a registered `executeAgent` run. Promoting
  it would give it an `executionId`, stream, cost rollup, and registry
  cancellation. This is a design decision (convert the helper-model coupling to
  a registered execution), not a mechanical relocation.
- **`sessionDescription`**, **`textEnhancement`**, **`textConnection`** — cross
  the same helper-model→registered-execution seam but are too lightweight to
  justify an execution record; they argue for keeping `helperModel.ts` as the
  deliberate "untracked one-shot" tier beneath the subagent boundary.
- **`review`** is *already* an agent (`AgentReviewService` launches via
  `runAgent`) — not a candidate.

## 5. Open items (unchanged; none a defect)

Carried from `-08-15 §7`, none actioned here:

1. **`HostInteractions` required/optional (north-star TD-2a)** — open maintainer
   decision; executing it as a mechanical cleanup is retired (would regress the
   package's tested minimal-host contract).
2. **Logger → event stream** — surfacing bootstrap/model-routing logs to an
   embedder means *extending `AgentEvent`* (a proposal, not a churn PR); L-2's
   process-global sink singletons are the same theme from the sink side and one
   facet of the once-at-startup multi-tenancy constraint.
3. **L-1** — narrow the remaining 8 log-only `createChannelTrace` callers onto
   `createLog` per-caller; low value, and the consolidation program is already
   doing it. Not a factory merge (the two have different return contracts).
4. **Publication** remains gated on packaging/legal, not API shape.

The two structural blockers (the `@tools/delegation ↔ executeAgent` lazy-import
cycle, tracked in the delegation-consolidation plan of record; and the
process-wide platform/registry multi-tenancy constraint) are maintainer-scoped
design decisions, not mechanical increments, and are unresolved by this pass.
