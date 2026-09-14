# Agent-SDK readiness — re-verification pass (2026-09-09)

Status: implemented

> **Status:** Written 2026-09-09 and, per the maintainer's request on #12154
> ("do them from latest main"), **re-derived against the latest `main` at
> `dff2602`** (`Merge pull request #12144 …/claude/v1-legacy-cleanup`, dated
> 2026-09-09) rather than the earlier `ce1538d` snapshot an initial shallow
> checkout carried. Every fact below is re-derived by **direct inspection at
> `dff2602`** and carries a `file:line`, config path, or count checked at that
> HEAD; where a citation moved as `main` advanced it is given at `dff2602` (e.g.
> the `createRunScope` call site is `:552` here, not the `:565` of the earlier
> snapshot). The top-line verdict is the **ninth consecutive green**
> (`-08-19` through `-09-09`) — **the alignment holds** — but this pass records
> one material change of framing (§0, §3) the prior eight did not: the specific
> SDK-surface/subagent enumerations are now owned by an in-flight, deeper
> re-platforming direction, and this pass defers to those docs rather than
> re-deriving them.

## 0. Verdict

**The standing structural verdict holds: no genuinely redundant abstraction was
found to remove, and no speculative refactor is warranted.** The pass-through
wrappers, convenience barrels, and one-impl interfaces the standing question
hunts for are still absent; every layer re-checked (§1) is load-bearing and
matches the standing record.

**What changed since `-09-04` is the framing, not the verdict.** A deeper
direction — re-express the agent runtime and model layer as an
**Effect-4-native** system, retire the PocketFlow node/graph composition
machinery, stand up an own **`packages/llm`** package, and retire the
`IModelHandler` port and provider-class compatibility, with `@texra-ai/agent`
as the single supported entry — has advanced. The **direction** itself is
ratified (the pure-Effect runtime,
[`2026-09-04-agent-runtime-on-effect.md`](../../implemented/architecture/2026-09-04-agent-runtime-on-effect.md)
and the accepted delivery plan
[`2026-09-06-effect-runtime-delivery-plan.md`](../../proposed/architecture/2026-09-06-effect-runtime-delivery-plan.md),
built on the migration PRD
[`2026-08-26-effect-4-runtime-migration.md`](../../proposed/architecture/2026-08-26-effect-4-runtime-migration.md)).
The specific SDK-surface and subagent **enumerations**, however, live in
documents still marked `status: proposed` — notably
[`2026-09-05-agent-sdk-architecture.md`](../../proposed/architecture/2026-09-05-agent-sdk-architecture.md),
which states it is "not a ratified implementation plan or a claim of readiness"
— so they are the current owners of the question, not a settled specification.
This does **not** overturn the "nothing redundant to delete" finding: the
current abstractions are correct for the current shape, and the plan removes
PocketFlow / `IModelHandler` **as an implementation consequence of
re-expression onto Effect**, not because they are unnecessary indirection today
(the review is explicit that "deleting node classes is an implementation
consequence, not the product objective", and the reflection pipeline and
tool-use loop are both preserved as first-class programs —
[`2026-09-06-agent-architecture-review.md`](../../proposed/architecture/2026-09-06-agent-architecture-review.md)).

The practical consequence for this routine: the three deliverables the standing
question asks a fresh pass to produce — (a) abstractions to remove, (b) surface
simplification / the Tier-1 manifest, (c) subagent split points — **already
exist as current planning** (§3). Re-enumerating them here would duplicate live
docs and risk drift. Consistent with the routine's default (no maintainer
request accompanies the audit itself), the audit is **recorded, not acted on**,
and points to the owning docs rather than restating them.

## 1. Tracked structural facts re-verify at `dff2602`

