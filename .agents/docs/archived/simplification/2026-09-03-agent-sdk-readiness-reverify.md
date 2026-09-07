# Agent-SDK readiness — re-verification pass (2026-09-03)

Status: implemented
Archived: 2026-09-06

> **Status:** Written 2026-09-03 against branch HEAD `d418d45`
> (`refactor: delete five dead surfaces in the runtime and CLI approval layers`,
> #11792). The scheduled audit routine re-ran the standing question — "review the
> agent core, model handler, logger, and surface for unnecessary abstraction and
> unready surface; design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](../architecture/2026-07-09-agent-sdk-north-star.md))
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
shape, and no structural refactor is warranted.** The pass-through wrappers and
convenience barrels the standing question hunts for are not present; single-caller
factories are down to one tracked, justified survivor (`createRunScope`, a
one-line immutability-freeze — one production caller at
`AgentLaunchContext.ts:470`, tracked as a retention decision, not a candidate for
removal). This is the **seventh consecutive** green pass (`-08-19`
through `-09-03`). The `646475d..d418d45` interval is 28 commits (§1) —
dominated by refactor and fix; its only new core structure is one _justified_
dedup extraction (`IncarnationMap`, evaluated in §1), its only public-surface
growth is one _sanctioned_, ratchet-recorded store method (offset by a removal),
and the host→`@agent` deep-import baselines held — and the cumulative structural
end-state measured at `d418d45` (§2) holds against the prior pass. Consistent with the routine's default (no
maintainer request accompanies a scheduled firing), the pass is **recorded, not
acted on**.

## 1. The `646475d..d418d45` interval — 28 commits: deletions, fixes, one justified core extraction

