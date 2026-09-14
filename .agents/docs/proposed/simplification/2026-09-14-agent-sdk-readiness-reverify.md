# Agent-SDK readiness — re-verification pass (2026-09-14)

Status: proposed

> **Written 2026-09-14 against branch HEAD `8f0b294`**
> (`fix(cli): resolve a remote workflow agent's default outputs from its loaded
> definition`, #12434). The scheduled audit routine re-ran the standing
> question — "review the agent core, model handler, logger, and surface for
> unnecessary abstraction and unready surface; design subagent boundaries" —
> against the most recent prior pass
> ([`-09-04`](../../archived/simplification/2026-09-04-agent-sdk-readiness-reverify.md),
> snapshot `4579625`) and the Tier-1 manifest of record
> ([`2026-09-10-agent-sdk-tier-1-manifest.md`](../architecture/2026-09-10-agent-sdk-tier-1-manifest.md)).
> This session's checkout is a **shallow clone** (50 commits, oldest reachable
> `f9bbfa0` @ 2026-09-13); the prior snapshot `4579625` is **not reachable**, so
> — unlike prior passes — this one could **not** do the commit-interval diffstat
> analysis. Instead every fact below was **re-derived from fresh direct
> inspection of the end-state at `8f0b294`** (`file:line`, config path, or grep
> count). Where a number cannot be verified without the missing history, it is
> called out as such rather than asserted.

## 0. Verdict

**The standing verdict holds, and this is the strongest structural pass on
record: the codebase is well-aligned with an Agent-SDK shape, and no structural
refactor is warranted.** This is the **ninth consecutive** green pass (`-08-19`
through `-09-14`). What is new is that, since the prior pass's snapshot, the
single largest simplification the north-star ever pointed at has **landed**:

- **The Node flow engine is deleted.** `src/agent/node/` no longer exists
  (`ls` → no such directory); the 158-LoC `BaseNode` + `Flow` the prior eight
  passes tracked is gone. A run is now one Effect program appending rows to the
  run ledger (`src/shared/session/runLedger.ts`, 139 LoC), exactly as the
  current `CLAUDE.md` describes. The only surviving `node` reference is the SDK
  package's own `@texra-ai/agent/node` platform entrypoint
  (`packages/agent/src/node.ts`) — unrelated to the deleted engine.
- **The `ModelHandler.ts` god-base is deleted and decomposed.** The 2,026-LoC
  base tracked as **M-3** is gone (`grep ModelHandler src/ packages/` → **zero**
  production hits, only `.agents/docs/*` history). Its responsibilities now split
  across `runtime/ModelInvoker.ts` (1,297 LoC, cohesive — "call the Model, own
  retry") and the `runtime/run/` service files (`modelBinding.ts`, `pricing.ts`,
  `routeEndpoint.ts`, `modelFailure.ts`, `validationModel.ts`, …), reached only
  through injection. **No re-export shim was left behind** (CLAUDE.md's anti-shim
  rule held).
- **`IModelHandler` is deleted.** The hand-maintained `Pick<ModelHandler<M,T>>`
  that prior passes carried as open item (1) — the internal surface that would
  have leaked provider-SDK type params — no longer exists (`grep IModelHandler`
  → zero). That open item is **closed by deletion.**
- **The frozen host→`@agent` deep-import width shrank on three of four hosts:**
  cli 7→**5**, desktop 5→**4**, extension 9→**8**; the SDK package's own row held
  at **7** (its provider-type floor). This is the "welcome, should shrink this
  file" direction of `host-agent-import-baseline.json`, not a widening.

Consistent with the routine's standing default across all eight prior passes —
a scheduled firing carries **no maintainer request** — this pass is **recorded,
not acted on.** The four minor items in §5 are recorded for a maintainer to pick
up; none is a defect, and none warrants a speculative edit into a green tree.

## 1. Method and its one limitation this pass

Four parallel area audits (agent core + run loop; model handler + `packages/llm`;
logger; SDK surface + subagent boundaries) each re-derived their tracked facts by
direct read and grep at `8f0b294`, counting **production (non-test) callers** for
every `create*`/factory and every exported symbol per the AGENTS.md factory bar
(a factory earns its place only with multiple callers, real logic, class
construction, or captured context; single-caller trivial extractions are banned).

**Limitation:** the shallow checkout removed the `4579625..HEAD` range, so the
per-commit "net −N lines / N refactor / zero new exported class" interval
accounting the prior passes provided is **absent here**. The structural
conclusions below rest on end-state inspection, which is sufficient for the
standing question (is there unnecessary abstraction *now*), but the interval
trend line should be re-established from a full clone on the next pass.

## 2. Tracked structural facts — re-verified at `8f0b294`

