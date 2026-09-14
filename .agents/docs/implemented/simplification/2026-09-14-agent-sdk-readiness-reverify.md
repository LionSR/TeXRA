# Agent-SDK readiness — re-verification pass (2026-09-14)

Status: implemented

> **Written 2026-09-14.** The scheduled audit routine re-ran the standing
> question — "review the agent core, model handler, logger, and surface for
> unnecessary abstraction and unready surface; design subagent boundaries" —
> against the immediately prior pass
> ([`-09-13`](./2026-09-13-agent-sdk-readiness-reverify.md),
> "eleventh consecutive green", inspected at `a7cd2ab`) and the Tier-1 manifest
> of record
> ([`2026-09-10-agent-sdk-tier-1-manifest.md`](../../proposed/architecture/2026-09-10-agent-sdk-tier-1-manifest.md)).
> This is the **twelfth consecutive green pass** (`-08-19` through `-09-14`).
> Facts below are re-derived by direct inspection and carry a `file:line`,
> config path, or count. The branch was **updated onto the current `main` tip
> `d5e95a89`** before this record was finalized, and every citation is against
> that tree, so the line numbers match what a reader sees on `main` today.

> **Correction note.** An earlier draft of this doc mis-numbered the pass as the
> "ninth" and cited `-09-04` as the most recent prior pass — it had consulted
> only `archived/simplification/` and missed the three newer records under
> [`implemented/simplification/`](./) (`-09-09`
> ninth, `-09-11` tenth, `-09-13` eleventh). That draft's `file:line` anchors
> were also transcribed from a branch base (`8f0b294`) that trailed `main`, so
> several were off by a few lines. Both are fixed here: the lineage is corrected
> and every citation re-derived against `main` (`d5e95a89`). Thanks to the
> `claude[bot]` review on PR #12452 for catching both.

## 0. Verdict

**The standing structural verdict holds: the codebase is well-aligned with an
Agent-SDK shape, and no speculative refactor is warranted.** Twelve consecutive
passes (`-08-19` → `-09-14`) now reach the same top-line conclusion. What is new
this pass is not the verdict but the tree: **the ratified Effect-4 cutover that
every prior pass described as the future direction "not available today" has now
landed.**

The prior lineage recorded the pre-cutover architecture as still live:

- `-09-11` (tenth) still tracked the **Node flow engine at 158 LoC**
  (`src/agent/node/index.ts`, `class BaseNode :30` + `class Flow :134`) and
  **`ModelHandler.ts` as a live 1,922-LoC `abstract class
ModelHandler<M,U,T,C,Resp,Media>`** (`:184`), with the PocketFlow node/graph
  kernel and the `IModelHandler` port named as retirements the ratified cutover
  _would_ make.
- `-09-13` (eleventh) already referenced `ModelInvoker.ts` and the
  `runtime/run/` services (`BoundModel` in `run/modelBinding.ts`), i.e. the new
  stack standing up alongside, but still framed the node-kernel / `IModelHandler`
  retirement as ratified-and-pending.

At this pass's HEAD the retirement is **complete**, verified directly:

- **Node flow engine — deleted.** `src/agent/node/` no longer exists (`ls` → no
  such directory). A run is now one Effect program appending rows to the run
  ledger (`src/shared/session/runLedger.ts`, 139 LoC), exactly as the current
  `CLAUDE.md` states ("There is no flow engine"). The only surviving `node`
  reference is the SDK package's own `@texra-ai/agent/node` platform entrypoint
  (`packages/agent/src/node.ts`), unrelated to the deleted engine.
- **`ModelHandler.ts` god-base and `IModelHandler` port — deleted.**
  `grep -n "class ModelHandler\|IModelHandler" src/ packages/` returns **zero**
  production hits (only `.agents/docs/*` history). The responsibilities now split
  across `runtime/ModelInvoker.ts` (1,297 LoC, cohesive — "call the Model, own
  retry") and the `runtime/run/*` modules (`modelBinding.ts`, `pricing.ts`,
  `routeEndpoint.ts`, `modelFailure.ts`, `validationModel.ts`, …). Those are
  ordinary helper modules imported directly (e.g. `ModelInvoker.ts:78-86` imports
  `bindModel`, `classifyModelFailure`, `priceTurnUsage`, `dispatchFactsFor`); the
  injected Context services are `AgentRun` and `ModelInvoker` itself, not the
  helper split. **No re-export shim was left behind.** The `IModelHandler` provider-type-leak
  concern the prior passes carried as a manifest-design note is now moot — the
  port is gone.
