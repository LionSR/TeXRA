# Agent SDK Readiness — Verification Checkpoint (2026-07-23)

**Status:** Verification checkpoint. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the plan of record
[`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md), the detailed
[`./2026-05-29-agent-sdk-readiness-audit.md`](./2026-05-29-agent-sdk-readiness-audit.md), the
trace-surface companion
[`2026-05-22-agent-trace-sdk-surface.md`](../../proposals/2026-05-22-agent-trace-sdk-surface.md), and the
`-2026-06-25` → `-2026-07-22` checkpoint chain (most recently
[`-2026-07-22`](./2026-07-22-agent-sdk-readiness-checkpoint.md)).

This pass re-verified the standing audit against branch
`claude/eager-noether-tevmuv` at HEAD `f7dded0` (v0.39.8, unreleased per
`CHANGELOG.md`'s `[0.39.8] - Unreleased` heading; **20 commits above the
`395e229` pin** the 07-22 checkpoint recorded, `395e229` confirmed an
ancestor of HEAD).

**Run context (honesty note).** This was an **unattended scheduled run** with
**no external adversarial review available** (no Codex second pass, the lever
the 07-22 checkpoint relied on to catch its own applied-then-reverted
mistake). It therefore ran a **fresh, uninformed three-way fan-out audit**
— three independent readers, briefed only with the repo's anti-abstraction
rules and _not_ with the standing adjudications — over (1) `agent/core` +
`agent/runtime` + `agent/implementations/flows` + `index`/`roster`, (2)
`agent/modelHandlers` + `toolConversion` + `IModelHandler` + `ModelFactory`,
and (3) `logger` + `platform` + the trace / `SessionEventHub` / `AppSignals`
surfaces + `output`/`storage`/`remote`/`export`/`goal`. Findings were then
reconciled against the adjudicated rulings and the tracked candidates in the
standing checkpoints. This pass deliberately **applies no code change** — see
"No change lands (by design this pass)" below.

## Verdict — unchanged

**The codebase remains well-aligned and SDK-ready in shape. No structural
refactoring is warranted.** The three fresh, uninformed readers independently
re-reached the standing conclusion — the same reconvergence every pass since
`-06-26` has recorded. **Every substantive candidate the fan-out surfaced maps
onto an already-adjudicated trap (ruling held), an already-tracked
reviewed-train / strategic item, or a candidate already recorded in a prior
checkpoint.** The fan-out surfaced **zero genuinely-new actionable debt.** The
one item not previously flagged as an abstraction-cleanup candidate in a
standing checkpoint or the audit is a pair of low-value single-caller factory
decorators in `ModelFactory` (item ⑧ below); a full-doc grep _does_ find both
identifiers in `2026-06-23-google-interactions-api-impl-spec.md`, but only as
implementation detail, never as a cleanup candidate. The 07-22
applied-then-reverted lesson argues specifically against inlining them in an
unattended pass.

## Fan-out findings mapped to standing adjudications — all held or non-actionable

Each numbered item is tagged **[Keep]**, **[strategic]**, or **[new]** (there
are no **[trap]** items in this section — traps are cataloged separately).
Nothing below is new _debt_: every item either matches a prior ruling
(**[Keep]**) or a tracked strategic/gated item (**[strategic]**); the lone
**[new]** item (⑧) is a newly-named but non-actionable observation, recorded
and deliberately not applied.

1. **[Keep] core/runtime has essentially no removable pass-through wrappers.**
   The
   agent-core reader confirmed the CLAUDE.md pattern is actually followed —
   `ResponseCycleNode.exec()` calls `createResponseCycleFlow<C>()` and runs it
   inline (`reflection/nodes/ResponseCycleNode.ts:104-118`); there is no
   wrapper between node and flow. `runReflectionFlow`/`runToolUseFlow`,
   `runAgent` vs `executeAgent`, `AgentFlowResult` vs `AgentFinalResult`,
   `IToolUseSession`, `withModelClient`, and the `createResponseCycleFlow`/
   `createToolUseRoundFlow` factories were each examined and **excluded as
   justified** (real single-home logic, the sanctioned
   `Node.exec → createFlow().run` shape, or a legitimate
   `core → implementations` port). Matches the held rulings carried since
   `-07-18`/`-07-21`.

2. **[strategic] The real core/runtime SDK-readiness item is ambient/global
   coupling, not excess layers.** `core/flows` reads the process-wide `RunContext`
   AsyncLocalStorage from inside flow primitives (`ResponseCycleFlow.ts:220`,
   `CommonCycleTypes.ts:109,127`, `RetryState.ts:304` via
   `useLaunchRunContext()`), and `core` carries sanctioned lateral/backward
   edges to `@agent/runtime`, `@auth/SupabaseClient`, and
   `@agent/index/agentRegistry`. This is **already captured** — the
   `2026-05-29-agent-sdk-readiness-audit.md`, the `-07-18` checkpoint, and
   `2026-05-30-agent-sdk-readiness.md` all record the ambient-`RunContext` / backward-edge
   embeddability tension, and `core/README.md` documents the edges as
   deliberately sanctioned host-agnostic collaborators. It is the north-star's
   NS-1 ("no public surface") strategic item, gated behind Steps 1–3 — not
   cleanup.

3. **[strategic] `RunAgentOptions` / `RunToolUseFlowInput` leak lease + resume
   plumbing into would-be-public signatures** (`runAgent.ts:11,44,46,49`;
   `runToolUseFlow.ts:73-107`). This is the same "shrink the public options
   type" observation the north-star records as Step-2/Step-3 packaging work
   (hide lease lifecycle behind `SessionHandle`; four-lifetime-tier host
   obligation, never a flat options bag). Strategic/gated. **No new action.**

4. **[Keep] `ModelHandler.ts` (~1,938 LOC) is a real shared base, not a
   god-object; `ModelFactory` is a justified factory, not a pass-through.** The
   model-handler reader confirmed each abstract/template method carries
   genuine overrides across the provider families (`createResponseImpl`,
   `sdkErrorTagger`, `extractResponse`, `normalizeUsage`, `extractToolUse`,
   plus the provider-trait predicates) rather than single-override template
   ceremony. Specific per-method override integers are **omitted
   deliberately** — the fan-out's counts were not re-run to forensic scope, and
   a spot-check this pass found `sdkErrorTagger` overridden in all seven
   non-base handlers (7, correcting the fan-out's noted 6), which is exactly
   why the soft counts are dropped rather than carried into the record.
   `createModelHandler` was confirmed to have 3 production callers plus real
   routing precedence (`modelHandlerCompatibilityKey`) and async credential
   overrides. Matches the `#7101`-triage **reviewed-train** ruling: the
   ~40-line justification doc-comments are a feature preventing re-litigation;
   do not collapse.

5. **[strategic] `IModelHandler` port width (~41 `Pick`ed members).** Re-derived; the
   reader's own conclusion is that this is a _surface-shape observation, not a
   delete_ (auto-derived via `Pick`, so not a drift risk) and that a real SDK
   port would separate the ~10–12-member invocation contract from the
   node-specific message-shaping helpers. This is exactly the standing
   **reviewed-train / strategic** port-width item (the message-opacity /
   `query()`-alignment tension), gated with the neutral-transcript lever.
   `IModelHandler = Pick<ModelHandler>` re-confirmed at
   `src/agent/types/IModelHandler.ts:41`.

6. **[Keep] `AnthropicStreamHandler` (463 LOC) sits in `support/` but is
   Anthropic-only (1 importer).** Re-surfaced by the model-handler reader as a
   placement nit (class-construction extraction, so exempt from the
   single-caller ban; belongs in `anthropic/`). **Already recorded** in the
   `-07-12`, `-07-18`, and `-07-21` checkpoints. Ruling held; not re-flagged as
   new. Low priority, not unattended-critical.

7. **[strategic] Trace `AgentEvent` union imports TeXRA-specific payloads
   directly**
   (`trace/events.ts:11-30`: `UpdateCompileFailuresPayload`,
   `GoalPausedPayload`, `UpdateMissingOutputsPayload`, …) while the file's own
   doc points app-specific events at a `domain` escape hatch. This is **not a
   new finding — it is the entire premise of
   [`2026-05-22-agent-trace-sdk-surface.md`](../../proposals/2026-05-22-agent-trace-sdk-surface.md)**, which
   specifies migrating TeXRA payloads to `{type:'domain', key, data}` "to keep
   the SDK union clean," one domain at a time. Tracked; not re-opened here.

8. **[new] Two single-caller factory decorators in `ModelFactory`** —
   `withReasoningOverride` (`ModelFactory.ts:155`, **1 caller**,
   `finalizeModelHandler`) and `withCompatibilityRoutingMode`
   (`ModelFactory.ts:399`, **1 caller**, `createModelHandlerForCompatibilityKey`).
   Both caller counts re-confirmed by direct grep this pass. These are the
   **only fan-out candidates no standing checkpoint or the audit flags as an
   abstraction-cleanup candidate** — a full-doc grep does surface both names in
   `2026-06-23-google-interactions-api-impl-spec.md`, but only as implementation detail.
   They are also the weakest possible finding: each carries _meaningful
   logic_ (a `globalState` read + `LEVEL_TO_EFFORT` map; real compatibility
   branch logic), so they survive the letter of the factory rule and violate
   only the single-caller-extraction clause, with a near-zero net-LOC gain from
   inlining. **Recorded, not applied** — see the next section for why an
   unattended pass is the wrong place to land this.

9. **[Keep] Logger, `output`/`storage`/`remote`/`export`/`goal`, boundary
   hygiene.**
   Logger re-confirmed a thin, justified sink (host-injectable channel factory,
   secret redaction, dedup) — matches the `-07-18`/`-07-21` "withdrawn as a
   cleanup candidate" ruling; the `createChannelWriter` single-caller seam and
   the `LogRedactionOptions.homeDir/workspacePath` path-redaction params are the
   same items those checkpoints already logged and kept. **Zero `vscode`
   imports in any declared VS Code-free zone** and **no `bus.emit` /
   `appSignals.emit` rule violation from an agnostic zone** — the separation
   rules are intact. `output/` (LaTeX-coupled) and `remote/` (Supabase-coupled)
   are correctly app-layer, not `@texra/core` material — a known part of the
   SDK/app split, not new debt.

## Subagent split points — unchanged

Delegation is already a mature strategy-pattern subsystem
(`startChildRunLoop` + `ChildRunStrategy` + `executionRegistry` lineage +
`detachSubagentsOnStop`), and `src/tools/claudeAgent.ts` already delegates
to `@anthropic-ai/claude-agent-sdk` (async spin-off mirroring `codex` /
`delegate_agent`, session resume via the SDK's `resume:` option). The
fan-out's independent split candidates — the provider families (`openai/`,
`google/`, `anthropic/` are cleanly separable, importing only the base +
shared `support/`/`utils/`, never a sibling), model resolution, the
execution registry/teardown cluster, persistence/resume, and index/roster
(already behind injected `Deps` ports) — all match the ranked split points
held since `-06-26` → `-07-22`. The depth-cap prerequisite (derive a depth
counter from lineage, then gate it) before exposing a recursive
`delegateTo(...)` still stands. **No new split point, no reordering.**

## No change lands (by design this pass)

Per the maintainer's standing "raise the bar every day — land at least one
verified improvement" directive, this pass considered whether to inline the two
`ModelFactory` decorators (item ⑧). **It deliberately does not**, for reasons
specific to an unattended run:

- The `-07-22` checkpoint is a worked example of exactly this hazard: an
  "easy," grep-justified cleanup (narrowing `MapToolRegistry`'s constructor
  away from its `Map` input) was applied, gated, and pushed — then **reverted
  in full** after an external Codex review caught both an incomplete caller
  census _and_ a silent-failure regression (`Object.entries(mapInstance)`
  returning `[]`, so a `Map` input would build an empty registry). The lesson
  recorded there: verify before landing, and this class of change needs a
  reviewer _outside_ the pass's own fan-out.
- This pass has **no such external reviewer** (unattended schedule). Landing a
  signature/shape change to the model-handler construction path with only my
  own fan-out's grep as evidence would repeat the precise setup that produced
  the 07-22 revert, with the safety net removed.
- The candidate's upside is ~2–4 LOC. The asymmetry (near-zero gain vs.
  documented revert risk on the spine) makes "record it, do not apply it" the
  correct call for an unattended checkpoint.

