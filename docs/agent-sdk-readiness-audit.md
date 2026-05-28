# Agent SDK Readiness Audit

_Audit date: 2026-05-28 · Scope: `src/agent/**`, `src/logger/**`, `src/eventBus/**`, plus extension/CLI entrypoints._

This is a **review + refactoring plan**, not an applied refactor. It identifies the
texra agent core, model handlers, logger, and surface areas; flags abstractions
that don't earn their keep; proposes surface simplifications; and marks subagent
split points that map onto Claude Agent SDK patterns.

All `file:line` references and counts below were verified directly against the tree
at audit time. Claims about Anthropic/Agent SDK *native* features are marked
**(verify)** where they depend on SDK versions not pinned in this repo.

---

## 0. TL;DR

TeXRA is **already well-architected** and largely SDK-aligned: one canonical run
entrypoint (`runValidatedExecutionRequest`), a PocketFlow-based agent loop with
durable resume, a single discriminated trace-event stream (`AgentTrace`), and
config-driven agents (5 workflow + 10 tool-use YAMLs over 2 shared flows) with a
working tool-driven delegation/subagent mechanism.

The gaps are **incremental, not structural**:

1. A handful of orchestration wrappers and single-use factories add indirection
   the repo's own CLAUDE.md guidance says to flatten.
2. Observability is split across **two** buses (`AgentTrace` + `ProgressEventBus`)
   with at least one genuinely duplicated signal (token usage).
3. Three deprecated logger facades are dead weight with **stale, reversed** doc
   comments.
4. The model-handler layer is sound but carries duplicated OpenAI streaming logic
   and hand-rolled Anthropic context management that could lean on SDK natives.
5. Delegation is a *tool call*, not a first-class primitive; subagent boundaries
   exist conceptually but aren't exposed as an API.

Estimated cleanup is small (low hundreds of LOC removed/flattened) with
outsized clarity gains. No rewrite warranted.

### Applied in this branch (net −64 LOC, behavior-preserving)

The line-removing, no-new-indirection items have been executed and pass
`npm run typecheck` + `eslint`:

- **§2.1** — Deleted the three dead logger facades (`TexraTrace.ts`,
  `TexraTraceEmitter.ts`, `noopTexraTrace.ts`), repointed `runTrace.ts` at
  `@agent/trace` directly, and fixed the reversed doc comments in `trace/`.
- **§2.2** — Inlined the single-use `createExecutionRunContext` into
  `withExecutionRunContext` and dropped the now-unused `RunContext` type import.
- **§3.4** — Replaced the five duplicated `getMessageNormalizationOptions()`
  overrides (DeepSeek, Kimi, MiniMax, GLM, DashScope) with three declarative
  flags on the base OpenAI handler (`convertContentToString`,
  `convertContentToStringUnlessVision`, `mergeConsecutiveRoles`).

Deferred (not pure line-removal / would add indirection or risk behavior):
the `@agent/runtime` facade barrel (§3.1, adds indirection), the `bridgeState`
→ `RunContext` move (§2.3, risky), and the duplicate usage-emission removal
(§4) — that one is a consumer rewire of the progress-view UI, not a deletion.

---

## 1. Areas Identified

| Area | Location | Size | Role |
|------|----------|------|------|
| Agent core | `src/agent/core/` (incl. `core/flows`) | ~3.5k LOC, 21 files | Config, state, cycle flows, services |
| Implementations | `src/agent/implementations/flows/{reflection,tooluse}` | ~2.5k LOC, 19 files | The two real agent loops |
| Runtime | `src/agent/runtime/` | ~4.3k LOC, 30 files | Entrypoints, context, coordinators, model factory |
| Model handlers | `src/agent/modelHandlers/` | ~16k LOC, 35 files | Per-provider API adapters |
| Logger | `src/logger/` + `src/agent/trace/` | ~1.5k LOC, 14 files | Trace event stream + host sinks |
| Event bus | `src/eventBus/` | ~0.3k LOC | Progress/UI events |

**The run call path (verified):**

```
executeCommand.ts:36 (ext)  ─┐
agentsRun/multiAgent (cli) ──┤→ runValidatedExecutionRequest (runExecutionRequest.ts:18)
                              │     → executeAgent (executeAgent.ts:376)
                              │         → buildAgentLaunchContext (AgentLaunchContext.ts:390)
                              │         → withExecutionRunContext (AsyncLocalStorage)
                              │         → branch on agentCategory:
                              │             toolUse  → runToolUseFlow   → PersistedFlow.run
                              │             workflow → runReflectionFlow → RoundPersistedFlow.run
```

Both hosts converge on one core function — a genuine strength.

---

## 2. Abstractions to Remove / Flatten

Ordered by value-to-effort. Each cites the repo's own anti-pattern rules in
CLAUDE.md ("Flattening Abstraction Layers", "Discouraged Factory Patterns").

### 2.1 Deprecated logger facades — **delete** (low effort, high tidiness)