| Item                                                          | Expected (`-09-04` @ `4579625`)           | `dff2602` state                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node flow engine**                                          | 158 LoC, `BaseNode` + `Flow` only         | **158 LoC** (`src/agent/node/index.ts`); only `class BaseNode` (`:30`) + `class Flow` (`:134`). No `BatchNode`/`ParallelBatchNode`. Matches CLAUDE.md.                                                                                                                                                                                              |
| **`ModelHandler.ts` god-base**                                | 2,026 LoC                                 | **1,954 LoC** (`wc -l`), **−72** — a continued reduction, not growth; consistent with the Effect-migration/simplification trend. Still a cohesive polymorphic base.                                                                                                                                                                                 |
| **`useHostInteractions` hook (removed from `SessionHandle`)** | gone                                      | **still gone.** `grep -rc useHostInteractions src/ packages/` returns zero live hits. Only the hook is tracked here — the `SessionHandle` class itself is alive and central (`SessionHandle.ts:145`).                                                                                                                                               |
| **Dead logger `export`**                                      | `OutputChannelFactoryOptions` de-exported | **still gone.** `src/logger/logUtils.ts:49` is `interface OutputChannelFactoryOptions` (no `export`); only internal use at `:191`.                                                                                                                                                                                                                  |
| **`createRunScope` survivor**                                 | 1 production caller                       | **1 production caller** — definition at `src/agent/runtime/RunScope.ts:28`, sole production call at `src/agent/runtime/AgentLaunchContext.ts:552` (moved from `:565` as `main` advanced); all other call sites are `src/test-kernel/`.                                                                                                              |
| **SDK version + surface**                                     | 0.40.9                                    | **0.41.0** (`packages/agent/package.json`). Not a bare version bump: the published surface has grown — `AgentRun.view` (folded session view, `index.ts:137`), the public `closeSession` operation + session owner (`index.ts:222`), and the `./effect` subpath and its services. `package.json` exports `['.', './schemas', './effect', './node']`. |

No new `export class` / `export function create*` reverses any standing fact;
the node engine, model-handler base, logger, and session composition all match
or improve on the prior record.

## 2. Frozen host deep-import width — held, cli at its post-shrink floor

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*`
deep-import specifiers per package, past the `@agent` barrel):

| Package             | `-09-04` | `dff2602` |
| ------------------- | -------- | --------- |
| cli                 | 7        | **6**     |
| desktop             | 5        | **5**     |
| extension           | 9        | **9**     |
| agent (SDK package) | 7        | **7**     |

**cli is at 6** (down from 7 at `-09-04` — a retired deep import), the direction
the set-based ratchet (`hostAgentDeepImportRatchet.vitest.ts`) rewards. Most
remaining host specifiers are **curated module-level barrel doors**
(`@agent/runtime`, `@agent/storage`, `@agent/trace`, `@agent/followUp`,
`@agent/index`, `@agent/export`, `@agent/review`, `@agent/features`,
`@agent/templates`). Two are **not** doors and remain outstanding internal leaf
edges: `@agent/core/state/executionRequests` and
`@agent/implementations/agentCreator/agentCreatorFlow` are deep imports that
still pin concrete internal layout — per the baseline's own semantics every
`@agent/*` deep import counts as internal-coupling width, so these two are not
yet fronted by a curated surface. `agent`'s 7 remains at its realistic floor,
bounded by the provider-type-leak constraint. No list widened.

## 3. The three standing deliverables already exist in current docs

Rather than re-derive, this pass records where each lives so the routine's output
stays a single source of truth:

- **(a) Abstractions to remove** — the Effect-4 migration PRD and delivery plan
  ("mechanisms and competing authorities removed" as the success measure), and
  the 2026-09-06 study cluster's "what disappears" tables (PocketFlow node/graph
  kernel, `PersistedFlow`, `IModelHandler`'s port and its provider-class
  compatibility). These are re-expression removals, not
  redundant-indirection removals (§0).
- **(b) Surface simplification / Tier-1 manifest** —
  [`2026-09-05-agent-sdk-architecture.md`](../../proposed/architecture/2026-09-05-agent-sdk-architecture.md)
  §4 (status: proposed): keep root `@texra-ai/agent` + `/node` + `/schemas`; no
  `@texra/core`; the manifest names exact exports and actual consumers; drop the
  `AgentPlatform extends Platform` roots coupling. **Note — the proposal's §4
  list omits `/effect`**, but `packages/agent/package.json` exports four subpaths
  today (`['.', './schemas', './effect', './node']`) and the README calls
  `./effect` (the Effect-typed surface under the Promise entry) a supported SDK
  entry. So a future Tier-1 manifest must **add** `/effect`, not inherit the §4
  list verbatim, or it would silently retire a live public export.
  **Possible gap:** the Tier-1 manifest is referenced as a _deliverable inside_
  that doc's §4 but is **not yet broken out as a standalone enumerated file**; if
  the routine is ever asked to _act_, extracting that manifest — seeded from the
  current barrel doors in §2 and the frozen `agent` list, `/effect` included — is
  the one concrete, low-risk artifact still missing.
- **(c) Subagent split points** — the SDK-architecture doc's subagent section
  (subagents run the same invocation path, cannot broaden the parent's
  tool/policy ceiling, keep independent child stream aggregates per substrate C9,
  re-root/detach on parent removal), plus the shipped `ChildRunStrategy` SPI and
  the execution-interaction-ownership design. Re-confirmed shape below.

## 4. Tracked small-item dispositions at HEAD

- **C-1 (ambient ALS reads in the cycle flows) — landed.** `grep -rn
useLaunchRunContext src/agent/implementations/flows src/agent/core/flows`
  returns **zero**; the tool-policy values are now an immutable service field
  (`ToolPolicy` / `createToolPolicy` at `src/agent/core/flows/BaseFlowServices.ts:26,36`,
  read via `toolPolicy` at `:56`), so both the response-cycle and tool-use cycle
  flows are drivable without an ALS frame — the property an SDK embedder wants.
  Closed (per `-08-15` §4, #10594).
- **C-3 (fat service bag → `Pick`-narrowed cycle services) — carried forward,
  not yet started on its target.** The node service bags C-3 tracks —
  `CycleRunServices`, `ResponseCycleServices`, `ToolUseRoundServices`
  (`src/agent/core/flows/CycleServices.ts:19,26,37`) — still each
  `extends BaseFlowContextInit` (`BaseFlowServices.ts:66`, itself `extends
AgentCore`), so the whole-bag spread the item flags is unchanged. The only
  `Pick<AgentCore, …>` narrowings in the tree are in helpers (`saveCycleDebug` at
  `CommonCycleTypes.ts:93`) and `ModelInvocationNode`'s `InvocationServices` — not
  the node bags — so they model the fix without applying it there. Not a
  correctness issue; carried forward.
- **L-1 (two parallel module-logger factories) — open, low value, subsumed.**
  `createLog` (**188** call sites across 170 files) and `createChannelTrace`
  (**7** call sites) still both express "a module-level, run-less logger keyed by
  name." (Counted at this HEAD by
  `git grep -n '<factory>(' -- 'src/**/*.ts' 'packages/**/*.ts' | grep -vE '\.(test|vitest)\.ts|/test-kernel/'`,
  which returns 189 and 8 lines respectively — one definition line each,
  subtracted above.) The magnitude holds either way: `createLog` is the dominant
  module-logger factory and `createChannelTrace` the marginal one. As `-08-15` §4
  noted, the only safe move is narrowing individual `createChannelTrace`
  log-only callers onto `createLog` — a per-caller change, not a factory merge —
  and it is largely subsumed by the Effect re-platform of the logging surface. No
  action this pass.
