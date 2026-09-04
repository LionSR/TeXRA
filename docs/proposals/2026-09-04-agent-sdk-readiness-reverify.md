# Agent-SDK readiness — re-verification pass (2026-09-04)

> **Status:** Written 2026-09-04 against branch HEAD `4579625`
> (`chore: bump version to 0.40.9`, #11820). The scheduled audit routine re-ran
> the standing question — "review the agent core, model handler, logger, and
> surface for unnecessary abstraction and unready surface; design subagent
> boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the most recent prior pass
> ([`-09-03`](./2026-09-03-agent-sdk-readiness-reverify.md), whose inspected
> snapshot was `d418d45`). This pass re-derived each tracked fact from fresh
> direct inspection at `4579625` — **23 commits** past the prior pass's snapshot
> — and reached the **same top-line verdict: the alignment holds.** Every claim
> below carries a `file:line`, config path, or count checked at `4579625`.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, and no structural refactor is warranted.** The pass-through wrappers and
convenience barrels the standing question hunts for are not present; single-caller
factories are down to the same one tracked, justified survivor (`createRunScope`,
a one-line immutability-freeze — one production caller at
`AgentLaunchContext.ts:470`, the other 12 `createRunScope(` call sites all
under `src/test-kernel/`). This is the **eighth consecutive** green pass (`-08-19`
through `-09-04`). The `d418d45..4579625` interval is 23 commits (§1) —
dominated by refactor (9) and docs (6), **net −141 lines** (3,272 ins /
3,413 del), and it added **no** new abstraction to the core: the interval's one
touch to `ModelHandler.ts` _removed_ two indirections (§1), no new `export class`
or `create*` factory appears in `src/agent/**` across the whole interval (§1),
and the host→`@agent` deep-import baselines held on all four packages (§3). The
cumulative structural end-state measured at `4579625` (§2) holds against the
prior pass. Consistent with the routine's default (no maintainer request
accompanies a scheduled firing), the pass is **recorded, not acted on**.

## 1. The `d418d45..4579625` interval — 23 commits: net −141, deletions and consolidations, zero new core abstraction

The prior pass inspected `d418d45`; the interval to this pass's snapshot
`4579625` is **23 commits** (`git rev-list --count`). By subject prefix
(`git log --format='%s'`, exact): **9 `refactor`, 6 `docs`, 3 `fix`, 2 `chore`,
1 `feat`, 1 `legal`, 1 `ci`** — dominated by refactor and docs, the standing
trend. The whole-interval diffstat is
`370 files changed, 3272 insertions(+), 3413 deletions(-)` — **net −141**. The
single `feat` (`dfca23b`, make GPT-5.6 the quality/new-chat default) is a
model-default config change, not new structure.

**Audited-area touches in the interval.** Five commits touch `src/agent/**`
(`git log … -- 'src/agent/**'`) — four `refactor`, one `docs`-only comment
correction. Net over `src/agent/**` is **−182** (417 ins / 599 del,
`git diff --numstat`). None introduces a new abstraction:

- `git diff d418d45..4579625 -- 'src/agent/**'` matched against
  `^\+.*(export (class|abstract class)|export function create[A-Z])` returns
  **zero** added exported classes or `create*` factories. The interval's core
  work is deletion and consolidation, not new indirection.
