# Agent-SDK readiness — re-verification pass (2026-09-03)

> **Status:** Written 2026-09-03 against branch HEAD `d418d45`
> (`refactor: delete five dead surfaces in the runtime and CLI approval layers`,
> #11792). The scheduled audit routine re-ran the standing question — "review the
> agent core, model handler, logger, and surface for unnecessary abstraction and
> unready surface; design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the most recent prior pass
> ([`-09-02`](./2026-09-02-agent-sdk-readiness-reverify.md), whose inspected
> snapshot was `646475d`). This pass re-derived each tracked fact from fresh
> direct inspection at `d418d45` — **28 commits** past the prior pass's snapshot
> (26 code + 2 docs; only the last two landed after the `-09-02` doc's own commit
> `7aa9985`) — and reached the **same top-line verdict: the alignment holds.**
> The structural measurements below are taken at `d418d45` and so reflect the
> cumulative end-state of the whole `646475d..d418d45` interval, not a two-commit
> delta. Every claim below carries a `file:line`, config path, or count checked
> at `d418d45`.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, and no structural refactor is warranted.** The pass-through wrappers,
convenience barrels, and single-caller factories the standing question hunts for
are not present. This is the **seventh consecutive** green pass (`-08-19`
through `-09-03`). The `646475d..d418d45` interval is 28 commits (§1) —
dominated by refactor and fix, with no wrapper layer added and no baseline
widened — and the cumulative structural end-state measured at `d418d45` (§2)
holds against the prior pass. Consistent with the routine's default (no
maintainer request accompanies a scheduled firing), the pass is **recorded, not
acted on**.

## 1. The `646475d..d418d45` interval — 28 commits, no baseline widened