`src/logger/TexraTrace.ts`, `TexraTraceEmitter.ts`, `noopTexraTrace.ts` are
re-export/alias shims. **No production code imports them** — the only references
to `TexraTrace` (11 files) live inside `trace/` and `logger/` themselves, and the
doc comments are **stale and reversed**: `trace/AgentTrace.ts:10`, `trace/TraceEmitter.ts:6`,
and `trace/noopTrace.ts:4` all point readers *back* to the deprecated facades as if
those were canonical, when in fact `@agent/trace` is now the source of truth.

- **Action:** Delete the three `logger/*Trace*` shims; move the one live type that
  still lives there (`FilesLoadedInput` in `TexraTrace.ts:16`) to `@agent/trace`;
  fix the three reversed doc comments in `trace/` to stop pointing at `@logger`.

### 2.2 `createExecutionRunContext` — **inline** (two-layer factory, called once)

`AgentLaunchContext.ts:88` defines it; the **only** caller is
`withExecutionRunContext` at `AgentLaunchContext.ts:112`. It's a trivial mapper
(spreads `AgentLaunchContext` fields into a `RunContext`). This is the exact
"two-layer factory called once" anti-pattern.

- **Action:** Inline the body into `withExecutionRunContext`.

### 2.3 `runCoordinators.ts` `bridgeState` — **own state in `RunContext`** (medium)

`runtime/runCoordinators.ts` keeps **module-level global state**: 8 `Map`s on a
`bridgeState` object (`runCoordinators.ts:36-45`), referenced 50× across 254 lines,
plus a `legacyCoordinators` singleton. Coordinator availability becomes invisible
to agent code and duplicates what `RunContext.coordinators` already holds.

- **Action:** Move per-stream coordinator retention into `RunContext`/execution
  registry lifecycle; drop the global `bridgeState` Maps. (Note the name
  `legacyCoordinators` — this is already flagged internally as legacy.)

### 2.4 Orchestration wrappers — **thin, but mostly justified** (judgment call)

`executeAgent` (~145 lines), `runToolUseFlow` (~205), `runReflectionFlow` (~251)
are heavy on "assemble services → build node graph → run flow → map result."
Per CLAUDE.md's flatten rule, the *pure result-mapping + lifecycle* portions are
candidates to fold into the flow runners. **However**, unlike the already-deleted
`ResponseCycle.ts`/`ToolUseCycle.ts` wrappers (see CLAUDE.md history), these still
do real work (tool resolution, delegation config, round looping, lifecycle).

- **Action (conservative):** Don't delete. Extract only the trivial result→
  `AgentFlowResult` mapping and the service-assembly bookkeeping into named
  helpers so the *loop* reads cleanly. Leave the orchestration in place.

### 2.5 `createRunContext` identity-ish factory — **leave or inline** (cosmetic)

`RunContext.ts:67` is validation + `Object.freeze` over an object literal. Borderline
against "trivial identity factory," but the validation (`runtimeHost` required) and
freeze give it marginal value. Low priority; inline only if touched anyway.

### 2.6 `modelHandlerValidation.ts` — **relocate out of the dispatch tree** (low)

A 232-LOC stub handler implementing the full `IModelHandler` with hardcoded
outputs, loaded only behind `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL=1`
(`ModelFactory.ts`). It's test/validation machinery sitting in the production
handler directory.

- **Action:** Move to `test-kernel/` (or a mock-handler module) and inject at
  runtime rather than dispatch it via `PROVIDER_HANDLERS`.

---

## 3. Surface-Area Simplifications

The public barrels (`@agent/index`, `@agent/core`, `@agent/types`) are
**intentionally narrow** — a real strength. The friction is at the edges:

1. **Deep-import leakage.** ~44 files in `packages/extension/src` import directly
   from `@agent/runtime/*`, `@agent/implementations/*`, `@agent/toolUse/*`,
   `@agent/storage/*` (e.g. `StreamStatusService`, `ToolUseFollowUpQueue`,
   `delegationPolicy`). Acceptable for internal command handlers, but there's no
   shielded "public runtime" subset.
   - **Action:** Add a small `@agent/runtime/index.ts` facade re-exporting the
     genuinely-public subset (`runValidatedExecutionRequest`, `executeAgent`,
     `resumeToolUseFromSnapshot`, `AgentRuntimeHost`). Keep internals importable
     but make the intended surface obvious.

2. **Core barrel under-exports.** `@agent/core` exports only ~3 symbols;
   `AgentConfigSchema`, `AgentWorkflowSetting`, `AgentToolUseSetting`,
   `UserVariableChannels` are reached by deep path imports.
   - **Action:** Add them to `core/index.ts` so consumers stop deep-importing
     `AgentDataclass`/`AgentConfig`.

3. **Two parallel OpenAI handler families.** `modelHandlerOpenAI.ts` (1.7k) and
   `modelHandlerOpenAIResponse.ts` (3.3k) duplicate ~200 LOC of stream-finalize
   logic with different event models.
   - **Action:** Extract a shared `finalizeOpenAIResponse(...)` helper; document
     the Responses-API split as known debt.