| Item | Expected (`-09-04` @ `4579625`) | `8f0b294` state |
| --- | --- | --- |
| **Node flow engine** | 158 LoC, `BaseNode` + `Flow` | **Deleted.** `src/agent/node/` absent. Replaced by the run-ledger Effect program (`runtime/loop/{toolUse,reflection,toolUseDispatch,rows}.ts` over `runLedger.ts`). |
| **M-3** `ModelHandler.ts` god-base | 2,026 LoC | **Deleted.** Zero production refs; decomposed into `ModelInvoker.ts` (1,297) + `runtime/run/*`. No shim. |
| **`IModelHandler`** | `Pick<ModelHandler>` internal | **Deleted.** Zero refs. Prior open item (1) closed. |
| **§8b / PT-2** `SessionHandle.useHostInteractions` | gone | **still gone** (`grep` → 0). |
| **§8a** dead logger export `OutputChannelFactoryOptions` | de-exported, internal use | **Deleted entirely** — symbol absent from `src/`/`packages/`; the output-channel-factory mechanism was removed in favor of the `logSink` model (`src/logger/logSink.ts`). Tracker can drop this line. |
| **L-3** `redactSecrets` | single-arg, no dead branch | **still clean.** `redactSecrets(text: string): string` (`src/logger/redaction.ts:81`), straight-line body; the file's growth to 118 LoC is the real `PROVIDER_KEY_REDACTION_RULES` table + `redactDisplayValue`, not a dead branch. |
| **SDK version** | 0.40.9 | **0.41.0** (`packages/agent/package.json`). |
| **`createRunScope`** survivor | 1 production caller | **1 production caller** (`AgentLaunchContext.ts:555`); all other `createRunScope(` sites under `src/test-kernel/`. Unchanged survivor (see §5.1). |
| **Deep-import width** (cli/desktop/ext/agent) | 7 / 5 / 9 / 7 | **5 / 4 / 8 / 7** — shrank on three hosts, agent held. |
| **Tier-1 named doors** | (manifest target) | **8/8 fronted** — `src/agent/{export,followUp,index,review,runtime,storage,templates,trace}/index.ts` all present. |

## 3. Loop ↔ ledger boundary and single-writer invariant — hold

The run loop calls `ledger.appendBatch(runId, state, [...])` directly; row
payloads are built by pure constructors in `loop/rows.ts` (`snapshotRow`,
`stepRow`, `appendRow`, `displayRow`, `runtimeSnapshotRow`, …), each with
multiple callers. The state the loop continues from is exactly what
`appendBatch` returns (`foldRunState` over committed rows), so live and resume
are the same function — no cursor, no graph, no intermediate writer service.

