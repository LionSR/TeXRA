# Agent-SDK readiness — re-verification pass (2026-09-06)

> **Status:** Written 2026-09-06 against branch HEAD `03d2cfd`
> (`chore(deps-dev): bump the development-dependencies group`, #11842). The
> scheduled audit routine re-ran the standing question — "review the agent
> core, model handler, logger, and surface for unnecessary abstraction and
> unready surface; design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the most recent prior pass
> ([`-09-04`](./2026-09-04-agent-sdk-readiness-reverify.md), whose inspected
> snapshot was `4579625`). This pass re-derived each tracked fact from fresh
> direct inspection at `03d2cfd` — **44 commits** past the prior pass's snapshot
> — and reached the **same top-line verdict: the alignment holds.** Every claim
> below carries a `file:line`, config path, or count checked at `03d2cfd`.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, and no structural refactor is warranted.** This is the **ninth
consecutive** green pass (`-08-19` through `-09-06`). It is also the first pass
to span a *large, additive-looking* interval — 44 commits, 11 of them `feat`,
net **+1,404** LoC inside `src/agent/**` — so the pass looked past the diffstat
sign and inspected the two new exported classes the standing question would flag.
Both clear: neither is the pass-through wrapper / convenience-barrel / god-object
species the question hunts for.

- **`SessionEventLog`** (`src/agent/runtime/SessionEvents.ts:144`, `extends
  Context.Service`) is genuinely new, but it is a **replacement, not an
  addition**: the same fold (#11881) **deleted `SessionEventHub`** (0 hits under
  `src/` and `packages/` at HEAD; the file existed at `4579625`) and folded the
  session-authored-fact plane onto one Effect service with a `Layer`
  (`sessionEventsLayer`, `:421`). CLAUDE.md already names this as the canonical
  session-owned channel ("facts the session itself authors … published as drafts
  through `SessionHandle.publish` … `SessionEvents` (`src/agent/runtime/`)"), so
  it is documented intended architecture, and it is a deep module behind a narrow
  reader, not indirection.
- **`AgentExecutionHandle`** (`src/agent/runtime/ExecutionHandle.ts:120`) is
  **not new** — it existed at `4579625` and matched the "added class" grep only
  because it gained a type parameter (`class AgentExecutionHandle {` →
  `class AgentExecutionHandle<`, #11881). It remains a rich domain handle
  (`settleResult`, `claimTerminalFinalize`, `detach`, `interrupt`, `suspend`,
  `beginSuspendedTermination`) with the same anti-drift `Pick<>` façade
  (`AgentRunHandle = Pick<…>`, `:350`) the codebase uses for `IModelHandler`.

The one **trivial** single-caller factory the standing question tracks remains
the same justified survivor: `createRunScope` — **one** production caller
(`src/agent/runtime/AgentLaunchContext.ts:526`; line moved from `:470` with the
fold, count unchanged), every other call site under `src/test-kernel/`.
Consistent with the routine's default (no maintainer request accompanies a
scheduled firing), the pass is **recorded, not acted on.**

## 1. The `4579625..03d2cfd` interval — 44 commits: a large SDK session-ownership fold, net −34k repo-wide, zero new core indirection

The interval is **44 commits** (`git rev-list --count`). By subject prefix
(exact): **14 `refactor`, 11 `feat`, 7 `docs`, 5 `fix`, 3 `perf`, 2 `chore`, 1
`simplify`** (plus 2 unprefixed). The whole-interval diffstat is
`864 files changed, 46290 insertions(+), 80293 deletions(-)` — **net −34,003.**
The interval is the landing of the session-ownership / D5 fold across its PRD
lanes (session view, Effect session services, three renderers, session-scoped
workspace roots); its dominant motion is deletion — representative subjects:
"delete the history import" (#11912), "retire the unread view fields, the
orphaned applier/state modules, and the duplicated host wiring" (#11897), "read
run facts at row open; delete the background hydration pass" (#11836), "delete
the startup restart-repair pass and the readiness gate" (#11837), "one
executions walker; drop the dead checkpointedOnly option" (#11858).

**Audited-area touches.** `src/agent/**` is `+2,882 / −1,478 = net +1,404`
(`git diff --numstat`). The `+1,404` is the new session substrate, and it is a
*substitution*: `SessionEvents.ts` adds 585 lines (#11881) and `SessionEventHub`
is deleted in the same fold (§0). The two exported classes the grep surfaced are
accounted for in §0 (one a replacement of a deleted hub, one a pre-existing class
that gained a generic). **No new convenience barrel** was added:
`git log --diff-filter=A … -- 'src/agent/**/index.ts'` returns zero; #11828
*documents* the two pre-existing barrels
(`src/agent/index/index.ts`, `src/shared/styles/index.ts`), it does not add one.

**`ModelHandler.ts`:** `2,032` LoC (`wc -l`), **+6** from `4579625`'s 2,026. The
delta is a *consolidation*, not growth in indirection: `8218ed4` (#11829,
`refactor(modelHandlers): unify AssistantTextAppendOptions contract`) is `+7/−1`,
and `47b7e85` is `+1/−1`. No per-provider copy-paste, no new god-surface.

**Logger:** untouched in the interval — `git log … -- 'src/logger/**'` returns
no commits — and separately re-verified clean at HEAD (§2).

## 2. Every tracked structural fact re-verifies at `03d2cfd`

| Item                               | Expected (`-09-04` @ `4579625`)           | `03d2cfd` state                                                                                                                                              |
| ---------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node flow engine**               | 158 LoC, `BaseNode` + `Flow` only         | **158 LoC** (`src/agent/node/index.ts`); only `class BaseNode` (`:30`) + `class Flow` (`:134`). No `BatchNode`/`ParallelBatchNode`. Matches CLAUDE.md.       |
| **M-3** `ModelHandler.ts` god-base | 2,026 LoC                                 | **2,032 LoC**, `+6` via a contract-unification refactor (§1). Genuinely shared behavior, no per-provider copy-paste; the delta is a consolidation.           |
| **§8b / PT-2** (`SessionHandle`)   | `useHostInteractions` gone                | **still gone.** `grep -rn useHostInteractions src/ packages/` returns **zero** hits.                                                                         |
| **§8a** (dead logger `export`)     | `OutputChannelFactoryOptions` de-exported | **still gone.** `src/logger/logUtils.ts:49` is `interface OutputChannelFactoryOptions` (no `export`); only internal use at `:191`.                           |
| **L-3** (dead redaction branch)    | `redactSecrets` single-arg                | **still closed.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:81`); no options branch.                                   |
| **SDK version**                    | 0.40.9                                    | **0.40.9** (`packages/agent/package.json`) — unchanged. No surface change.                                                                                   |
| **createRunScope** survivor        | 1 production caller @ `:470`              | **1 production caller** (`src/agent/runtime/AgentLaunchContext.ts:526`; moved with the fold). The other call sites are all under `src/test-kernel/`.          |
| **`SessionEventHub`**              | present (pre-fold hub)                     | **deleted.** 0 hits under `src/`/`packages/`; replaced by `SessionEventLog` + `sessionEventsLayer` (§0).                                                      |

## 3. Frozen host deep-import width — held on three packages, **shrank** on cli

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*`
deep-import specifiers per package, past the `@agent` barrel):

| Package             | `-09-04` | `03d2cfd` |
| ------------------- | -------- | --------- |
| cli                 | 7        | **6** ▾   |
| desktop             | 5        | **5**     |
| extension           | 9        | **9**     |
| agent (SDK package) | 7        | **7**     |

The set-based ratchet (`hostAgentDeepImportRatchet.vitest.ts`) fails on an
undocumented new edge and on stale headroom. **cli dropped `@agent/trace`** in
the fold (#11881) — one fewer internal edge a future SDK barrel must re-export.
This is the ratchet working as intended (the file's own semantics note: "Removing
a deep import … is welcome and should shrink this file"). The other three held;
`agent`'s 7 remains at its realistic floor, bounded by the provider-type-leak
constraint (carried forward unchanged).

## 4. Subagent boundaries — still a shipped SPI; signatures unchanged

Re-confirmed at HEAD as a **shipped, multi-implementor SPI, not a design task**:
`ChildRunStrategy<TTurn>` + `ChildRunPorts` (`src/agent/runtime/childRunLoop.ts`
`:168` and `:105`). `childRunLoop.ts` has **no commits in the interval**
(`git log … -- src/agent/runtime/childRunLoop.ts`), so the two named SPI
signatures did not change. Production strategy construction lives under
`src/tools/` (`nativeSubagentStrategy.ts`, `workflowScriptStrategy.ts`,
`bash.ts`, plus the inline `agentCliShared.ts` loop; `detachedChildRun.ts`
forwards a caller-supplied strategy and is not an implementor). **`agentCreator`
remains the one genuine "logical agent not yet running as one"** — a single
linear `runAgentCreator` (`src/agent/implementations/agentCreator/agentCreatorFlow.ts:434`,
one `export async function`), running inline in the extension host. That boundary
stays open **correctly**: closing it is interactive-UI design work (the
`AgentCreatorUI`/approval channel the public `HostInteractions` deliberately
lacks), not a mechanical move.

## 5. Remaining open items — carried forward, none a defect

All design-gated and unchanged from `-09-04`, not restated in full: (1)
`IModelHandler` is a hand-maintained `Pick<ModelHandler<…>>` (correct anti-drift
choice internally, a manifest-design note for a public SDK); (2) the provider-SDK
type leak (`M`/`T`) is the floor on `agent`'s 7 specifiers; (3) logger +
telemetry are process-global singletons whose SDK-correct unlock (injectable
owners behind Tier-1 doors) is designed for logging, unspecified for
usage/telemetry; (4) the two open Tier-1 leaf surfaces (`agentCreatorFlow`,
`core/state`) remain leaf surfaces, not members of the named doors; (5)
`HostInteractions` required/optional is an open maintainer contract decision; (7)
publication remains gated on the named-external-consumer hold. The session-view /
Effect-session-services fold (§1) is a **readiness advance** on the plan of
record, not a regression: it collapses the dual event-plane (hub → one Effect
service) that prior passes tracked as a consolidation target.

## 6. Bottom line

Nine consecutive passes (`-08-19` through `-09-06`) now find a green top-line
verdict. This pass re-derived every tracked fact from fresh inspection at
`03d2cfd`: the node engine holds at 158 LoC, the model-handler base at 2,032
(`+6` from a contract-unification consolidation), `SessionHandle` and the logger
stay clean, `createRunScope` stays the one justified trivial-factory survivor,
and `SessionEventHub` is gone. The 44-commit interval is the large
session-ownership / D5 fold — net −34k repo-wide, its `src/agent` `+1,404` a
*substitution* (`SessionEventHub` deleted, the `SessionEvents` Effect plane
added) that CLAUDE.md documents as canonical architecture, with **no** new
convenience barrel and **no** new pass-through wrapper. The one host deep-import
baseline that moved, moved **down** (cli 7→6). The subagent SPI is unchanged in
shape, with `agentCreator` still the single correctly-open boundary. Nothing
found is a defect; nothing warrants a speculative edit into the green tree absent
a maintainer request, which this scheduled firing does not carry. The pass is
recorded, not acted on.