- **Host→`@agent` deep-import width at its narrowest recorded.** Current
  `host-agent-import-baseline.json`: cli **5**, desktop **4**, extension **8**,
  agent (the SDK package) **7**. Against `-09-11` (cli 5, desktop 4, extension
  9), **extension shrank 9 → 8**; cli/desktop hold at their `-09-11` floor; the
  SDK package's own row stays at its provider-type-leak floor of 7.

Consistent with the routine's standing default — a scheduled firing carries **no
maintainer request** — this pass is **recorded, not acted on** for the codebase,
with one exception mirroring the `-09-13` precedent: the audit surfaced a
concrete SDK-surface documentation defect (§5.5, the `@texra-ai/agent` README
telling consumers to install an `effect` version the package does not pin), and
because that is a clearly-correct, on-theme one-line fix flagged in review, **it
is fixed in this PR** alongside this record. The remaining four minor items in §5
are logged for a maintainer; none is a defect.

## 1. Method and scope

Four independent area audits — agent core + run loop, model handler +
`packages/llm`, logger, and the `@texra-ai/agent` package surface + subagent
boundaries — each re-derived the banned-pattern candidates (pass-through
wrappers, convenience barrels, one-impl interfaces, single-caller extractions,
re-export shims, silent degradation) and counted **production (non-test) callers**
for every `create*`/factory and exported symbol, per the AGENTS.md factory bar (a
factory earns its place only with multiple callers, real logic, class
construction, or captured context).

**On the interval trend line.** This session began from a shallow checkout that
could not reach the prior snapshots, so the per-commit "net −N lines / N
refactor / zero new exported class" diffstat accounting the prior passes provided
is **not reproduced here**. The history was subsequently deepened and the branch
updated onto `main` (`d5e95a89`) so that every end-state fact and citation is
current; the structural conclusions rest on that end-state inspection, which is
sufficient for the standing question (is there unnecessary abstraction _now_).

## 2. Tracked structural facts — re-verified against `main` (`d5e95a89`)

| Item                                          | Prior lineage                                 | This pass                                                                                                                                                                                   |
| --------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node flow engine**                          | 158 LoC `BaseNode`+`Flow` (live at `-09-11`)  | **Deleted.** `src/agent/node/` absent; replaced by the run-ledger Effect program (`runtime/loop/{toolUse,reflection,toolUseDispatch,rows}.ts` over `runLedger.ts`).                         |
| **`ModelHandler.ts` god-base**                | 1,922-LoC `abstract class` (live at `-09-11`) | **Deleted.** Zero production refs; decomposed into `ModelInvoker.ts` (1,297) + `runtime/run/*`. No shim.                                                                                    |
| **`IModelHandler` port**                      | ratified retirement, pending at `-09-13`      | **Deleted.** Zero refs; provider-type-leak note moot.                                                                                                                                       |
| **`SessionHandle.useHostInteractions`**       | gone                                          | **still gone** (`grep` → 0).                                                                                                                                                                |
| **`redactSecrets`**                           | single-arg, no dead branch                    | **still clean.** `redactSecrets(text: string): string` (`src/logger/redaction.ts:93`), straight-line body; the provider-key table + `redactDisplayValue` are real logic, not a dead branch. |
| **SDK version**                               | 0.41.0                                        | **0.41.0** (`packages/agent/package.json`).                                                                                                                                                 |
| **`createRunScope`** survivor                 | 1 production caller                           | **1 production caller** (`AgentLaunchContext.ts:555`); all other sites under `src/test-kernel/`. Unchanged survivor (§5.1).                                                                 |
| **Deep-import width** (cli/desktop/ext/agent) | 5 / 4 / 9 / 7 (`-09-11`)                      | **5 / 4 / 8 / 7** — extension shrank 9→8; rest hold.                                                                                                                                        |
| **Tier-1 named doors**                        | manifest target                               | **8/8 fronted** — `src/agent/{export,followUp,index,review,runtime,storage,templates,trace}/index.ts` all present.                                                                          |

## 3. Loop ↔ ledger boundary and single-writer invariant — hold