4. **Repeated `getMessageNormalizationOptions()` overrides.** 5–6 OpenAI-compatible
   handlers (DeepSeek, Kimi, MiniMax, GLM, XAI, DashScope) each re-declare nearly
   identical normalization. These are otherwise *good* thin wrappers (19–137 LOC).
   - **Action:** Drive normalization from capability flags in the base handler;
     keep only genuine per-provider deltas. ~250 LOC saving, low risk.

5. **Anthropic context management is hand-rolled.** `anthropicContextManagement.ts`
   (threshold heuristics, 4-slot cache management, hardcoded 1.25×/2.0× cache
   multipliers) reimplements logic the Anthropic SDK exposes natively
   (`cache_control`, server-side `context_management`/compaction) **(verify
   against the SDK version this repo targets)**.
   - **Action:** For Anthropic-only paths, prefer SDK-native context management and
     derive cache multipliers from response metadata rather than constants. Keep
     the cross-provider heuristic as an explicit fallback.

---

## 4. Observability Unification

Two independent event streams exist where the Agent SDK favors one:

- **`AgentTrace`** (`src/agent/trace/`) — the SDK-shaped surface: a single
  discriminated `AgentEvent` union with one `emit()` + `subscribe()` core
  (`TraceEmitter.ts`). Clean. Plain logs and structured emitters (usage,
  contextState, tool lifecycle, stages, streams) all reduce to `emit()`.
- **`ProgressEventBus`** (`src/eventBus/`) — a separate Node `EventEmitter` with
  ~40 UI-oriented payload types (permissions, stream status, output-file tracking),
  with pre-listener buffering.

**Genuine duplication:** token usage is emitted on *both* — `trace.usage(...)`
*and* `bus.emit('updateStreamUsage', ...)` (in `UsageMonitor`). Stream status and
tool-approval events live only on the bus, with no trace counterpart.

- **Action:** Make `AgentTrace` the single source of truth. Route UI/extension
  concerns through the trace `domain({ key, data })` escape hatch and let the
  progress view subscribe + filter by key, rather than maintaining a parallel bus.
  This collapses observability to one SDK-aligned stream. (Do this *after* the
  facade deletion in §2.1 so there's one obvious trace import path.)

---

## 5. Proposed Subagent Split Points

TeXRA **already has** a working subagent mechanism: delegation tools
(`delegate_workflow`, `delegate_agent`, `resume_agent`, `propose_workflow`,
`propose_agent` in `shared/constants/delegationTools.ts`), depth tracking
(`runtime/delegationPolicy.ts`), parent-linked spawns via the execution registry,
and multi-agent presets (Physicist / Mathematician / CS-ML / Lean). The agents
themselves are config-driven (5 workflow + 10 tool-use YAMLs over 2 flows) — so
new subagents are a YAML + tool-list concern, not new code.

The **architectural gap** is that delegation is a *tool call inside the LLM loop*,
not a first-class SDK primitive with typed input/output and constraints.

Split candidates, by SDK fit:

| Candidate | Today | SDK fit | Why |
|-----------|-------|---------|-----|
| `polish`, `merge`, `correct` | Workflow YAMLs on reflection flow | ★★★★★ | Single-turn, deterministic, no tools — clean prompt-in/structured-out actors |
| `latexDiff` | Tool-use YAML | ★★★★☆ | Already structured for orchestrator calls; clear I/O contract |
| `review` | Tool-use YAML | ★★★☆☆ | Critique loop; tools mostly read context — could be a near-stateless reviewer |
| `orchestrator` | Tool-use + delegation tools | ★★★★☆ | Natural fit for an SDK orchestrator primitive (pure dispatch, no domain tools) |
| Helper/polish models | `runtime/helperModel.ts`, `polishModel.ts` | ★★★☆☆ | Already isolated single-shot model kits; thin to formalize |

**Not good split points** (keep inline): `chat`, `research`, `numerics`, `creator`,
`latexFixer`, `lean` — open-ended, user-interaction- or environment-coupled
(persistent Lean state, file-system feedback loops).

> Correction to a common framing: polish/merge/correct are **not** "buried inside"
> the reflection flow — they are already independent agent definitions that *share*
> one flow implementation. The work is exposing each as an SDK actor with a typed
> contract, not extracting code from a monolith.

**Recommended primitive:** introduce
`delegateTo(subagent, input, { maxDepth, tools })` over the existing
delegation/registry plumbing, so subagent invocation is typed and testable
independent of whether the parent model happened to emit a tool call.

---

## 6. Suggested Sequencing

1. **Tidy (½ day):** delete logger facades (§2.1), fix reversed trace doc comments,
   inline `createExecutionRunContext` (§2.2), expand `@agent/core` barrel (§3.2).
2. **Consolidate (1–2 days):** relocate `modelHandlerValidation` (§2.6), extract
   shared OpenAI stream-finalize (§3.3), capability-drive message normalization
   (§3.4), add `@agent/runtime` facade (§3.1).
3. **Structural (scoped):** unify observability onto `AgentTrace` domain events
   (§4); migrate `bridgeState` into `RunContext` (§2.3).
4. **SDK-native (largest, verify first):** Anthropic context-management/cache via
   SDK natives (§3.5); formalize `delegateTo` subagent primitive (§5).

Each step is independently shippable and reversible; none requires a rewrite.
