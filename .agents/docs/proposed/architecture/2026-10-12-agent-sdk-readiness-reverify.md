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

**Pin vs. landing tree.** Module paths and line numbers below are as of the pin
`d8d4a6b`. This note lands on a branch that has since merged `main` (≈40 further
commits), which relocated a few cited coordinates — e.g. the process
composition moved from `effect/sessions.ts` to `effect/processLayer.ts`, and the
tagged-error headline count stepped up — so where the merge moved a cited path,
the landing-tree location governs and the authoritative, non-drifting reference
for the public export surface is `config/api-reports/`, not a path pinned here. Fully re-pinning every coordinate to the merged tree is
owner-level follow-up, not this routine.

## What moved in the 18-commit delta (abstractions removed, by review)

The delta since the 2026-10-10 pin is the D/E/G lanes of the durable-harness and
run-surface work, every move in the direction this charter asks for and every
one landed through human review, not this routine:

- **`AgentEngine` is gone**; the parent edge is the run's rows (lane D2b-1,
  #13949). **`runAgent` and the plugin's raw registry are gone**; `Runs` is the
  session's one run surface (lane D2b-2, #13952), simplified after lanes C and D
  (#13954). An `AgentEngine`/`runAgent` grep over `packages/harness/src` is now
  empty.
- **The run history is one door, one cell**: the loop's run-history writes go
  through its cell and runs are born with their opening (lane D1, #13932; lane
  D2a, #13938) — scoped to the loop's own history, not every run-state row (see
  the writer-map note under ask 2).
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
found **no wrapper layer that only forwards, no second writer of the loop's run
history, no services-bag, no re-export shim** introduced by the lane work. The loop and the
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
     `routeDecision.ts`) is the one binding service a run goes through. It binds
     two kinds of route: the wire `@texra-ai/llm` `Model` through `bindModel`
     (`packages/llm/src/node.ts`, whose one caller is `modelAccess/binding.ts`),
     and the editor-backed route (`bindEditor` → `LanguageModel.acquire`, served
     by the extension's `acquireVscodeLanguageModel`) for VS Code/Copilot runs —
     so acquiring a VS Code `Model` is a real inference route, not only the
     settings-view consent probe. The model work that stays outside ModelAccess
     is the known set of tools that load their own provider SDK directly: audio
     transcription builds `OpenAI` (`packages/texra/src/tools/media/audio.ts:253`)
     and the `codex`/`claude_code` agent-CLI tools.
   - Logger: `packages/harness/src/logger/` (`effectLog.ts`, `logSink.ts`,
     `effectDiagnostics.ts`, `formatLogData.ts`, `redaction.ts`) — same five-file
     set.
   - SDK surface: `packages/harness` (`@texra-ai/harness`) — `index.ts`,
     `node.ts`, `plugins.ts`, `schemas.ts`, `effect/`.

2. **Audit for unnecessary abstraction.** Done, four ways.
   - **Agent core.** One run-history writer intact: `makeRunHistory`
     (`runtime/RunHistory.ts`) is the sole implementation, and after the D1/D2
     "one door, one cell" refactor the loop's run-history writes funnel through
     `RunCell.append` → its internal `commit` → `sessionLog.transact` (the one
     writer, with the `SynchronizedRef` lock, fold-back and uninterruptible
     mask); `finalizeRun` (`storage/runLifecycle.ts`, "the one writer of a run's
     end") appends through that same cell door, and `forkRun.ts` is the one-time
     atomic birth of a _new_ forked run, not a second writer into an existing
     one. The invariant is that the loop is the one writer of its own run
     history through that cell, not that literally every run-state row is written
     through the cell: several other run-state row kinds are written directly
     through `session.log.transact`/`runStateAppend` by other parts of the system
     — among them the request surface (`request.*`), settlement/meta rows
     (`child.turn`, `run.description`, `run.result`), and `endIn`'s loud "run ends
     unloaded" fallback (`runLifecycle.ts:285`). Some have more than one writer
     (e.g. a row's birth, its user/model update, and its settled form), which is
     fine — none of them is a second writer of the **loop's** history, and that
     is the single-writer invariant this audit checks. (The run-state fold,
     `shared/session/runStateFold.ts`, classifies which row types it folds into
     `RunState` versus ignores — `run.description`, `run.result` and `child.turn`
     sit in its ignored set, folded by their own readers — so it is a row-type
     classification, not a row-to-writer map.) `SessionHandle`
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
     `defineTool`) is pure Effect with no `Effect.run*` at the data/center
     surface. The deliberate exception is the runtime-entry module
     `platform/processRuntime.ts`, the named runtime entry where the publicly
     exported `withForkFailureReporting` wraps `runtime.runFork` (the Tier-1
     manifest records this), per the ESLint `no-restricted-syntax` carve-out for
     runtime entries — not a stray `run*` in the center. The center is minimal
     and clean; the redundancy that remains is at the edges (§Carried.3).

3. **Plan API-surface simplification.** The durable-harness "extend" half
   (`Plugin`, `Sessions.layer({ plugins })`, `Plugins.contribute`,
   `Session.resume`), much of which has landed, plus the frozen-list shrink
   AGENTS.md names. The SDK speaks pure Effect end-to-end. The one owner-level
   item the surface audit still asks for is §Carried.3.

4. **Design subagent boundaries.** First-class and unchanged: (a) native
   subagents via `executeAgent`/`resumeTurn` with an owned `RunId`, dispatched in
   the shared `runtime/nativeSubagentStrategy.ts` (`programs.executeAgent`/
   `resumeTurn`) that `subagentRun`/`scriptRun`/`resumeRun` reuse —
   `tools/delegation/inBandSubagentRun.ts` constructs that strategy and starts
   the shared child loop rather than dispatching itself; (b) the workflow-script run plus its
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
   `setLogSink`). The embedder-facing composition — `effect/processLayer.ts`
   (which defines `Sessions`/`Sessions.layer`/`processLayer` at the landing tree;
   it was in `effect/sessions.ts` at the pin) and `platform/processRuntime.ts` —
   installs no sink, so an embedder of
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

3. **Ratify the re-scoped Tier-1 manifest — the re-scope has landed; only the
   ratification is open.** The 2026-09-10 manifest
   (`2026-09-10-agent-sdk-tier-1-manifest.md`, status: proposed) carries a
   **2026-10-12 rework** that already did the re-scoping this charter's earlier
   passes asked for: it removed the hand-maintained static export inventory
   rather than re-pin it a fourth time, renamed the surface to `@texra-ai/harness`
   / `packages/harness`, and delegated the authoritative, non-drifting
   enumeration to the committed `config/api-reports/` snapshots. So the manifest
   no longer names a dead package or pins deleted types — the stale-coordinate
   problem the prior passes flagged is resolved. What stays **open** is the
   manifest's own stated gap: its §ratification (what Tier-1 keeps, seals, or
   sheds) is "open, awaiting an owner" — the durable-harness program, not this
   routine. The shed/leak questions that survive the pivot are unchanged:
   `SettingHost` (TeXRA's internal host enum reaching the public surface on more
   than one path — `ITool.unavailableHosts` and the required `host` field of
   `WorkspaceRoots`, exposed through the public `AgentPlatform.roots`/`Session.roots`
   (`platform/workspaceRoots.ts`) — so a seal/remove decision must cover the
   composition contract, not only the tool contract) and the
   `MapToolRegistry`/`IToolRegistry`
   registry plumbing an embedder on the documented `StartInput.tools`/`defineTool`
   path never constructs (both still exported from `index.ts`).

