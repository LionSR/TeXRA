# Agent SDK readiness re-verify: the 2026-10-02 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding, and it
supersedes the 2026-09-26 pass
(`2026-09-26-agent-sdk-readiness-reverify.md`), whose §New.1/§New.3 evidence
has since drifted.

Pin: verified against branch `claude/eager-noether-i1f5ke` at `f78a550`
(`feat(approvals): a pending approval survives a restart (#13604)`). The
2026-09-26 pass pinned `f0811a0` on a different branch line (`q6bj0r`), which is
not an ancestor reachable from this clone, so this pass re-checks every open
claim directly against the current tree rather than against a commit range.

## Verdict (unchanged)

The codebase remains well-aligned, and this audit remains a standing program,
not a gap. **No autonomous refactor is warranted from this charter.** A fresh
read-only pass over the four areas — agent core, model handler, logger, SDK
public surface — again found **no forward-only wrapper, no second ledger
writer, no services-bag, no re-export shim**. Every safe candidate is already
filed, already landed, or already recorded as refused with a ruling in
`config/ratchets/refuted-candidates.json`. The open work is still ratification
and manifest-writing, which needs an owner, not a routine.

What this pass adds over "re-running adds no signal": two of the prior pass's
concrete file:line anchors have gone stale against the tree, and one open item
has sharpened into a now-false claim in the published SDK README (§Moved.1).
Stale evidence is precisely what the manifest and refuted-candidate gates exist
to catch, so refreshing it is the signal, even though the verdict does not move.

## The four asks, re-confirmed at this pin

1. **Identify the areas.** Unchanged from the 2026-09-26 map, with one
   structural note under §Moved.2 (the model handler's chat-codec files were
   reorganized). Areas:
   - Agent core: `src/agent/core/`; run programs `@agent/runtime/loop/` over the
     run ledger; the run-loop model call is `@agent/runtime/ModelInvoker.ts`
     (with `helperModel.ts` and `run/compaction.ts` the deliberate direct-bind
     exceptions, not a second handler).
   - Model handler: provider calls reached only through the `packages/llm`
     (`@texra-ai/llm`) `Model` bound by `runtime/run/modelBinding.ts`. The
     deliberate out-of-route exceptions remain (`src/tools/media/audio.ts`,
     `src/tools/claudeAgent.ts`, the Codex tool, and the settings-view consent
     probe).
   - Logger: `src/logger/`.
   - SDK surface: `packages/agent` (`@texra-ai/agent`).

2. **Audit for unnecessary abstraction.** Done, four ways. Agent core stays
   defensively written against the exact anti-patterns the charter names; the
   model handler is one chat codec over the OpenAI-compatible protocols plus a
   shared-codec Responses split (not duplication); the logger is a single-owner
   render→redact→truncate pipeline behind a host-agnostic producer port; the SDK
   center (Sessions/Session/Run + tagged errors + `defineTool`, pure Effect, no
   in-package `runPromise`) is minimal. The only residue is at the edges, below.

3. **Plan API-surface simplification.** Still the Tier-1 public manifest
   (`2026-09-10-agent-sdk-tier-1-manifest.md`, still `proposed`) plus the
   frozen-list shrink. Re-enumeration is still a prerequisite to ratifying it
   (§Open.1).

4. **Design subagent boundaries.** Already first-class, re-confirmed unchanged:
   (a) native subagents via `executeAgent` with an owned `RunId`; (b) the
   workflow-script run plus its `agent()` grandchildren; (c) the agent-CLI
   children (`claude_code`, `codex`) through `startDetachedChildRunLoop`. The
   usual charter-named candidates (reflection output extraction, `compileCheck`,
   `LatexDiffManager`, `runAgentCreator`) remain effectful sub-run stages with no
   independent run/model lifecycle, so an agent boundary still buys nothing. No
   boundary change warranted.

## Open items, re-confirmed present at this pin (human-owned)

1. **Tier-1 manifest still drifted and unratified.**
   `2026-09-10-agent-sdk-tier-1-manifest.md` §3.1 still carries the header count
   "34 (10 values, 24 types)" and still lists `ToolHost` as a root export
   (`:128`, `:157`). The live `packages/agent/src/index.ts:68-74` exports `ITool`,
   `IToolRegistry`, `ToolGuard`, `SettingHost`, and `MapToolRegistry`, and does
   **not** export `ToolHost`. The manifest must be re-enumerated against
   `index.ts` before it can be ratified; this remains the single concrete,
   owner-gated action the charter produces.