`MapToolRegistry` was re-checked and remains
`Map<string, ITool> | Record<string, ITool>` with the `instanceof Map` branch
intact (`ToolTypes.ts:47-61`) — the reverted, byte-identical state the 07-22
checkpoint left it in still holds at `f7dded0`, notwithstanding the intervening
`70b0a1a`/#9068 "Remove dead Map input branch" commit in the `395e229..HEAD`
range (its removal did not survive into the current tree). **Do not re-attempt
the narrowing without a deliberate compatibility boundary for `Map` inputs.**

## No-public-surface — still NS-1, still the one real gap

The host→core import surface remains the single real SDK-readiness gap. Step 0's
R-a (inbound host-import freeze) and R-b (frozen per-host deep-import baseline)
are installed and enforcing at a zero-violation baseline;
`config/ratchets/host-agent-import-baseline.json` reads **extension 41, CLI 31,
desktop 27** at `f7dded0` (verified directly this pass). Step 1 (the TD-2
contract-residue quartet + executable consumer-contract suite) and Step 3
(packaging, gated on a real external consumer) remain the sequenced path.
Nothing this pass changes that sequencing.

## Coverage gaps (honest scope of this pass)

- This pass ran **three** readers, not the standard four-way fan-out; the
  host↔core surface / SDK-concept-alignment reader was folded into reader (3)
  rather than run as a fourth independent lens. Alignment against the live
  `code.claude.com/docs/en/agent-sdk` docs was **not** re-fetched this pass; the
  standing `-07-22` verification against those docs is carried forward, not
  re-established.
