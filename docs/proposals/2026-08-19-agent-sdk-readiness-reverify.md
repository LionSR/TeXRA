# Agent-SDK readiness — re-verification pass (2026-08-19)

> **Status:** Verification-only, written 2026-08-19 against branch HEAD
> `391033e`. The scheduled audit routine re-ran the standing question — "review
> the agent core, model handler, logger, and surface for unnecessary abstraction
> and unready surface; design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the most recent pass
> ([`-08-15`](./2026-08-15-agent-sdk-readiness-reverify.md)). This pass found the
> alignment has **strengthened** since `-08-15`: both live small candidates and
> the #1 structural blocker were resolved by intervening cleanup, and the frozen
> host surface narrowed. **No abstraction to remove, nothing to land this pass.**
> Every claim carries a `file:line`, config path, or commit, checked at `391033e`
> unless noted. (The prior pass measured at parent `ee56ceb`, which is beyond
> this fresh clone's shallow boundary; the deltas below are stated against the
> `-08-15` document's recorded values, not a live diff of that commit.)

## 0. Verdict

**The standing verdict holds and has strengthened: the codebase is well-aligned
with an Agent-SDK shape, no structural refactor is warranted, and no genuinely
redundant abstraction was found to remove.** Since `-08-15`, five of the six
tracked live items moved in the right direction on their own via converging
cleanup PRs; this pass verifies that and files no change, because there is no
speculative edit worth landing into a deliberately-architected, ratchet-guarded
tree.

## 1. What resolved since `-08-15` (verified)

| Item                            | `-08-15` state                                                              | `391033e` state                                                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L-3** (dead redaction branch) | one small defect: `redactSecrets` dropped `LogRedactionOptions` path-scrub  | **closed.** `redactSecrets(text: string)` is now single-arg with no options branch (`redaction.ts:81-101`); the deleted path-scrub is documented dead-by-design in `test-kernel/desktop/DesktopLogRedaction.vitest.ts:21` ("No production call site ever passed LogRedactionOptions"). Chose the "delete the unreachable branch" disposition. |
| **L-1** (dup log-only callers)  | ~28 non-test `createChannelTrace` call sites shadowing `createLog`          | **substantially reduced.** Non-test `createChannelTrace(` call sites down to **7** (`grep` over `src/`+`packages/`, test-excluded). The per-caller narrowing the prior pass prescribed has largely happened; the ~7 tail is a low-value cleanup, not a defect.                                                                    |
| **§6a** delegation layer cycle  | `@tools/delegation ↔ executeAgent` cycle papered by two lazy `await import()` | **resolved.** No `await import(...)` remains anywhere under `src/tools/delegation/`, and no lazy import of `nativeSubagentStrategy` exists anywhere in the repo. The two papered edges (`subagentExecution.ts`, `inBandSubagentExecution.ts`) are gone — the delegation-flow substrate consolidation (the prior plan of record's #1) landed. |
| **C-1** (ambient ALS in cycle)  | closed by #10594 (`ToolPolicy` service field)                               | **still closed.** `ToolPolicy` interface + `createToolPolicy` + `readonly toolPolicy` field present (`core/flows/BaseFlowServices.ts:26,36,56`).                                                                        |
| Frozen host specifier width     | cli / desktop / extension = **18 / 13 / 17**; agent 7                        | **narrowed to 12 / 10 / 13**; agent still **7** (`config/ratchets/host-agent-import-baseline.json`). The stated open work — "shrinking the frozen lists" — is progressing; no baseline widened.                          |

## 2. What is unchanged, and correctly so (deliberate design, not debt)

- **§6b in-process multi-tenancy.** `runAgent` still documents the platform and
  agent registry as process-wide and throws on a second distinct platform
  (`packages/agent/src/index.ts:225`, `:243`). This is a maintainer architecture
  decision (once-at-startup composition), not a fixable seam — do not relitigate.
- **L-2 process-global log sink.** `channels` / `mainOutputChannel` /
  `outputChannelFactory` / `outputSinksTrusted` remain module singletons
  (`logUtils.ts:54-57`); `createRedactingSink` still routes through the shared
  `redactSecrets` (`:61-75`). This is one facet of §6b, not an independent
  blocker; there is still no `platform().log` port, by design.
- **M-3 `ModelHandler.ts` cohesive god-base** — 2,161 LoC (`wc -l`), up modestly
  from ~2,000. Genuinely shared behavior; a long-horizon port-narrowing note, not
  a discrete removal.
- **Version 0.40.3** (`package.json`) — the `runFact.` retirement is gated on
  v0.41 and not yet due.
- Logger core LoC: `logUtils` 256 / `redaction` 101 / `channelTrace` 82 (the
  redaction drop from 117 is the L-3 deletion).

## 3. Subagent boundaries — still already drawn

Unchanged from `-08-15 §5`. The dispatch boundary (`delegate_agent` /
`delegate_workflow` → `executeSubagent` → `createNativeSubagentStrategy` →
`startChildRunLoop`) remains cleanly drawn and host-agnostic, and the §6a cycle
resolution above removes the layering wrinkle that previously sat under it. The
named carve-out starting points (`childRunLoop`, `executeAgent` /
`resumeToolUseFromResumeData`, the helper-model kit, `resolveAndResumeStream`,
`ExecutionSubscriptionBinder`) are unchanged and each still reaches a concrete
runtime collaborator that a real carve-out must convert to an injected port
first — none is a pure relocation today. No new boundary to invent.

## 4. Remaining open items (all pre-existing, none a defect)

1. **`HostInteractions` required/optional (north-star TD-2a)** — open maintainer
   contract decision; executing it as a mechanical cleanup is retired
   (`-08-15 §6`), the shape question stays open.
2. **Logger → event stream** — surfacing bootstrap/model-routing logs to an
   embedder means extending `AgentEvent` (a proposal, not a churn PR); L-2 is the
   same theme from the sink side.
3. **Further specifier reduction** continues but is bounded near the realistic
   floor by the provider-type-leak constraint; agent's 7 is unchanged.
4. **L-1 tail** — the ~7 remaining log-only `createChannelTrace` call sites could
   be narrowed onto `createLog` one at a time. Low value; the only genuine small
   candidate left, and not worth a dedicated PR.
5. **Publication** remains gated on packaging/legal, not API shape.

## 5. Bottom line for this pass

Nothing to refactor. The two candidates the `-08-15` pass left for a future
land-one-increment turn (L-3, L-1) were both addressed by intervening cleanup —
L-3 fully, L-1 down to a negligible tail — and the largest tracked structural
blocker (§6a) was resolved. The deliberate design decisions (§6b multi-tenancy,
L-2 sink globals, M-3 god-base) are correctly untouched. This pass therefore
lands no code change; a speculative edit into this tree with the verdict already
green would be net-negative.