The prior pass inspected `646475d`; the interval to this pass's snapshot
`d418d45` is **28 commits** (`git rev-list --count`). By subject prefix
(`git log --format='%s'`, exact): **12 `refactor`, 9 `fix`, 2 `feat`, 2
`chore`, 2 `docs`, 1 unprefixed** (`9f156ef` "Replace custom cache with
LRUCache…") — dominated by refactor and fix, the standing trend. The
whole-interval diffstat is
`145 files changed, 4422 insertions(+), 1834 deletions(-)`. Additions by top
path (`git diff --numstat`, aggregated): **`docs/` 2098** (the two survey/record
docs), then `src/test-kernel` 537, `src/tools` 368, **`src/agent` 302**,
`src/controllers` 253, `src/transcript` 244 — spread across the codebase from
the refactor/fix churn, not concentrated in the two `feat` model-catalog
commits (`src/model` took just 3 added lines; the model rows live in a
dependency). So the agent core **was** touched (302 added lines across 8
commits, below) — the evidence it added no abstraction is the cumulative
structural end-state at `d418d45` (§2–§4), not any claim the core went
untouched.

**Audited-area touches in the interval.** Eight commits touch `src/agent/**`
(`git log … -- 'src/agent/**'`) — three `refactor`, five `fix` — all
simplification or bug-fix, none introducing an abstraction layer:

- `refactor`: `d418d45` (#11792, five dead surfaces deleted — see table),
  `974d459` (#11775, staged-deletion single-owner — see table), `b024fba`
  (#11780, extract `IncarnationMap` for `SessionStores`' nested deletion maps).
- `fix`: `e2118c5` (#11786, stop double-emitting the parent-edge clear on
  detach), `3422b5f` (#11785, keep a live reservation when restart repair holds
  a stream), `d4fd6a9` (#11787, read both child-policy toggles through the
  settings catalog), `810abdc` (#11789, stop dropping the resume-failure
  notice), `03fa583` (#11757, release per-subagent/per-request state in long CLI
  runs).

Plus one logger touch — `a251cd8` (#11777) `refactor`: use `date-fns` for log
timestamp formatting (`logUtils`, a dependency swap retiring hand-rolled code).
The model handler (`src/agent/modelHandlers/ModelHandler.ts`, counted within the
`src/agent` 302) saw no net structural change — §2 confirms it holds at
2,030 LoC.

The two commits that landed **after** the `-09-02` doc's own commit `7aa9985`
(all line counts from `git show --numstat`, i.e. true net deltas, not `--stat`
histogram widths):

| Commit             | Effect                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `d418d45` (#11792) | **Net −354** (122 ins / 476 del). Deleted five dead surfaces across the runtime + CLI approval layers — `SessionEventHub.ts` (net −49), `executionListing.ts`, and the CLI `approvalAdapter`/`approvalPrompts` pair. Directly in the audited "surface" area: pure removal, no new export.                                            |
| `974d459` (#11775) | **Consolidation, net +14** (82 ins / 68 del). Gave the staged-deletion rollback path and the `sr`-only recipe a single owner: `StagedDeletionCoordinator.ts` +30, `adjacentStreamCleanup.ts` −9 (4 / 13), `SessionStores.ts` −7 (19 / 26). Net-positive because logic moved to one owner — indirection removal, not new abstraction. |

No commit in the interval widens the frozen host→`@agent` deep-import width
(§3's baselines held). The one public-surface change is a **tracked, sanctioned
transition**, not a silent widening: `e599027` (#11762) adds
`StreamSnapshotStore.requestEviction()` — recorded in
`config/ratchets/store-public-surface-baseline.json` as "the one sanctioned
addition" — and `1719dea` (#11788) removes the dead `deleteStream` wrapper, so
the store's public-method count nets unchanged while the member set did change.
Both are ratchet-governed. §2's structural measurements, taken at `d418d45`, are
cumulative over all 28 commits and match the prior pass.

## 2. Every tracked structural fact re-verifies at `d418d45`

| Item                               | Expected (`-09-02` @ `646475d`)             | `d418d45` state                                                                                                                                        |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Node flow engine**               | 158 LoC, `BaseNode` + `Flow` only           | **158 LoC** (`src/agent/node/index.ts`); only `class BaseNode` (`:30`) + `class Flow` (`:134`). No `BatchNode`/`ParallelBatchNode`. Matches CLAUDE.md. |
| **M-3** `ModelHandler.ts` god-base | 2,030 LoC                                   | **2,030 LoC** (`wc -l`). Unchanged; genuinely shared behavior, no per-provider copy-paste.                                                             |
| **§8b / PT-2** (`SessionHandle`)   | `useHostInteractions` gone                  | **still gone.** `grep -rn useHostInteractions src/ packages/` returns **zero** hits.                                                                   |
| **§8a** (dead logger `export`)     | `OutputChannelFactoryOptions` de-exported   | **still gone.** `src/logger/logUtils.ts:49` is `interface OutputChannelFactoryOptions` (no `export`); only internal use at `:191`.                     |
| **SDK version**                    | 0.40.8 (short of the v0.41 `runFact.` gate) | **0.40.8** (`packages/agent/package.json`). Unchanged; retirement gate not yet due.                                                                    |

## 3. Frozen host deep-import width — held on every package

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*`
deep-import specifiers per package, past the `@agent` barrel):

| Package             | `-09-02` | `d418d45` |
| ------------------- | -------- | --------- |
| cli                 | 7        | **7**     |
| desktop             | 5        | **5**     |
| extension           | 9        | **9**     |
| agent (SDK package) | 7        | **7**     |

The set-based ratchet forbids any new edge and also fails on stale headroom, so
the lists can only shrink or hold; the "never widen a baseline" invariant is
structurally enforced. `agent`'s 7 remains at its realistic floor, bounded by
the provider-type-leak constraint (§5.2 of `-09-02`, carried forward unchanged).

## 4. Subagent boundaries — unchanged, still a shipped SPI

Re-confirmed at HEAD as a **shipped, multi-implementor SPI, not a design task**:
`ChildRunStrategy<TTurn>` + `ChildRunPorts` (`src/agent/runtime/childRunLoop.ts`)
— a deep module with a narrow turn-based interface, driven by independent
production factories (`nativeSubagentStrategy.ts`, `workflowScriptStrategy.ts`,
background bash, and the shared external-CLI loop). **Only `agentCreator` remains
the one genuine "logical agent not yet running as one"** — a single linear
`runAgentCreator` (`src/agent/implementations/agentCreator/agentCreatorFlow.ts:440`),
running inline in the extension host. That boundary stays open **correctly**:
closing it is interactive-UI design work (the `AgentCreatorUI`/approval channel
the public `HostInteractions` deliberately lacks), not a mechanical move.

## 5. Remaining open items — carried forward from `-09-02`, none a defect

Unchanged and design-gated; not restated in full. In brief: (1) `IModelHandler`
is a hand-maintained `Pick<ModelHandler<…>>` — the correct anti-drift choice
internally, a manifest-design note for a public SDK; (2) the provider-SDK type
leak (`M`/`T`) is the floor on `agent`'s 7 specifiers; (3) logger + telemetry are
process-global singletons whose SDK-correct unlock (injectable owners behind
Tier-1 doors) is designed for logging, unspecified for usage/telemetry; (4) two
of eight Tier-1 doors remain open (`agentCreatorFlow`, `core/state`), both
gated; (5) `HostInteractions` required/optional is an open maintainer contract
decision; (6) result-taxonomy documentation; (7) publication remains gated on
the named-external-consumer hold.

## 6. Bottom line

Seven consecutive passes (`-08-19` through `-09-03`) now find a green top-line
verdict. This pass re-derived every tracked fact from fresh inspection at
`d418d45`: the node engine holds at 158 LoC, the model-handler base at 2,030,
`SessionHandle` and the logger stay clean, and all four deep-import baselines
held. The 28-commit interval since the prior pass's snapshot (§1) is dominated
by refactor and fix, touches audited-area files only through fixes and a
`date-fns` logging swap, and widens no baseline. Nothing found is a defect;
nothing warrants a speculative edit into the green tree absent a maintainer
request, which this scheduled firing does not carry. The pass is recorded, not
acted on.