The run loop calls `ledger.appendBatch(runId, state, [...])` directly; row
payloads are built by pure constructors in `loop/rows.ts` (`snapshotRow`,
`stepRow`, `appendRow`, `displayRow`, `runtimeSnapshotRow`, …), each with
multiple callers. The state the loop continues from is exactly what `appendBatch`
returns (`foldRunState` over committed rows), so live and resume are the same
function — no cursor, no graph, no intermediate writer service.

Single writer holds for the rows that actually fold run state: the durable rows
`foldRunState` mutates state from (`flow.snapshot`, `model.message`,
`model.compaction`, `tool.intent`, `tool.result`, `flow.step`, loop-owned
`request.opened`) have one writer, `RunLedger.appendBatch`
(`src/agent/runtime/RunLedger.ts:361` — the 455-LoC runtime implementation,
distinct from the 139-LoC session contract `src/shared/session/runLedger.ts`
cited in §0/§2; the doc uses both, so the capitalization disambiguates them).
**`stream.end` is
not one of them** — it is a trace/display-plane event emitted through
`TraceEmitter` (`src/agent/trace/TraceEmitter.ts:379`) and explicitly folds to
no state mutation (`runStateFold.ts:961` returns `null`, "the ledger row beside
it is the fact"); an earlier draft mislisted it here. Likewise the two
`session.publish` sites in `loop/` (`toolUse.ts` `run.workspaceFiles`,
`run.record`) are display-plane events, not run-state rows. Two documented,
intentional second-plane exceptions exist for the run-state rows and are
not migration accidents: `RunLedger.acquire` (`RunLedger.ts:272`) publishing
`request.decided` cancellation rows (`:300`) for a dead owner's unbound requests
(in-service, file-header-documented), and the host request plane writing
`request.opened`/`request.decided` through `SessionHandle.openRequest`/`commit`
("the one door for a request outside the loop's own batches"). No silent
degradation found in any of the four areas (no empty `catch {}`; every `??` is a
fallback over an optional field or documented restore, never over a failed read).

## 4. Subagent boundaries — shipped 4-implementor SPI; one boundary correctly open

`ChildRunStrategy<TTurn, R>` + `ChildRunPorts`
(`src/agent/runtime/childRunLoop.ts:156` and `:101`), driven by the single owner
`startChildRunLoop`, remain a shipped, multi-implementor SPI, not a design task.
Four distinct production construction sites:

| Site                                                 | Constructor                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/tools/delegation/nativeSubagentStrategy.ts:193` | `createNativeSubagentStrategy` (native subagent)                             |
| `src/tools/delegation/workflowScriptStrategy.ts:151` | `createWorkflowScriptStrategy` (workflow-script child)                       |
| `src/tools/bash.ts:233`                              | `createBackgroundBashStrategy` (background shell)                            |
| `src/tools/agentCliShared.ts`                        | inline `const strategy: ChildRunStrategy<TTurn>` (codex/claude CLI sessions) |

`detachedChildRun.ts` is a consumer of the SPI (shared launcher for the first
two), not a fifth implementor. The `R = never` context type param is the
Effect-native shape, not a widening.

**`runAgentCreator` remains the one genuine "logical agent not yet running as
one."** A single linear `Effect.fn` generator
(`src/agent/implementations/agentCreator/agentCreatorFlow.ts:437`), one
production caller running **inline in the extension host**
(`packages/extension/src/commands/agent/agentCreatorCommands.ts:188`, whose
enclosing command "never itself becomes a trackable session"). It stays open
**correctly**: closing it is interactive-UI design work (the
`AgentCreatorUI`/`HostInteractions` approval channel the public surface
deliberately lacks), not a mechanical move (manifest §7.3).

## 5. Findings

1. **`createRunScope` (`src/agent/runtime/RunScope.ts`) — single-caller factory,
   carried-forward survivor.** One production caller
   (`AgentLaunchContext.ts:555`); the body is `Object.freeze({ ...scope })` with
   an identity `RunScope → RunScope` signature. Its defensible retention is a
   documented immutability invariant (run identity must not mutate mid-run) plus
   a shared test-kernel constructor seam. Same disposition as the prior passes:
   inline it or re-document the invariant; not a defect.
2. **`turnText` ~5-line copy.** `ModelInvoker.ts:201` exports `turnText`;
   `src/agent/runtime/helperModel.ts` re-implements the identical
   `content.flatMap(part.kind==='message' ? …)` body, with an inline comment
   justifying the copy as avoiding dragging the run-loop closure through the
   module graph. The clean fix is to relocate this pure `TurnResult → string`
   function to a leaf module (e.g. beside `packages/llm/src/turn.ts`) that both
   import. Actionable, low value, low risk.
3. **`PROVIDER_KEY_REDACTION_RULES` (`src/logger/redaction.ts`) — test-only
   export, already baselined.** Zero production consumers of the _export_ (the
   file's own use needs the value, not the `export`; the sole external reader is
   `DesktopLogRedaction.vitest.ts`), already recorded `"production-dead"` in
   `config/ratchets/knip-baseline.json`. The internal `satisfies Record<…>` table
   earns its place (compile-time provider exhaustiveness); only the `export`
   keyword + the `examples` fixture are test-only surface. Cleanup: drop the
   `export`, move the fixture into the test.
4. **Manifest drift (doc housekeeping).** `2026-09-10-agent-sdk-tier-1-manifest.md`
   §3's export enumeration predates the one-run-model rename: it lists
   `StreamView`/`ExecutionId`/`ExecutionIdSchema`, but the entries now export
   `RunView` and `RunId`/`RunIdSchema`. The surface is internally consistent
   (README documents `RunView`); the manifest's own §7.5 already flags it for
   re-enumeration.
5. **`@texra-ai/agent` README `effect` peer-version drift — a real defect, fixed
   in this PR.** `packages/agent/package.json` pins the `effect` peer at
   `4.0.0-rc.115` (peer and dev), but the README install guidance told consumers
   to install `4.0.0-rc.112`. Because the README itself warns that two copies of
   `effect` in one process "do not work at all", a consumer following the
   documented setup would hit exactly that duplicate-runtime failure. This is the
   one place the surface did **not** re-verify clean, so the earlier "no
   degradation found" conclusion is corrected here. The README is updated to
   `4.0.0-rc.115` to match the pin (the acted item noted in §0). Better still,
   the install line should read the pinned version from `package.json` rather
   than restate it, to stop this drift recurring — left as a follow-up.

## 6. Carried-forward design notes (unchanged, none a defect)

- **Logger + telemetry are process-global singletons** (`logSink.ts`'s
  module-level `let sink`, mutated by `setLogSink`, read by every
  `writeLogEntry`). The SDK-correct unlock — an injectable sink owner behind a
  Tier-1 door — is designed for logging, unspecified for usage/telemetry.
- **Two Tier-1 leaf surfaces stay un-fronted, as the manifest predicts:**
  `@agent/core/state/runRequests` and
  `@agent/implementations/agentCreator/agentCreatorFlow` are still reached by full
  deep path; the latter is design-gated on `runAgentCreator`'s interactive-UI
  boundary (§4). For the SDK package's own row, `core/definition` and `core/tools`
  stay un-`index`ed — the deliberate width a Tier-1 barrel must re-export or seal.
- **`HostInteractions` required/optional** remains an open maintainer contract
  decision; **publication** remains gated on the named-external-consumer hold.

## 7. Bottom line

Twelve consecutive passes find a green top-line verdict. This pass's news is that
the ratified Effect-4 cutover has **landed**: relative to `-09-11` (which still
recorded the Node flow engine at 158 LoC and `ModelHandler.ts` as a live 1,922-LoC
abstract base), the node engine, the `ModelHandler` god-base, and the
`IModelHandler` port are now deleted with no shim, the model stack is
`ModelInvoker.ts` + the `runtime/run/*` helper modules over the run ledger,
extension's deep-import width shrank 9→8, and all eight named doors are fronted.
The run loop, the loop↔ledger single-writer boundary (for the rows that fold run
state), and the logger re-verify clean with no silent degradation. The public
surface is clean but for one documentation defect — the README `effect`
peer-version drift (§5.5), fixed in this PR. The subagent SPI is a real
four-implementor contract; `agentCreator` is the single, correctly-open boundary.
Of the five §5 items, four are minor cleanups and one doc re-enumeration (none a
defect, none warranting a speculative edit into the green tree absent a maintainer
request this scheduled firing does not carry); the fifth was a real defect and is
fixed here.