The prior pass inspected `646475d`; the interval to this pass's snapshot
`d418d45` is **28 commits** (`git rev-list --count`). By subject prefix
(`git log --format='%s'`, exact): **12 `refactor`, 9 `fix`, 2 `feat`, 2
`chore`, 2 `docs`, 1 unprefixed** (`9f156ef` "Replace custom cache with
LRUCache…") — dominated by refactor and fix, the standing trend. The
whole-interval diffstat is
`145 files changed, 4422 insertions(+), 1834 deletions(-)`; the additions are
spread across the codebase (docs, test-kernel, tools, `src/agent`, controllers,
transcript), with `src/agent` taking ~302 of them — so the agent core **was**
touched. The evidence it added no **unnecessary** abstraction — the interval's
one new class, `IncarnationMap`, is evaluated below as a justified dedup
extraction — is not a claim the core went untouched, but the cumulative
structural end-state measured at `d418d45` (§2–§4).

**Audited-area touches in the interval.** Eight commits touch `src/agent/**`
(`git log … -- 'src/agent/**'`) — three `refactor`, five `fix`. Two of the
refactors are pure deletion/consolidation; the third introduces one new class,
evaluated below and judged justified:

- `refactor`: `d418d45` (#11792, five dead surfaces deleted — see table),
  `974d459` (#11775, staged-deletion single-owner — see table), `b024fba`
  (#11780, extract `IncarnationMap` for `SessionStores`' nested deletion maps).
  **`b024fba` does add an abstraction** — a new `IncarnationMap` class (`SessionStores.ts`
  net +43) — so the "no new abstraction" question must be answered for it, not
  assumed: it has **two `new IncarnationMap` construction sites** within
  `SessionStores` (`pendingStreamDeletions` and `streamDeletionClaims`, ~10
  method invocations across them) and encapsulates real nested-map bookkeeping,
  clearing the repo's factory/class bar (multiple consumers + real logic;
  AGENTS.md) and dedup'ing repeated logic. It is a
  justified extraction, the opposite of the single-caller/speculative
  indirection the standing question flags — but it _is_ new structure in the
  core, recorded here rather than waved past.
- `fix`: `e2118c5` (#11786, stop double-emitting the parent-edge clear on
  detach), `3422b5f` (#11785, keep a live reservation when restart repair holds
  a stream), `d4fd6a9` (#11787, read both child-policy toggles through the
  settings catalog), `810abdc` (#11789, stop dropping the resume-failure
  notice), `03fa583` (#11757, release per-subagent/per-request state in long CLI
  runs).

Plus one logger touch — `a251cd8` (#11777) `refactor`: use `date-fns` for log
timestamp formatting (`logUtils`, a dependency swap retiring hand-rolled code).
The model handler (`src/agent/modelHandlers/ModelHandler.ts`) is **unchanged in
the interval** — `git diff --numstat 646475d..d418d45 --` returns no row for it,
so it contributes none of the `src/agent` 302 — and is separately re-measured at
2,030 LoC (§2).

The two commits that landed **after** the `-09-02` doc's own commit `7aa9985`
(all line counts from `git show --numstat`, i.e. true net deltas, not `--stat`
histogram widths):

| Commit             | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d418d45` (#11792) | **Net −354** (122 ins / 476 del). Deleted five dead surfaces across the runtime + CLI approval layers — `SessionEventHub.ts` (net −49), `executionListing.ts`, and the CLI `approvalAdapter`/`approvalPrompts` pair. Directly in the audited "surface" area: pure removal, no new export.                                                                                                                                                                                                                                                                                                                   |
| `974d459` (#11775) | **Consolidation, net +14** (82 ins / 68 del). Introduced one new exported helper — `deleteTranscriptWithSnapshotRollback` in `StagedDeletionCoordinator.ts` — and routed both `SessionStores` (`:948`) and `adjacentStreamCleanup` (`:72`) through it: **2 production callers dedup'ing genuine rollback logic**, clearing the same factory/class bar as `IncarnationMap` above. Net per-file: `StagedDeletionCoordinator.ts` +30, `adjacentStreamCleanup.ts` −9 (4 / 13), `SessionStores.ts` −7 (19 / 26). A justified extraction — evaluated, not waved past — the same treatment given `IncarnationMap`. |

The section above is a **characterization**, not an exhaustive signature-diff:
the interval carries other public-surface simplifications too (e.g. `03fa583`
also removed `SessionHandle.onResult`'s `replayMissed` option and
`AgentExecutionHandle.attachToolUseFlow`'s optional signal; `d418d45` removed
the injectable dependency seam from `createLatexExecutionDiscovery` and the
matching test file — the factory itself remains exported at
`src/agent/storage/executionListing.ts:291` and `src/agent/storage/index.ts:43`,
with live desktop and extension callers). These are removals or narrowings,
consistent with the trend below. What the verdict rests on is the **cumulative
end-state at `d418d45`** (§2–§4), not an exhaustive interval diff — the reason
the tracked-fact table is built to be re-runnable against any snapshot.

Bounded claims about baseline motion in the interval:

- **Host→`@agent` deep-import baselines:** held on every package (§3, ratchet-checked).
- **Public store-method surface:** transiently widened 21→22 (`e599027` adds
  `StreamSnapshotStore.requestEviction()`, recorded in
  `config/ratchets/store-public-surface-baseline.json` as "the one sanctioned
  addition"), then 22→21 (`1719dea` removes the dead `deleteStream`) — one
  sanctioned, ratchet-recorded addition offset by a removal.
- **SPI signature refinement on the subagent boundary:** `03fa583` changed
  `ChildRunStrategy.launch`/`runTurn` to take an `AbortSignal` instead of an
  `AbortController`; all four production implementations updated in lockstep,
  boundary shape and implementation set unchanged (§4).

§2's structural measurements, taken at `d418d45`, are cumulative over all 28
commits and match the prior pass.

## 2. Every tracked structural fact re-verifies at `d418d45`

| Item                               | Expected (`-09-02` @ `646475d`)           | `d418d45` state                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Node flow engine**               | 158 LoC, `BaseNode` + `Flow` only         | **158 LoC** (`src/agent/node/index.ts`); only `class BaseNode` (`:30`) + `class Flow` (`:134`). No `BatchNode`/`ParallelBatchNode`. Matches CLAUDE.md.                                                                                                                                                                                                             |
| **M-3** `ModelHandler.ts` god-base | 2,030 LoC                                 | **2,030 LoC** (`wc -l`). Unchanged; genuinely shared behavior, no per-provider copy-paste.                                                                                                                                                                                                                                                                         |
| **§8b / PT-2** (`SessionHandle`)   | `useHostInteractions` gone                | **still gone.** `grep -rn useHostInteractions src/ packages/` returns **zero** hits.                                                                                                                                                                                                                                                                               |
| **§8a** (dead logger `export`)     | `OutputChannelFactoryOptions` de-exported | **still gone.** `src/logger/logUtils.ts:49` is `interface OutputChannelFactoryOptions` (no `export`); only internal use at `:191`.                                                                                                                                                                                                                                 |
| **L-3** (dead redaction branch)    | `redactSecrets` single-arg                | **still closed.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:81`); no options branch.                                                                                                                                                                                                                                         |
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
Tier-1 doors) is designed for logging, unspecified for usage/telemetry;
(4) **correction to the inherited row:** the eight named Tier-1 doors
(`index`/`runtime`/`storage`/`trace`/`followUp`/`export`/`review`/`templates`)
all have `index.ts` at `d418d45` and are **present**. The two open items
(`agentCreatorFlow`, `core/state`) are **leaf surfaces still to be fronted
behind existing doors**, not two members of the eight-door manifest — a
distinction prior passes elided; (5) `HostInteractions` required/optional is an open maintainer contract
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
surface (a net reduction plus one sanctioned, ratchet-recorded addition), and the
subagent SPI (an `AbortSignal` signature refinement). The one new core structure
is a justified dedup extraction (`IncarnationMap`, §1); no _unsanctioned_
baseline widening or _unnecessary_ abstraction appears, and the cumulative
end-state at `d418d45` is verified in §2–§4. Nothing found is a defect; nothing
warrants a speculative edit into the green tree absent a maintainer request,
which this scheduled firing does not carry. The pass is recorded, not acted on.
