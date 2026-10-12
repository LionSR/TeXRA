# Agent SDK readiness re-verify: the 2026-10-12 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding, and it
supersedes the 2026-10-04 pass (`2026-10-04-agent-sdk-readiness-reverify.md`),
which is now deleted; version control keeps it, per `.agents/docs/README.md`.

## Pin

Verified against branch `claude/eager-noether-3a6qh4` at `d8d4a6b`. The
2026-10-04 pass's pin, `ae953c3`, is an ancestor of `d8d4a6b` — **210 commits
back** (`git rev-list --count ae953c3..d8d4a6b`); it only looks unreachable from
a shallow clone, which needs `git fetch --deepen` first. This pass re-verifies
the current tree and reads that range for the delta.

The last pass predicted "re-running this audit as a routine will again add no
signal **until the harness program moves**." It moved — a lot. The 210-commit
delta is the largest between any two passes, and it is the reason this one is
worth recording: the harness program the last pass pivoted onto has executed
through its middle, the package was renamed, and three of the last pass's own
coordinates are now stale names. The verdict is unchanged; the map is not.

## What moved in the delta (the program executed, by review)

The delta is almost entirely the accepted durable-harness program
(`2026-10-02-durable-harness.md`), the harness-package-split (`2026-10-02-harness-package-split.md`)
and the codemode program running through their lanes. Every move is in the
direction this charter asks for, and every one landed through human review, not
this routine:

