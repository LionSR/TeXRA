# Agent SDK readiness re-verify: the 2026-09-29 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding, and it
supersedes the [2026-09-26 pass](../../archived/architecture/2026-09-26-agent-sdk-readiness-reverify.md),
which is now archived.

Pin: verified against branch `claude/eager-noether-3bd4b2` at `b26a925`. The
2026-09-26 pass pinned `f0811a0` on a branch not reachable from this one, so the
deterministic anchor here is the commit that landed that note into this tree,
`491490e` (#13443), an ancestor of `b26a925`. In `491490e..b26a925`, **29
commits touch the audited areas** (`src/agent`, `src/model`, `src/logger`,
`packages/llm/src`, `packages/agent/src`). Every one is a human-owned,
PR-numbered commit continuing the same program the standing note named — among
them #13494 (the agent catalog is a process service; the second loader goes),
#13491 (the SDK composes no setup platform), #13488 (core decides the policy for
every request kind), #13487/#13407 (every model call goes through the invoker;
bindings own their scope; classify a failed call from `ModelError` first),
#13454/#13455/#13457 (the run vocabulary replaces the flow-engine names;
`run.position` is the one loop coordinate), #13481 (Claude Code hooks run out of
process, typed and recorded). Alignment has **improved**, entirely through
review, not this routine — the exact pattern the last three passes recorded.

## Verdict (unchanged)

The codebase is still well-aligned, and this audit remains a standing program,
not a gap. No autonomous refactor is warranted from this charter: every safe
candidate in these areas is already filed, already landed, or already recorded
as refused with a ruling (`config/ratchets/refuted-candidates.json`). The four
read-only audits (agent core, model handler, logger, SDK public surface) that
the 2026-09-26 pass performed hold at this pin: no wrapper layer that only
forwards, no second ledger writer, no services-bag, no re-export shim; the large
files are large because of irreducible durability/resume/stop invariants. The
open work is ratification and manifest-writing, which needs an owner, not a
routine.

