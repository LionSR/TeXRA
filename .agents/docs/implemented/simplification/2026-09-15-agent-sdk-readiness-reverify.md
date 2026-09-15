# Agent-SDK readiness — re-verification pass (2026-09-15)

Status: implemented

> **Written 2026-09-15.** The scheduled audit routine re-ran the standing
> question — "review the agent core, model handler, logger, and surface for
> unnecessary abstraction and unready surface; design subagent boundaries" —
> against the immediately prior pass
> ([`-09-14`](./2026-09-14-agent-sdk-readiness-reverify.md), "twelfth
> consecutive green") and the Tier-1 manifest of record
> ([`2026-09-10-agent-sdk-tier-1-manifest.md`](../../proposed/architecture/2026-09-10-agent-sdk-tier-1-manifest.md)).
> This is the **thirteenth consecutive green pass** (`-08-19` through
> `-09-15`). Facts below are re-derived by direct inspection and carry a
> `file:line`, config path, or count.
>
> **Tree inspected.** Every citation is against this branch's HEAD
> (`2c98984`, `claude/eager-noether-c6o44x`), which carries the `-09-14`
> record plus the ongoing "recovers through Effect; no raw catch remains"
> host-refactor line. Unlike `-09-14`, this pass did **not** re-base onto the
> current `origin/main` tip (`ce1538d`): the session's checkout is shallow and
> does not reach it, so the honest scope is "is there unnecessary abstraction
> _in the tree I can see_", and the structural conclusions rest on end-state
> inspection of that tree. Where a line number differs from `-09-14` by one or
> two, the branch's own edits shifted it; the anchors below are current.

## 0. Verdict

**The standing structural verdict holds: the codebase is well-aligned with an
Agent-SDK shape, and no speculative refactor is warranted.** Thirteen
consecutive passes (`-08-19` → `-09-15`) reach the same top-line conclusion.
The Effect-4 cutover ratified and completed before `-09-13` remains complete
and un-regressed — the PocketFlow node/graph engine, the `ModelHandler`
god-base, and the `IModelHandler` port stay deleted with no re-export shim:

- **Node flow engine — still deleted.** `src/agent/node/` does not exist
  (`ls` → no such directory). A run remains one Effect program appending rows
  to the run ledger, exactly as `CLAUDE.md` states ("There is no flow
  engine"). The only surviving `node` reference is the SDK package's own
  `@texra-ai/agent/node` platform entrypoint (`packages/agent/src/node.ts`),
  unrelated to the deleted engine.
- **`ModelHandler` god-base and `IModelHandler` port — still deleted.**
  `grep -n "class ModelHandler\|IModelHandler" src/ packages/` returns **zero**
  production hits (history under `.agents/docs/*` only). The responsibilities
  stay split across `runtime/ModelInvoker.ts` (cohesive — "call the Model, own
  retry") and the `runtime/run/*` modules (`modelBinding.ts`, `pricing.ts`,
  `routeEndpoint.ts`, `modelFailure.ts`, `validationModel.ts`, …), a mix of
  directly-imported helper functions and injected Context services. No shim.
- **`effect` peer pin and README agree.** `packages/agent/package.json` pins
  the `effect` peer at `4.0.0-rc.115`, and `packages/agent/README.md` now
  instructs consumers to install `4.0.0-rc.115` (README.md:26,32). The
  peer-version drift that `-09-14` §5.5 found and fixed is present on this
  branch and re-verifies clean. SDK package version `0.41.0`.

Consistent with the routine's standing default — a scheduled firing carries
**no maintainer request** — this pass is **recorded, not acted on** for the
codebase. Unlike `-09-14` (which fixed the README `effect` drift because it
was a live defect flagged in review), this pass surfaced **no live defect**:
every §5 item is a non-defect carried forward or a containment note, so
nothing is edited into the green tree.

## 1. Method and scope

Four independent area audits — agent core + run loop, model handler +
`packages/llm`, logger, and the `@texra-ai/agent` package surface + subagent
boundaries — each re-derived the banned-pattern candidates (pass-through
wrappers, convenience barrels, one-impl interfaces, single-caller
extractions, re-export shims, silent degradation) and counted **production
(non-test) callers** for every `create*`/factory and exported symbol, per the
AGENTS.md factory bar. The per-commit diffstat trend line the earlier passes
provided is not reproduced here (shallow checkout, per the header); the
structural conclusions rest on end-state inspection, which answers the
standing question (is there unnecessary abstraction _now_).

## 2. Tracked structural facts — re-verified against HEAD (`2c98984`)

| Item                                          | Prior (`-09-14`)                          | This pass                                                                                                                   |
| --------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Node flow engine**                          | deleted                                   | **still deleted** (`src/agent/node/` absent). Run is the run-ledger Effect program (`runtime/loop/{toolUse,reflection,toolUseDispatch,rows}.ts`). |
| **`ModelHandler` god-base**                   | deleted, no shim                          | **still deleted.** Zero production refs; decomposed into `ModelInvoker.ts` + `runtime/run/*`.                               |
| **`IModelHandler` port**                      | deleted                                   | **still deleted.** Zero refs; provider-type-leak note moot (but see §5.6, `ServerTools`).                                   |
| **`redactSecrets`**                           | single-arg, no dead branch                | **still clean** (`src/logger/redaction.ts`). Provider-key table + `redactDisplayValue` are real logic.                     |
| **SDK version / `effect` pin**                | 0.41.0 / rc.115 (README fixed)            | **0.41.0 / rc.115**, README agrees (README.md:26,32). No drift.                                                            |
| **`createRunScope`** survivor                 | 1 production caller (`:555`)              | **1 production caller** (`AgentLaunchContext.ts:556`); all other sites under `src/test-kernel/`. Unchanged survivor (§5.1). |
| **`turnText` copy**                           | ModelInvoker.ts:201 vs helperModel        | **still present** (`ModelInvoker.ts:202` exports it; `helperModel.ts:116-117` re-implements the identical body, no import). |
| **Deep-import width** (cli/desktop/ext/agent) | 5 / 4 / 8 / 7                             | **5 / 4 / 8 / 7** — unchanged (`config/ratchets/host-agent-import-baseline.json`).                                          |
| **Tier-1 named doors**                        | 8/8 fronted                               | **8/8 fronted** — `src/agent/{export,followUp,index,review,runtime,storage,templates,trace}/index.ts` all present.         |

## 3. Loop ↔ ledger boundary — fold-based continuation

The verified property remains the **continuation model**, not a writer
inventory: the two run programs (`runtime/loop/toolUse.ts`,
`runtime/loop/reflection.ts`) call `ledger.appendBatch(runId, state, [...])`
and continue from exactly what `appendBatch` returns (`foldRunState` over
committed rows), so live and resume are the same function — no cursor, no
graph, no intermediate flow engine. Row payloads are built by pure
constructors in `loop/rows.ts`. Per the `-09-14` correction, **this pass makes
no single-writer claim**: the write side is deliberately multi-owner
(`appendBatch` has several callers; request/child-run rows are written through
`SessionHandle`), and enumerating it exhaustively is out of scope. What is
verified is the fold-based continuation, the CLAUDE.md "one publisher,
loop-owned cards" rule holding on the loop's own path, and **no silent
degradation** in any of the four areas (no empty `catch {}`; every `??` is a
fallback over an optional field or documented restore, never over a failed
read). The logger area confirms this independently: one redacting host sink
(`logSink.ts` `writeLogEntry`), two producer front-ends split strictly by
Effect-vs-Promise capability (`@logger/logUtils` and `@logger/effectLog` via
`effectDiagnosticsLayer`), redaction default-ON, and the only best-effort
`catch {}` living in host sinks (`desktopAppLog.ts`) with a documented
"logging must never become a startup dependency" justification.

## 4. Subagent boundaries — shipped 4-implementor SPI; one boundary correctly open

`ChildRunStrategy<TTurn, R>` + `ChildRunPorts`
(`src/agent/runtime/childRunLoop.ts:157` and `:101`), driven by the single
owner `startChildRunLoop`, remain a shipped, multi-implementor SPI, not a
design task. Production construction sites verified this pass:

| Site                                                 | Constructor                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `src/tools/delegation/nativeSubagentStrategy.ts:193` | `createNativeSubagentStrategy` (native subagent)              |
| `src/tools/delegation/workflowScriptStrategy.ts:151` | `createWorkflowScriptStrategy` (workflow-script child)        |
| `src/tools/bash.ts:233`                              | `createBackgroundBashStrategy` (background shell)             |
| `src/tools/agentCliShared.ts`                        | inline `ChildRunStrategy` (codex/claude CLI sessions)         |

`detachedChildRun.ts` (`startDetachedChildRunLoop`) is the shared launcher for
the first three, a consumer of the SPI rather than a fifth implementor. Note
`src/agent/remote/` is **not** subagent dispatch — it is remote-agent config
loading (fetching agent YAML from Supabase); do not conflate the two.

**`runAgentCreator` remains the one genuine "logical agent not yet running as
one."** The blueprint/YAML generation runs as linear `Effect.fn` generators
(`src/agent/implementations/agentCreator/agentCreatorFlow.ts:353,400`), with a
single production caller running inline in the extension host. It stays open
**correctly**: closing it is interactive-UI design work (the
`AgentCreatorUI`/`HostInteractions` approval channel the public surface
deliberately lacks), not a mechanical move (manifest §7.3). Do not propose
collapsing it without addressing that approval channel.

## 5. Findings

1. **`createRunScope` (`src/agent/runtime/RunScope.ts`) — single-caller
   factory, carried-forward survivor.** One production caller
   (`AgentLaunchContext.ts:556`); body is `Object.freeze({ ...scope })` with an
   identity signature. Defensible retention: a documented immutability
   invariant plus a shared test-kernel constructor seam. Inline it or
   re-document the invariant; not a defect.
2. **`turnText` ~5-line copy — still present.** `ModelInvoker.ts:202` exports
   `turnText`; `helperModel.ts:116-117` re-implements the identical
   `part.kind === 'message' ? part.content.map(piece => piece.text) : []` body
   without importing it (inline comment justifies the copy as avoiding dragging
   the run-loop closure through the module graph). Clean fix: relocate this
   pure `TurnResult → string` function to a leaf module (e.g. beside
   `packages/llm/src/turn.ts`) that both import. Actionable, low value, low
   risk.
3. **`PROVIDER_KEY_REDACTION_RULES` (`src/logger/redaction.ts`) — test-only
   export, already baselined.** Zero production consumers of the _export_ (the
   file's own use needs the value, not the `export`; the sole external reader is
   `DesktopLogRedaction.vitest.ts`), recorded `"production-dead"` in
   `config/ratchets/knip-baseline.json`. Cleanup: drop the `export`, move the
   fixture into the test.
4. **Tier-1 manifest drift (doc housekeeping).**
   `2026-09-10-agent-sdk-tier-1-manifest.md` predates both the one-run-model
   rename and the completed cutover, so §3's export tables list
   `StreamView`/`ExecutionId`/`ExecutionIdSchema` where the entries now export
   `RunView`/`RunId`/`RunIdSchema`, and §7 still frames the
   `IModelHandler`/PocketFlow retirement as future work (done — §0). The
   manifest wants a full re-enumeration against the post-cutover surface. This
   is the single most useful non-duplicative work item this routine keeps
   surfacing; a future acting pass should do the re-enumeration rather than
   re-discover it.
5. **`src/agent/runtime/README.md` stale against the landed cutover — drift,
   recorded not fixed.** That module-map README still describes the directory as
   "a flat list of ~50 files", whereas the cutover added `runtime/run/` and
   `runtime/loop/` subdirectories, and names a `RunStatusService` that a
   repo-wide search finds nowhere outside the README. Flagged for a maintainer.
6. **`ServerTools` provider-type containment — the one spot provider SDK types
   touch an SDK-reachable zone (new this pass, latent, not a live defect).**
   `src/agent/types/ServerTools.ts:15,19` imports type-only from
   `@anthropic-ai/sdk/resources/messages` and
   `openai/resources/responses/responses`. This lives under `src/agent/` (an
   SDK-reachable zone), so it is the single place provider SDK types reach agent
   core. It is **green today only by non-reachability**: `ServerTools` is not
   imported anywhere under `packages/agent/src/` (`grep` → 0), so it is absent
   from every published door's `.d.ts` declaration graph, and
   `packages/agent/scripts/validate-artifacts.mjs` (which walks that graph per
   manifest entry and throws on `@anthropic-ai/sdk`/`openai`/`@google/genai`/
   `@openrouter/sdk`) passes. The risk is that the build-time guard is the
   *only* thing standing between these imports and a real provider-type leak: if
   `ServerTools` is ever pulled onto a Tier-1 barrel, it leaks. Recommendation
   (for a future acting pass, not this recorded one): keep provider SDK types
   out of any potentially-exported signature by defining local structural
   aliases in `ServerTools.ts`, so containment rests on the type definitions
   themselves rather than on non-reachability. Low urgency while `ServerTools`
   stays un-fronted; worth resolving before any Tier-1 re-enumeration (§5.4)
   that might touch it.

## 6. Carried-forward design notes (unchanged, none a defect)

- **Logger + telemetry are process-global singletons** (`logSink.ts`'s
  module-level `let sink`, mutated by `setLogSink`, read by every
  `writeLogEntry`). `platform().log` deliberately does not exist
  (`src/platform/platform.ts` documents "Hosts install their log sink via
  `logSink.setLogSink` directly"), consistent with Platform shrinking onto
  services. The SDK-correct unlock — an injectable sink owner behind a Tier-1
  door — is designed for logging, unspecified for usage/telemetry; both stay
  gated on the named-external-consumer hold.
- **Two Tier-1 leaf surfaces stay un-fronted, as the manifest predicts:**
  `@agent/core/state/runRequests` and
  `@agent/implementations/agentCreator/agentCreatorFlow` are still reached by
  full deep path; the latter is design-gated on `runAgentCreator`'s
  interactive-UI boundary (§4). For the SDK package's own row, `core/definition`
  and `core/tools` stay un-`index`ed — the deliberate width a Tier-1 barrel must
  re-export or seal.
- **`HostInteractions` required/optional** remains an open maintainer contract
  decision; **npm publication** remains gated on the named-external-consumer
  hold (`packages/agent` builds and bundles but is not published; the one
  in-repo consumer-shaped artifact is `packages/agent/example/effectSession.mjs`,
  which exercises `/effect` + `/node` only).

## 7. Bottom line

Thirteen consecutive passes find a green top-line verdict. The Effect-4 cutover
(node engine, `ModelHandler` god-base, and `IModelHandler` port deleted with no
shim; the model stack now `ModelInvoker.ts` + `runtime/run/*` over the run
ledger) stays complete and un-regressed; the `effect` peer README drift `-09-14`
fixed is present and clean; deep-import width holds at 5/4/8/7; all eight named
doors are fronted. The run loop's fold-based continuation (§3) and the logger
(§3) re-verify clean with no silent degradation. The subagent SPI is a real
four-implementor contract; `agentCreator` is the single, correctly-open
boundary. Of the six §5 items, five are carried-forward non-defects (two minor
cleanups, one baselined test-only export, one manifest re-enumeration, one
recorded README-drift note) and one is a **new containment note** (§5.6,
`ServerTools` provider-type imports, green by non-reachability) — none a live
defect, so, absent a maintainer request this scheduled firing does not carry,
nothing is edited into the green tree this pass.
