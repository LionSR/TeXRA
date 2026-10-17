# Agent SDK readiness re-verify: the 2026-10-17 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding, and it
supersedes the 2026-10-12 pass (`2026-10-12-agent-sdk-readiness-reverify.md`),
which is now deleted; version control keeps it, per `.agents/docs/README.md`.
(The 2026-10-12 pass had itself superseded 2026-10-10, which superseded
2026-10-04.)

## Pin

Verified against branch `claude/eager-noether-700vxo` at `de3b39a`. The prior
pass's pin, `d8d4a6b` (2026-10-12), is **50 commits back**
(`git rev-list --count d8d4a6b..de3b39a`). This pass reads the 50-commit delta
since 2026-10-12 and re-confirms the whole with four read-only audits (agent
core, model handler, logger, SDK surface). The authoritative, non-drifting
reference for the public export surface is `config/api-reports/`, not a path
pinned here.

## What moved in the 50-commit delta: the charter's own direction, landing by review

The delta since the 2026-10-12 pin is net **−1,021 lines across the four audited
areas** (agent `−1,308`, logger `−16`, llm handler churn, surface `+772` of
intended public manifest). It is a single coherent **public-surface program
("API P4–P8")** landing through human-reviewed PRs — every move in the direction
this charter asks for, none of it this routine's doing:

- **Subpath entries published:** `./plugins` (plugin-authoring API, #14100),
  `./schemas` + `./transcript` (browser-safe readonly views, #14119), `./node`
  (runs programs; harness-owned service keys, #14120).
- **Internal services promoted to a narrow public surface:** `Settings` (one
  service replaces four free functions, #14108), `AgentCatalog` (#14118),
  `MemoryStore` (#14126), the tool catalog as a narrow view (#14129),
  `Skills`/`InstalledPlugins` (#14131), `GlobalValues`/`StateStores` (#14127).
- **Deep-import drains:** hosts stop deep-importing the harness's core helpers
  (#14124, P8a); trace-viewer/desktop/extension reach the harness through its
  entries (#14082).
- **Log writers privatized:** hosts and the app log through Effect; the log
  writers stay private (#14112, P5e).

Two new files under `agent/` in this delta are single-owner consolidations, not
new indirection tiers: `runtime/recipeResult.ts` ("the one reader of a recipe's
`output.structured`") and `agent/index/agentCatalog.ts` (the process agent
catalog "every host reads through this service", P5c).

Everything the 2026-10-12 pass recorded about the earlier arc still holds at this
pin, re-confirmed by direct check: no `AgentEngine`/`runAgent` in
`packages/harness/src`; the loop's 8-file decomposition
(`loop/{toolUse,toolUseDispatch,runProgram,step,modelSwitch,toolGuard,hooks,rows}.ts`,
no `rounds.ts`); the 5-file `modelAccess/`; the model handler is one
`ModelAccess` over the `@texra-ai/llm` `Model`; the SDK extend surface
(`Plugin`, `Composition`, `Sessions`, `InlinePersona`) is intended shape.

## Verdict (unchanged)

The codebase is still well-aligned, and this audit remains a standing program,
not a gap. **No autonomous refactor is warranted from this charter.** The four
read-only audits this pass found **no wrapper layer that only forwards, no
second writer of the loop's run history, no services-bag, no re-export shim,
no one-caller factory** of the kind this charter hunts. The loop and model
handler each carry many files, but each is an Effect-native, concern-separated
decomposition of one program under the core-size rule, not an added indirection
tier — one `Effect` per run appending one history, one `ModelAccess` binding one
`Model`. "Agent SDK readiness" tracks the durable-harness program
(`2026-10-02-durable-harness.md`), which is landing its public-surface lanes as
the delta above; this routine adds no refactor signal on top of it.

## The four asks, re-mapped to the current pin

1. **Identify the areas.** Re-confirmed at `de3b39a`:
   - Agent core: `packages/harness/src/agent/core/` (`definition/{AgentConfig,RunRecord}.ts`,
     `tools/ToolTypes.ts` — no `core` barrel by policy). Run program
     `@agent/runtime/loop/toolUse.ts` (`runToolUse`, a plain
     `Effect.acquireUseRelease` loop, no cursor/graph) over the run history
     (`RunHistory.ts`/`RunCell`), with the loop's turn call through
     `ModelInvoker.ts` and `helperModel.ts`/`run/compaction.ts` reusing the one
     model-call seam (`run/modelCall.ts`). Per-run services from context:
     `AgentRun` (frozen value, "no node fields, no services bag"), `ModelInvoker`,
     `ModelAccess`, `RunHistory`/`RunCell`, `Runs`/`RunRegistry`.
   - Model handler: `packages/harness/src/agent/runtime/modelAccess/`
     (`ModelAccess.ts`, `binding.ts`, `credentials.ts`, `failureInfo.ts`,
     `routeDecision.ts`) is the one binding service — the wire
     `@texra-ai/llm` `Model` via `bindModel` (`packages/llm/src/node.ts`) and
     the editor route (`bindEditor`). The model work outside it is the known set
     of tools that load their own provider SDK (audio transcription;
     `codex`/`claude_code` agent-CLI).
   - Logger: `packages/harness/src/logger/` — the same five-file set
     (`effectLog.ts`, `logSink.ts`, `effectDiagnostics.ts`, `formatLogData.ts`,
     `redaction.ts`). The producer side (`withLogChannel`, `LogEntry`,
     `diagnosticLogger`) is a razor-thin mapping onto Effect by design; the sink
     side carries the render→redact→truncate single-owner logic.
   - SDK surface: `packages/harness` (`@texra-ai/harness`) — `index.ts` (the one
     sanctioned barrel, grouped and justified), `node.ts`, `plugins.ts`,
     `schemas.ts`, `transcriptEntry.ts`, `effect/`. Reads as a deliberate
     manifest, not a grab-bag; dead-export axis is green (knip flags no logger
     or entry-file export).

2. **Audit for unnecessary abstraction.** Done four ways; the agent core,
   logger and SDK surface found only already-tracked items (see Carried). The
   model handler surfaced three *new* candidates this pass (see Candidates).
   One run-history-writer invariant intact (loop-scoped through `RunCell`;
   lifecycle/terminal/cross-run rows written elsewhere by design, when no live
   loop owns the run — a clean ownership split, not a competing writer).

3. **Plan API-surface simplification.** It is happening — the P4–P8 program
   above is the plan, landing by review. The one owner-level item the surface
   audit still asks for is the Tier-1 manifest ratification (Carried.3).

4. **Design subagent boundaries.** First-class and unchanged: (a) native
   subagents via `executeAgent`/`resumeTurn` with an owned `RunId`
   (`runtime/nativeSubagentStrategy.ts`); (b) the workflow-script run plus its
   `agent()` grandchildren (`runtime/scriptRun.ts`); (c) the agent-CLI children
   `claude_code`/`codex`, each loading its own provider SDK, entering through
   `ChildRuns.launchProcess`. Non-candidates (`compileCheck`, `LatexDiffManager`)
   still have no independent run or model lifecycle. No boundary change warranted.

## Candidates surfaced this pass (owner-level, NOT for autonomous action)

New since 2026-10-12, all in the model path, each a judgment call the standing
verdict reserves for human review — recorded, not acted on. None matches an
entry in `config/ratchets/refuted-candidates.json`.

1. **`ModelInvoker.call` / `CallResult` — single-caller
   (`ModelInvoker.ts:778`, only caller `run/compaction.ts:192`; verified by
   grep).** A candidate to inline: compaction could call `callModel` with run
   context directly, dropping a second method off a service whose purpose is to
   run turns. **But** the method is not a pure pass-through — it assembles the
   run's binding/rebind/attribution/`record` row-callbacks/gate/usageLog — and
   the two sub-audits disagreed on whether it is collapsible indirection or a
   legitimate second method. That disagreement is exactly why this stays an
   owner call, not a routine edit.
2. **`BoundModel` re-fields the llm `Binding` pass-through members**
   (`ModelAccess.ts:57` vs `binding.ts:244`): `serviceTier`/`forcedToolChoice`/
   `persistentConnection`/`background` spread straight through; only
   `config`/`routes`/`delivery`/`textOnly`/`automaticRetries` are harness-added.
   Candidate to embed the `Binding` rather than re-field its pass-through subset.
3. **`helperCall` builds its own `modelAccessLayer` inline** (`helperModel.ts:58`)
   instead of taking `ModelAccess` from context as the run path does — two wiring
   paths for one service.
4. **`AgentConfig.ts:4` — stale alias comment (the one outright nit).**
   `AgentConfigSchema = AgentConfigFieldsSchema` is a pure alias whose comment
   ("… with output file count validation") describes the *source* schema; the
   `superRefine` actually lives in `@shared/schemas/agentConfig.ts`. Keep the
   name (it owns the public contract name, re-exported via `schemas.ts`); trim
   the comment.
5. **Two knip test-only dead exports**, outside the audited scopes but safe to
   drop: `prepareToolEditApprovalPrompt`
   (`tools/approval/toolEditApproval.ts`) and `countPinnedMemories`
   (`tools/memory/memoryFileSystem.ts`), each consumed only by tests.

## Carried (needs an owner, not a routine)

1. **Logger sink→Layer still unlanded.** The mutable module global persists
   (`logger/logSink.ts:147` `let sink`, `:148` `let sinkTrusted`, `:155`
   `setLogSink`) — the one non-Effect-native piece, so an embedder of
   `@texra-ai/harness` cannot inject its own sink through the public boundary and
   two embedders in one process share one global. P5e privatized the *writers*
   around it but did not convert the global to a Layer. A costed proposal already
   exists (`2026-09-21-effect-design-synchronous-facades.md` §5, step 6); it is
   proposed, not refused, and remains the owner's expensive step.
2. **The two `packages/llm` ambient-header reads are refusal guards, effectively
   closed** (`openaiResponsesRequest.ts` and `anthropicMessages.ts` both throw a
   `ModelError` when a `*_CUSTOM_HEADERS` env var is set). Low priority; file
   into `2026-09-20-llm-package-hardening.md` only if the host-boundary
   relocation of the `process.env` *check* is ever wanted.
3. **Ratify the Tier-1 manifest — still owner-gated.** The manifest
   (`2026-09-10-agent-sdk-tier-1-manifest.md`) carries its 2026-10-12 rework
   (re-scoped to `@texra-ai/harness`, enumeration delegated to
   `config/api-reports/`); its §5 ratification (keep/seal/shed) is still "open,
   awaiting an owner." Progress since 2026-10-12: **`MapToolRegistry` /
   `IToolRegistry` are gone from the public harness API report** (one named shed
   candidate, closed). Still open: `SettingHost` (`index.ts:164`) reaches the
   public surface on more than one path — `ITool.unavailableHosts`,
   `WorkspaceRoots.host`, `SettingsStores.host` (all in `harness.api.md`) — so a
   seal/remove decision must cover the composition contract, not only the tool
   contract.
4. **Durable-harness Q5 largely reconciled.** The manifest rework now records
   Q5 (package names) as **accepted** against the landed
   `@texra-ai/texra`/`@texra-ai/harness`; the lone remaining doc-only item is
   closing the stale "Proposed names, still open" section inside
   `2026-10-02-durable-harness.md` itself.

## Meta: the duplicate-routine problem persists (this is the actionable item)

The 2026-10-12 pass flagged that **two parallel scheduled sessions run this one
charter** and should be consolidated to one. This pass is the fourth
superseding re-verification in under two weeks (10-04 → 10-10 → 10-12 → 10-17),
each concluding "well-aligned, no refactor." The audit is genuinely a standing
program against an actively-improving codebase, so the diminishing return is
structural, not a one-off. Recommended owner actions, in priority order:
consolidate to a single scheduled charter and lower its cadence; let the
durable-harness/P-series program carry the surface simplification (it is, by
review); and clear the doc-only items above (Tier-1 ratification §Carried.3,
the Q5 section §Carried.4). Re-running this audit as a routine will keep adding
no refactor signal until the harness program moves further.

## Recommendation

No refactor to land autonomously from this charter. The owner-level actions are
the three doc/surface items in Carried (logger sink→Layer rides the synchronous-
facades note; Tier-1 ratification; Q5 section close) and, above all, the
routine-consolidation in Meta. The five candidates above are recorded for an
owner's judgment, not for autonomous edits — candidate 1 in particular because
two sub-audits of the same code disagreed on it.
