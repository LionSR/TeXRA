# Agent SDK Readiness Audit

_Audit date: 2026-05-28 · Scope: `src/agent/**`, `src/logger/**`, `src/eventBus/**`, plus extension/CLI entrypoints._

This is a **review + refactoring plan**, not an applied refactor. It identifies the
texra agent core, model handlers, logger, and surface areas; flags abstractions
that don't earn their keep; proposes surface simplifications; and marks subagent
split points that map onto Claude Agent SDK patterns.

All `file:line` references and counts below were verified directly against the tree
at audit time. Claims about Anthropic/Agent SDK _native_ features are marked
**(verify)** where they depend on SDK versions not pinned in this repo.

---

## 0. TL;DR

TeXRA is **already well-architected** and largely SDK-aligned: a single core run
path behind a deliberate two-tier API (`validateExecutionRequest` → `runAgent`,
with `runAgentStream` as the lower-level streaming engine — see §1/§9), a
PocketFlow-based agent loop with durable resume, a single discriminated
trace-event stream (`AgentTrace`), and
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
5. Delegation is a _tool call_, not a first-class primitive; subagent boundaries
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

| Area            | Location                                               | Size                | Role                                              |
| --------------- | ------------------------------------------------------ | ------------------- | ------------------------------------------------- |
| Agent core      | `src/agent/core/` (incl. `core/flows`)                 | ~3.5k LOC, 21 files | Config, state, cycle flows, services              |
| Implementations | `src/agent/implementations/flows/{reflection,tooluse}` | ~2.5k LOC, 19 files | The two real agent loops                          |
| Runtime         | `src/agent/runtime/`                                   | ~4.3k LOC, 30 files | Entrypoints, context, coordinators, model factory |
| Model handlers  | `src/agent/modelHandlers/`                             | ~16k LOC, 35 files  | Per-provider API adapters                         |
| Logger          | `src/logger/` + `src/agent/trace/`                     | ~1.5k LOC, 14 files | Trace event stream + host sinks                   |
| Event bus       | `src/eventBus/`                                        | ~0.3k LOC           | Progress/UI events                                |

**The run call path (verified — entry renamed since 2026-05-30, see §9):**

```
executeCommand.ts:42 (ext)        AgentConfigSchema.parse → runAgent (runAgent.ts:32) ─┐
agentsRun.ts + multiAgent.ts(cli) AgentConfigSchema.parse → executeCliRequest → runAgent┤
                                                                                         │
                              runAgent ──→ executeAgent (executeAgent.ts)                │
                                  → buildAgentLaunchContext (AgentLaunchContext.ts) ──────┘
                                  → withExecutionRunContext (AsyncLocalStorage)
                                  → branch on agentCategory:
                                      toolUse  → runToolUseFlow   → PersistedFlow.run
                                      workflow → runReflectionFlow → RoundPersistedFlow.run
```

Both hosts validate via `AgentConfigSchema.parse` and converge on one core
function (`runAgent` → `executeAgent`) — a genuine strength. Note: the named
extension/CLI hosts call `runAgent` directly; the sibling `validateExecutionRequest`
(`executionRequests.ts:24`) is the **`@texra/core` public-surface validator**
used by the webview/desktop handlers (`ProgressViewMessageHandler`,
`MainViewExecutionController`, `desktopAgentExecution`) and recommended for
external embedders, not the literal path these two hosts take. The curated
`@texra/core` barrel re-exports both (`validateExecutionRequest` + `runAgent`,
plus the lower-level `runAgentStream`) as the single public surface — see §9.

---

## 2. Abstractions to Remove / Flatten

Ordered by value-to-effort. Each cites the repo's own anti-pattern rules in
CLAUDE.md ("Flattening Abstraction Layers", "Discouraged Factory Patterns").

### 2.1 Deprecated logger facades — **delete** (low effort, high tidiness)

`src/logger/TexraTrace.ts`, `TexraTraceEmitter.ts`, `noopTexraTrace.ts` are
re-export/alias shims. **No production code imports them** — the only references
to `TexraTrace` (11 files) live inside `trace/` and `logger/` themselves, and the
doc comments are **stale and reversed**: `trace/AgentTrace.ts:10`, `trace/TraceEmitter.ts:6`,
and `trace/noopTrace.ts:4` all point readers _back_ to the deprecated facades as if
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
Per CLAUDE.md's flatten rule, the _pure result-mapping + lifecycle_ portions are
candidates to fold into the flow runners. **However**, unlike the already-deleted
`ResponseCycle.ts`/`ToolUseCycle.ts` wrappers (see CLAUDE.md history), these still
do real work (tool resolution, delegation config, round looping, lifecycle).