2. **Logger sink→Layer conversion (step 6) has not landed.**
   `src/logger/logSink.ts:165-186` still holds the mutable module global
   (`let sink = consoleLogSink`, `setLogSink`, `writeLogEntry`). This is still
   the one real SDK-relevant host leak: an embedder of `@texra-ai/agent` gets
   whatever process-global sink is set and cannot inject its own through the
   public boundary; two embedders in one process share one global. Owned by
   `2026-09-21-effect-design-synchronous-facades.md` §5/step 6; unchanged since
   the 2026-09-26 pass.

## Moved since the 2026-09-26 pass (evidence corrected)

1. **The error-count mismatch has sharpened into a now-false README claim.**
   `packages/agent/src/effect/errors.ts` defines **four** tagged errors
   (`PlatformConflict`, `AgentNotFound`, `ToolsRefused`, `RunFailure`), and its
   header still says "tagged errors, no more" (`:3`). But `index.ts:46-49` also
   re-exports `DatabaseOpenFailed` and `DatabaseReadFailed` (values) from
   `@shared/session/database`, so the **public tagged-error surface is six**.
   `README.md:206` now lists only the four from `errors.ts` and adds the
   affirmative line "Nothing else is exported: no store, no fold internals, no
   host widgets" — which the two `Database*` value exports in `index.ts`
   directly contradict. The 2026-09-26 pass flagged this as a count to
   reconcile; it is now a published statement that is false as written.
   Reconcile README/`errors.ts` with the six-error reality (or re-home the two
   `Database*` errors), and fix the "no more" comment.

2. **The `packages/llm` ambient-read count dropped from three to two.** The
   2026-09-26 pass named three sites reading
   `process.env.{OPENAI,ANTHROPIC}_CUSTOM_HEADERS` inside otherwise-pure codec
   factories (`openaiChat.ts`, `anthropicMessages.ts`,
   `openaiResponsesRequest.ts`). `openaiChat.ts` no longer exists — the chat
   codec family was reorganized (`chatStream.ts`, `openrouterChat.ts`, …) and
   that ambient read went with it. Two remain:
   `packages/llm/src/anthropicMessages.ts:460` and
   `packages/llm/src/openaiResponsesRequest.ts:254`. The framing is unchanged
   (intentional guardrails; a pure `Model` boundary would relocate, not delete,
   the check, passing it explicitly into each factory so the `test-live` direct
   callers keep it). Still unfiled against the closed
   `2026-09-20-llm-package-hardening.md`; needs a fresh tech-debt entry to have
   an owner.

3. **One marginal cleanup can no longer be confirmed at its cited line.** The
   2026-09-26 pass flagged an unreachable re-guard at `modelBinding.ts:1027-1037`
   (its `vscode-lm`/`validation` disjuncts dead because both branches had already
   returned). `modelBinding.ts` is now 996 lines, so that second guard is no
   longer at :1027; the live bind-time route guard at `:874-883`
   (`protocol === 'vscode-lm' || route.kind === 'copilot' || route.kind ===
   'validation'`) remains and is reachable. Treat the earlier marginal item as
   resolved-or-moved; nothing actionable here.

## Recommendation

No refactor to land autonomously from this charter — the verdict is unchanged
and every prior pass agrees. The concrete, owner-gated actions, in priority
order:

1. **Fix the now-false README claim (§Moved.1)** — lowest-effort, highest value:
   the published `@texra-ai/agent` README asserts "Nothing else is exported"
   while `index.ts` exports two `Database*` tagged errors. This is a
   documentation correctness defect in the SDK surface, not merely a count to
   tidy.
2. **Re-enumerate the Tier-1 manifest against `index.ts` (§Open.1)** before
   ratifying it — still the single open deliverable the charter produces.
3. **File the two `packages/llm` ambient reads (§Moved.2)** as a tech-debt entry
   so they have an owner; the hardening note that would house them is closed.

The logger sink→Layer step (§Open.2) rides its existing owner. Re-running this
audit as a routine will again add no new signal until these move; its only
recurring value is catching exactly the evidence drift this pass found.
