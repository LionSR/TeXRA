# Agent SDK readiness re-verify: the 2026-10-06 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding, and it
supersedes the 2026-10-04 pass (`2026-10-04-agent-sdk-readiness-reverify.md`),
which is now deleted; version control keeps it, per `.agents/docs/README.md`.

Pin: verified against branch `claude/eager-noether-ii0b17` at `f3362c1`. The
2026-10-04 pin, `ae953c3`, is **99 commits back**
(`git rev-list --count ae953c3..HEAD`); it only looks unreachable from a
shallow clone, which needs deepening first. This pass re-verifies the current
tree and reads that range for the delta.

## The harness program moved — so this pass adds signal

The 2026-10-04 pass closed with "re-running this audit as a routine will again
add no signal **until the harness program moves**." It has moved, structurally
and by a lot. Over `ae953c3..HEAD` the accepted durable-harness program
(`2026-10-02-durable-harness.md`, status: accepted) and the package split
(`2026-10-02-harness-package-split.md`) landed their core:

1. **The package split (M8).** The SDK package was renamed
   `@texra-ai/agent` → **`@texra-ai/harness`** at **`packages/harness`**
   (#13756, slice 1); the core moved `src/` → **`packages/harness/src/`**
   (#13778, slice 3); the app moved to **`packages/texra`** (#13764, slice 2);
   and the harness now imports nothing from the app — **the seven residents
   went** (#13779), the open "shrink the residents" item the prior pass carried.
2. **The Plugin extend surface — the durable-harness "extend" half — landed.**
   A `Plugin` says what it contributes (#13709); the external inquiry became a
   plugin arm (M6, #13706); **`./plugins` is now a fourth package entry**
   (exports `harnessBuiltins`); and `Plugin`, `Composition`, and a new
   `PluginsRefused` tagged error are root exports.
3. **R1: one document recipe replaced round mode** (#13686). `loop/rounds.ts`
   is gone; the recipe now lives in the **app** at
   `packages/texra/src/agent/output/documentRecipe.ts` (it runs over the
   documents plugin's tools, which are app code) — it left the harness core.
4. **R2: flat persona agent files with an optional `task:` block** (#13678).
5. **The tool contract was reshaped**: a tool reads its call through a 4-field
   `ToolContext` (#13754) — `ToolContext`, `ToolContextShape`, `CallRequests`,
   `ToolEnv` are now on the root entry; **`ToolHost` is gone** (the deletion the
   manifest and two prior passes flagged).
6. **The model handler kept shrinking**: `modelBinding.ts` is **427 lines**,
   down from 966 at the prior pin and 1037 before that — all consolidation.

Everything in the range trends toward *less* structure: "drop dead run-record
methods" (#13769), "drop an always-false finalize field and three redundant
checks" (#13786), "one record per tool call / one scheduler" (#13780), "one
owner for a run's title" (#13805), "one dropdown value reader" (#13800). None
adds an indirection tier.

## Verdict (unchanged, re-audited not inherited)

The codebase is still well-aligned, and this audit remains a standing program,
not a gap. **No autonomous refactor is warranted from this charter.** The
no-unnecessary-abstraction verdict was re-derived at this pin by an adversarial
sweep of the four areas against the five anti-patterns the charter names, not
carried over:

- **No second run-history writer.** The one append path holds: `RunCell.append`
  (`loop/runProgram.ts:97`) → `RunHistory.appendBatch` (`RunHistory.ts:420`) →
  `SessionEvents.publish` (`RunHistory.ts:485`, "the one transaction"). The
  three direct `appendBatch` callers outside a cell (`forkRun.ts:161`,
  `run/compaction.ts:272`, `FollowUps.ts:373`) all go through that same
  function; `loop/rows.ts` builds drafts and writes nothing;
  `SessionHandle.publish/commit/commitRegistration` write a different row
  category through the same graph transaction, not run-history-private rows.
- **No pass-through wrapper.** `ModelInvoker.call` assembles
  binding/rebind/gate/settings/attribution/logger (real composition);
  `bindModel` → `bindWireModel` is wrapped in ~180 lines of route/credential/
  reasoning resolution; `SessionHandle.commit` → `graph.publish` exposes a
  **private** owner field through a named method with 10+ callers (encapsulation,
  not indirection).
- **No re-export shim.** `index.ts` is the one blessed barrel; `schemas.ts`,
  `plugins.ts`, `node.ts` are wired subpath entries in `package.json`, not
  leftovers; the `RunEndResult` duplication is deliberate (sourced from its own
  module to keep a provider-SDK type off the declared surface, per
  `validate-artifacts.mjs`).
- **No services-bag.** `run/AgentRun.ts` holds run-*owned* data provided once at
  the `executeAgent` boundary and read from context — its header states
  "Nothing here is threaded through node fields or a services bag."

The single item a reviewer could legitimately raise is
`createNeutralResponseTextProcessing` (`agent/runtime/responseTextProcessing.ts:23`,
one caller at `SessionHandle.ts:361`), a 3-line neutral-default object. It is a
**justified named default** for the injectable `ResponseTextProcessing` port
(TeXRA hosts inject `@latex/texraResponseTextProcessing`); the name documents the
neutral-default contract. Borderline, not a defect — do not inline.
`config/ratchets/refuted-candidates.json` is unchanged in substance (no retained
refusal reversed), so none of it bears on this verdict.

## The four asks, re-mapped to the current pin

1. **Identify the areas.** Re-confirmed, with the paths updated for the split:
   - **Agent core:** `packages/harness/src/agent/core/` (`definition/`,
     `state/`, `tools/`); run program `@agent/runtime/loop/toolUse.ts` over the
     run history, with `loop/{runProgram,step,rows,toolGuard,toolUseDispatch,hooks,modelSwitch}.ts`
     (`loop/rounds.ts` is gone — R1); the loop's model call is
     `@agent/runtime/ModelInvoker.ts` (`helperModel.ts` and `run/compaction.ts`
     invoke the bound `Model` directly — deliberate exceptions). The document
     recipe **left the harness**: it is now app code at
     `packages/texra/src/agent/output/documentRecipe.ts`.
   - **Model handler:** provider calls reached only through the `packages/llm`
     (`@texra-ai/llm`) `Model` bound by `runtime/run/modelBinding.ts` (427
     lines). The deliberate exceptions outside that route are unchanged.
   - **Logger:** `packages/harness/src/logger/` (`effectLog.ts`, `logSink.ts`,
     `effectDiagnostics.ts`, `formatLogData.ts`, `redaction.ts`).
   - **SDK surface:** `@texra-ai/harness` — now **four entries**: `.`
     (`index.ts`), `./schemas`, **`./plugins`** (new — `harnessBuiltins`), and
     `./node`; plus `effect/{errors,runtime,sessions,sessionPrograms}.ts`.

2. **Audit for unnecessary abstraction.** Done, four ways plus the adversarial
   sweep above. Agent core and loop are substantive (row constructors, guard,
   model-switch, `RunCell` scaffolding — no pass-throughs); the model handler is
   one service with real bind/call/callModel logic; the logger is a clean
   render→redact→truncate single-owner reached through the producer port
   (`Effect.log*` + `withLogChannel`); the SDK surface center is minimal and
   pure-Effect, the redundancy only at the edges (§New.1).

3. **Plan API-surface simplification.** The plan is the durable-harness extend
   surface (accepted) — `Plugin`, `Sessions.layer({ plugins })`,
   `Plugins.contribute`, `Session.resume` — which is now **substantially
   landed** (`Plugin`/`Composition`/`PluginsRefused` on the root, the `./plugins`
   entry). The one surface item left is to re-scope the Tier-1 manifest around
   the harness SDK (§New.1). The SDK speaks pure Effect end-to-end.

4. **Design subagent boundaries.** Already first-class, re-confirmed unchanged:
   (a) native subagents via `executeAgent` with an owned `RunId`; (b) the
   workflow-script run plus its `agent()` grandchildren; and (c) the agent-CLI
   children (`claude_code`, `codex`) through `startDetachedChildRunLoop` with
   provider-specific `ChildRunStrategy`. No boundary change is warranted.

## New / updated since the 2026-10-04 pass (needs an owner, not a routine)

1. **The 2026-09-10 Tier-1 manifest is now doubly stale — re-scope or retire
   it, do not ratify.** `2026-09-10-agent-sdk-tier-1-manifest.md` still
   references the **dead package name** `@texra-ai/agent` / `packages/agent`
   throughout (renamed to `@texra-ai/harness` / `packages/harness`, #13756);
   lists **three entries** where there are now four (`./plugins` added); still
   lists the **deleted `ToolHost`** as a root type; and predates `Plugin`,
   `Composition`, `PluginsRefused`, and the 4-field
   `ToolContext`/`ToolContextShape`/`CallRequests`/`ToolEnv` that now define the
   tool contract. The shed/leak questions it raised survive on the live root:
   `SettingHost` (TeXRA's internal host enum reaching the public contract,
   `index.ts:74`) and `MapToolRegistry`/`IToolRegistry` (registry plumbing the
   documented `defineTool` path never constructs, `index.ts:68`-`75`). Owner
   action: re-scope around the harness SDK per the durable-harness program's H4,
   rather than pin a list that names a dead package and a deleted type.

2. **The logger sink→Layer step is still unlanded.**
   `packages/harness/src/logger/logSink.ts` still holds the mutable module
   global (`let sink = consoleLogSink` at :165, `setLogSink`, `writeLogEntry`),
   set by host callers; `effect/runtime.ts` composes the process runtime but
   installs no sink, so an embedder of `@texra-ai/harness` gets whatever
   process-global sink is set and cannot inject its own through
   `Sessions.layer`/`AgentPlatform`, and two embedders in one process share one
   global. Rides `2026-09-21-effect-design-synchronous-facades.md` §5 step 6;
   still the one real SDK-relevant host leak, still the expensive step.

3. **`packages/llm` ambient reads still two; the README error count went stale.**
   - The ambient `process.env.*_CUSTOM_HEADERS` reads remain **two**
     (`anthropicMessages.ts:715`, `openaiResponsesRequest.ts:254`; lines moved,
     count unchanged). Intentional guardrails; relocation to the host boundary
     must be passed into every factory explicitly (the `packages/llm/test-live/`
     callers construct factories without `modelBinding`). Low priority; still
     needs filing into `2026-09-20-llm-package-hardening.md` or a fresh
     tech-debt entry.
   - **README error-count staleness — flagged this pass, not applied (first
     observation).** The plugin pivot added a seventh root error,
     `PluginsRefused`. `effect/errors.ts` was updated with it (its header reads
     "five defined … seven tagged errors on the surface in all"), but
     `packages/harness/README.md` was **not**: lines ~257-264 still read "Four
     come from the package itself … for six in all," now contradicting the
     code's own header. Per this routine's discipline (a doc drift is *filed*
     on first observation and *applied* only when a second consecutive pass
     confirms it — the mechanism the 2026-10-04 six-error reconcile followed),
     this is filed, not fixed. The owner call the pivot's "intended surface,
     not drift to reconcile" framing invites: on confirmation, either bump the
     count to seven or stop hard-coding a count the plugin surface will keep
     growing.

## Marginal cleanups (tech-debt-tier, re-pinned)

- `AgentRunLifecycle` `finalizeRunTerminalBody` single-caller — **resolved.**
  Gone repo-wide (folded in the single-caller-collapse program over this range).
  Dropped from the list.
- `createNeutralResponseTextProcessing` (`agent/runtime/responseTextProcessing.ts:23`)
  single caller — **do not inline** (justified named port-default; see Verdict).
  Recorded, not actioned.

**Do not collapse** (unchanged): `executeAgent` `resumeToolUse*` nested
`Effect.scoped`/`acquireRelease` chain — each level is a distinct scope region
whose nesting order is load-bearing for finalizer-before-release ordering.

## Genuinely open (carried, still human-owned)

- **Re-scope the Tier-1 manifest around the harness SDK** (not ratify the
  2026-09-10 static list) — §New.1; belongs to the durable-harness program, and
  now more urgent because the manifest names a renamed package and a deleted
  type.
- **Keep shrinking the frozen import lists, never widen** — the harness-no-app
  seven residents went (#13779); the `host-agent-import` baseline shrinks as the
  manifest ratifies each edge.

## Recommendation

No refactor to land autonomously from this charter. The one owner-level action
the surface audit asks for is to **re-scope (or retire) the 2026-09-10 Tier-1
manifest around the `@texra-ai/harness` SDK** (§New.1): the live surface already
carries the `Plugin`/`Composition` extend surface the accepted durable-harness
program is built on, while the old draft names a dead package (`@texra-ai/agent`)
and a deleted type (`ToolHost`). The logger sink→Layer step (§New.2) rides
`2026-09-21-effect-design-synchronous-facades.md`; the two `packages/llm`
ambient reads and the README error-count staleness (§New.3) need filing. Having
now watched the harness program move — the M8 split and the plugin pivot — this
pass confirms the re-run added signal **exactly where the 2026-10-04 pass
predicted it would**: in the surface/manifest reconcile, not in new abstraction
to remove. Re-running this routine will again add no signal until the manifest
is re-scoped or the durable-harness program advances further.
