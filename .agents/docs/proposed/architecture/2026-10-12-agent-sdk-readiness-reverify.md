# Agent SDK readiness re-verify: the 2026-10-12 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding, and it
supersedes the 2026-10-10 pass (`2026-10-10-agent-sdk-readiness-reverify.md`),
which is now deleted; version control keeps it, per `.agents/docs/README.md`.
(The 2026-10-10 pass had itself superseded 2026-10-04.)

## Why a fresh pass two days after 2026-10-10

Two scheduled sessions ran this charter in parallel: `claude/eager-noether-5nwuta`
produced the 2026-10-10 pass (pin `8a58597`, #13922), which landed on `main`;
this session (`claude/eager-noether-3a6qh4`) produced the present pass against a
tree **18 commits newer**. Rather than keep two near-duplicate notes, this one
folds the 2026-10-10 pass's findings forward (including two points where it was
sharper than an earlier draft of this pass — see §Carried.2 and §Observations)
and re-pins to the newer tree. The duplicate-routine race is itself worth the
owner's attention: one scheduled charter, not two, should own this standing
audit.

## Pin

Verified against branch `claude/eager-noether-3a6qh4` at `d8d4a6b`. The immediate
prior pass's pin, `8a58597` (2026-10-10), is an ancestor — **18 commits back**
(`git rev-list --count 8a58597..d8d4a6b`). The 2026-10-04 pin `ae953c3` is 210
commits back; the 2026-10-10 pass already read the bulk of that arc (the
`packages/agent` → `packages/harness` split, the `ModelAccess` consolidation,
the `BoundModel` slimming), so this pass does not re-narrate it — it reads the
18-commit delta since 2026-10-10 and re-confirms the whole.

## What moved in the 18-commit delta (abstractions removed, by review)

The delta since the 2026-10-10 pin is the D/E/G lanes of the durable-harness and
run-surface work, every move in the direction this charter asks for and every
one landed through human review, not this routine:

- **`AgentEngine` is gone**; the parent edge is the run's rows (lane D2b-1,
  #13949). **`runAgent` and the plugin's raw registry are gone**; `Runs` is the
  session's one run surface (lane D2b-2, #13952), simplified after lanes C and D
  (#13954). An `AgentEngine`/`runAgent` grep over `packages/harness/src` is now
  empty.
- **The run history is one door, one cell**: every run writes through its cell
  and runs are born with their opening (lane D1, #13932); every row a run's state
  folds commits through its cell (lane D2a, #13938).
- **App concerns left the harness**: app plugin tools hold no `SessionHandle` —
  `ChildRuns` and call requests serve them (lane E5, #13955); editor capabilities
  left `HostInteractions` (lane G3, #13945); the auto-open policy moved to the app
  and a tool marks itself as launching tasks (lane G5, #13953); a tool edit's
  preview is a request kind and hosts read the persisted approval policy (lane G4,
  #13950). A second composition in a process is refused a root the first holds
  (lane G1, #13947).

Everything the 2026-10-10 pass recorded about the earlier arc still holds at this
pin: the package is `@texra-ai/harness`; the model handler is one `ModelAccess`
service over the `@texra-ai/llm` `Model`; `BoundModel` keeps only what the run
reads; the SDK extend surface (`Plugin`, `Composition`, `Sessions`,
`InlinePersona`) is intended shape, not drift.

## Verdict (unchanged)

The codebase is still well-aligned, and this audit remains a standing program,
not a gap. **No autonomous refactor is warranted from this charter.** Four
read-only audits this pass — agent core, model handler, logger, SDK surface —
found **no wrapper layer that only forwards, no second run-history writer, no
services-bag, no re-export shim** introduced by the lane work. The loop and the
model handler each carry many files, but each is an Effect-native,
concern-separated decomposition of one program under the 400-line core rule, not
an added indirection tier — one `Effect` per run appending one history, one
`ModelAccess` service binding one `Model`.

## The four asks, re-mapped to the current pin

1. **Identify the areas.** Re-confirmed:
   - Agent core: `packages/harness/src/agent/core/` (`definition/`, `state/`,
     `tools/`); run program `@agent/runtime/loop/toolUse.ts` over the run history
     (`RunHistory.ts`, one `makeRunHistory`), with shared
     scaffolding in `loop/runProgram.ts` and the loop decomposed into
     `loop/{step,modelSwitch,toolGuard,hooks,rows,toolUseDispatch}.ts` (there is
     no `loop/rounds.ts` at this pin — the earlier round-mode file is gone from
     the harness loop); the loop's turn call is
     `ModelInvoker.ts`, with `helperModel.ts` and `run/compaction.ts` reusing the
     same `callModel` seam (`run/modelCall.ts`) — reuse of the one model-call
     path, not a second handler.
   - Model handler: `packages/harness/src/agent/runtime/modelAccess/`
     (`ModelAccess.ts`, `binding.ts`, `credentials.ts`, `failureInfo.ts`,
     `routeDecision.ts`) — one service over the `@texra-ai/llm` `Model`. Provider
     SDKs are constructed only inside the llm Model, loaded only by `bindModel`
     (`packages/llm/src/node.ts`), whose one caller is `modelAccess/binding.ts`.
     The deliberate exceptions outside that route are unchanged: audio
     transcription builds `OpenAI` directly
     (`packages/texra/src/tools/media/audio.ts:253`); the `codex`/`claude_code`
     tools load their own provider SDKs; the settings-view consent probe
     acquires a VS Code `Model`.
   - Logger: `packages/harness/src/logger/` (`effectLog.ts`, `logSink.ts`,
     `effectDiagnostics.ts`, `formatLogData.ts`, `redaction.ts`) — same five-file
     set.
   - SDK surface: `packages/harness` (`@texra-ai/harness`) — `index.ts`,
     `node.ts`, `plugins.ts`, `schemas.ts`, `effect/`.

2. **Audit for unnecessary abstraction.** Done, four ways.
   - **Agent core.** One run-history writer intact: `makeRunHistory`
     (`runtime/RunHistory.ts`) is the sole implementation; `appendBatch`'s live
     call site is `RunCell.append` (the one writer, with the `SynchronizedRef`
     lock, fold-back and uninterruptible mask), and `finalizeRun`
     (`storage/runLifecycle.ts`, "the one writer of a run's end") appends through
     the same cell door. `forkRun.ts` is the one-time atomic birth of a _new_
     forked run, not a second writer into an existing one. `SessionHandle`
     remains a flat record of owner fields that "does no work and forwards
     nothing" (`SessionHandle.ts:342-372`). `ChildRuns` (lane E5,
     `runtime/ToolServices.ts`) is a capability-narrowing door that hides
     `SessionHandle` from plugin tools and refuses when there is no run — logic,
     not a pass-through.
   - **Model handler.** `ModelAccess` is one service; its four sibling files each
     do distinct real work (routing once in `routeDecision.ts`, failure wording
     once in `failureInfo.ts`, credentials in `credentials.ts`, the `BoundModel`
     build in `binding.ts`) and none merely forwards to another. The `Model`
     interface (`packages/llm/src/turn.ts`) still takes only the Zod-guarded
     materialized `TurnRequest`, revalidated at the boundary (`turnInput.ts`), and
     keeps host concerns in `BindSpec`/`BoundModel`. No `modelBinding` re-export
     survives.
   - **Logger.** Reached through the clean host-agnostic producer port
     (`Effect.log*` + `withLogChannel`), render→redact→truncate single-owner. The
     one remaining structural item is the sink→Layer conversion (§Carried.1),
     still unlanded.
   - **SDK surface.** The center (Sessions/Session/Run + tagged errors +
     `defineTool`, pure Effect, no in-package `runPromise`/`runSync`/`runFork`) is
     minimal and clean. The redundancy that remains is at the edges
     (§Carried.3).

3. **Plan API-surface simplification.** The durable-harness "extend" half
   (`Plugin`, `Sessions.layer({ plugins })`, `Plugins.contribute`,
   `Session.resume`), much of which has landed, plus the frozen-list shrink
   AGENTS.md names. The SDK speaks pure Effect end-to-end. The one owner-level
   item the surface audit still asks for is §Carried.3.

4. **Design subagent boundaries.** First-class and unchanged: (a) native
   subagents via `executeAgent` with an owned `RunId` (dispatch in
   `tools/delegation/inBandSubagentRun.ts`); (b) the workflow-script run plus its
   `agent()` grandchildren (`runtime/scriptRun.ts`); (c) the agent-CLI children —
   `claude_code` (`packages/texra/src/tools/claudeAgent.ts`) and `codex`
   (`packages/texra/src/tools/codex.ts`), each loading its own provider SDK —
   which enter through `ChildRuns.launchProcess` (`runtime/ToolServices.ts`) and
   build their provider-specific strategies in the app tool modules
   (`packages/texra/src/tools/agentCliShared.ts`), the detached driver being
   `startDetachedChildRunLoop` (`tools/delegation/detachedChildRun.ts`);
   `runtime/nativeSubagentStrategy.ts` is the separate in-process native
   strategy, not the CLI-child path. The non-candidates (`compileCheck`,
   `LatexDiffManager`) still have no independent run or model lifecycle. No
   boundary change is warranted.

## Carried (needs an owner, not a routine)

1. **The logger sink→Layer step is still unlanded, and the composition root
   still installs no sink.** `packages/harness/src/logger/logSink.ts` holds the
   mutable module global (`const consoleLogSink` :133, `let sink = consoleLogSink`
   :165, `let sinkTrusted = false` :166, `setLogSink` :173, `writeLogEntry` :183),
   set by the host bootstraps (`packages/{extension,desktop,cli}` call
   `setLogSink`). The embedder-facing composition (`effect/sessions.ts`,
   `platform/processRuntime.ts`) installs no sink, so an embedder of
   `@texra-ai/harness` gets whatever process-global sink is set and cannot inject
   its own through `Sessions.layer`/`AgentPlatform`, and two embedders in one
   process share one global. This is the one real SDK-relevant host leak; step 6
   of `2026-09-21-effect-design-synchronous-facades.md` §5, riding that note. It
   is the expensive step (it rewrites the kernel log-capture seam) and does not,
   by itself, deliver embedder injection through the public boundary — a further,
   not-yet-designed public-API step.

2. **The two `packages/llm` ambient-header reads are refusal guards, effectively
   closed.** At this pin neither path _honors_ an ambient value:
   `openaiResponsesRequest.ts:254` throws a `ModelError` (`kind 'unsupported'`,
   "Ambient OpenAI headers cannot override the selected deployment.") when
   `OPENAI_CUSTOM_HEADERS` is set, and `anthropicMessages.ts:715` throws a
   `ModelError` ("Anthropic Messages does not support ANTHROPIC_CUSTOM_HEADERS
   …") — both make the selected binding the sole source of request headers. These
   are intentional guardrails, not value-honoring reads; relocating the
   `process.env` _check_ to the host boundary stays a low-value relocation (each
   llm factory would have to be passed the decision explicitly, and
   `packages/llm/test-live/` constructs factories without it), not a lift. Low
   priority; file into `2026-09-20-llm-package-hardening.md` only if the
   relocation is ever wanted.

3. **Re-scope the Tier-1 manifest around the harness SDK — overdue.** The
   2026-09-10 static-export manifest (`2026-09-10-agent-sdk-tier-1-manifest.md`,
   status: proposed) still names the **old package** throughout (`packages/agent`,
   `@texra-ai/agent`, `@texra-ai/agent/{schemas,node}`, `typecheck:agent`), a
   package that no longer exists, and carries the earlier drift: it lists
   `ToolHost` as a root type (a `ToolHost` grep of `packages/harness/src` is empty)
   and omits `Plugin`, `Composition`, `InlinePersona`, which the live root entry
   (`packages/harness/src/index.ts`) now carries as the harness extend surface.
   Ratifying it as-is would pin a dead package name and a deleted type, so it
   should be retired or rewritten around `@texra-ai/harness` and its entries
   (`.`, `/schemas`, `/plugins`, `/node`) — durable-harness program, not this
   routine. The shed/leak questions that survive the pivot are unchanged:
   `SettingHost` (TeXRA's internal host enum reaching the public tool-definition
   contract via `unavailableHosts`) and the `MapToolRegistry`/`IToolRegistry`
   registry plumbing an embedder on the documented `StartInput.tools`/`defineTool`
   path never constructs (both still exported from `index.ts`).

## Observations this pass (not defects, recorded so the next pass need not re-derive)

- **Error vocabulary: eight lifecycle+store, seventeen tagged classes in all; the
  "eight in all" wording is scoped.** `packages/harness/src/effect/errors.ts`
  defines six lifecycle tagged errors (`PluginsRefused`, `SessionOptionsConflict`,
  `AgentNotFound`, `ToolsRefused`, `ResumeRefused`, `RunFailure`) plus two
  re-exported store errors (`DatabaseOpenFailed`, `DatabaseReadFailed`, the
  `SessionOpenError` union) — eight, which both the `errors.ts` header and
  `packages/harness/README.md` state with the same breakdown; that reconcile held
  through the growth from the 2026-10-04 six. But the root entry also re-exports
  the `RequestError` union values (`NotOwner`, `Unavailable`, `Cancelled`,
  `Rejected`, `Internal`) and the platform error classes (`ConfigWriteFailed`,
  `StateReadFailed`, `StateWriteFailed`, `AgentDirectoriesFailed`), for seventeen
  tagged-error classes in all. Those are separately documented families (the
  request vocabulary every host reads; the platform-port write failures), not a
  second launch-error vocabulary — so the eight is the lifecycle+store count
  correctly, but the "eight … in all" phrasing reads as a total it is not. A
  one-line clarification in `errors.ts`/README is a cheap owner-level follow-up,
  not a reconcile this pass owns.
- **One direct `bound.model.*` call outside invoker/helper/compaction, and it is
  not inference.** `loop/toolUseDispatch.ts:1158` binds `bound.model.uploadFile`
  (invoked during tool-result delivery to offer delivered documents to the
  provider upload cache). It is a file-upload-cache primitive on the bound model,
  not a turn/generation call, so it is not a second model handler and warrants no
  change. Recorded so a future audit does not flag it as a fourth model-call site.
- **The marginal single-caller cleanup earlier passes carried is resolved by
  deletion.** `finalizeRunTerminalBody` (2026-10-04: `AgentRunLifecycle.ts:134`)
  no longer exists — the file was rewritten in the lifecycle lanes
  (`runWithLifecycle`/`finalizeRunTerminal` now carry the terminal choreography).

## Recommendation

No refactor to land autonomously from this charter. "Agent SDK readiness" tracks
the durable-harness program (`2026-10-02-durable-harness.md` H1–H6), which
continued through its D/E/G lanes this delta; the one owner-level action the
surface audit asks for is to **re-scope the Tier-1 manifest around the harness
SDK rather than ratify the 2026-09-10 static list** (§Carried.3) — overdue. The
logger sink→Layer step (§Carried.1) rides
`2026-09-21-effect-design-synchronous-facades.md`; the two `packages/llm` ambient
reads (§Carried.2) are effectively closed as refusal guards. **Separately, the
two parallel scheduled sessions running this one charter should be consolidated
to one** so future passes do not race to re-pin the same note. Re-running this
audit as a routine will again add no refactor signal until the harness program
moves further.