**Single writer of run-state rows holds literally.** Durable run-state rows
(`flow.snapshot`, `model.message`, `model.compaction`, `tool.intent`,
`tool.result`, `flow.step`, `stream.end`, loop-owned `request.opened`) have one
writer: `RunLedger.appendBatch` (`RunLedger.ts:361`). The two `session.publish`
sites in `loop/` (`toolUse.ts:188` `run.workspaceFiles`, `:301` `run.record`)
are display-plane events, not ledger rows. Two documented, intentional
exceptions exist and are not migration accidents: `RunLedger.acquire` publishing
`request.decided` cancellation rows for a dead owner's unbound requests
(`RunLedger.ts:297-319`, in-service, file-header-documented), and the host
request plane writing `request.opened`/`request.decided` through
`SessionHandle.openRequest`/`commit` ("the one door for a request outside the
loop's own batches"). Worth a maintainer confirming this two-plane split is the
invariant CLAUDE.md's "one publisher" wording intends — it reads as deliberate,
not a defect.

## 4. Subagent boundaries — shipped 4-implementor SPI; one boundary correctly open

`ChildRunStrategy<TTurn, R>` + `ChildRunPorts`
(`src/agent/runtime/childRunLoop.ts:156` and `:101`), driven by the single owner
`startChildRunLoop` (`:783`), remain a **shipped, multi-implementor SPI, not a
design task.** Four distinct production construction sites:

| Site | Constructor |
| --- | --- |
| `src/tools/delegation/nativeSubagentStrategy.ts:195` | `createNativeSubagentStrategy` (native subagent, both output categories) |
| `src/tools/delegation/workflowScriptStrategy.ts:153` | `createWorkflowScriptStrategy` (workflow-script child) |
| `src/tools/bash.ts:239` | `createBackgroundBashStrategy` (background shell) |
| `src/tools/agentCliShared.ts:614` | inline `const strategy: ChildRunStrategy<TTurn>` (codex/claude CLI sessions) |

`detachedChildRun.ts:64` is a **consumer** of the SPI (shared launcher for the
first two), not a fifth implementor. The SPI now carries an Effect context type
param (`R = never`) — consistent with the Effect-native migration, not a
widening.

**`runAgentCreator` remains the one genuine "logical agent not yet running as
one."** A single linear `Effect.fn` generator
(`src/agent/implementations/agentCreator/agentCreatorFlow.ts:437`), one
production caller running **inline in the extension host**
(`packages/extension/src/commands/agent/agentCreatorCommands.ts:186`, whose
docstring states it "never itself becomes a trackable session"). It stays open
**correctly**: closing it is interactive-UI design work (the
`AgentCreatorUI`/`HostInteractions` approval channel the public surface
deliberately lacks), not a mechanical move (manifest §7.3).

## 5. Findings — all minor, none a defect, recorded not acted on

1. **`createRunScope` (`src/agent/runtime/RunScope.ts:30`) — single-caller
   factory, carried-forward survivor.** One production caller
   (`AgentLaunchContext.ts:555`); the body is `Object.freeze({ ...scope })` with
   an identity `RunScope → RunScope` signature. By the letter of the
   single-caller ban it is inlineable; its defensible retention is *documented
   immutability invariant (run identity must not mutate mid-run) + shared
   test-kernel constructor seam*. Same disposition as the prior eight passes:
   inline it **or** re-document the invariant at the definition; either way not a
   defect.
2. **`turnText` ~5-line copy — the one genuine duplication in the model
   surface.** `ModelInvoker.ts:201-207` exports `turnText`;
   `src/agent/runtime/helperModel.ts:116-120` re-implements the identical
   `content.flatMap(part.kind==='message' ? …)` body, with an inline comment
   justifying the copy as avoiding dragging the run-loop closure through the
   module graph. The comment's concern is real; the clean fix is to relocate
   this pure `TurnResult → string` function to a leaf module (e.g. beside
   `packages/llm/src/turn.ts`) that both import. Actionable, low value, low risk.
3. **`PROVIDER_KEY_REDACTION_RULES` (`src/logger/redaction.ts:28`) — test-only
   export, already baselined.** Zero production consumers of the *export* (the
   file's own use at `:75` needs the value, not the `export`; the sole external
   reader is `DesktopLogRedaction.vitest.ts`). Already recorded
   `"production-dead"` in `config/ratchets/knip-baseline.json`. The internal
   `satisfies Record<ApiKeyProviderId, …>` table earns its place (compile-time
   provider exhaustiveness); only the `export` keyword + the `examples` fixture
   arrays are test-only surface baked into a production module. Cleanup: drop the
   `export`, move the exhaustiveness fixture into the test.
4. **Manifest drift (doc housekeeping, not a surface defect).** The
   `2026-09-10-agent-sdk-tier-1-manifest.md` §3 export enumeration predates the
   one-run-model rename and is stale against code: it lists
   `StreamView`/`ExecutionId`/`ExecutionIdSchema`, but the entries now export
   `RunView` (`index.ts:73`, `effect.ts:30`) and `RunId`/`RunIdSchema`
   (`schemas.ts:38,46`; `effect.ts:51`). The surface itself is internally
   consistent (README documents `RunView`); the manifest's own §7.5 already flags
   it for re-enumeration. Re-run that enumeration.

## 6. Carried-forward design notes (unchanged, none a defect)

- **Logger + telemetry are process-global singletons.** The sink is a
  module-level `let sink` mutated by `setLogSink` (`logSink.ts:100-108`), read by
  every `writeLogEntry`. The SDK-correct unlock — an injectable sink owner behind
  a Tier-1 door — is designed for logging, unspecified for usage/telemetry.
- **Two Tier-1 leaf surfaces stay un-fronted, as the manifest predicts:**
  `@agent/core/state/runRequests` and
  `@agent/implementations/agentCreator/agentCreatorFlow` are still reached by full
  deep path (no `index.ts`); the latter is design-gated on `runAgentCreator`'s
  interactive-UI boundary (§4). For the SDK package's own row, `core/definition`
  and `core/tools` likewise stay un-`index`ed — the deliberate provider-type-leak
  floor keeping `agent` at 7 specifiers.
- **`HostInteractions` required/optional** remains an open maintainer contract
  decision.
- **Publication remains gated** on the named-external-consumer hold.

## 7. Bottom line

Nine consecutive passes now find a green top-line verdict, and this one records
the largest structural advance of the series: the Node flow engine deleted, the
`ModelHandler` god-base and `IModelHandler` deleted and decomposed with no shim,
three of four host deep-import baselines shrunk, and all eight named doors
fronted — the run loop, the loop↔ledger boundary (single-writer for run-state
rows), the logger, and the public surface all re-verify clean, with no silent
degradation found in any of the four areas. The subagent SPI is a real
four-implementor contract; `agentCreator` is the single, correctly-open
boundary. The four items in §5 are minor cleanups and one doc re-enumeration,
not defects. Nothing warrants a speculative edit into the green tree absent a
maintainer request, which this scheduled firing does not carry. The pass is
recorded, not acted on. Next pass should run from a full clone to restore the
commit-interval trend line this one could not compute.