- `8d16c08` (#11805, behavior-preserving simplification sweep) is the interval's
  only touch to `ModelHandler.ts`, and it **removes** two indirections rather
  than adding any: it inlined the `resolveBaseUrl` pass-through helper (call site
  now `resolveProxyEndpoint(this.buildProxyConfig(...)).baseUrl`) and replaced the
  `hasEndTag(x)` wrapper with the inline `x.includes(OUTPUT_END_TAG)` at both use
  sites. Net `−4` on the file (§2). This is the exact species of unnecessary
  abstraction the standing question hunts for — now gone, not added.
- `733b8a4` (#11804, land the tail of the recorded audits — 44 verified findings
  in nine batches) and `361ae9e` (#11814, post-merge consolidation follow-ups)
  are deletion/consolidation sweeps; `733b8a4`'s `childRunLoop.ts` touch is
  net `−7` (16 ins / 23 del) and **does not change the `ChildRunStrategy` SPI
  signature** (§4) — a `grep` of the file's interval diff for
  `interface ChildRunStrategy|interface ChildRunPorts|launch|runTurn|formatDelivery`
  returns no changed line.
- `49907f5` (#11793, give stop and sendFollowUp one home each) is a
  one-home-per-user-action consolidation removing duplicate command surfaces —
  net `−57` across 16 files.
- `35bd24a` (#11803) is a docs-only comment correction, no code change.

Adjacent single-owner/surface-narrowing consolidations in the interval, outside
`src/agent/**` but in the audited "surface" area, all reductions:

- `9aaedfd` (#11808) gave the startup stream sweep one owner per host instead of
  a flag; `91fa38b` (#11802) made `DesktopAgentExecution.runExecution` private
  (surface narrowing); `939ccf9` (#11794) deleted the `taskRuns` absolute-path
  arm (dead path).

**Logger:** untouched in the interval —
`git log … -- 'src/logger/**'` returns no commits — and separately re-verified
clean at HEAD (§2). **`ModelHandler.ts`** changed only by the `−4` simplification
above.

## 2. Every tracked structural fact re-verifies at `4579625`

| Item                               | Expected (`-09-03` @ `d418d45`)           | `4579625` state                                                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node flow engine**               | 158 LoC, `BaseNode` + `Flow` only         | **158 LoC** (`src/agent/node/index.ts`); only `class BaseNode` (`:30`) + `class Flow` (`:134`). No `BatchNode`/`ParallelBatchNode`. Matches CLAUDE.md.                                                                        |
| **M-3** `ModelHandler.ts` god-base | 2,030 LoC                                 | **2,026 LoC** (`wc -l`), **−4** via `8d16c08`'s two removed indirections (§1). Genuinely shared behavior, no per-provider copy-paste; the delta is a simplification, not growth.                                              |
| **§8b / PT-2** (`SessionHandle`)   | `useHostInteractions` gone                | **still gone.** `grep -rn useHostInteractions src/ packages/` returns **zero** hits.                                                                                                                                          |
| **§8a** (dead logger `export`)     | `OutputChannelFactoryOptions` de-exported | **still gone.** `src/logger/logUtils.ts:49` is `interface OutputChannelFactoryOptions` (no `export`); only internal use at `:191`.                                                                                            |
| **L-3** (dead redaction branch)    | `redactSecrets` single-arg                | **still closed.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:81`); no options branch.                                                                                                    |
| **SDK version**                    | 0.40.8                                    | **0.40.9** (`packages/agent/package.json`, bumped by `4579625`/#11820). Version bump only; no surface change. No pending v0.41 runFact gate (retired per the prior pass's TD-2c correction).                                  |
| **createRunScope** survivor        | 1 production caller @ `:470`              | **1 production caller** (`src/agent/runtime/AgentLaunchContext.ts:470`); the other 12 `createRunScope(` call sites are all under `src/test-kernel/` (plus 9 test-kernel import lines). Tracked retention decision, unchanged. |

## 3. Frozen host deep-import width — held on every package

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*`
deep-import specifiers per package, past the `@agent` barrel):

| Package             | `-09-03` | `4579625` |
| ------------------- | -------- | --------- |
| cli                 | 7        | **7**     |
| desktop             | 5        | **5**     |
| extension           | 9        | **9**     |
| agent (SDK package) | 7        | **7**     |

The set-based ratchet (`hostAgentDeepImportRatchet.vitest.ts`) compares the live
import set against this checked-in JSON: it fails on an undocumented new edge and
on stale headroom. No commit in this interval widened any list (all four held).
`agent`'s 7 remains at its realistic floor, bounded by the provider-type-leak
constraint (carried forward unchanged).

## 4. Subagent boundaries — still a shipped SPI; named SPI signatures unchanged, one adjacent surface reduction

Re-confirmed at HEAD as a **shipped, multi-implementor SPI, not a design task**:
`ChildRunStrategy<TTurn>` + `ChildRunPorts` (`src/agent/runtime/childRunLoop.ts`
`:168` and `:105`) — a deep module with a narrow turn-based interface, driven by
independent production implementations, which live under `src/tools/delegation/`
and `src/tools/`, not `src/agent/runtime/`: **four strategy-construction sites**
— three factory functions that _return_ a `ChildRunStrategy<…>`
(`nativeSubagentStrategy.ts` `:207`, `workflowScriptStrategy.ts` `:157`, and the
background-bash strategy in `bash.ts` `:249`), plus one built inline inside the
external-CLI loop entrypoint `startAgentCliLoop` (`agentCliShared.ts:515`, a
`void`-returning function `:463` that constructs the typed strategy locally and
hands it straight to `startChildRunLoop`, rather than returning it). The
four-implementor conclusion holds; only the shape of the fourth site differs.
(`detachedChildRun.ts` is **not** a fifth implementor — it is detached-execution
choreography that forwards a caller-supplied `strategy` to the loop, so it is
excluded from this count.) The **two named SPI interfaces did not change** in this
interval — `childRunLoop.ts`'s net `−7` (from the `733b8a4` audit sweep) leaves
the `ChildRunStrategy`/`ChildRunPorts` signatures untouched (§1), unlike the
prior interval's `AbortSignal` refinement. The same sweep did make one _adjacent_
surface change on the child-stream boundary, and it is a **reduction**: `733b8a4`
removed the exported `ChildRunOutcome` union from `childRunLoop.ts` (zero hits
repo-wide at HEAD; it was deep-imported only by
`src/tools/delegation/childStream.ts`) and tightened `ChildStreamPort.finalize`
from `options?: { outcome?: ChildRunOutcome; … }` to
`options: { outcome: RunOutcome; error?: unknown; … }` — dropping a cross-module
type import and a redundant encode/decode round-trip, consistent with the
interval's deletion trend, not a boundary widening. **Only `agentCreator` remains the one
genuine "logical agent not yet running as one"** — a single linear
`runAgentCreator` (`src/agent/implementations/agentCreator/agentCreatorFlow.ts:434`,
one `export async function`), running inline in the extension host. That boundary
stays open **correctly**: closing it is interactive-UI design work (the
`AgentCreatorUI`/approval channel the public `HostInteractions` deliberately
lacks), not a mechanical move.

## 5. Remaining open items — one closed this interval, the rest carried forward, none a defect

Design-gated; not restated in full. **One item closed in this interval:** the
former (6) result-taxonomy documentation — `733b8a4` landed it on the published
SDK surface. `packages/agent/README.md:58-80` now documents the single
`AgentFlowResult` (discriminated on `category`), why the non-terminal `WAITING`
shape is deliberately unexported and never resolves `result`, and why the
normalized `cost` breakdown and per-file `diffs` stay internal while the contract
exposes only the coarse `totalCostUsd`; the commit message records
`agent-sdk-readiness:S6` complete. This is a readiness advance, not a regression.

The rest carry forward unchanged: (1) `IModelHandler` is a hand-maintained
`Pick<ModelHandler<…>>` — the correct anti-drift choice internally, a
manifest-design note for a public SDK; (2) the provider-SDK type leak (`M`/`T`)
is the floor on `agent`'s 7 specifiers; (3) logger + telemetry are process-global
singletons whose SDK-correct unlock (injectable owners behind Tier-1 doors) is
designed for logging, unspecified for usage/telemetry; (4) the two open Tier-1
leaf surfaces still to be fronted behind existing doors (`agentCreatorFlow`,
`core/state`) remain leaf surfaces, not members of the eight named doors (all
present with `index.ts`); (5) `HostInteractions` required/optional is an open
maintainer contract decision; (7) publication remains gated on the
named-external-consumer hold.

## 6. Bottom line

Eight consecutive passes (`-08-19` through `-09-04`) now find a green top-line
verdict. This pass re-derived every tracked fact from fresh inspection at
`4579625`: the node engine holds at 158 LoC, the model-handler base at 2,026
(down 4 from a simplification, not up), `SessionHandle` and the logger stay
clean, `createRunScope` stays the one justified single-caller survivor, and all
four deep-import baselines held. The 23-commit interval since the prior pass's
snapshot (§1) is net −141, dominated by refactor and docs; its `src/agent`
touches are deletion and consolidation with **no** new exported class or factory,
and its one `ModelHandler.ts` change removed two indirections. The subagent SPI
is unchanged in shape, with `agentCreator` still the single correctly-open
boundary. Nothing found is a defect; nothing warrants a speculative edit into the
green tree absent a maintainer request, which this scheduled firing does not
carry. The pass is recorded, not acted on.