- **Subagent boundary — unchanged.** `ChildRunStrategy` / `ChildRunPorts`
  (`src/agent/runtime/childRunLoop.ts`) remain a shipped, multi-implementor SPI
  driven from `src/tools/delegation/` and `src/tools/`, not a design task.
  `agentCreator` (`runAgentCreator`,
  `src/agent/implementations/agentCreator/agentCreatorFlow.ts:434`) stays the one
  genuine "logical agent not yet running as one," and stays correctly open —
  closing it needs an interactive-UI channel (`AgentCreatorUI` / approval
  prompts) that the public SDK does not expose at all: `packages/agent` no longer
  exports any `HostInteractions` interface or a `RunAgentInput.interactions`
  input (the internal run uses a fixed `HEADLESS_HOST`, `effect/sessions.ts:544`),
  so the boundary is blocked on designing a public interactive channel, not on
  un-withholding an existing one. A mechanical move it is not.

## 5. Bottom line

Nine consecutive passes (`-08-19` through `-09-09`) find a green top-line verdict.
Re-derived at **latest `main` (`dff2602`)** at the maintainer's request: node
engine holds at 158 LoC, the model-handler base is down 72 lines to 1,954 (a
reduction, not growth), the logger and `SessionHandle` stay clean, `createRunScope`
stays the one justified single-caller survivor (now `AgentLaunchContext.ts:552`),
and the host deep-import baselines hold on every package with cli at its
post-shrink 6. Two things did change: in-tree, the published SDK surface grew
(`AgentRun.view`, `closeSession` + session owner, the `./effect` subpath — §1);
and in the docs, the deeper Effect-4 re-platforming direction advanced and now
owns the standing question's SDK-surface/subagent deliverables (§3, direction
ratified, specifics still proposed), so this pass defers to those docs rather
than duplicating them, and flags the single missing artifact (a standalone
Tier-1 manifest file that must include `/effect`, §3b) for whenever the routine
is asked to act. Nothing found is a defect; nothing warrants a speculative edit
into the tree absent a maintainer request. The audit is recorded, not acted on.
