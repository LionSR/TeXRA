# Agent-SDK readiness — re-verification pass and SDK-package fold-in (2026-08-14)

> **Status:** Verification + one landed increment, written 2026-08-14 at HEAD
> `70df50f`. A scheduled audit routine re-ran the standing question — "audit the
> core, model handler, logger, and surface for unnecessary abstraction and
> unready surface" — reconciled it against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the prior passes
> ([`-08-04`](./2026-08-04-agent-sdk-readiness-review.md),
> [`-08-12`](./2026-08-12-agent-sdk-readiness-reverify.md)), and then landed the
> next incremental fold-in. Every claim carries a `file:line`, config path, or
> commit, checked at this HEAD.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, no structural refactor is warranted, and no genuinely redundant
abstraction was found to remove.**

What is new in this pass:

1. **The `-08-12` reconciliation item is resolved** (§2). The host baselines
   dropped because of two real merged commits, not a history gap.
2. **The SDK package is folded behind the `@agent/runtime` barrel: 10 → 7
   specifiers** (§3) — the increment #10011 skipped.
3. **A hard constraint was discovered that bounds the fold** (§4): the package's
   _public_ types cannot come from the broad runtime barrel, because declaration
   emit drags the barrel's whole `.d.ts` graph into the published type surface
   and trips the provider-type leak check. This is enforced, not stylistic.
4. **Two items previously listed as open are already done** (§5), and **the
   `-08-12` "higher-level public-typed entry" proposal conflicts with the plan of
   record** (§6) and should not be built as written.

---

## 1. Scope re-audited

| Area          | Entry points inspected                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| Agent core    | `src/agent/runtime/{runAgent,executeAgent,index}.ts`, `src/agent/implementations/flows/`                       |
| Model handler | `src/agent/modelHandlers/ModelHandler.ts`, `src/agent/types/IModelHandler.ts`                                  |
| Logger        | `src/logger/{logUtils,redaction}.ts`, `src/agent/trace/channelTrace.ts`                                        |
| Surface       | `packages/agent/src/{index,schemas,node}.ts`, the R-b ratchet, `packages/agent/scripts/validate-artifacts.mjs` |
| Subagents     | `src/tools/delegation/`, `src/agent/{review,goal,roster}/`, `implementations/flows/agentCreator/`              |

## 2. Reconciliation item from `-08-12` — resolved

The `-08-12` pass recorded extension 34 / cli 31 / desktop 25, while this tree
showed 17 / 18 / 13. Fetching the cited HEAD settles it: at `a7b1a64` the
baseline was **exactly cli 31, desktop 25, extension 34, agent 10** — the `-08-12`
numbers were correct. The drop came from two merged commits:

- **`d3e6ad51` — "fold host runtime deep-imports behind an `@agent/runtime`
  barrel (#10011)"**, whose own message calls it "the first incremental Tier-1
  fold-in from the Agent-SDK north star".
- **`66796d1f` — "relocate misplaced abstraction-layer utilities (#10118)"**.

So this is **landed Tier-1 progress, not a history gap**. No bookkeeping action
remains. Note for future passes: #10011 also settles the §5 "no barrel" question
— that caution was about a premature public `@texra/core` package, not about an
internal curated barrel, which is now the sanctioned fold-in mechanism.

## 3. What this pass landed — the SDK package fold-in (10 → 7)

#10011 folded the three hosts behind `@agent/runtime` but left the SDK package
itself at 10 specifiers. This pass applies the same pattern to that package:

| Specifier                         | Before | After                          |
| --------------------------------- | ------ | ------------------------------ |
| `@agent/runtime/runAgent`         | ✓      | → `@agent/runtime`             |
| `@agent/runtime/SessionHandle`    | ✓      | → `@agent/runtime`             |
| `@agent/runtime/ExecutionHandle`  | ✓      | → `@agent/runtime`             |
| `@agent/runtime/HostInteractions` | ✓      | → `@agent/runtime`             |
| `@agent/index/agentRegistry`      | ✓      | → `@agent/index`               |
| `@agent/runtime/AgentFlowResult`  | ✓      | **kept deliberately** — see §4 |

Net: **10 → 7**, baseline shrunk in `config/ratchets/host-agent-import-baseline.json`.
The package stops pinning five internal module paths — four under `runtime/` plus
`index/agentRegistry` — so those files can move or split without breaking it.
`@agent/runtime/AgentFlowResult` stays pinned by design (§4).

This is a **barrel fold, not a new layer** — no wrapper function, no facade, no
new abstraction. The touched files are `packages/agent/src/index.ts`,
`src/test-kernel/agent/AgentPackage.vitest.ts` (mocks the one barrel door
instead of each module path), and the baseline.

Verified: `npm run typecheck` clean; agent package build validates 720
declarations / 69 external packages; lint and prettier clean; 3,107 tests pass
across `src/test-kernel/architecture/` and `src/test-kernel/agent/`.

## 4. New hard finding — the barrel cannot carry the package's public types

This bounds the fold-in permanently and is the most useful thing this pass found.

`packages/agent/scripts/validate-artifacts.mjs:115-132` walks the **entire
transitive `.d.ts` graph reachable from the main entry** and fails the build if
any provider SDK appears (`@anthropic-ai/sdk`, `@google/genai`, `@openrouter/sdk`,
`openai`). Routing `AgentFlowResult` — which appears in the package's public
declarations (`AgentRun.result`, plus its re-export) — through `@agent/runtime`
made `index.d.ts` import the barrel, whose graph reaches
`ModelHandlerContracts.d.ts` → `@anthropic-ai/sdk`. The build failed with
`Provider type leaked into the main entry`.

The rule this yields, now documented at the import site
(`packages/agent/src/index.ts`):

- **Values, and types used only inside function bodies** (`SessionHandle`,
  `runAgent`, `AgentRunHandle`, `HostInteractions`) — safe through the barrel;
  they never reach the emitted declarations.
- **Types in public declarations** (`AgentFlowResult`) — must come from their own
  narrow module, or the barrel's whole graph joins the published surface.

This also explains why #10011 stopped where it did: **the SDK package's remaining
specifiers are not all collapsible.** Any future "seal the last specifiers" work
has to respect this, so the realistic floor is a handful of narrow public-type
modules plus the barrel — not one door.

## 5. Items previously listed as open that are already done

Checked against the north-star's own acceptance metrics (§6 of that doc):

- **Phantom contract arms (metric: 6 of 11 → 0).** Done.
  `RuntimePresentationEventPayloads` now has exactly **5 arms**, none phantom
  (`src/agent/runtime/runtimePresentationEvents.ts:16-22`).
- **Embedder smoke test (metric: none → contract suite green).** Done.
  `src/test-kernel/agent/AgentPackage.vitest.ts` is a real consumer-contract
  suite: init-once-per-process, event-subscribe-before-run ordering, approval-tool
  rejection, teardown ordering, disposal-failure paths, early-iteration detach.
- **`'runFact.'` prefix retirement — not yet due.** Dated v0.41; the repo is at
  **0.40.3**. On schedule, no action.

## 6. Correction — the `-08-12` "higher-level entry" proposal conflicts with the plan of record

`-08-12 §2` proposed sealing four specifiers "by giving the runtime one
higher-level, public-typed entry that resolves the agent by name, owns the
session, and returns/accepts only public types", and called that "unchanged from
the north-star". **That last claim is wrong.** North-star §5, under "What NOT to
do (verified traps, do not relitigate)":

> **No `runSession()` facade / SDK wrapper layer** — the ceremony shrinks by
> _deleting_ host-side bookkeeping into `SessionHandle`, not by wrapping it.

The proposed entry is exactly that facade. The sanctioned mechanism is the
barrel fold (§3, precedent #10011) plus, per north-star Step 2, moving
attach/load/flush bookkeeping _into_ `SessionHandle` — host lines deleted per
concern. Future passes should not resurrect the wrapper.

## 7. Abstraction audit — still nothing redundant to remove

Re-checked against the repo's guardrails; all load-bearing:

- **`runAgent` → `executeAgent` is earned.** `runAgent` validates-then-runs: it
  assigns the `executionId` (`runAgent.ts:103`), registers the execution
  (`:121`), and calls the engine (`:157`), which forwards `openWorkflowOutput` so
  the host can surface a workflow result (`executeAgent.ts:474`). The
  `executeAgent` module's two engine entries have ≥4 production consumers:
  `executeAgent` itself from `runAgent.ts:157` and
  `nativeSubagentStrategy.ts:254`, and its sibling `resumeToolUseFromResumeData`
  (`executeAgent.ts:522`) from `resumeQueuedToolUse.ts:134`,
  `nativeSubagentStrategy.ts:306`, and the CLI resume path
  (`chatSessionController.ts:573`) — the resume entry CLAUDE.md deliberately
  distinguishes from `runAgent`.
- **`ModelHandler` remains a genuine provider port**, consumed as the narrowed
  `IModelHandler` with its one interface-only optional member
  (`createBatchedToolUseFollowUpMessages`, `IModelHandler.ts:104`).
- **The logger surface is minimal and single-owner** — `logUtils.ts` (250 LoC),
  `redaction.ts` (117), `channelTrace.ts` (82, spreads `noopTrace`, no wrapper
  subclass).
- **Standing watch-items, unchanged:** `applyHelperModelPreference`
  (single-caller but real branching + its own vitest) and the `ModelFactory`
  routing round-trip. Revisit only if edited for another reason.

## 8. Subagent boundaries — unchanged

The dispatch boundary (`delegate_agent`/`delegate_workflow` → `executeSubagent` →
`createNativeSubagentStrategy` → `startChildRunLoop`) is cleanly drawn and
host-agnostic. Promote-as-is units: `src/tools/delegation/`, `src/agent/review/`,
`agentCreator/agentCreatorFlow.ts`, the agent-CLI adapters. The two per-run
engines and the `goal/` loop remain runtime-coupled — north-star Step 2 work.

## 9. Remaining open items

1. **`HostInteractions` required/optional (north-star TD-2(a), metric 0/7 → 6/7).**
   Still open — all request methods are optional (`HostInteractions.ts:344-391`).
   This is the real content of what earlier passes vaguely called "stabilize the
   withheld interaction contract". **Genuine maintainer decision, not a mechanical
   edit:** it is cross-host, it "rides micro-audit A2's −300..−450 legacy-fallback
   deletion" per the north-star, and it forces an answer to what a UI-less embedder
   does about tool-edit/bash approval — today the package rejects approval-requiring
   tools outright (`packages/agent/src/index.ts`) and hard-denies `requestRetry`.
   Deliberately not invented here.
2. **Logger → event stream (`-08-12 §4`).** Unchanged: the package's bootstrap
   logger and model-handler routing decisions reach only the process-wide sink,
   never the embedder's `AgentRun`. Surfacing them means **extending `AgentEvent`**,
   which CLAUDE.md routes through the event-channel ruling — a proposal, not a
   churn PR. (`platform().log` is still not a real surface; do not plan against it.)
3. **Further specifier reduction** is bounded by §4 — the remaining 7 are near the
   realistic floor without redesigning the barrel's type graph.

Nothing in §9 is a defect.
