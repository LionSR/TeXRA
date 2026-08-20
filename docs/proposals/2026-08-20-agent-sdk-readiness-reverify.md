# Agent-SDK readiness — re-verification pass (2026-08-20)

> **Status:** Verification-only, written 2026-08-20 against branch HEAD
> `74fab00`. The scheduled audit routine re-ran the standing question — "review
> the agent core, model handler, logger, and surface for unnecessary abstraction
> and unready surface; design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the immediately-prior pass
> ([`-08-19`](./2026-08-19-agent-sdk-readiness-reverify.md), measured at
> `391033e`). This pass found the alignment **holds and has strengthened
> marginally**: every `-08-19` claim re-verifies at `74fab00`, and the frozen
> host deep-import lists narrowed by one specifier in each host with no baseline
> widened. **No abstraction to remove, nothing to land this pass.** Every claim
> below carries a `file:line`, config path, or count checked at `74fab00`.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, no structural refactor is warranted, and no genuinely redundant
abstraction was found to remove.** The delta since `-08-19` is entirely in the
right direction — the frozen host-import surface is one specifier narrower per
host — and the intervening merges (child-run lifecycle fixes #11222, and
two indirection-removing refactors #11215 unused content-provider contract,
#11212 shared html/markdown) add no wrapper layers. A speculative edit into this
tree with the verdict already green would be net-negative.

## 1. Every `-08-19` tracked fact re-verifies at `74fab00`

| Item                                         | `-08-19` state                                | `74fab00` state                                                                                                                                               |
| -------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L-3** (dead redaction branch)              | closed; `redactSecrets` single-arg            | **still closed.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:81`); no options branch.                                    |
| **§6a** delegation-layer cycle               | resolved; no lazy `await import()`            | **still resolved.** `0` `await import(` under `src/tools/delegation/`; `0` lazy imports of `nativeSubagentStrategy` anywhere in `src/`. Static imports only.  |
| **C-1** (ambient ALS in cycle)               | closed by #10594 (`ToolPolicy` field)         | **still closed.** `ToolPolicy` interface + `createToolPolicy` + `readonly toolPolicy` field present (`src/agent/core/flows/BaseFlowServices.ts:26,36,56`).    |
| **§6b** in-process multi-tenancy             | deliberate; throws on 2nd platform            | **unchanged, correctly.** Guard intact — `tryPlatform()` / throw-on-second-platform (`packages/agent/src/index.ts:240-246`). Maintainer decision, not a seam. |
| **L-1 tail** (log-only `createChannelTrace`) | ~7 non-test call sites                        | **unchanged at 7** (grep over `src/`+`packages/`, test-excluded). Low-value tail, not a defect.                                                               |
| **M-3** `ModelHandler.ts` god-base           | 2,032 LoC (merge base)                        | **2,068 LoC** (`wc -l`). Modest; genuinely shared behavior, a long-horizon port-narrowing note, not a discrete removal.                                       |
| **Version**                                  | 0.40.3 (`runFact.` retirement gated on v0.41) | **still 0.40.3.** Not yet due.                                                                                                                                |

## 2. Frozen host deep-import width — narrowed one per host, no widening

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*` deep-import
specifiers per package):

| Package             | `-08-19` | `74fab00` |
| ------------------- | -------- | --------- |
| cli                 | 12       | **11**    |
| desktop             | 10       | **9**     |
| extension           | 13       | **12**    |
| agent (SDK package) | 7        | **7**     |

The stated open work — "shrinking the frozen lists" — is progressing on its own
via converging cleanup; the set-based ratchet still forbids any new edge. Agent's
7 is unchanged and sits near the realistic floor bounded by the provider-type-leak
constraint.

## 3. Subagent boundaries — still already drawn

Unchanged from `-08-19 §3`. The dispatch boundary (`delegate_agent` /
`delegate_workflow` → `executeSubagent` → `createNativeSubagentStrategy` →
`startChildRunLoop`) remains cleanly drawn and host-agnostic; the §6a cycle
resolution keeps it free of the prior layering wrinkle. The intervening child-run
lifecycle fixes (#11222 — launch guard plus failed-child finalize/auto-close)
harden this boundary without reshaping it. The named carve-out starting points
(`childRunLoop`, `executeAgent` / `resumeToolUseFromResumeData`, the helper-model
kit, `resolveAndResumeStream`, `ExecutionSubscriptionBinder`) are unchanged; each
still reaches a concrete runtime collaborator that a real carve-out must convert
to an injected port first. No new boundary to invent.

## 4. Remaining open items (all pre-existing, none a defect)

Carried forward from `-08-19 §4`, all unchanged:

1. **`HostInteractions` required/optional (north-star TD-2a)** — open maintainer
   contract decision, not a mechanical cleanup.
2. **Logger → event stream** — surfacing bootstrap/model-routing logs to an
   embedder means extending `AgentEvent` (a proposal, not a churn PR); the L-2
   process-global log sink is the same theme from the sink side.
3. **Further specifier reduction** continues but is bounded near the floor by the
   provider-type-leak constraint; agent's 7 is unchanged.
4. **L-1 tail** — the ~7 remaining log-only `createChannelTrace` sites could be
   narrowed onto `createLog` one at a time. Low value; the only genuine small
   candidate left, not worth a dedicated PR.
5. **Publication** remains gated on packaging/legal, not API shape.

## 5. Bottom line for this pass

Nothing to refactor. Two consecutive daily passes (`-08-19`, `-08-20`) now find a
green, strengthening verdict with the frozen surface still contracting on its own.
This pass lands no code change; the durable record is this verification entry.