What this pass adds over 2026-09-26 is one data point, not a new finding: the
standing verdict **survives a 29-commit human-owned delta** in the audited
areas, and 3 days on the single named open deliverable — the Tier-1 manifest —
**still has not moved**. The 2026-09-26 pass set the bar ("re-running adds no
signal until the manifest is re-enumerated and moves"); this pass confirms that
prediction held. See [Recommendation](#recommendation) on the routine itself.

## The four asks, re-mapped to the current pin

The 2026-09-26 map is re-confirmed verbatim; only the deltas are restated here.

1. **Identify the areas.** Unchanged. Agent core `src/agent/core/` +
   `@agent/runtime/loop/{toolUse,reflection}.ts` over the run ledger, model call
   at `@agent/runtime/ModelInvoker.ts`; model handler reached through the
   `packages/llm` `Model` bound by `runtime/run/modelBinding.ts`; logger
   `src/logger/`; SDK surface `packages/agent`. The run-vocabulary rename
   (#13454) touched names, not boundaries — the loop is still one Effect program
   over the ledger, and #13407/#13487 tightened, not widened, the single model
   route (every call through the invoker; bindings own their scope).

2. **Audit for unnecessary abstraction.** Re-confirmed. Spot-checks at this pin
   found no new indirection: `modelBinding.ts` still collapses its switches into
   the one `PROTOCOL_DESCRIPTORS` table; the loop programs still share
   `loop/runProgram.ts`; `SessionHandle` still re-exposes owners as fields
   rather than forwarding. The marginal cleanups the 2026-09-26 pass filed are
   below the worthwhile-change bar and are not this routine's to land.

3. **Plan API-surface simplification.** Unchanged: the plan is the Tier-1 public
   manifest (`2026-09-10-agent-sdk-tier-1-manifest.md`, still `proposed`) plus
   the frozen-list shrink AGENTS.md names. The SDK already speaks pure Effect
   end-to-end.

4. **Design subagent boundaries.** Unchanged and re-confirmed: (a) native
   subagents via `executeAgent` with an owned `RunId`; (b) the workflow-script
   run plus its `agent()` grandchildren; (c) the agent-CLI children
   (`claude_code`, `codex`) through `startDetachedChildRunLoop`. #13481 moved
   Claude Code hooks out of process but did not add a new run-owning boundary. No
   boundary change is warranted.

## The three open items persist unchanged

Each was named by the 2026-09-26 pass; each was re-checked at `b26a925` and
still holds, with fresh line numbers. None moved in the 29-commit delta.

1. **The Tier-1 manifest is still un-re-enumerated (drift stands).**
   `2026-09-10-agent-sdk-tier-1-manifest.md:157` still lists `ToolHost` as a
   root export and its §3.1 header (`:128`) still reads "34 (10 values, 24
   types)"; the live `packages/agent/src/index.ts` exports `ITool`,
   `IToolRegistry`, `ToolGuard` (`:70-71`), `SettingHost` (`:73`), and
   `MapToolRegistry` (`:74`), and no longer exports `ToolHost`. The manifest was
   touched twice in the delta (#13454, #13471) but only by the mechanical
   run-vocabulary rename, not a re-enumeration. `effect/errors.ts:2` still says
   "Four" while the declared set is six tagged errors. The re-enumeration remains
   a prerequisite for ratification, not a substitute; the shed questions the
   2026-09-26 pass framed (`MapToolRegistry`/`IToolRegistry`; the `SettingHost`
   host-enum leak) are unchanged.

2. **The logger sink→Layer step (step 6) is still unlanded.**
   `src/logger/logSink.ts:165` still holds the mutable module global
   (`let sink = consoleLogSink`), with `setLogSink` (`:173`) and `writeLogEntry`
   (`:183`) set by host callers. #13447 touched this file ("the platform log
   sink is always silent") but did not convert the sink to a Layer, so the
   cross-embedder sharing hazard the 2026-09-26 pass named remains: an embedder
   of `@texra-ai/agent` gets whatever process-global sink is set and cannot
   inject its own through `Sessions.layer`. Owned by
   `2026-09-21-effect-design-synchronous-facades.md` §5 / step 6 (the expensive
   kernel-seam step); exposing embedder injection through the public
   `AgentPlatform` is a further, not-yet-designed step on top of it.

3. **The `packages/llm` ambient-read item still needs filing.** The
   `process.env.*_CUSTOM_HEADERS` reads inside otherwise-pure codec factories
   remain — `openaiResponsesRequest.ts:359` and `anthropicMessages.ts:464`
   (the latter now rejects the variable rather than honoring it, per #13460, but
   is still an ambient read in a pure codec). These fall in
   `2026-09-20-llm-package-hardening.md`'s territory but are not recorded there
   (that note's §0 is closed), so they still need filing before they have an
   owner. This is a relocation-not-deletion item and must preserve the guard for
   direct factory callers (`packages/llm/test-live/`).

## Genuinely open (carried, still human-owned)

- **Re-enumerate the Tier-1 manifest against `index.ts`, then ratify it.** Gated
  on the re-enumeration (§ open item 1). Unchanged owner.
- **Shrink the `host-agent-import` frozen list** as the manifest ratifies each
  edge; never widen.
- **Owner ruling on the two agent-creation systems** (`texra.createAgentWithAI`
  wizard vs. the `creator` tool-use agent), per `2026-09-23-ssot-ownership-survey.md`
  §2 — reverses two rulings and changes user-visible behaviour, so not a
  routine's call.

## Recommendation

No refactor to land autonomously from this charter. The single concrete action
for an owner is still to **re-enumerate the Tier-1 manifest against `index.ts`
before ratifying it** (§ open item 1); the logger sink→Layer step and the
`packages/llm` ambient-read item ride their named notes.

On the routine itself: this is now the case the 2026-09-26 pass predicted. Over
the last several passes the verdict has been stable ("well-aligned; the one open
deliverable is human-owned and has not moved"), and this pass adds only that the
verdict survives a large human-owned delta. Until the manifest is re-enumerated
and moves, further routine runs will keep confirming the same state — so the
higher-value action is to **assign the manifest re-enumeration to an owner** (or
to lower this routine's cadence), rather than to keep re-verifying a settled
standing state.