- Caller/override counts below the spot-checks in the "Verified" section come
  from the fan-out readers' greps, **not** re-run to the forensic
  full-`src/`-scope standard the `-07-22` census-correction discipline
  demands. Treat the two decorator counts (directly re-grepped) and the spine
  invariants as verified; treat the wider override tables as re-derived-but-not-
  re-audited.
- The 10 of 11 `runtime`/`storage` files that `0dc0f8b`/#9035 touched and that
  the `-07-22` pass flagged as _not opened_ were **not** opened this pass
  either — the acknowledged coverage gap from `-07-22` persists and a future
  pass should still read them explicitly.

## Verified (this checkpoint)

- Spine invariants at HEAD `f7dded0`: `src/agent/core/index.ts` **absent** (no
  barrel regression); `IModelHandler = Pick<ModelHandler>`
  (`src/agent/types/IModelHandler.ts:41`); the `Node.exec → createFlow().run`
  shape intact (`ResponseCycleNode.ts:104-118`).
- Boundary hygiene: **0** `vscode` imports across all declared VS Code-free
  zones (`src/agent`, `model`, `latex`, `tools`, `controllers`, `shared`,
  `replacement`, `eventBus`, `hosts`, `logger`, `platform`); no
  agnostic-zone `bus.emit` / `appSignals.emit` rule violation.
- Ratchets present and enforcing:
  `config/ratchets/host-agent-import-baseline.json` (extension 41, CLI 31,
  desktop 27) and `config/ratchets/knip-baseline.json`.
- Item ⑧ caller counts re-grepped directly: `withReasoningOverride` **1**
  caller, `withCompatibilityRoutingMode` **1** caller.
- `MapToolRegistry` (`src/agent/core/tools/ToolTypes.ts:47-61`) still
  `Map | Record` with the `instanceof Map` branch — reverted state holds at
  `f7dded0` despite the intervening `70b0a1a`/#9068 removal commit.
- Commit range: `git log 395e229..HEAD` = 20 commits; `395e229` confirmed an
  ancestor of `f7dded0`.
- This checkpoint is added under `docs/proposals/`, an internal directory
  excluded from the texra.ai publish allowlist — not a root-level doc.
