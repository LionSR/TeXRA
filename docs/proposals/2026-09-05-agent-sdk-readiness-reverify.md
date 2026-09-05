# Agent-SDK readiness — re-verification pass (2026-09-05)

> **Status:** Written 2026-09-05 against branch HEAD `05b6cd3`
> (`refactor(desktop): read the open-session set from the paper registry in the
> resume owner`, #11871). The scheduled audit routine re-ran the standing
> question — "review the agent core, model handler, logger, and surface for
> unnecessary abstraction and unready surface; design subagent boundaries" —
> against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the most recent prior pass
> ([`-09-04`](./2026-09-04-agent-sdk-readiness-reverify.md), whose inspected
> snapshot was `4579625`). This pass re-derived each tracked fact from fresh
> direct inspection at `05b6cd3` — **25 commits** past the prior pass's snapshot
> — and reached the **same top-line verdict: the alignment holds.** Every claim
> below carries a `file:line`, config path, or count checked at `05b6cd3`.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, and no structural refactor is warranted.** The pass-through wrappers and
convenience barrels the standing question hunts for are not present; the one
**trivial** single-caller factory the standing question tracks remains the same
justified survivor (`createRunScope`, a one-line immutability-freeze — one
production caller at `src/agent/runtime/AgentLaunchContext.ts:470`, the other
`createRunScope(` call sites all under `src/test-kernel/`). Other factories with
a single production caller do exist — e.g. `createToolPolicy`
(`AgentLaunchContext.ts:522`), `createRunContext` (`AgentLaunchContext.ts:138`),
and `createOutputState` (now `implementations/flows/reflection/output/outputState.ts:47`,
relocated from `runReflectionFlow.ts` by an interval refactor) — but each carries
real initialization logic and so clears the AGENTS.md factory bar (real logic /
captured context); they are not the trivial-pass-through category this claim
tracks. This is the **ninth consecutive** green pass (`-08-19` through `-09-05`).
The `4579625..05b6cd3` interval is 25 commits (§1); it is a larger, more
feature-heavy interval than recent passes (**5 `feat`, net +6,625 lines**), but
the growth is product work — session-scoped workspace roots, a new model, a
read-only hold, read-time phase derivation — **not** new abstraction in the
audited core: no new `export class` or `create*` factory appears anywhere in
`src/agent/**` across the whole interval (§1), the interval's `modelHandlers`
work is a cross-provider contract **unification** (§1), the logger was not
touched (§1), and the host→`@agent` deep-import baselines held on all four
packages (§3). The cumulative structural end-state measured at `05b6cd3` (§2)
holds against the prior pass. Consistent with the routine's default (no
maintainer request accompanies a scheduled firing), the pass is **recorded, not
acted on**.

## 1. The `4579625..05b6cd3` interval — 25 commits: feature-heavy but zero new core abstraction