4. **Reconcile the stale package-name decision in the durable-harness note**
   (carried from the 2026-10-10 pass). `2026-10-02-durable-harness.md` still
   records "the package names (Q5) stay open" (line 15) and, under "Proposed
   names, still open (Q5)" (line 353), proposes `packages/theorist` /
   `@texra-ai/theorist` for the app plugins — but the tree resolved this: the
   app shipped as `packages/texra` / `@texra-ai/texra` and the SDK as
   `packages/harness` / `@texra-ai/harness`. The manifest's 2026-10-12 rework
   already treats Q5 as settled by the rename, so the durable-harness note is now
   the lone unreconciled post-rename document — its Q5 section should be closed
   against the landed names. Doc-only reconciliation, owner-level, not this
   routine; so manifest ratification (§Carried.3) is not the _only_ open owner
   action.

## Observations this pass (not defects, recorded so the next pass need not re-derive)

- **The error-vocabulary "N in all" wording is scoped to one family — a cheap
  owner-level clarification.** `packages/harness/src/effect/errors.ts` and
  `packages/harness/README.md` carry a headline count ("… in all") that both
  keep in sync and that moves as the surface grows (the lifecycle errors defined
  in `errors.ts` plus the re-exported store family — the count has stepped from
  six to the current nine as errors were added and `SessionOptionsConflict` moved
  into the store family). The authoritative, non-drifting enumeration is
  `errors.ts`/README plus the committed `config/api-reports/` snapshots, so this
  note deliberately asserts no fixed total of its own. The only point worth
  recording is that the "… in all" phrasing is scoped to the lifecycle+store
  family and is **not** the whole tagged-error surface: the root entry also
  re-exports the `RequestError` family (the request vocabulary every host reads)
  and the platform-port write-failure classes, which that headline does not
  count. A one-line scope clarification in `errors.ts`/README is the cheap
  owner-level follow-up; it is not a reconcile this pass owns, and the exact
  counts live in the api-report, not here.
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
continued through its D/E/G lanes this delta. The doc-only, owner-level actions
that remain are: **ratify the already-re-scoped Tier-1 manifest** (§Carried.3) —
its 2026-10-12 rework landed the re-scope around `@texra-ai/harness` and
delegated enumeration to `config/api-reports/`, leaving the owner ratification
open; **reconcile the durable-harness note's stale Q5 package-name section**
(§Carried.4) against the landed `@texra-ai/texra`/`@texra-ai/harness` names; and
the one-line `errors.ts`/README scope clarification noted in Observations (the
"… in all" headline is scoped to the lifecycle+store family). The
logger sink→Layer step (§Carried.1) rides
`2026-09-21-effect-design-synchronous-facades.md`; the two `packages/llm` ambient
reads (§Carried.2) are effectively closed as refusal guards. **Separately, the
two parallel scheduled sessions running this one charter should be consolidated
to one** so future passes do not race to re-pin the same note. Re-running this
audit as a routine will again add no refactor signal until the harness program
moves further.