- **Action (conservative):** Don't delete. Extract only the trivial result→
  `AgentFlowResult` mapping and the service-assembly bookkeeping into named
  helpers so the _loop_ reads cleanly. Leave the orchestration in place.

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
     genuinely-public subset (`runAgent`/`validateExecutionRequest`, `executeAgent`,
     `resumeToolUseFromSnapshot`, `AgentRuntimeHost` — the API renamed since this
     pass, see §9). Keep internals importable but make the intended surface obvious.

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

4. **Repeated `getMessageNormalizationOptions()` overrides.** 5 OpenAI-compatible
   handlers (DeepSeek, Kimi, MiniMax, GLM, DashScope) each re-declare nearly
   identical normalization. These are otherwise _good_ thin wrappers (19–137 LOC).
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

**Genuine duplication:** token usage is emitted on _both_ — `trace.usage(...)`
_and_ `bus.emit('updateStreamUsage', ...)` (in `UsageMonitor`). Stream status and
tool-approval events live only on the bus, with no trace counterpart.

- **Action:** Make `AgentTrace` the single source of truth. Route UI/extension
  concerns through the trace `domain({ key, data })` escape hatch and let the
  progress view subscribe + filter by key, rather than maintaining a parallel bus.
  This collapses observability to one SDK-aligned stream. (Do this _after_ the
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

The **architectural gap** is that delegation is a _tool call inside the LLM loop_,
not a first-class SDK primitive with typed input/output and constraints.

Split candidates, by SDK fit:

| Candidate                    | Today                                      | SDK fit | Why                                                                            |
| ---------------------------- | ------------------------------------------ | ------- | ------------------------------------------------------------------------------ |
| `polish`, `merge`, `correct` | Workflow YAMLs on reflection flow          | ★★★★★   | Single-turn, deterministic, no tools — clean prompt-in/structured-out actors   |
| `latexDiff`                  | Tool-use YAML                              | ★★★★☆   | Already structured for orchestrator calls; clear I/O contract                  |
| `review`                     | Tool-use YAML                              | ★★★☆☆   | Critique loop; tools mostly read context — could be a near-stateless reviewer  |
| `orchestrator`               | Tool-use + delegation tools                | ★★★★☆   | Natural fit for an SDK orchestrator primitive (pure dispatch, no domain tools) |
| Helper/polish models         | `runtime/helperModel.ts`, `polishModel.ts` | ★★★☆☆   | Already isolated single-shot model kits; thin to formalize                     |

**Not good split points** (keep inline): `chat`, `research`, `numerics`, `creator`,
`latexFixer`, `lean` — open-ended, user-interaction- or environment-coupled
(persistent Lean state, file-system feedback loops).

> Correction to a common framing: polish/merge/correct are **not** "buried inside"
> the reflection flow — they are already independent agent definitions that _share_
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

---

## 7. Re-verification addendum — 2026-05-29

A second independent pass re-audited the same surfaces against the current tree.
The 2026-05-28 findings hold. Status of the plan and two corrections:

**Applied & merged (PR #4579, commit `a2cef9f`) — verified in tree:**

- §2.1 — the three `logger/*Trace*` facades are gone; `runTrace` points at `@agent/trace`.
- §2.2 — `createExecutionRunContext` is inlined (no longer exists).
- §3.4 — `getMessageNormalizationOptions` overrides collapsed; only the base
  `modelHandlerOpenAI.ts` retains it.
- §3.2 (partial) — `@agent/core` now re-exports `AgentConfigSchema` and
  `AgentWorkflowSetting`.

**Applied 2026-05-29 — §2.3 (scoped correction):**

Both the original §2.3 and the first addendum overstated this: the `bridgeState`
maps are **load-bearing**, not dead weight. The resolve-side functions
(`resolvePlanApproval`, `resolveProposal`, `triggerRetry`, `cancelRetry`) are
called from the host/UI layer (extension `ProgressViewMessageHandler`, CLI
`approvalAdapter`, desktop `desktopAgentExecution`) — async contexts with no
access to the run's `AsyncLocalStorage`. `bridgeState` is exactly the lookup that
maps `approvalId`/`streamId` → that run's coordinators across contexts, so it must
stay. `RunContext.coordinators` therefore cannot be made non-optional or the bridge
deleted.

What _was_ vestigial: the `legacyCoordinators` singleton **fallback** on the resolve
side. Every `waitForX` registers the per-run coordinators in `bridgeState`, and the
module singletons were referenced nowhere else, so the fallback never held pending
state — it always no-op'd. It also contradicted the suite's documented intent
(`runCoordinators.vitest.ts`: "does not fall back to default coordinators when a run
has none"). Removed the `legacyCoordinators` object and the three now-dead exported
singletons (`planApprovalCoordinator`/`proposalCoordinator`/`retryCoordinator`);
resolve-side misses now no-op via optional chaining. Verified: `test:kernel`
runtime suite (13 tests) + root/test-kernel typecheck + eslint all green.

**Still pending (verified present):**

- §2.6 — `modelHandlerValidation.ts` still sits in the dispatch dir.
- §3.1 — no `@agent/runtime` facade barrel yet (`src/agent/runtime/index.ts` absent).
- §4 — token usage is still double-emitted in `UsageMonitor.ts:173` (`emit('updateStreamUsage')`)
  and `:179` (`logger.usage`).

**New finding (not in the 2026-05-28 audit) — provider identity vs. capability:**

`ModelHandler.ts:399-426` exposes `isAnthropic`/`isOpenai`/`isGoogle`/`isDeepSeek`/
`isKimi`/`isMiniMax` getters that leak provider identity to callers. These are
consumed in ~6 sites (verified): behavioral gates in `ToolUseCycleFlow.ts:809-812`
and `ModelFactory.ts:72`, plus display/template flags in `AgentLaunchContext.ts:256-257`
and `userVars.ts:168-169`. For SDK alignment (capability-driven, not identity-driven
dispatch), convert the two _behavioral_ gates to named `capabilities.*` flags; the
display flags can keep an explicit allow-list. Complements §3.4. Low risk, ~1 day.

**Correction to retract:** an interim pass flagged `redactSecrets`
(`logger/redaction.ts`) as a dead export. **It is not dead** — it is used by
`packages/desktop/src/main/desktopAppLog.ts` (4 call sites) via the `@logger/redaction`
deep import, which is exactly why the `logger/index.ts` re-export exists. Methodology
note: audits of `src/` must also grep `packages/**` (desktop, cli, extension) before
declaring a symbol unused.

---

## 8. Re-verification addendum — 2026-05-30

A third independent pass (agent core, model handlers, logger, and platform/surface)
re-audited the same surfaces against the current tree. **The 2026-05-28/29 findings
hold without change.** TeXRA remains well-architected and SDK-aligned; no structural
gaps surfaced. The applied items (§2.1, §2.2, §3.4, §3.2-partial, §7 `legacyCoordinators`)
remain in place. Verification of the still-open items and two methodology corrections:

**Applied in this PR — §7 behavioral gates → capability flags (behavior-preserving):**

The two _behavioral_ provider-identity gates are now capability-driven, matching the
existing handler-level boolean pattern (`canProcessToolResultAttachments`,
`supportsManualCompaction`). Two readonly getters were added to `IModelHandler` /
base `ModelHandler`:

- `requiresBatchedParallelToolResults` — replaces the
  `isGoogle || isDeepSeek || isKimi || isMiniMax` gate at `ToolUseCycleFlow.ts`
  (was `:809-812`). Overridden `=> true` in the Google, DeepSeek, Kimi, and MiniMax
  handlers; base returns `false`.
- `supportsReasoningLevelOverride` — replaces
  `supportsReasoningEffort || (isDeepSeek && supportsReasoning)` at `ModelFactory.ts:71-72`.
  Base returns `capabilities.supportsReasoningEffort`; DeepSeek overrides to also honor
  `supportsReasoning`.

Both are exact equivalents of the prior expressions (verified by case analysis over
all providers). The flow/factory **call sites** (`ToolUseCycleFlow`, `ModelFactory`)
no longer read provider identity — it is now consulted only _inside_ the handler
hierarchy. Direct provider handlers encode their need via the overrides above; the
`ModelHandlerOpenRouterNative` handler, which proxies many providers behind one class
(`config.provider` is preserved through routing), still maps `isGoogle`/`isDeepSeek`/
`isKimi`/`isMiniMax` → capability internally (see §8 OpenRouter fix below). So the
`isGoogle`/`isDeepSeek`/`isKimi`/`isMiniMax` getters have **no remaining callers
outside the `IModelHandler` hierarchy** _except_ the one display flag on `isGoogle`
(`AgentLaunchContext.ts:264` → `userVars.ts:169`); `isOpenai`/`isAnthropic` keep their
display callers. Verified: root + test-kernel `typecheck` green; ModelFactory routing
and tool-use vitest suites green.

**Pending items re-confirmed present (line numbers refreshed where drifted):**

- **§2.6** — `src/agent/modelHandlers/modelHandlerValidation.ts` still sits in the
  dispatch dir, loaded behind `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL=1`
  (`ModelFactory.ts:21-22`, dispatched at `:195-207`). Still recommended to relocate
  to `test-kernel/` and inject.
- **§3.1** — no `@agent/runtime` facade barrel yet (`src/agent/runtime/index.ts` absent).
  Deep-import leakage into `@agent/runtime/*` from the extension persists.
- **§4** — token usage is still double-emitted in `UsageMonitor.ts` (was `:173`/`:179`):
  now `runtimeHost.emit('updateStreamUsage', …)` at `:155` and `logger.usage(payload, …)`
  at `:164`. The single-source-of-truth consolidation onto `AgentTrace` is still open.
- **§5** — no first-class `delegateTo(...)` primitive yet (`grep delegateTo src/**` empty);
  delegation remains a tool call inside the LLM loop. Subagent mechanism otherwise intact.
- **§7** — **the two behavioral gates are now converted** (see "Applied in this PR"
  above). The provider-identity getters remain on `ModelHandler.ts` as an allow-list
  the audit explicitly endorsed keeping. Post-refactor they are consumed only by
  display flags (`isOpenai`/`isAnthropic`/`isGoogle`) and _internally_ by
  `ModelHandlerOpenRouterNative` (which maps `isGoogle`/`isDeepSeek`/`isKimi`/
  `isMiniMax` → capability for the providers it proxies). No call site outside the
  `IModelHandler` hierarchy dispatches on identity any longer.

**Two false positives caught this pass (recorded so they are not re-flagged):**

- The cycle-flow factories `createResponseCycleFlow` / `createToolUseCycleFlow`
  (`core/flows/{ResponseCycleFlow,ToolUseCycleFlow}.ts`) are each called from exactly
  one node `exec()` — `ResponseCycleNode.ts:91` and `ToolUseCycleNode.ts:73`. That is
  the **prescribed** `Node.exec() → createFlow() → flow.run()` pattern in CLAUDE.md
  ("Flattening Abstraction Layers"), the same shape the deleted `ResponseCycle.ts`/
  `ToolUseCycle.ts` wrappers were refactored _into_. **Not** a wrapper to inline.
- `src/utils/config/configUtils.ts` (107 LOC, 5 exports, ~70 callers) reads like a
  thin façade over `platform().config` but carries real logic: `tryPlatform()`
  null-safety at import-time facades plus the multi-namespace path resolution
  (`path` → `texra.path` → explicit prefix). It is justified DRY, **not** removable
  over-abstraction.

**Surface/packaging note (SUPERSEDED — now resolved, see §9/§10):** _[The state
described below is as of 2026-05-30 and is retained as a dated record; the §8
recommendation was resolved by Step 6 / PR #4781 — §9 and §10 carry the current
status.]_ `packages/core`
was still a stub — `packages/core/src/index.ts` exported only `corePackageReady = true`,
and consumers reached core via path aliases (`@agent`, `@platform`, `@logger`, `@shared`)
rather than `@texra/core`. This was harmless but meant there was no single
versioned public surface to point an external SDK consumer at; the recommendation was to
populate it as a barrel of the genuinely-public types or drop it. **§9/§10 record that
this has since been done** — `packages/core/src/index.ts` is now a curated `@texra/core`
barrel; treat §9/§10 as the current status for this item.

**Scope note:** "Agent SDK readiness" here means aligning TeXRA's _own_ hand-rolled
loop with Agent-SDK-shaped patterns. `@anthropic-ai/claude-agent-sdk` is depended on
only as a **tool** (`src/tools/claudeAgent.ts` spins off Claude Code), not as the core
engine — and it cannot replace the multi-provider model-handler layer, since that layer
serves OpenAI/Google/OpenRouter/etc. that the Anthropic SDK does not abstract. The
handler-layer cleanups (§3.3–§3.5, §7) are internal de-duplication wins, not "delete
and adopt the SDK" swaps; treat any framing that says otherwise as over-optimistic.

---

## 9. Re-verification addendum — 2026-05-31

A fourth independent pass (four parallel audits: agent core/runtime, model handlers,
logger/trace/eventBus, and the platform/packaging surface + subagent boundaries) re-ran
against current `main`. **All 2026-05-28/29/30 findings hold without change.** TeXRA
remains well-architected and SDK-aligned; the four passes surfaced **no new structural
over-abstraction** — they independently re-confirmed the prior conclusions.

**Landed since the 2026-05-30 pass — Step 6 (run-entry naming/curation, behavior-neutral):**

The proposal's refined Step 6 (`docs/proposals/agent-sdk-readiness.md` §6) is **now in
tree** (commit `da131dc`, PR #4781):

- `runtime/runExecutionRequest.ts` → **`runtime/runAgent.ts`**; `runValidatedExecutionRequest`
  → **`runAgent`**, `RunExecutionRequestOptions` → `RunAgentOptions` (body byte-identical,
  verified — the "START HERE" doc comment is present at `runAgent.ts`).
- `@texra/core` is **no longer the `corePackageReady` stub** flagged through §8: it is a
  curated 8-section surface (`packages/core/src/index.ts`, 115 LOC) exporting the platform
  composition root, `AgentConfig`/`AgentCategory`, execution-request validation, `runAgent`
  - `runAgentStream` (the `executeAgent` alias), `AgentRuntimeHost`, the `AgentTrace` channel,
    the agent registry, and execution storage. `ExecutionId`/`ExecuteAgentOptions`/
    `WorkflowFlowResult` are exported; `getAgentPath` is dropped from the surface — exactly the
    Step 6 spec. This resolves the §8 "no single versioned public surface" packaging note.

**Independently re-confirmed by the four parallel passes (no action — recorded so they
are not re-flagged):**

- **Agent core/runtime is clean.** The coordinator hierarchy (`BasePromiseCoordinator` +
  `AgentProposalCoordinator`/`RetryRequestCoordinator`/`PlanApprovalCoordinator`) is genuinely
  distinct shared logic, not redundant wrappers; `runFlowWithLifecycle` and
  `buildAgentLaunchContext`'s two-layer assembly are load-bearing (saga-style compensation,
  error classification, disposal), not the "wrapper to inline" anti-pattern; PocketFlow nodes
  create+run flows directly (`ResponseCycleNode.exec` → `createResponseCycleFlow().run`,
  `runToolUseFlow` inline node graph). Zero core abstractions recommended for removal.
- **`runCoordinators.bridgeState` is load-bearing** (re-confirmed, consistent with §7/Step 7c):
  the resolve-side UI callers run outside the run's `AsyncLocalStorage` and key by
  `approvalId`/`proposalId`/`streamId`. Relocate onto a per-run handle (Step 7); never delete.
- **Logger/trace/eventBus are lean and SDK-ready.** `@logger` is decoupled from `platform()`
  by design (hosts wire `logUtils.setOutputChannelFactory` directly); `createChannelTrace`
  stays host-neutral while `createRunTrace` carries the transcript recorder (the Step 2
  layering split holds); `redaction.ts` is centralized; `ProgressEventBus` is a clean
  buffered pub/sub. The three deprecated logger facades (original §2.1) remain gone.
- **Model-handler factory + shared utilities are correctly factored.** `PROVIDER_HANDLERS`
  is exhaustive over `ModelProvider`; `toolConversion`, `UsageNormalizer`,
  `MediaAttachmentProcessor`, `sdkErrorAdapters`, `BaseReasoningStreamAggregator` are genuinely
  shared. The §3.4 normalization collapse holds (only base `modelHandlerOpenAI` retains
  `getMessageNormalizationOptions`).
- **Subagent boundaries unchanged.** The §5 / proposal split candidates remain accurate:
  config-driven YAML agents over two flows + the `delegate_*` tools are the existing subagent
  mechanism; `executeAgent`'s `agentCategory` dispatch is the cleanest internal seam.

**Still-open items re-confirmed present (line numbers refreshed against current `main`):**

- **§2.6** — `src/agent/modelHandlers/modelHandlerValidation.ts` still sits in the dispatch
  dir, gated behind `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL=1`. Still recommended to
  relocate to `test-kernel/` and inject.
- **§4** — token usage is still double-emitted in `UsageMonitor.ts`: `runtimeHost.emit('updateStreamUsage', …)`
  at `:155` and `logger.usage(payload, …)` at `:164`. Single-source-of-truth consolidation
  onto `AgentTrace` remains open.
- **§5 / proposal Step 7** — no first-class `delegateTo(...)` primitive (`grep delegateTo`
  empty); delegation remains a tool call. The three module-global registries
  (`executionRegistry` — module Maps; `runCoordinators.bridgeState` — 8 Maps; the tool-use
  interrupt registry still named `ToolUseAgentRegistry`, not the proposed `SessionInterruptRegistry`)
  are **unchanged**: Step 7a–7d has not landed. These are the gating blocker for concurrent
  in-process sessions; relocate-onto-a-handle (never delete) is still the prescription.

**Two genuinely new minor findings (low/medium, recorded for the backlog — not blockers):**

1. **Redaction is host-side-optional, not enforced at emit (low–medium, security hygiene).**
   `redactSecrets()` (`logger/redaction.ts`) is applied only by hosts that opt in (desktop
   app log, CLI log sinks); the trace/logger core does **not** redact on `logAt()`. A new SDK
   consumer that forgets to wire it can leak secrets into logs. Additionally the three regex
   patterns are module constants with no extension hook. **Suggested:** document the host
   redaction responsibility in `logUtils` TSDoc, and (optionally) expose the pattern set as a
   configurable hook for SDK consumers. Deliberately not auto-redacting at emit is defensible
   (cost/flexibility) — the fix is a documented contract, not forced redaction.

2. **Thin OpenAI-compatible handler proliferation (low, judgment call — leans _keep_).**
   `modelHandlerDashScope` (14 LOC), `modelHandlerXAI` (38), `modelHandlerGLM` (45),
   plus the slightly larger `Kimi`/`MiniMax`/`DeepSeek` (≈130 each) are mostly capability/config
   deltas over `modelHandlerOpenAI`. A config-driven collapse is _conceivable_ (~250 LOC), **but
   this is in direct tension with the §3.4 decision to keep them as "good thin wrappers"**: each
   maps 1:1 to a `ModelProvider` enum arm in the exhaustive `PROVIDER_HANDLERS` record, several
   carry genuine deltas (Kimi's token-count API, MiniMax's `reasoning_details`, DeepSeek's
   content-format + effort validation), and the prior OpenRouter merge of the same flavor was
   _deliberately reverted_ (proposal "Rejected findings"). **Verdict: do not pursue as a quick
   win** — the registry still needs a class per provider, so the collapse trades small LOC for a
   less-obvious dispatch table. Recorded only so it is not re-discovered as "new."

**False positives re-confirmed (do not re-flag):** the cycle-flow factories
(`createResponseCycleFlow`/`createToolUseCycleFlow`) are the prescribed `Node.exec()→createFlow()→run()`
shape (§8); `configUtils.ts` is justified DRY (§8); `IModelHandler` is **not** a redundant duplicate
of `ModelHandler` (proposal "Rejected findings"); the two run entries (`runAgent` vs `runAgentStream`)
serve different consumer classes and must not be merged (proposal "Rejected findings").

**Net for 2026-05-31:** the structural surface is done (Steps 1–6 landed). What remains is the
**multi-session-isolation work** (Step 7a–7d: relocate the three module-global registries onto a
per-run/session handle) and three small, independently-shippable tidies (§2.6 relocate,
§4 usage de-dup, redaction-contract doc). No rewrite warranted; the codebase has the structure it
would have had if designed with these hosts in mind.

---

## 10. Re-verification addendum — 2026-06-01

A fifth independent pass (agent core/runtime, model handlers, logger/trace, and
platform/surface, fanned out across four parallel explorers) re-audited the same
surfaces against the current tree. **The 2026-05-28/29/30/31 findings hold; no new
structural gaps surfaced.** TeXRA remains well-architected and SDK-aligned. The
notable change since 2026-05-30 is that the top open surface item has been
**resolved**, plus one entrypoint rename that dated the §1 diagram.

**Resolved since last pass — §8 `packages/core` surface (was a stub, now a real barrel):**

`packages/core/src/index.ts` is no longer `corePackageReady = true`. It is now a
curated **`@texra/core` barrel** (~115 lines, 8 labeled sections:
platform composition root → config/identity → request building → running an agent
→ host port → `AgentTrace` telemetry → agent registry → execution storage). It is
the single host-neutral public surface §8 asked for — the package typechecks with
only `@types/node`, so any `vscode` leak into the surface fails the build. This
**closes the §8 recommendation** ("either populate it as a barrel … or drop it");
the team populated it. Deep `@agent/*` imports still work and are adopted
incrementally, as the module's own docstring states.

**Entrypoint rename (dates the §1 diagram, now corrected above):**

The canonical run entry the prior passes called `runValidatedExecutionRequest`
(`runExecutionRequest.ts:18`) has been split/renamed into the two-tier API the
`@texra/core` barrel now exposes: `validateExecutionRequest`
(`core/execution/executionRequests.ts:24`) → `runAgent` (`runtime/runAgent.ts:32`),
with the lower-level streaming engine `executeAgent` re-exported as `runAgentStream`.
This is the deliberate, _documented_ high-level/low-level split (`runAgent.ts:19-31`),
not accidental duplication — `runAgent` adds only id-gen + `registerExecution` +
the workflow-output callback over `executeAgent`. §1 updated to match.

**Pending items re-confirmed present (paths refreshed where drifted):**

- **§2.6** — `src/agent/modelHandlers/modelHandlerValidation.ts` still sits in the
  dispatch dir. Still recommended to relocate to `test-kernel/` and inject.
- **§3.1** — no `@agent/runtime/index.ts` facade barrel yet. _Reduced priority:_ the
  new `@texra/core` barrel now provides the package-level shielded surface that §3.1's
  underlying concern (no obvious public runtime subset) was really about; a separate
  per-directory runtime barrel is now optional polish, not a gap.
- **§4** — token usage is **still double-emitted**. `UsageMonitor` relocated from
  `core/usage/` to `src/agent/utils/UsageMonitor.ts`; the two emissions are now
  `runtimeHost.emit('updateStreamUsage', …)` at `:155` and `logger.usage(payload, …)`
  at `:164`. The single-source-of-truth consolidation onto `AgentTrace` remains open.
- **§5** — no first-class `delegateTo(...)` primitive (`grep delegateTo src/** packages/**`
  empty); delegation remains a tool call inside the LLM loop. Subagent mechanism otherwise
  intact (delegation tools, depth tracking, parent-linked spawns, multi-agent presets).
- **§7** — holds. The provider-identity getters (`ModelHandler.ts:406-431`) survive only
  as the explicitly-endorsed display allow-list: their sole callers outside the handler
  hierarchy are the template flags at `AgentLaunchContext.ts:263-265` → `userVars.ts:167-169`
  (`IS_OPENAI/ANTHROPIC/GOOGLE_MODEL`). No behavioral dispatch on identity remains.

**Cross-cutting confirmation (model handlers, logger/trace):** Both layers re-audited
clean this pass and need no change. The model-handler factory (`ModelFactory.ts`) is a
single-purpose three-path router (Responses-API / OpenRouter / direct), usage is
normalized once through `support/UsageNormalizer`, and tool conversion shares one schema
normalizer across providers. The logger stays SDK/product-free (`logger/index.ts` is a
3-line re-export; `createChannelTrace`/`attachChannelSubscriber` are justified DRY
composition, not indirection), with `AgentTrace` as the single per-run event channel and
`ProgressEventBus` orthogonal — the only genuine overlap is the §4 usage double-emit.

**Net:** the audit's "incremental, not structural" thesis (§0) is reaffirmed, and the
ledger shrinks — §8 resolved, §3.1 downgraded to optional. Remaining open work is §2.6
(relocate), §4 (one consumer rewire), and §5 (formalize the subagent primitive).
