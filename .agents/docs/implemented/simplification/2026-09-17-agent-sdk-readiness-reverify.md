# Agent-SDK readiness — re-verification pass (2026-09-17)

Status: implemented

> **Written 2026-09-17.** The scheduled audit routine re-ran the standing
> question — "review the agent core, model handler, logger, and surface for
> unnecessary abstraction and unready surface; design subagent boundaries" —
> against the immediately prior filed pass
> ([`-09-14`](./2026-09-14-agent-sdk-readiness-reverify.md), the "twelfth
> consecutive green", inspected at `d5e95a89`) and the Tier-1 manifest of record
> ([`2026-09-10-agent-sdk-tier-1-manifest.md`](../../proposed/architecture/2026-09-10-agent-sdk-tier-1-manifest.md)).
> This is the **thirteenth consecutive green pass** (`-08-19` through `-09-17`).
> No `-09-15` or `-09-16` record exists under
> [`implemented/simplification/`](./) — the routine did not file on those days —
> so `-09-14` is the immediately prior pass and the lineage has no gap in
> substance, only in calendar dates. Facts below are re-derived by direct
> inspection at branch HEAD `3d5fbda` (`main` tip, 2026-09-17) and carry a
> `file:line`, config path, or count; every citation matches what a reader sees
> on that tree.

## 0. Verdict

**The standing structural verdict holds: the codebase is well-aligned with an
Agent-SDK shape, and no speculative refactor is warranted.** Thirteen
consecutive passes (`-08-19` → `-09-17`) reach the same top-line conclusion.
What is new this pass is not the verdict but **two convergent improvements that
landed on their own since `-09-14`**, both moving in the direction the prior
passes named:

- **`-09-14` §5.2 (`turnText` duplication) — resolved, exactly as prescribed.**
  The prior pass flagged that `ModelInvoker.ts` exported `turnText` and
  `helperModel.ts` re-implemented the identical `TurnResult → string` body, and
  prescribed "relocate this pure function to a leaf module … that both import."
  That is what happened: `turnText` now lives in the leaf module
  `src/agent/runtime/run/turnText.ts:4` and is imported by all four call sites —
  `ModelInvoker.ts:90`, `runtime/loop/reflection.ts:119`, `helperModel.ts:24`,
  and `run/compaction.ts:38`. The duplicate re-implementation is gone; no shim
  was left behind. A tracked minor cleanup discharged by convergent PRs, not a
  speculative edit.
- **Host→`@agent` deep-import width shrank again.** Current
  `host-agent-import-baseline.json`: cli **5**, desktop **4**, extension **7**,
  agent (the SDK package) **7**. Against `-09-14` (5 / 4 / **8** / 7),
  **extension shrank 8 → 7**; cli/desktop/agent hold at their floor. The stated
  open work — "shrinking the frozen deep-import lists" — is progressing; no
  baseline widened.

The 50 commits between `-09-14` (`d5e95a89`) and this HEAD (`3d5fbda`) are
convergent cleanup, net-negative in the four spot-checked recent commits (e.g.
`6bbfea1` "delete dead BaseFS/RelativeFS layers and Promise-era shims", −236/+52;
`124ec8e` "drop Promise shims over synchronous run-loop work"; `a87461f` "inline
processServicesLayer, make storage roots data"). None introduces a new exported
class, wrapper layer, or one-implementor interface in the four audited areas.

Consistent with the routine's standing default — a scheduled firing carries **no
maintainer request** — this pass is **recorded, not acted on** for the codebase.
Unlike `-09-14` (which fixed a real README `effect`-version defect flagged in
review) and `-09-13`, this pass found **no defect** and no clearly-correct
one-line fix flagged in review, so there is nothing to act on: the one README
drift below (§5.4) was already flagged "for a maintainer" by `-09-14` and its
disposition is unchanged. The remaining §5 items are logged; none is a defect.

## 1. Method and scope

Four independent area audits — agent core + run loop, model handler +
`packages/llm`, logger, and the `@texra-ai/agent` package surface + subagent
boundaries — each re-derived the banned-pattern candidates (pass-through
wrappers, convenience barrels, one-impl interfaces, single-caller extractions,
re-export shims, silent degradation) and re-counted **production (non-test)
callers** for the carried-forward `create*`/factory and exported-symbol
findings, per the AGENTS.md factory bar (a factory earns its place only with
multiple callers, real logic, class construction, or captured context).

Silent-degradation spot check: `grep` for empty `catch {}` blocks across
`src/agent`, `src/model`, `src/logger`, `packages/llm`, and `packages/agent`
(test-excluded) returns **zero** hits. Consistent with prior passes, no `??` in
the four areas covers a failed read.

The per-commit diffstat trend-line accounting is not reproduced here (this
session inspected the end-state tree, sufficient for the standing question — is
there unnecessary abstraction _now_).

## 2. Tracked structural facts — re-verified against `main` (`3d5fbda`)

| Item                                          | `-09-14` state                       | This pass (`3d5fbda`)                                                                                                                                             |
| --------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node flow engine**                          | deleted                              | **still deleted.** `ls src/agent/node` → no such directory. Runs are the run-ledger Effect program (`src/shared/session/runLedger.ts`, 140 LoC).                  |
| **`ModelHandler.ts` god-base / `IModelHandler`** | deleted, no shim                  | **still gone.** `grep "class ModelHandler\|IModelHandler" src/ packages/` → zero production hits. Model stack is `ModelInvoker.ts` (**1,326** LoC) + `runtime/run/*`. |
| **`redactSecrets`**                           | single-arg, clean                    | **still clean.** `redactSecrets(text: string): string` (`src/logger/redaction.ts:93`), straight-line body.                                                       |
| **SDK version**                               | 0.41.0                               | **0.41.0** (`packages/agent/package.json`).                                                                                                                       |
| **README `effect` peer pin**                  | fixed to `4.0.0-rc.115` in `-09-14` PR | **holds.** `package.json` peer `4.0.0-rc.115`; README install guidance matches. No re-drift.                                                                    |
| **`createRunScope`** survivor                 | 1 production caller                  | **1 production caller** (`AgentLaunchContext.ts:555`); all other sites under `src/test-kernel/`. Unchanged survivor (§5.1).                                        |
| **`turnText` duplication** (`-09-14` §5.2)    | dup present, cleanup prescribed      | **resolved.** Relocated to leaf `run/turnText.ts:4`; four importers, no dup, no shim (§0).                                                                        |
| **Deep-import width** (cli/desktop/ext/agent) | 5 / 4 / 8 / 7                        | **5 / 4 / 7 / 7** — extension shrank 8→7; rest hold.                                                                                                              |
| **Tier-1 named doors**                        | 8/8 fronted                          | **8/8 fronted** — `src/agent/{export,followUp,index,review,runtime,storage,templates,trace}/index.ts` all present.                                                |

## 3. Loop ↔ ledger boundary — fold-based continuation (unchanged)

The verified property is the **continuation model**, unchanged from `-09-14`:
the two run programs (`runtime/loop/toolUse.ts`, `runtime/loop/reflection.ts`)
call `ledger.appendBatch(runId, state, [...])` and continue from what
`appendBatch` returns (`foldRunState` over committed rows), so live and resume
are the same function — no cursor, no graph, no intermediate flow engine. The
ledger implementation is `RunLedger.appendBatch` (`src/agent/runtime/RunLedger.ts`,
460 LoC — distinct from the 140-LoC session contract
`src/shared/session/runLedger.ts`; capitalization disambiguates). As `-09-14`
established, **this pass makes no single-writer claim** — the write side is
deliberately multi-owner. What is re-verified: the fold-based continuation, the
CLAUDE.md "one publisher, loop-owned cards" rule holding on the loop's own path,
and **no silent degradation** in any of the four areas (§1).

## 4. Subagent boundaries — shipped 4-implementor SPI; one boundary correctly open

`ChildRunStrategy<TTurn, R>` (`src/agent/runtime/childRunLoop.ts:158`) +
`ChildRunPorts` (`:102`), driven by the single owner `startChildRunLoop` (`:889`),
remain a shipped, multi-implementor SPI, not a design task. Four distinct
production construction sites, unchanged:

| Site                                                 | Constructor                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `src/tools/delegation/nativeSubagentStrategy.ts:193` | `createNativeSubagentStrategy` (native subagent)                  |
| `src/tools/delegation/workflowScriptStrategy.ts:156` | `createWorkflowScriptStrategy` (workflow-script child)            |
| `src/tools/bash.ts:230`                              | `createBackgroundBashStrategy` (background shell; used `:558`)    |
| `src/tools/agentCliShared.ts:615`                    | inline `const strategy: ChildRunStrategy<TTurn>` (codex/claude CLI) |

**`runAgentCreator` remains the one genuine "logical agent not yet running as
one."** A single linear `Effect.fn` generator
(`src/agent/implementations/agentCreator/agentCreatorFlow.ts:482`), one
production caller running **inline in the extension host**
(`packages/extension/src/commands/agent/agentCreatorCommands.ts:305`; moved from
`:188` at `-09-14` by intervening edits, still a single inline caller). It stays
open **correctly**: closing it is interactive-UI design work (the
`AgentCreatorUI`/`HostInteractions` approval channel the public surface
deliberately lacks), not a mechanical move (manifest §7.3).

## 5. Findings (all carried forward; none a defect; none acted on)

1. **`createRunScope` (`src/agent/runtime/RunScope.ts`) — single-caller factory,
   carried-forward survivor.** One production caller (`AgentLaunchContext.ts:555`);
   `Object.freeze({ ...scope })` with an identity `RunScope → RunScope`
   signature. Defensible retention: a documented immutability invariant (run
   identity must not mutate mid-run) plus a shared test-kernel constructor seam.
   Same disposition as every prior pass: inline it or re-document the invariant;
   not a defect.
2. **`PROVIDER_KEY_REDACTION_RULES` (`src/logger/redaction.ts:28`) — test-only
   export, already baselined.** Zero production consumers of the _export_ (the
   file's own use at `:75` needs the value, not the `export`; the sole external
   reader is `DesktopLogRedaction.vitest.ts`), already recorded
   `"production-dead"` in `config/ratchets/knip-baseline.json`. The
   `satisfies Record<…>` table earns its place (compile-time provider
   exhaustiveness); only the `export` keyword + the `examples` fixture are
   test-only surface. Cleanup: drop the `export`, move the fixture into the test.
3. **Tier-1 manifest re-enumeration still owed (doc, open work).** The
   `2026-09-10-agent-sdk-tier-1-manifest.md` still predates the one-run-model
   rename and completed cutover, so its export tables and §7 tail point at
   renamed/deleted surfaces (`StreamView`/`ExecutionId`, `IModelHandler` as a
   live candidate). This is the enumeration half of the standing open work
   (`AGENTS.md`: "the Tier-1 public manifest and shrinking the frozen deep-import
   lists"), unchanged since `-09-14` §4. Wants a full re-enumeration against the
   post-cutover surface, not a spot patch.
4. **`src/agent/runtime/README.md` stale against the landed cutover — drift,
   recorded not fixed (unchanged from `-09-14` §5.6).** The README still says the
   directory "stays a flat list of ~50 files" (`README.md:6`), contradicted by
   the `runtime/run/` and `runtime/loop/` subdirectories the cutover added; and
   its module table (`README.md:17`) still names a `RunStatusService` that a
   repo-wide search (`grep "RunStatusService" src/ packages/`, test-excluded)
   finds **nowhere in code** — confirmed zero references this pass. Fixing the
   README is a production-doc change; `-09-14` flagged it for a maintainer and
   that disposition is unchanged (the scheduled firing carries no maintainer
   request).

## 6. Carried-forward design notes (unchanged, none a defect)

- **Logger + telemetry are process-global singletons** (`logSink.ts`'s
  module-level `let sink`, mutated by `setLogSink`). The SDK-correct unlock — an
  injectable sink owner behind a Tier-1 door — is designed for logging,
  unspecified for usage/telemetry.
- **Two Tier-1 leaf surfaces stay un-fronted, as the manifest predicts:**
  `@agent/core/state/runRequests` and
  `@agent/implementations/agentCreator/agentCreatorFlow` are still reached by
  full deep path; the latter is design-gated on `runAgentCreator`'s
  interactive-UI boundary (§4). For the SDK package's own row, `core/definition`
  and `core/tools` stay un-`index`ed — the deliberate width a Tier-1 barrel must
  re-export or seal.
- **`HostInteractions` required/optional** remains an open maintainer contract
  decision; **publication** remains gated on the named-external-consumer hold.

## 7. Bottom line

Thirteen consecutive passes find a green top-line verdict. This pass's
substantive content is **two convergent improvements, not news**: the `-09-14`
§5.2 `turnText` duplication was resolved exactly as prescribed (relocated to the
`run/turnText.ts` leaf module, four importers, no shim), and the extension's
deep-import width shrank 8 → 7 — both the shape of progress the standing open
work names, landed by ordinary cleanup PRs rather than by this routine. All
eight named doors stay fronted; the model stack is the cohesive `ModelInvoker.ts`
+ `runtime/run/*` over the run ledger, with no `ModelHandler`/`IModelHandler`
residue; the run loop's fold-based continuation and the logger re-verify clean
with no silent degradation. The subagent SPI is a real four-implementor
contract; `agentCreator` is the single, correctly-open boundary. Of the four §5
items, none is a defect (two minor cleanups, one manifest re-enumeration owed,
one recorded README-drift note) — none warranting a speculative edit into the
green tree absent a maintainer request this scheduled firing does not carry, so
this pass is **recorded, not acted on**.