The prior pass inspected `4579625`; the interval to this pass's snapshot
`05b6cd3` is **25 commits** (`git rev-list --count`). By subject prefix
(`git log --format='%s'`, exact): **7 `refactor`, 5 `feat`, 4 `docs`, 3 `perf`,
3 `fix`, 1 `simplify`, 1 `chore`, 1 uncategorized** (`65a53d7`, "Document
rationale for two barrel modules"). The whole-interval diffstat is
`300 files changed, 12566 insertions(+), 5941 deletions(-)` — **net +6,625**.
Unlike the recent deletion-dominated intervals, this one carries real feature
work (`2672b95` session-scoped workspace roots / one session per paper, PRD lane
6; `6949f8a` GPT-6 Astra; `c0870c7` read-only hold on write-open; `b61d8c1`
transcript close-at-exit; `df8b9e3` read-time phase derivation). None of it adds
structure to the audited core.

**Audited-area touches in the interval.** Thirteen commits touch `src/agent/**`
(`git log … -- 'src/agent/**'`). Net over `src/agent/**` is **+104**
(1,031 ins / 927 del, `git diff --numstat`) — modest growth from the feature
work, with no new indirection:

- `git diff 4579625..05b6cd3 -- 'src/agent/**'` matched against
  `^\+.*(export (class|abstract class)|export function create[A-Z])` returns
  **zero** added exported classes or `create*` factories. The interval adds
  feature behavior into existing modules, not new indirection layers.
- The interval's `modelHandlers` work is a **consolidation, not an addition**.
  `8218ed4` (#11829) unified the `AssistantTextAppendOptions` contract across
  every provider handler — `+7/−1` on `ModelHandler.ts` (net +6, the whole of
  the file's interval delta, §2) and small `+2/−1` touches across each provider
  (`anthropicMessages`, `modelHandlerAnthropic`, `modelHandlerGoogleInteractions`,
  `modelHandlerOpenAI`, `modelHandlerOpenAIResponse`, `modelHandlerOpenRouterNative`,
  `modelHandlerVscodeLm`, `modelHandlerValidation`) — collapsing per-provider
  option shapes onto one shared contract, the SSOT species the standing question
  favors. `ecbc2d6` (#11855) carries the same subject but is an **empty commit**
  (zero file changes; the contract already landed in #11829), harmless.
- `1f3f87c` (#11858) is a storage consolidation ("one executions walker; drop the
  dead `checkpointedOnly` option and stale repair prose") — a dead-option
  removal, the exact deletion species the audit favors.
- The session/runtime feats (`2672b95`, `c0870c7`, `b61d8c1`, `df8b9e3`,
  `5e4e92f`, `84d4077`, `e56abf3`) add or relocate behavior within existing
  session-lifecycle modules; several are net reductions of their own
  (`5e4e92f` "delete the background hydration pass"; `84d4077` "take the
  leftover-stream sweep off every host's ready path"; `60534e9` "delete the
  startup restart-repair pass and the readiness gate").
- `65a53d7` (#11828) **documents** the rationale for the two surviving barrel
  modules (`src/agent/index/index.ts`, `src/shared/styles/index.ts`) rather than
  adding any — `+17/−1` of comment, consistent with the "no convenience barrels"
  invariant (a barrel exists only for a documented public surface).

**Logger:** untouched in the interval — `git log … -- 'src/logger/**'` returns
**zero** commits (`git rev-list --count` = 0) — and separately re-verified clean
at HEAD (§2). **`ModelHandler.ts`** changed only by the `+6` unification above.

## 2. Every tracked structural fact re-verifies at `05b6cd3`

| Item                               | Expected (`-09-04` @ `4579625`)           | `05b6cd3` state                                                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node flow engine**               | 158 LoC, `BaseNode` + `Flow` only         | **158 LoC** (`src/agent/node/index.ts`); only `class BaseNode` (`:30`) + `class Flow` (`:134`). No `BatchNode`/`ParallelBatchNode`. Matches CLAUDE.md.                                                                        |
| **M-3** `ModelHandler.ts` god-base | 2,026 LoC                                 | **2,032 LoC** (`wc -l`), **+6** via `8218ed4`'s cross-provider contract unification (§1). Genuinely shared behavior, no per-provider copy-paste; the delta is a consolidation, not indirection growth.                       |
| **§8b / PT-2** (`SessionHandle`)   | `useHostInteractions` gone                | **still gone.** `grep -rn useHostInteractions src/ packages/` returns **zero** hits.                                                                                                                                          |
| **§8a** (dead logger `export`)     | `OutputChannelFactoryOptions` de-exported | **still gone.** `src/logger/logUtils.ts:49` is `interface OutputChannelFactoryOptions` (no `export`); only internal use at `:191`.                                                                                            |
| **L-3** (dead redaction branch)    | `redactSecrets` single-arg                | **still closed.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:81`); no options branch.                                                                                                    |
| **SDK version**                    | 0.40.9                                    | **0.40.9** (`packages/agent/package.json`). Unchanged this interval; no surface change.                                                                                                                                       |
| **createRunScope** survivor        | 1 production caller @ `:470`              | **1 production caller** (`src/agent/runtime/AgentLaunchContext.ts:470`); every other `createRunScope(` call site is under `src/test-kernel/`. Tracked retention decision, unchanged.                                          |

## 3. Frozen host deep-import width — held on every package

`config/ratchets/host-agent-import-baseline.json` (`hosts` map; distinct
`@agent/*` deep-import specifiers per package, past the `@agent` barrel):

| Package             | `-09-04` | `05b6cd3` |
| ------------------- | -------- | --------- |
| cli                 | 7        | **7**     |
| desktop             | 5        | **5**     |
| extension           | 9        | **9**     |
| agent (SDK package) | 7        | **7**     |

The set-based ratchet (`hostAgentDeepImportRatchet.vitest.ts`) compares the live
import set against this checked-in JSON: it fails on an undocumented new edge and
on stale headroom. No commit in this interval widened any list (all four held) —
notable given the interval's `desktop` refactors (`05b6cd3`, `90bdb92`,
`fe16171`) reworked per-paper wiring without adding a new `@agent` deep edge.
`agent`'s 7 remains at its realistic floor, bounded by the provider-type-leak
constraint (carried forward unchanged).

## 4. Subagent boundaries — still a shipped SPI; signatures and implementor set unchanged

Re-confirmed at HEAD as a **shipped, multi-implementor SPI, not a design task**:
`ChildRunStrategy<TTurn>` + `ChildRunPorts` (`src/agent/runtime/childRunLoop.ts`
`:168` and `:105`) — a deep module with a narrow turn-based interface, driven by
independent production implementations under `src/tools/`: **four
strategy-construction sites** — three factory functions that _return_ a
`ChildRunStrategy<…>` (`nativeSubagentStrategy.ts:207`,
`workflowScriptStrategy.ts:157`, and the background-bash strategy in
`bash.ts:249`), plus one built inline inside the external-CLI loop entrypoint
`startAgentCliLoop` (`agentCliShared.ts:515`). All four line references are
**unchanged from the prior pass**. (`detachedChildRun.ts:69` is **not** a fifth
implementor — it takes a caller-supplied `strategy` and forwards it to the loop,
so it is excluded from this count.) The two named SPI interfaces did not change
in this interval — `childRunLoop.ts` carries no interval touch to the
`ChildRunStrategy`/`ChildRunPorts` signatures. **Only `agentCreator` remains the
one genuine "logical agent not yet running as one"** — a single linear
`runAgentCreator` (`src/agent/implementations/agentCreator/agentCreatorFlow.ts:434`,
one `export async function`), running inline in the extension host. That boundary
stays open **correctly**: closing it is interactive-UI design work (the
`AgentCreatorUI`/approval channel the public `HostInteractions` deliberately
lacks), not a mechanical move.

## 5. Remaining open items — all carried forward, none a defect

Design-gated; not restated in full, and none advanced or regressed this interval:
(1) `IModelHandler` is a hand-maintained `Pick<ModelHandler<…>>`
(`src/agent/types/IModelHandler.ts:30`) — the correct anti-drift choice
internally, a manifest-design note for a public SDK; (2) the provider-SDK type
leak (`M`/`T`) is the floor on `agent`'s 7 specifiers; (3) logger + telemetry are
process-global singletons whose SDK-correct unlock (injectable owners behind
Tier-1 doors) is designed for logging, unspecified for usage/telemetry; (4) the
two open Tier-1 leaf surfaces still to be fronted behind existing doors
(`agentCreatorFlow`, `core/state`) remain leaf surfaces, not members of the eight
named doors; (5) `HostInteractions` required/optional is an open maintainer
contract decision; (7) publication remains gated on the named-external-consumer
hold. (Item (6), result-taxonomy documentation, was closed in the prior interval
by `733b8a4` and stays closed.)

## 6. Bottom line

Nine consecutive passes (`-08-19` through `-09-05`) now find a green top-line
verdict. This pass re-derived every tracked fact from fresh inspection at
`05b6cd3`: the node engine holds at 158 LoC, the model-handler base at 2,032
(+6 from a cross-provider contract unification, not a new abstraction),
`SessionHandle` and the logger stay clean, `createRunScope` stays the one
justified survivor in the trivial single-caller-factory category the standing
question tracks (§0), and all four deep-import baselines held. The 25-commit
interval since the prior pass's snapshot (§1) is net +6,625 and feature-heavy,
but its `src/agent` touches add product behavior with **no** new exported class
or factory, and its one `ModelHandler.ts` change is a consolidation. The subagent
SPI is unchanged in shape and implementor set, with `agentCreator` still the
single correctly-open boundary. Nothing found is a defect; nothing warrants a
speculative edit into the green tree absent a maintainer request, which this
scheduled firing does not carry. The pass is recorded, not acted on.
