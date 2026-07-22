# Agent SDK Readiness — Verification Checkpoint (2026-07-22)

**Status:** Verification checkpoint. Read alongside the canonical
[`agent-sdk-readiness.md`](./agent-sdk-readiness.md), the plan of record
[`agent-sdk-north-star.md`](./agent-sdk-north-star.md), the detailed
[`../agent-sdk-readiness-audit.md`](../agent-sdk-readiness-audit.md), the
[`agent-sdk-readiness-delta-2026-06-24.md`](./agent-sdk-readiness-delta-2026-06-24.md)
addendum, and the `-2026-06-25` → `-2026-07-21` checkpoints (most recently
[`-2026-07-21`](./agent-sdk-readiness-checkpoint-2026-07-21.md)).

This pass re-verified the standing audit against `claude/eager-noether-2kgehc`
at HEAD `395e229` (v0.39.8-dev, 11 commits above the `3612630` pin the 07-21
checkpoint recorded — the intervening commits are dependency bumps (#9056,
#9058, #9060), the citty CLI arg-parse refactor (#9039), and the
consolidate-onto-native-helpers refactor (#9036); none touch the agent
spine). As on every prior pass it ran a **fresh, uninformed four-way fan-out
audit** — four separate readers for (1) `agent/core` + `agent/implementations/flows`,
(2) `agent/modelHandlers` + `toolConversion` + `IModelHandler`, (3)
`agent/runtime` + `logger` + the trace/`SessionEventHub`/`AppSignals` surfaces,
and (4) host↔core surface + SDK-concept alignment (against the fetched
`code.claude.com/docs/en/agent-sdk` docs) + subagent split points — then
reconciled every finding against the adjudicated rulings and the tracked
candidates in the standing checkpoints.

## Verdict — unchanged

**The codebase remains well-aligned and SDK-ready in shape. No structural
refactoring is warranted.** The four fresh, uninformed readers independently
re-reached the standing conclusion (the same reconvergence the 07-21 pass
recorded). Every substantive candidate the fan-out surfaced maps onto an
**already-adjudicated trap** (ruling held), an **already-tracked
strategic / reviewed-train** item, or a **verified false positive** — and the
recurring `src/`-only-grep methodology error struck twice this pass: once in
the fan-out itself (the runtime reader proposed un-exporting `useRunContext`;
it is imported by two test files and cannot be un-exported — see below), and
once in this checkpoint's own verification of an applied change (an
incomplete `MapToolRegistry` caller census, caught only after the change had
already been pushed — see "Applied-then-reverted" below).

## Applied-then-reverted this pass — a self-caught verification failure

Per the maintainer's "raise the bar every day — land at least one verified
improvement" directive, this pass initially applied, gated, and pushed one
candidate. An external automated review (Codex, three P2 comments) then
caught that the "verification" was itself incomplete in two distinct ways,
and that the change carried a real safety regression. All three catches were
independently re-verified and the change was reverted in full. Recording this
in detail because it is exactly the failure mode this checkpoint series
exists to catch — this time the recurring error hit the audit-and-apply step,
not just the audit.

**What was proposed and initially applied.** `MapToolRegistry`
(`src/agent/core/tools/ToolTypes.ts:47-61`) accepted
`Map<string, ITool> | Record<string, ITool>` and branched on
`tools instanceof Map ? tools : new Map(Object.entries(tools))`. A grep of
`new MapToolRegistry(...)` was read as showing 1 production + 14 test call
sites across 5 files, all passing `Record`, so the `instanceof Map` arm was
narrowed away (constructor changed to `Record<string, ITool>` only).

**Catch 1 (Codex, P2) — the caller census itself was incomplete.** The actual
full-repo grep returns **16** constructions across **10** files (1 production
and **15** test, not 14, across **9** test files not 5) — the omitted suites
were `ToolUseDispatchInterruption`, `ToolUseRoundFollowUpMedia`,
`DelegationAgentAvailability`, and `DelegationWorktreeAvailability`. All 4
missed suites (33 additional tests) were run after the catch and pass with
`Record`-typed arguments, so the underlying conclusion ("no in-repo caller
passes a `Map`") happened to still hold — but the stated validation scope
("73 tests across five suites") was false. A second, distinct incomplete-grep
error, layered on top of the audit's already-diagnosed recurring failure mode.

**Catch 2 (Codex, P2) — narrowing an exported constructor's accepted input is
not "removing dead code."** `MapToolRegistry` is `export`ed; its `Map` branch
was a documented, explicitly-accepted input shape, not a provably-unreachable
code path. "No current in-repo caller exercises it" is a usage argument, not
an unreachability argument — it says nothing about a type-unsafe or future
caller (an `as any` cast, a dynamically-loaded consumer) that does pass a
`Map`. Worse, the failure mode is **silent**, not a compile error:
`Object.entries(mapInstance)` returns `[]`, so a `Map` input after the change
would silently construct an **empty** registry rather than fail loudly.
Removing the branch traded a real, if narrow, correctness guarantee on an
exported symbol for 2 LOC, with no caller demanding the removal.

**What was reverted.** The constructor is restored to
`Map<string, ITool> | Record<string, ITool>` with the `instanceof Map` branch
intact — byte-identical to the pre-checkpoint code. The class doc-comment is
back to "Map- or Record-backed".

**Verified after revert.** `npm run typecheck` exit 0 (root + test-kernel
configs); `eslint` clean on the touched file; all **9**
`MapToolRegistry`-constructing suites green — **106 tests**
(`ToolUseDispatchParallel`, `ToolUseToolResolution`, `structuredOutput`,
`BashTool`, `SessionResumeRetrieval`, plus the 4 initially-missed suites:
`ToolUseDispatchInterruption`, `ToolUseRoundFollowUpMedia`,
`DelegationAgentAvailability`, `DelegationWorktreeAvailability`).

**Net effect.** No code change lands this pass after all — the dead-branch
candidate did not survive verification once the verification itself was
corrected. This replaces last pass's "raise the bar" applied-improvement with
a documented non-improvement: a real signature-narrowing change was drafted,
gated on an incomplete test/caller audit, pushed, then reverted after
independent review caught both the incomplete audit and the safety
regression it was masking. The discipline holds — verify before landing, and
re-verify when an outside reviewer disagrees — but this time the "verify"
step needed a second pass from a reviewer outside the checkpoint's own
fan-out.

## Other candidates rejected outright (record — caller counts again)

Two further "easy" fan-out candidates were examined and **rejected**, each an
incomplete-grep or already-adjudicated artifact:

- **`useRunContext` un-export** (runtime reader: "0 external callers, could be
  un-exported"). Full-repo grep shows it imported by
  `src/test-kernel/agent/runtime/RunContext.vitest.ts` and
  `AgentLaunchContext.vitest.ts` via `@agent/runtime/RunContext` — the export
  is load-bearing for the test seam. **Keep.** (The `src/`-only grep that
  motivated the suggestion missed the test-kernel importers.)
- **The Anthropic empty-response magic number**
  `responseObject.usage.output_tokens === 3`
  (`modelHandlerAnthropic.ts:973`, model-handler reader re-surfaced it as a
  fragile heuristic). This is **already recorded** — the
  [`-2026-07-18`](./agent-sdk-readiness-checkpoint-2026-07-18.md) checkpoint
  (item on the `anthropic/` handler) already flagged the undocumented constant
  and its "worth a content-based check" fix as "not unattended-safe, cheap
  when a maintainer picks it up." Ruling held; not re-flagged as new.

## Fan-out findings mapped to standing adjudications — all held

Nothing below is new debt; each was independently re-derived and matches a
prior ruling.

- **`ModelHandler.ts` ~1,931-LOC base tangling ~7 concerns** — model-handler
  reader re-derived it; the `#7101` triage doc-comments (the ~40-line
  justifications per capability getter) are a _feature_ preventing
  re-litigation. **Reviewed-train** (the standing `runTurn`/`streamTurn`-façade
  decomposition item); do not collapse. Optional future: extract the
  credential-routing / token-count-template blocks into injected collaborators —
  size/cohesion, not duplication.
- **`IModelHandler` port width (~41 members)** — the message-opacity /
  `query()`-alignment tension the north-star already records; the six
  provider-trait predicates stay overridable per the `#7101` triage (not
  foldable into a static `capabilities` object — their values are computed
  per-handler at runtime). **Reviewed-train / strategic**, gated with the
  neutral-transcript lever.
- **`toolConversion.ts` one-way converters** — model-handler reader confirmed
  **no round-tripping**; each of the six converters has a distinct provider
  caller and real per-format logic (`flattenTopLevelUnion`, `stripDollarSchema`
  work around documented OpenAI/Gemini 400s). **Keep.**
- **Anthropic handler delegates to `@anthropic-ai/sdk`** — streaming via
  `client.beta.messages.stream` + `finalMessage()`, retries via
  `isAutoRetryManagedByProvider() === true`, caching via SDK `cache_control`.
  Very little is re-implemented; the document-continuation loop it _does_ own
  is required by the multi-provider unification. **Keep.**
- **OpenAI-compatible subclasses** (`ReasoningModelHandlerOpenAI` + the
  per-provider handlers) — each carries genuine wire-format divergence; the
  intermediate base has 4 subclasses. **Keep** (the `DashScope`/`XAI`/`GLM`
  consolidation remains the standing reviewed-train note).
- **`ResponseCycleFlow`/`ToolUseRoundFlow` primitives, `createResponseCycleFlow`
  /`createToolUseRoundFlow` factories, `withModelClient`, `ModelInvocationNode`,
  `IToolUseSession`, `IToolRegistry`** — all re-derived and match the held
  rulings: the factories _are_ the prescribed `Node.exec() → createFlow().run()`
  shape (fresh stateful node graph per round); `withModelClient` is the
  load-bearing live-`client` getter for relay-401 rebinding; the single-impl
  ports are legitimate `core → implementations`/`core → tools` seams. **Keep.**
- **Four event/subscribe surfaces** (`AgentTrace.subscribe`,
  `SessionEventHub.subscribe`, `SessionHandle.onResult`, `AppSignals.on`) —
  the runtime reader re-derived the run-`result` overlap. This is the standing
  **Observability / unified-stream** strategic item; the 07-21 pass already
  refined it (the genuine parallel registries are interaction/presentation;
  `emitRunFact` is _not_ a third delivery surface; the broker-side pre-dispatch
  filter in `SessionEventHub.emit` must be preserved). No new action.
- **Logger** — thin, justified sink (host-injectable channel factory, secret
  redaction, dedup); `redaction.ts` guards security properties (desktop
  path-redaction caller + the `satisfies Record<ApiKeyProviderId>` exhaustiveness
  ratchet). **Keep** — matches the 07-21 "withdrawn as a cleanup candidate"
  ruling.
- **Subagent split points** — delegation is already a mature strategy-pattern
  subsystem (`startChildRunLoop` + `ChildRunStrategy` + `executionRegistry`
  lineage + `detachSubagentsOnStop`); `review` is already an isolated tool-use
  agent (the reference split), `agentCreator` already runs on an isolated
  helper-model kit, goal-continuation is hook-shaped not subagent-shaped, and
  `followUp`/`export` are correctly not candidates. Ranked split points
  **unchanged** from `-06-26` → `-07-21`. The depth-cap prerequisite (derive a
  depth counter from lineage, then gate it) before exposing a recursive
  `delegateTo(...)` still stands.

## No-public-surface — the central item, still the north-star's NS-1

The host→core import surface remains the one real SDK-readiness gap (hosts
still deep-import ~26 of 51 `runtime/` files; distinct `@agent/*` specifiers
per host were 41/31/26 at the 07-21 pin). This is **not new** and is **not
eroding unfenced** anymore: Step 0's R-a (inbound host-import freeze in
`eslint.config.mjs`) and R-b (frozen per-host deep-import baseline +
`hostAgentDeepImportRatchet.vitest.ts`) are both installed and enforcing at a
zero-violation baseline, and width dropped on all three hosts last window.
Step 1 (the TD-2 contract-residue quartet + executable consumer-contract
suite) and Step 3 (packaging, gated on a real external consumer) remain the
sequenced path. Nothing this pass changes that sequencing.

## One genuinely-uncaptured observation — MCP tool exposure (strategic, product-facing)

The SDK-alignment reader noted an angle the readiness series (focused on the
_runtime-as-external-SDK_ direction) does not capture: TeXRA already **embeds**
the Agent SDK as a delegated tool (`src/tools/claudeAgent.ts`, the `claude_code`
tool over `@anthropic-ai/claude-agent-sdk`), but its ~55-tool registry
(`src/tools/registry.ts`, incl. the domain tools — arxiv, latex figure/bib/tikz,
zotero, lean, wolfram, crossref) is **in-process only**. There is no proposal
(grep-confirmed) on wrapping that registry as an **in-process MCP server** so
the embedded `claude_code` agent (and any external SDK/CLI consumer) could
reach TeXRA's domain tools instead of only SDK built-ins. `parallelSafe` /
`requiresApproval` map cleanly onto MCP annotations + the SDK permission layer.
Recorded as a **strategic product idea**, not a readiness-refactoring item — it
adds surface rather than removing it, so it does not change the "no structural
refactoring warranted" verdict; noting it only so the option is captured
somewhere.

## Recommendation

**SDK-ready in shape; no structural refactoring warranted.** The tree is
healthy at `395e229` (v0.39.8-dev); a fresh four-way fan-out reconverged on the
standing verdict. **No net code change lands this pass.** The one candidate
this pass initially applied — narrowing `MapToolRegistry`'s constructor away
from its `Map` input — was pushed, then **reverted** after an external review
(Codex, P2 ×2) caught both an incomplete caller census (16 constructions
across 10 files, not 14 across 5) and a real silent-failure regression on the
exported class's accepted `Map` input; see "Applied-then-reverted" above. Two
further candidates were verified and rejected outright (`useRunContext`
export is needed by two test files; the `output_tokens === 3` heuristic is
already recorded in `-07-18`). This checkpoint's own host-import
boundary-width figure is also corrected, **55 → 54** (Codex, P2): the raw
token grep counted a comment-only `@agent/review` reference
(`agentReviewCommands.ts:6`, prose, never used as a real import specifier)
as if it were one. Every remaining item is reviewed-train (`ModelHandler`
decomposition, the `IModelHandler` port-width facets kept overridable per the
`#7101` triage) or strategic/gated (the unified event stream preserving
broker-side filtering, the `HostInteractions` 7/7 required-methods conversion
behind Step 1, the frozen `GoogleGenAI` handler gated on `#7097` +
transcript-format retirement, the no-public-surface Steps 1–3). Do not re-open
the traps; do not re-flag `useRunContext`, `IToolRegistry`, `IModelHandler`,
or `followUpResumeDetection` as dead (each has a live caller or a test seam a
`src/`-only grep misses); do not re-attempt the `MapToolRegistry` narrowing
without also providing a deliberate compatibility boundary for `Map` inputs.

## Verified (this checkpoint)

- Spine re-confirmed at HEAD `395e229`: `src/agent/core/index.ts` **absent**
  (no barrel regression); `IModelHandler` = `Pick<ModelHandler>`
  (`src/agent/types/IModelHandler.ts:41`); the `Node.exec → createFlow().run`
  shape intact; delegation strategy subsystem intact.
- Boundary width: hosts still deep-import **54** distinct `@agent/*`
  specifiers (union) / 26 of 51 `runtime/` files (independent recount, ±1 vs a
  differently-tokenized census; consistent with the 07-21 per-host 41/31/26).
  Corrected from an initial raw-token count of 55 (Codex, P2): the token grep
  matched a comment-only `@agent/review` reference
  (`packages/extension/src/commands/review/agentReviewCommands.ts:6`, doc-comment
  prose, not an import) as if it were a real specifier — confirmed via
  `grep -rn "from '@agent/review'"` returning zero hits for that bare path.
  Step 0 R-a/R-b ratchets present and enforcing.
- `MapToolRegistry` (`src/agent/core/tools/ToolTypes.ts:47-61`) — narrowed to
  `Record<string, ITool>`, pushed, then **reverted** to
  `Map<string, ITool> | Record<string, ITool>` (byte-identical to
  pre-checkpoint) after Codex P2 review. Full-repo recount after the catch: 16
  constructions across 10 files (1 production + 15 test across 9 test files,
  not 14 across 5 as first reported). `npm run typecheck` exit 0 (root +
  test-kernel), `eslint` clean, all 9 constructing suites green — 106 tests.
- Rejected candidates verified: `useRunContext` imported by
  `RunContext.vitest.ts` + `AgentLaunchContext.vitest.ts` (export required);
  `output_tokens === 3` already flagged in `-2026-07-18`.
- MCP-exposure observation: no proposal mentions exposing the TeXRA tool
  registry as an MCP server (grep across `docs/proposals/`); `claude_code` tool
  confirmed at `src/tools/claudeAgent.ts` importing
  `@anthropic-ai/claude-agent-sdk`.
- This checkpoint is added under `docs/proposals/`, an internal directory
  excluded from the texra.ai publish allowlist — not a root-level doc.
