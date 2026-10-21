# Agent SDK readiness re-verify: the 2026-10-21 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding, and it
supersedes the 2026-10-12 pass (`2026-10-12-agent-sdk-readiness-reverify.md`),
which is now deleted; version control keeps it, per `.agents/docs/README.md`.
(The 2026-10-12 pass itself folded forward 2026-10-10 and 2026-10-04.)

This pass does **not** re-derive the full four-way audit — the 2026-10-12 note
(in git history) carries the reasoning, the module map, and the carried items.
This note reads the delta since that note landed and re-confirms the whole.

## Pin

Verified against `main` at `4b1dbfb` ("run banners and script-call status are
keys; the words move to @ui", #14176). The prior pass's note was committed at
`87f18b9` (#14132); this pass reads the **49-commit delta** since
(`git rev-list --count 87f18b9..4b1dbfb`). The authoritative, non-drifting
reference for the public export surface is `config/api-reports/`, not a path or
count pinned here.

## What moved in the 49-commit delta (abstractions removed / surface shrunk, by review)

Every commit in the delta is in the direction this charter asks for, and every
one landed through human review, not this routine. The load-bearing ones:

- **The host-facing door shrank to one typed handle.** Hosts now hold the public
  `LocalSession`; the `@agent/runtime` door is gone (#14137, API P7-B2) and the
  session-view source moved into the harness (#14173, API §3.8). `forgotten
  exports 277 → 0` (#14178) drove the forgotten-export ratchet to zero.
- **App and storage concerns kept leaving the harness.** The TeXRA storage
  layout and config stores moved to `texra` (#14133, #14117, #14131, API P5d);
  hosts take the harness's text helpers and process-environment reads from its
  entries rather than deep imports (#14128, #14123, API P8b / P6).
- **New surface entries are browser-safe and manifest-shaped.** `./transcript`
  (browser-safe entry), readonly views in `./schemas`, and failures at the root
  landed (#14119, API P4) — hence `packages/harness/src/transcriptEntry.ts`
  alongside the four `index/node/plugins/schemas` entries. Published TSDoc was
  scrubbed of LaTeX/VS Code/internal references (#14125, #14140, #14162,
  #14174) — domain-free SDK docs, the manifest direction.
- **Model and llm work was fixes and a pricing window, not new structure**:
  per-model ChatGPT-subscription window + llm-zoo 3.1.0 (#14143), stateless
  Google responses without IDs (#14145), ChatGPT backend `response.metadata` as
  a notice (#14141). No new provider handler class; `modelAccess/` is the same
  five files.

## Verdict (unchanged)

The codebase is still well-aligned, and this audit remains a standing program,
not a gap. **No autonomous refactor is warranted from this charter.** Spot-checks
at this pin re-confirm the invariants the four audits turn on:

- **Agent core / run loop.** `AgentEngine`/`runAgent` grep over
  `packages/harness/src` is still empty; `Runs` is the one run surface and the
  loop is still the one writer of its own run history through its cell.
- **Model handler.** `agent/runtime/modelAccess/` is the same five files
  (`ModelAccess`, `binding`, `credentials`, `failureInfo`, `routeDecision`); one
  binding service over the `@texra-ai/llm` `Model`, no per-provider handler
  class.
- **Logger.** Same five files (`effectLog`, `logSink`, `effectDiagnostics`,
  `formatLogData`, `redaction`); the render→redact→truncate single-owner write
  path is unchanged. The lone logging commit in the delta was a payload-marker
  consistency fix (#14154), not a structural change.
- **SDK surface.** The center stays pure Effect; the delta only shrank it (door
  removal, forgotten-exports to zero) and added browser-safe entries.

No wrapper layer that only forwards, no second writer of the loop's history, no
services-bag, no re-export shim was introduced by the delta.

## The four asks

1. **Identify the areas.** Re-confirmed, same coordinates as the 2026-10-12 note
   (agent core `agent/core/` + run program `@agent/runtime/loop/toolUse.ts`;
   model handler `agent/runtime/modelAccess/`; logger `logger/`; SDK surface
   `packages/harness`, now five entry files with `./transcript`).
2. **Audit for unnecessary abstraction.** Done, four ways; see verdict above and
   the 2026-10-12 note for the per-area reasoning, which still holds.
3. **Plan API-surface simplification.** The durable-harness program's door-shrink
   and manifest work advanced materially this delta (P4/P5d/P6/P7/P8). The one
   owner-level surface item still open is §Carried.3.
4. **Design subagent boundaries.** First-class and unchanged: native subagents
   via `executeAgent`/`resumeTurn`; the workflow-script run and its `agent()`
   grandchildren; the agent-CLI children (`claude_code`, `codex`) through
   `ChildRuns.launchProcess`. No boundary change is warranted.

## Carried (needs an owner, not a routine)

Unchanged from 2026-10-12; none is a routine action. In priority order:

1. **Ratify the re-scoped Tier-1 manifest** (`2026-09-10-agent-sdk-tier-1-manifest.md`).
   The re-scope (rename to `@texra-ai/harness`, enumeration delegated to
   `config/api-reports/`) has landed; only the §ratification — what Tier-1 keeps,
   seals, or sheds — is open. The shed/leak questions that survive: `SettingHost`
   reaching the public surface via `ITool.unavailableHosts` and
   `WorkspaceRoots.host` (through `AgentPlatform.roots`/`Session.roots`), and the
   `MapToolRegistry`/`IToolRegistry` plumbing an embedder on the documented
   `StartInput.tools`/`defineTool` path never constructs.
2. **The logger sink→Layer step** rides step 6 of
   `2026-09-21-effect-design-synchronous-facades.md` §5: `logSink.ts` still holds
   a mutable module global (`let sink`, `setLogSink`), so an embedder of
   `@texra-ai/harness` cannot inject its own sink through `Sessions.layer` and two
   embedders in one process share one global. The one real SDK-relevant host
   leak; expensive (rewrites the kernel log-capture seam) and not, by itself, the
   public-API injection step.
3. **Reconcile the stale Q5 package-name section** in
   `2026-10-02-durable-harness.md` against the landed
   `@texra-ai/texra`/`@texra-ai/harness` names (doc-only).
4. **One-line `errors.ts`/README scope clarification**: the "… in all" headline
   count is scoped to the lifecycle+store error family and does not count the
   re-exported `RequestError` family or the platform-port write-failure classes;
   the api-report is authoritative for totals.

## Observations (not defects, recorded so the next pass need not re-derive)

- The two `packages/llm` ambient-header reads
  (`openaiResponsesRequest.ts`, `anthropicMessages.ts`) remain **refusal
  guards** that throw a `ModelError` rather than honoring an ambient value — not
  value-honoring reads; relocating the `process.env` check stays low-value. File
  into `2026-09-20-llm-package-hardening.md` only if ever wanted.
- One direct `bound.model.uploadFile` call in `loop/toolUseDispatch.ts` (tool-
  result delivery) is a file-upload-cache primitive, not a turn/generation call —
  not a second model handler.

## Recommendation

No refactor to land autonomously from this charter. "Agent SDK readiness" tracks
the durable-harness program (`2026-10-02-durable-harness.md` H1–H6), which
advanced through its P4–P8 / P5d surface lanes this delta, all human-reviewed.
The open actions are owner-level and doc-only (the four Carried items).

**Routine hygiene, re-raised from 2026-10-12 and still unactioned:** this charter
runs from more than one scheduled trigger, and the passes race to re-pin the same
note (2026-10-10 and 2026-10-12 were produced by two parallel sessions two days
apart). This pass fired from routine "Agent SDK readiness refactor"
(`trig_01NbPMHeNfL5DgndqYb1NLTV`). **The duplicate scheduled routines should be
consolidated to one**, or the standing audit retired until the harness program
moves materially — re-running it as a routine will keep adding no refactor signal
and only churns this note.
