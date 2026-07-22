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
recurring `src/`-only-grep methodology error struck the fan-out again (the
runtime reader proposed un-exporting `useRunContext`; it is imported by two
test files and cannot be un-exported — see below).

## Applied this pass — one verified dedup (dead constructor branch)

Per the maintainer's "raise the bar every day — land at least one verified
improvement" directive, this pass lands one gated, behavior-preserving
simplification.

**What it was.** `MapToolRegistry` (`src/agent/core/tools/ToolTypes.ts:47-61`)
accepted `Map<string, ITool> | Record<string, ITool>` and branched on
`tools instanceof Map ? tools : new Map(Object.entries(tools))`. The `Map`
input arm was speculative generality: a **full-repo** grep of every
`new MapToolRegistry(...)` construction (1 production site —
`src/tools/registry.ts:178`, passing `createDefaultTools()` which returns a
`Record`; 14 test sites, all passing object literals or a `Record`-typed
`opts.tools`) confirmed **no caller anywhere passes a `Map`**, and no test
passes a `Map` either. The `instanceof Map` branch was therefore dead code.

**What was applied.** Narrowed the constructor to
`constructor(tools: Record<string, ITool>)` and dropped the `instanceof Map`
branch (`this.tools = new Map(Object.entries(tools))`); updated the class
doc-comment from "Map- or Record-backed" to "Record-backed". Net −2 LOC, one
narrowed public signature on a `core` type.

**Why this cleared the bar (src-only, but a core-type signature change, so
gated not swept).** `npm run typecheck` exit 0 across **all six** project
configs (root, test-kernel, extension, CLI, trace-viewer, desktop); `eslint`
clean on the touched file; the five test files that construct
`MapToolRegistry` (`ToolUseDispatchParallel`, `ToolUseToolResolution`,
`structuredOutput`, `BashTool`, `SessionResumeRetrieval`) green — 73 tests
passing. Behavior-preserving: the retained path is byte-identical to the old
`Record` branch. This candidate is **not** recorded in any prior checkpoint —
genuinely new, but trivial.

## Candidates that did NOT survive verification (record — caller counts again)

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
  justifications per capability getter) are a *feature* preventing
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
  Very little is re-implemented; the document-continuation loop it *does* own
  is required by the multi-provider unification. **Keep.**
- **OpenAI-compatible subclasses** (`ReasoningModelHandlerOpenAI` + the
  per-provider handlers) — each carries genuine wire-format divergence; the
  intermediate base has 4 subclasses. **Keep** (the `DashScope`/`XAI`/`GLM`
  consolidation remains the standing reviewed-train note).
- **`ResponseCycleFlow`/`ToolUseRoundFlow` primitives, `createResponseCycleFlow`
  /`createToolUseRoundFlow` factories, `withModelClient`, `ModelInvocationNode`,
  `IToolUseSession`, `IToolRegistry`** — all re-derived and match the held
  rulings: the factories *are* the prescribed `Node.exec() → createFlow().run()`
  shape (fresh stateful node graph per round); `withModelClient` is the
  load-bearing live-`client` getter for relay-401 rebinding; the single-impl
  ports are legitimate `core → implementations`/`core → tools` seams. **Keep.**
- **Four event/subscribe surfaces** (`AgentTrace.subscribe`,
  `SessionEventHub.subscribe`, `SessionHandle.onResult`, `AppSignals.on`) —
  the runtime reader re-derived the run-`result` overlap. This is the standing
  **Observability / unified-stream** strategic item; the 07-21 pass already
  refined it (the genuine parallel registries are interaction/presentation;
  `emitRunFact` is *not* a third delivery surface; the broker-side pre-dispatch
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
*runtime-as-external-SDK* direction) does not capture: TeXRA already **embeds**
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
standing verdict. **One verified improvement was applied** — the dead `Map`
input branch on `MapToolRegistry`'s constructor was removed (−2 LOC, signature
narrowed to `Record`), gated green across all six typecheck configs + lint + 73
tests, a real dead-branch dedup not a blind sweep. Two further candidates were
verified and rejected (`useRunContext` export is needed by two test files;
the `output_tokens === 3` heuristic is already recorded in `-07-18`). Every
remaining item is reviewed-train (`ModelHandler` decomposition, the
`IModelHandler` port-width facets kept overridable per the `#7101` triage) or
strategic/gated (the unified event stream preserving broker-side filtering, the
`HostInteractions` 7/7 required-methods conversion behind Step 1, the frozen
`GoogleGenAI` handler gated on `#7097` + transcript-format retirement, the
no-public-surface Steps 1–3). Do not re-open the traps; do not re-flag
`useRunContext`, `IToolRegistry`, `IModelHandler`, or `followUpResumeDetection`
as dead (each has a live caller or a test seam a `src/`-only grep misses).

## Verified (this checkpoint)

- Spine re-confirmed at HEAD `395e229`: `src/agent/core/index.ts` **absent**
  (no barrel regression); `IModelHandler` = `Pick<ModelHandler>`
  (`src/agent/types/IModelHandler.ts:41`); the `Node.exec → createFlow().run`
  shape intact; delegation strategy subsystem intact.
- Boundary width: hosts still deep-import 55 distinct `@agent/*` specifiers
  (union) / 26 of 51 `runtime/` files (independent recount, ±1 vs a
  differently-tokenized census; consistent with the 07-21 per-host 41/31/26).
  Step 0 R-a/R-b ratchets present and enforcing.
- Applied cleanup verified: `MapToolRegistry` constructor narrowed to
  `Record<string, ITool>` (`src/agent/core/tools/ToolTypes.ts:50`), `instanceof
  Map` branch removed. Full-repo grep: 1 production + 14 test constructions, all
  `Record`; **0** pass a `Map`. `npm run typecheck` exit 0 (all six configs),
  `eslint` clean on the touched file, 73 tests green across the five
  `MapToolRegistry`-constructing suites.
- Rejected candidates verified: `useRunContext` imported by
  `RunContext.vitest.ts` + `AgentLaunchContext.vitest.ts` (export required);
  `output_tokens === 3` already flagged in `-2026-07-18`.
- MCP-exposure observation: no proposal mentions exposing the TeXRA tool
  registry as an MCP server (grep across `docs/proposals/`); `claude_code` tool
  confirmed at `src/tools/claudeAgent.ts` importing
  `@anthropic-ai/claude-agent-sdk`.
- This checkpoint is added under `docs/proposals/`, an internal directory
  excluded from the texra.ai publish allowlist — not a root-level doc.
