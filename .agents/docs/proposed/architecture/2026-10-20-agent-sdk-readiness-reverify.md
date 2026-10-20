# Agent SDK readiness re-verify: the 2026-10-20 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding. It supersedes
the 2026-10-12 pass (`2026-10-12-agent-sdk-readiness-reverify.md`, pin
`d8d4a6b`), which is now deleted; version control keeps it, per
`.agents/docs/README.md`.

## Pin

Verified against `claude/eager-noether-kpnwwo` at `6990c80`. The prior pass
landed on `main` with `bf20287` (#14092); **49 commits** separate that landing
from this pin (`git rev-list --count bf20287..6990c80`). The authoritative,
non-drifting reference for the public export surface is `config/api-reports/`,
not the coordinates pinned here.

## Why a fresh pass is warranted now (unlike a bump-only delta)

The prior pass closed with: "Re-running this audit as a routine will again add
no refactor signal **until the harness program moves further**." It has moved
further. The 49-commit delta is not dependency noise — it carries a sustained
public-surface wave, the **API P4–P8a** series, which is precisely the Tier-1
manifest / deep-import-shrink program the charter's §"plan API-surface
simplification" asks for, every move landed through human review and none by
this routine:

- **P4** (#14119): browser-safe `./transcript` entry, readonly views in
  `./schemas`, failures re-exported at the root.
- **P5a** (#14108): one public `Settings` service replaces the settings free
  functions. **P5b** (#14104): one public `readModelOptions` replaces the four
  picker reads. **P5c** (#14118): `AgentCatalog` public. **P5d** (#14117,
  #14126, #14129, #14131, #14132, #14117): `Skills`/`InstalledPlugins`, the
  user's MCP config, the run-files listing, the tool catalog (narrow view) and
  one memory store, each made a public fact of the storage layout. **P5e**
  (#14112): hosts and the app log through Effect and stop deep-importing
  `@logger/*`; the log writers stay private (see Carried.1 — this is import
  hygiene, not the Layer step).
- **P6** (#14120): `./node` runs programs; harness-owned service keys.
- **P7-A** (#14127): `GlobalValues`, `StateStores` and storage maintenance at
  the root. **P7-B1** (#14130): the door's presentation names go to the root.
- **P8a** (#14124): hosts stop deep-importing the harness's core helpers.

`packages/harness/src/index.ts` at this pin already reflects the whole wave —
`Settings`, `readModelOptions`, `AgentCatalog`, `Skills`, `InstalledPlugins`,
`GlobalValues`/`StateStores` and the root-level failures are all exported there
now. This is the surface narrowing from deep-import to named public service
that the program exists to do.

## Verdict (unchanged)

The codebase is still well-aligned, and this audit remains a standing program,
not a gap. **No autonomous refactor is warranted from this charter.** The four
structural invariants the prior passes pinned all still hold at `6990c80`:

- **Agent core.** `AgentEngine`/`runAgent` remain absent from
  `packages/harness/src` (grep empty); the run program is still one Effect over
  the run history, decomposed under the 400-line core rule, not an added
  indirection tier.
- **Model handler.** `agent/runtime/modelAccess/` is the same five-file set
  (`ModelAccess.ts`, `binding.ts`, `credentials.ts`, `failureInfo.ts`,
  `routeDecision.ts`) — one binding service over the `@texra-ai/llm` `Model`,
  no per-provider handler class. The P5b picker consolidation touched
  `@model/computeModelOptions`'s public read, not this binding path.
- **Logger.** Same five files (`effectLog.ts`, `logSink.ts`,
  `effectDiagnostics.ts`, `formatLogData.ts`, `redaction.ts`).
- **SDK surface.** The P4–P8a wave narrowed the surface; the center stays pure
  Effect with no stray `Effect.run*`.

No wrapper layer that only forwards, no second writer of the loop's run
history, no services-bag, and no re-export shim was introduced by the wave.

## Subagent boundaries (unchanged)

First-class and unchanged at this pin: (a) native in-process subagents via
`executeAgent`/`resumeTurn` with an owned `RunId`, dispatched through the shared
`runtime/nativeSubagentStrategy.ts` that `subagentRun`/`scriptRun`/`resumeRun`
reuse; (b) the workflow-script run plus its `agent()` grandchildren
(`runtime/scriptRun.ts`); (c) the agent-CLI children `claude_code`
(`packages/texra/src/tools/claudeAgent.ts`) and `codex`
(`packages/texra/src/tools/codex.ts`), each loading its own provider SDK and
entering through `ChildRuns.launchProcess`. The non-candidates (`compileCheck`,
`LatexDiffManager`) still have no independent run or model lifecycle. No
boundary change is warranted.

## Carried (needs an owner, not a routine)

1. **Logger sink→Layer: P5e advanced the import hygiene; the Layer step is
   still unlanded.** #14112 (P5e) is a real stride — hosts now reach the sink
   through the root port (`setLogSink`, `entryChannel`, `entryMessage`,
   `LogEntry`, `LogSink` from `@texra-ai/harness`) instead of deep-importing
   `@logger/logSink`/`@logger/redaction`/`@logger/formatLogData`, and no writer
   is published. **But the injection mechanism is still a mutable module
   global**: `logSink.ts:147` (`let sink = consoleLogSink`), `:148`
   (`let sinkTrusted = false`), `setLogSink` at `:155`, `writeLogEntry` at
   `:165`. An embedder of `@texra-ai/harness` still cannot inject its own sink
   through `Sessions.layer`/`AgentPlatform`, and two embedders in one process
   still share one global. This is the one real SDK-relevant host leak; it rides
   step 6 of `2026-09-21-effect-design-synchronous-facades.md` §5. It is the
   expensive step (it rewrites the kernel log-capture seam) and, on its own,
   still does not deliver embedder injection through the public boundary — a
   further, not-yet-designed public-API step.

2. **The two `packages/llm` ambient-header reads remain refusal guards,
   effectively closed.** `openaiResponsesRequest.ts:254` and
   `anthropicMessages.ts:715` still throw a `ModelError` when
   `OPENAI_CUSTOM_HEADERS` / `ANTHROPIC_CUSTOM_HEADERS` is set, making the
   selected binding the sole source of request headers — intentional
   guardrails, not value-honoring reads. Relocating the `process.env` check to
   the host boundary stays a low-value relocation. File into
   `2026-09-20-llm-package-hardening.md` only if ever wanted.

3. **Ratify the re-scoped Tier-1 manifest.** The P4–P8a wave is the surface
   rework the manifest (`2026-09-10-agent-sdk-tier-1-manifest.md`, status still
   `proposed`) describes; its 2026-10-12 rework already delegated the
   authoritative enumeration to `config/api-reports/`. What stays **open** is
   the manifest's own §ratification (what Tier-1 keeps, seals, or sheds) —
   owner-level, awaiting the durable-harness program. The surviving shed/leak
   questions are unchanged: `SettingHost` reaching the public surface on more
   than one path (`ITool.unavailableHosts` and `WorkspaceRoots.host` via
   `AgentPlatform.roots`/`Session.roots`), and the `MapToolRegistry`/
   `IToolRegistry` plumbing an embedder on the documented
   `StartInput.tools`/`defineTool` path never constructs.

4. **Reconcile the stale Q5 package-name section in
   `2026-10-02-durable-harness.md`.** It still records "the package names (Q5)
   stay open" (line 15) and proposes `packages/theorist` / `@texra-ai/theorist`
   (lines 353, 358, 451), but the tree resolved this: the app shipped as
   `packages/texra` / `@texra-ai/texra` and the SDK as `packages/harness` /
   `@texra-ai/harness`. Doc-only reconciliation, owner-level.

## Observations (not defects, recorded so the next pass need not re-derive)

- **The error-vocabulary headline count moved as the surface grew and is now
  pinned by the api-report, not by prose.** #3260f66 (#14101) scoped the
  `errors.ts`/README "… in all" wording to the lifecycle+store family — the
  cheap owner-level clarification the prior pass flagged in its Observations has
  **landed**. The authoritative, non-drifting enumeration remains
  `config/api-reports/`.
- **The published-TSDoc leak scrubs continued** (#14125, #14121, #14140), a
  routine hygiene of the growing public surface, not a structural change.

## Recommendation

No refactor to land autonomously from this charter. The owner-level actions that
remain are doc-only: **ratify the already-re-scoped Tier-1 manifest**
(Carried.3) and **reconcile the durable-harness Q5 section** (Carried.4). The
logger sink→Layer step (Carried.1) rides
`2026-09-21-effect-design-synchronous-facades.md` and is the one substantive
SDK-relevant item still open; it is owner/program work, not a routine refactor.

**Standing process note, repeated because it still holds.** The prior two passes
recorded that more than one scheduled session was racing this single charter and
producing near-duplicate notes, and asked the owner to consolidate to one
routine. This pass found a single living note (one living note is the intended
state) and superseded it cleanly, but the underlying recommendation stands:
**one scheduled charter, not several, should own this standing audit**, and the
routine should re-run on a cadence matched to when the harness program actually
moves (as it did in this delta) rather than on a short fixed interval that
re-pins an unchanged verdict.
