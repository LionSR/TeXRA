# Agent-SDK readiness — re-verification pass (2026-09-03)

> **Status:** Written 2026-09-03 against branch HEAD `d418d45`
> (`refactor: delete five dead surfaces in the runtime and CLI approval layers`,
> #11792). The scheduled audit routine re-ran the standing question — "review the
> agent core, model handler, logger, and surface for unnecessary abstraction and
> unready surface; design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the most recent prior pass
> ([`-09-02`](./2026-09-02-agent-sdk-readiness-reverify.md), written at
> `646475d`). This pass re-derived each tracked fact from fresh direct inspection
> at `d418d45` — two commits past the prior pass — and reached the **same
> top-line verdict: the alignment holds.** Every claim below carries a
> `file:line`, config path, or count checked at `d418d45`.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, and no structural refactor is warranted.** The pass-through wrappers,
convenience barrels, and single-caller factories the standing question hunts for
are not present. This is the **seventh consecutive** green pass (`-08-19`
through `-09-03`). Both commits merged since `-09-02` are net-negative
refactors on audited surfaces — readiness-positive, adding no wrapper layer and
widening no baseline. Consistent with the routine's default (no maintainer
request accompanies a scheduled firing), the pass is **recorded, not acted on**.

## 1. Two merges since `-09-02` — both readiness-positive, on audited surfaces

| Commit             | Effect                                                                                                                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d418d45` (#11792) | **−354 net lines.** Deleted five dead surfaces across the runtime + CLI approval layers — `SessionEventHub.ts` (−51), `executionListing.ts`, and the CLI `approvalAdapter`/`approvalPrompts` pair. Directly in the audited "surface" area: pure removal, no new export. |
| `974d459` (#11775) | **Consolidation.** Gave the staged-deletion rollback path and the `sr`-only recipe a single owner (`StagedDeletionCoordinator.ts` +30, `adjacentStreamCleanup.ts` −17, `SessionStores.ts` net −4). Indirection removal, not addition.                                   |

Neither touches the frozen host→`@agent` deep-import width or adds a public
member. The window's motion is deletion and single-ownership — the standing
trend.

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
held. The two merges this window (#11792, #11775) were both net-negative
refactors on audited surfaces. Nothing found is a defect; nothing warrants a
speculative edit into the green tree absent a maintainer request, which this
scheduled firing does not carry. The pass is recorded, not acted on.