- **The SDK package was renamed `packages/agent` (`@texra-ai/agent`) →
  `packages/harness` (`@texra-ai/harness`)** at `packages/harness` (M8 slice 1,
  #13756), and the app and hosts now reach the ports, request errors, follow-up
  and presentation helpers through `@texra-ai/harness` (#13782, and the CLI
  follow-ups). **Every path in the last pass that read `src/agent/…` or
  `packages/agent/…` is renamed**; the coordinates below are re-pinned.
- **Abstractions were removed, not added** — the charter's literal ask, done by
  review: `AgentEngine` is gone, the parent edge is the run's rows (lane D2b-1,
  #13949); `runAgent` and the plugin's raw registry are gone, `Runs` is the
  session's one run surface (lane D2b-2, #13952); `run.snapshot` is gone, every
  fact the loop reads is a row (#13837); the background drift layer is deleted
  (#13838); `stateMutation` and `AgentWorkspaceState` are gone, the workspace is
  folded from tool results (#13834); the `tool.binding` row kind is gone
  (#13851); stored and config fields nothing reads were deleted (#13871);
  hand-rolled helpers were replaced by Effect/Node/dependency built-ins
  (#13860). A `ToolHost`/`runAgent`/`AgentEngine`/`modelBinding` grep over
  `packages/harness/src` is now empty.
- **The model handler was consolidated**: `one ModelAccess replaces model
  binding, routes and failure reading` (#13919) — the old `modelBinding.ts` is
  gone, replaced by `runtime/modelAccess/` (`ModelAccess.ts`, `binding.ts`,
  `credentials.ts`, `failureInfo.ts`, `routeDecision.ts`); `BoundModel` keeps
  what the run reads and picker copy/coding plans/`modelFileName` moved to the
  app (#13920). The invocation ledger became one retry loop over the attempt
  rows (lane 3, #13835).
- **The run history is one door, one cell**: every run writes through its cell;
  runs are born with their opening (lane D1, #13932); every row a run's state
  folds commits through its cell (lane D2a, #13938). A second composition in a
  process is refused a root the first holds (lane G1, #13947).
- **The SDK extend surface landed** (durable-harness H4): `feat(sdk):
  persistent sessions, session.resume, and an approval handler` (#13867);
  `StartInput takes an inline persona` (#13856); hosts and `Sessions.layer`
  compose one `processLayer` (#13825). App-owned session/plugin modules, editor
  capabilities and the auto-open policy moved out of the harness into the app
  (lanes G2/G3/G5, #13940/#13945/#13953), shrinking the boundary the manifest
  must describe.

## Verdict (unchanged)

The codebase is still well-aligned, and this audit remains a standing program,
not a gap. **No autonomous refactor is warranted from this charter.** Four
read-only audits this pass — agent core, model handler, logger, SDK surface —
found **no wrapper layer that only forwards, no second run-history writer, no
services-bag, no re-export shim from any renamed or deleted module.** The loop
and the model handler each grew files (the loop's `step/modelSwitch/toolGuard/
hooks/rounds`; the model handler's five `modelAccess/` files), but each file is
an Effect-native, concern-separated decomposition of one program, not an added
indirection tier — there is still one `Effect` per run appending one history,
and one `ModelAccess` service binding one `@texra-ai/llm` `Model`.

## The four asks, re-mapped to the current pin

1. **Identify the areas.** Re-confirmed at the renamed paths:
   - Agent core: `packages/harness/src/agent/core/` (`definition/`, `state/`,
     `tools/`); run program `@agent/runtime/loop/toolUse.ts` over the run
     history (`RunHistory.ts`, one `makeRunHistory`), round mode via
     `loop/rounds.ts`, shared scaffolding in `loop/runProgram.ts`; the run
     loop's model call is `@agent/runtime/ModelInvoker.ts`, with `helperModel.ts`
     and `run/compaction.ts` invoking the bound `Model` through `run/modelCall.ts`
     — the two deliberate direct exceptions, unchanged.
   - Model handler: `packages/harness/src/agent/runtime/modelAccess/` —
     `ModelAccess` is the single `Context.Service` (`ModelAccess.ts`), orchestrating
     `routeDecision → binding → credentials + bindWireModel (@texra-ai/llm) +
     failureInfo`. Provider SDKs are constructed only inside the llm Model, loaded
     only by `bindModel` (`packages/llm/src/node.ts`).
   - Logger: `packages/harness/src/logger/` (`effectLog.ts`, `logSink.ts`,
     `effectDiagnostics.ts`, `formatLogData.ts`, `redaction.ts`) — same five-file
     set as the last pass, moved under `packages/harness`.
   - SDK surface: `packages/harness` (`@texra-ai/harness`) — `index.ts`,
     `node.ts`, `plugins.ts`, `schemas.ts`, `effect/`.

2. **Audit for unnecessary abstraction.** Done, four ways.
   - **Agent core.** One run-history writer intact: `makeRunHistory`
     (`runtime/RunHistory.ts`) is the sole implementation; the loop and
     `finalizeRun` (`storage/runLifecycle.ts`, "the one writer of a run's end")
     are the documented lifecycle split, and both append through the one
     `RunCell` door, serialized by the publisher and the cell's `SynchronizedRef`.
     The only non-cell append is the documented, guarded "run ends unloaded"
     degraded path. `SessionHandle` is still a flat record of owner fields
     (`roots`, `log`, `view`, `runs`, `tools`, `requests`, `approvals`,
     `interactions`, `followUps`, `trace`, `runHistory`, `history`;
     `SessionHandle.ts:342-372`) whose header states it "does no work and
     forwards nothing." `ChildRuns` (lane E5, `runtime/ToolServices.ts`) is a
     capability-narrowing door that hides `SessionHandle` from plugin tools and
     refuses when there is no run — logic, not a pass-through.
   - **Model handler.** `ModelAccess` is one service; its four sibling files each
     do distinct real work and none merely forwards to another. The `Model`
     interface (`packages/llm/src/turn.ts`) still takes only the Zod-guarded
     materialized `TurnRequest`, revalidated at the boundary
     (`turnInput.ts`), and keeps host concerns in `BindSpec`/`BoundModel`. No
     `modelBinding` re-export survives.
   - **Logger.** Reached through the clean host-agnostic producer port
     (`Effect.log*` + `withLogChannel`), render→redact→truncate single-owner. The
     one remaining structural item is the sink→Layer conversion (§Carried.1),
     still unlanded.
   - **SDK surface.** The center (Sessions/Session/Run + tagged errors +
     `defineTool`, pure Effect, no in-package `runPromise`) is minimal and clean.
     The approval handler and persistent-session/resume surface (#13867) are new,
     intended additions; the redundancy that remains is at the edges
     (§Carried.3).

3. **Plan API-surface simplification.** Still the durable-harness "extend" half
   (`Plugin`, `Sessions.layer({ plugins })`, `Plugins.contribute`,
   `Session.resume`), much of which has now landed, plus the frozen-list shrink
   AGENTS.md names. The SDK speaks pure Effect end-to-end; the Promise boundary
   stays gone. The one owner-level item the surface audit still asks for is
   §Carried.3.

4. **Design subagent boundaries.** Already first-class, re-confirmed unchanged:
   (a) native subagents via `executeAgent` with an owned `RunId`
   (`runtime/executeAgent.ts:298`); (b) the workflow-script run plus its
   `agent()` grandchildren (`runtime/scriptRun.ts`); (c) the agent-CLI children —
   `claude_code` (`packages/texra/src/tools/claudeAgent.ts`) and `codex`
   (`packages/texra/src/tools/codex.ts`), each loading its own provider SDK —
   through `startDetachedChildRunLoop` with a provider-specific `ChildRunStrategy`
   (`runtime/childRunLoop.ts`, `runtime/nativeSubagentStrategy.ts`). The
   non-candidates (round-output extraction, `compileCheck`, `LatexDiffManager`)
   still have no independent run or model lifecycle, so reifying one buys nothing.
   No boundary change is warranted.

## Carried (needs an owner, not a routine) — unchanged since the last pass

1. **The logger sink→Layer step is still unlanded.**
   `packages/harness/src/logger/logSink.ts` still holds the mutable module global
   (`const consoleLogSink` :133, `let sink = consoleLogSink` :165, `setLogSink`
   :173, `writeLogEntry` :183), set by the host callers. This remains the one
   real SDK-relevant host leak: `packages/harness/src/effect/*` composes the
   process runtime but installs no sink, so an embedder of `@texra-ai/harness`
   gets whatever process-global sink is set and cannot inject its own through
   `Sessions.layer`/`AgentPlatform`, and two embedders in one process share one
   global. This is step 6 of `2026-09-21-effect-design-synchronous-facades.md`
   §5 and rides that note; it is the expensive step (it rewrites the kernel
   log-capture seam) and does not, by itself, deliver embedder injection through
   the public boundary — that is a further, not-yet-designed public-API step.

2. **The two `packages/llm` ambient `process.env` reads remain.**
   `anthropicMessages.ts:715` and `openaiResponsesRequest.ts:254`
   (`*_CUSTOM_HEADERS`) are the only ambient env reads in the llm request path —
   still two, the line numbers moved with the chat-codec consolidation. These are
   intentional guardrails; moving the check to the host boundary remains a
   relocation that must be passed explicitly into every factory (the
   `packages/llm/test-live/` callers construct the factories without a binding),
   not a lift. Low priority; file into `2026-09-20-llm-package-hardening.md` or a
   fresh tech-debt entry.

3. **Re-scope the Tier-1 manifest around the harness SDK — now overdue.** The
   2026-09-10 static-export manifest (`2026-09-10-agent-sdk-tier-1-manifest.md`,
   still status: proposed) pins the old static list against the deleted package
   name `packages/agent` and the deleted type `ToolHost`, and predates the
   harness extend surface the live `packages/harness/src/index.ts` now exports —
   `Plugin`, `Composition` (`./effect/sessions.js`), `ApprovalHandler` (new with
   #13867), `ToolGuard`, `SettingHost`. Ratifying it as-is would pin a deleted
   name and omit the very surface the pivot is built on, so it should be retired
   or rewritten against the durable-harness program rather than ratified. The
   shed/leak questions that survive the pivot are unchanged: `SettingHost`
   (TeXRA's internal host enum reaching the public tool-definition contract via
   `unavailableHosts`) and the `MapToolRegistry`/`IToolRegistry` registry
   plumbing an embedder on the documented `StartInput.tools`/`defineTool` path
   never constructs (both still exported from `index.ts`).

## Observations this pass (not defects, recorded so the next pass need not re-derive)

- **Error surface grew 6 → 8, docs kept in sync.** The last pass reconciled the
  surface at six (four defined + two store errors). It is now **eight**:
  `packages/harness/src/effect/errors.ts` defines six (plugin-list refusal,
  reopen-options-differ, the two launch refusals, the resume refusal, the run's
  own failure) and re-exports two store errors (`DatabaseOpenFailed`,
  `DatabaseReadFailed`, the `SessionOpenError` union). Both the `errors.ts`
  header and `packages/harness/README.md` already state "eight in all" — they
  grew together with the new defined errors (resume/reopen), so there is no
  reconcile to apply. Recorded only because the count changed from the last
  pass's pin.
- **One direct `bound.model.*` call outside invoker/helper/compaction, and it is
  not inference.** `loop/toolUseDispatch.ts:1158` binds `bound.model.uploadFile`
  (invoked during tool-result delivery to offer delivered documents to the
  provider upload cache). It is a file-upload-cache primitive on the bound model,
  not a turn/generation call, so it is not a second model handler and warrants no
  change — the analogue of the last pass's `modelBinding` re-guard note: a direct
  touch that is correct where it is. Recorded so a future audit does not flag it
  as a fourth model-call site.
- **The marginal single-caller cleanup the last pass carried is resolved by
  deletion.** `finalizeRunTerminalBody` (last pass: `AgentRunLifecycle.ts:134`,
  "cosmetic split, carried") no longer exists — the file was rewritten in the
  lifecycle lanes (`runWithLifecycle`/`finalizeRunTerminal` now carry the
  terminal choreography). Dropped from the list.

## Recommendation

No refactor to land autonomously from this charter. "Agent SDK readiness" tracks
the durable-harness program (`2026-10-02-durable-harness.md` H1–H6), which has
executed through its middle this delta; the one owner-level action the surface
audit asks for is to **re-scope the Tier-1 manifest around the harness SDK rather
than ratify the 2026-09-10 static list** (§Carried.3) — now overdue, because the
manifest pins a deleted package name and a deleted type while the live root entry
already carries the harness extend surface. The logger sink→Layer step
(§Carried.1) rides `2026-09-21-effect-design-synchronous-facades.md`; the two
`packages/llm` ambient reads (§Carried.2) still need filing. Re-running this
audit as a routine will again add no refactor signal until the harness program
moves further; the signal it adds is this re-pin and delta record.
