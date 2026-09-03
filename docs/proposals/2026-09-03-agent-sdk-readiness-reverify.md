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
`145 files changed, 4422 insertions(+), 1834 deletions(-)`; the additions are
spread across the codebase (docs, test-kernel, tools, `src/agent`, controllers,
transcript), with `src/agent` taking ~302 of them — so the agent core **was**
touched. The evidence it added no abstraction is not a claim the core went
untouched, but the cumulative structural end-state measured at `d418d45`
(§2–§4).

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
(§3's baselines held). The runtime public surface saw a **net reduction plus one
sanctioned, ratchet-recorded addition** — motion in the readiness-positive
direction, not a silent widening:

- **Removed:** `HostInteractions.showInfoMessage` (`810abdc`, from the exported
  interface and `SessionHostInteractions`), `SessionEventHub.assertRunSubscribersAttachedBeforeActivation()`
  (`d418d45`), and the dead `StreamSnapshotStore.deleteStream` wrapper
  (`1719dea`).
- **Added (sanctioned):** `StreamSnapshotStore.requestEviction()` (`e599027`),
  recorded in `config/ratchets/store-public-surface-baseline.json` as "the one
  sanctioned addition" (its `deleteStream` removal nets the store's method count
  unchanged).

One **SPI signature refinement** landed too: `03fa583` changed
`ChildRunStrategy.launch`/`runTurn` to take an `AbortSignal` instead of an
`AbortController`, updating all four production implementations — a contract
narrowing, with the implementation _set_ unchanged (§4). §2's structural
measurements, taken at `d418d45`, are cumulative over all 28 commits and match
the prior pass.

## 2. Every tracked structural fact re-verifies at `d418d45`

| Item                               | Expected (`-09-02` @ `646475d`)           | `d418d45` state                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Node flow engine**               | 158 LoC, `BaseNode` + `Flow` only         | **158 LoC** (`src/agent/node/index.ts`); only `class BaseNode` (`:30`) + `class Flow` (`:134`). No `BatchNode`/`ParallelBatchNode`. Matches CLAUDE.md.                                                                                                                                                                                                             |
| **M-3** `ModelHandler.ts` god-base | 2,030 LoC                                 | **2,030 LoC** (`wc -l`). Unchanged; genuinely shared behavior, no per-provider copy-paste.                                                                                                                                                                                                                                                                         |
| **§8b / PT-2** (`SessionHandle`)   | `useHostInteractions` gone                | **still gone.** `grep -rn useHostInteractions src/ packages/` returns **zero** hits.                                                                                                                                                                                                                                                                               |
| **§8a** (dead logger `export`)     | `OutputChannelFactoryOptions` de-exported | **still gone.** `src/logger/logUtils.ts:49` is `interface OutputChannelFactoryOptions` (no `export`); only internal use at `:191`.                                                                                                                                                                                                                                 |
| **SDK version**                    | 0.40.8                                    | **0.40.8** (`packages/agent/package.json`), unchanged. Correction to the inherited row: the `runFact.` retirement (TD-2c) already **landed** — no `runFact.` prefix protocol exists under `src/agent` at `d418d45`, and `runFactEvents.ts:34` emits explicit `AgentEvent` arms; the 2026-08-03 checkpoint records it done. There is no pending v0.41 runFact gate. |

## 3. Frozen host deep-import width — held on every package

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*`
deep-import specifiers per package, past the `@agent` barrel):

| Package             | `-09-02` | `d418d45` |
| ------------------- | -------- | --------- |
| cli                 | 7        | **7**     |
| desktop             | 5        | **5**     |
| extension           | 9        | **9**     |
| agent (SDK package) | 7        | **7**     |

The set-based ratchet (`hostAgentDeepImportRatchet.vitest.ts`) compares the live
import set against this checked-in JSON: it fails on an undocumented new edge (a
live specifier missing from the list) and on stale headroom (a listed specifier
no longer imported). It does **not** mechanically forbid widening — a commit that
adds an import _and_ its baseline entry passes both checks. The "never widen a
baseline" guarantee is therefore the contribution **policy** (CLAUDE.md), which
the ratchet makes visible and auditable rather than structurally impossible; no
commit in this interval exercised that escape hatch (all four lists held or
shrank). `agent`'s 7 remains at its realistic floor, bounded by the
provider-type-leak constraint (§5.2 of `-09-02`, carried forward unchanged).

## 4. Subagent boundaries — still a shipped SPI; one in-interval signature refinement

Re-confirmed at HEAD as a **shipped, multi-implementor SPI, not a design task**:
`ChildRunStrategy<TTurn>` + `ChildRunPorts` (`src/agent/runtime/childRunLoop.ts`)
— a deep module with a narrow turn-based interface, driven by independent
production factories (`nativeSubagentStrategy.ts`, `workflowScriptStrategy.ts`,
background bash, and the shared external-CLI loop). The **contract did change
once** in the interval — `03fa583` narrowed `launch`/`runTurn` to accept an
`AbortSignal` rather than an `AbortController`, updating all four
implementations in lockstep — but the implementation _set_, the deep-module
shape, and the narrow interface are unchanged; this is a signature refinement,
not a boundary redesign. **Only `agentCreator` remains
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
by refactor and fix, and it did touch the audited core (three `src/agent`
refactors and five fixes), the logger (a `date-fns` swap), the runtime public
surface (a net reduction plus one sanctioned addition), and the subagent SPI (an
`AbortSignal` signature refinement) — all readiness-positive or neutral, none
widening a baseline or adding an abstraction layer, with the cumulative
end-state at `d418d45` verified in §2–§4. Nothing found is a defect; nothing
warrants a speculative edit into the green tree absent a maintainer request,
which this scheduled firing does not carry. The pass is recorded, not acted on.
