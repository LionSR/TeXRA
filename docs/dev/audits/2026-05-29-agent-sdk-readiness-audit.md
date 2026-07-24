# Agent SDK Readiness Audit

> **Packaging note (2026-07-05):** #7099 later demotes/deletes the unused
> `@texra/core` package. Mentions below are historical audit observations, not
> current workspace layout.

_Audit date: 2026-05-28 · Re-verified through 2026-07-04 (§26) · Scope: `src/agent/**`, `src/logger/**`, `src/eventBus/**`, `src/platform/**`, `packages/core/src/**`, plus extension/CLI entrypoints._

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
   from `@agent/runtime/*`, `@agent/implementations/*`, `@agent/followUp/*`,
   `@agent/storage/*` (e.g. `StreamStatusService`, `ToolUseFollowUpQueue`,
   `executionLifecycle`). Acceptable for internal command handlers, but there's no
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
`propose_agent` in `shared/constants/delegationTools.ts`), persisted child lineage
(`storage/executionLifecycle.ts`), parent-linked spawns via the execution registry,
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
resolve-side misses now no-op via optional chaining. Verified: `test`
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

The proposal's refined Step 6 (`docs/proposals/2026-05-30-agent-sdk-readiness.md` §6) is **now in
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
structural gaps surfaced.** TeXRA remains well-architected and SDK-aligned. As
already documented in §9 (2026-05-31), the top open surface item (the §8
`packages/core` packaging note) was resolved and the run entrypoint was renamed
between the 2026-05-30 and 2026-05-31 passes; this fifth pass re-confirms both
remain in place as of 2026-06-01 (and is what dated the original §1 diagram, now
corrected).

**§8 `packages/core` surface — resolved (landed by §9's pass, re-confirmed here; was a stub, now a real barrel):**

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

---

## 11. Re-verification addendum — 2026-06-02

A sixth independent pass (three parallel maps — agent core/runtime, model handlers, and
logger/platform/public surface — plus a direct line-by-line re-check of every open item)
re-audited the same surfaces against `main` at HEAD `10f8b81`. **All
2026-05-28/29/30/31 and 2026-06-01 findings hold without change. No new structural
over-abstraction surfaced, and no new barrels or run-entry wrappers were added since the
fifth pass.** TeXRA remains well-architected and SDK-aligned; this pass is a confirmation,
not a re-scoping.

**New since the 2026-06-01 pass — audited clean (not a regression):**

- **`agentToolResolution` (`runtime/agentToolResolution.ts`, 163 LOC; PR #4703).** Tool
  resolution was **extracted** out of the tool-use flow into one documented, single-
  responsibility module (`resolveAgentTools` + one private helper), called from
  `runToolUseFlow.ts` and covered by `ToolUseToolResolution.vitest.ts`. This is a textbook
  CLAUDE.md "single source of truth" extraction — it _reduces_ inline branching in the
  flow, it does **not** add an indirection layer. No action.
- The only other commits touching the audited tree since 2026-06-01 are localized fixes
  (`fsEntryType` relocation #5007, prompt-file var sync, CLI workflow-approval filtering)
  — none introduces a wrapper, barrel, or surface change. Verified: `git log --since` over
  `src/agent`, `src/logger`, `packages/core` shows no new `index.ts` barrel added.

**Open items re-confirmed present (line numbers refreshed against HEAD `10f8b81`):**

- **§2.6** — `src/agent/modelHandlers/modelHandlerValidation.ts` still sits in the
  production handler directory (`src/agent/modelHandlers/`, alongside the real provider
  handlers rather than in `test-kernel/`), gated by
  `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL` and dispatched from `ModelFactory.ts`
  (`:22` reads the env flag, `:211` dynamically imports the handler). _Methodology note for the eventual fix:_ it is **CLI** validation
  machinery (the env var is `TEXRA_CLI_*`), not vitest-only — relocating it must keep it in
  the CLI bundle, so "move to `test-kernel/`" needs an injection seam the CLI can reach, not
  a straight move. Still recommended; still low priority.
- **§4** — token usage is still double-emitted in `src/agent/utils/UsageMonitor.ts`:
  `runtimeHost.emit('updateStreamUsage', …)` at `:155` and `logger.usage(payload, …)` at
  `:164`. The single-source-of-truth consolidation onto `AgentTrace` remains open (a
  progress-view consumer rewire, not a deletion).
- **§5 / proposal Step 7** — no first-class `delegateTo(...)` primitive (`grep delegateTo
src/** packages/**` empty); delegation remains a tool call inside the LLM loop. The three
  module-global registries are **unchanged**: `runCoordinators.bridgeState` (`:27`),
  `executionRegistry` module Maps (`:32`–`:36`), and the interrupt registry still named
  `ToolUseAgentRegistry` (the proposal's `SessionInterruptRegistry` rename, Step 7a, has not
  landed). These remain the gating blocker for concurrent in-process sessions; the
  prescription is unchanged — **relocate onto a per-run/session handle, never delete** (the
  resolve-side UI callers run outside the run's `AsyncLocalStorage`).
- **§3.1** — still no `@agent/runtime/index.ts` barrel; still optional polish (the
  `@texra/core` barrel already provides the package-level shielded surface §3.1 was about).
- **§9 finding #1 (redaction contract)** — unchanged. `redactSecrets()`
  (`logger/redaction.ts`) is still applied only by hosts that opt in (desktop/CLI sinks);
  the trace/logger core does not redact at `logAt()`, and the three regex patterns are
  module constants with no extension hook. The fix remains a documented host-responsibility
  contract in `logUtils` TSDoc (+ optionally a configurable pattern hook) — not forced
  emit-time redaction. One of the three small, independently-shippable tidies in the net
  summary below.
- **§7** — holds. The provider-identity getters survive only as the endorsed display
  allow-list (`ModelHandler.ts:406–431`: `isAnthropic`/`isOpenai`/`isGoogle`/`isDeepSeek`/
  `isKimi`/`isMiniMax`); their sole callers outside the handler hierarchy are the template
  flags in `AgentLaunchContext`/`userVars`. No behavioral dispatch on identity remains.

**Independently re-confirmed clean by the three parallel maps (recorded so they are not
re-flagged):**

- **Agent core/runtime.** The two-tier run entry (`runAgent` → `executeAgent`/`runAgentStream`)
  is the documented high/low split — `runAgent` adds only id-gen + `registerExecution` +
  the `openWorkflowOutput` callback (`runtime/runAgent.ts`); not duplication. PocketFlow nodes
  create+run flows directly. The coordinator hierarchy, `MapToolRegistry`, the noop
  `AgentRuntimeHost`/`RunStorageService`, `InterruptManager`, and the small single-purpose
  helpers (`streamTab`, `followUpResumeDetection`, `priceUtils`) are justified DI seams / DRY
  naming, **not** removable over-abstraction — consistent with the prior passes' false-positive
  ledger.
- **Model handlers.** `IModelHandler` is not a redundant duplicate of `ModelHandler` (the
  optional `createBatchedToolUseFollowUpMessages?` is load-bearing); `PROVIDER_HANDLERS` is
  exhaustive over `ModelProvider`; usage normalizes once through `support/UsageNormalizer`;
  tool conversion shares one schema flattener; the thin OpenAI-compatible subclasses each carry
  genuine deltas and map 1:1 to a `ModelProvider` arm. The `modelHandlerOpenAIResponse.ts`
  god-file and per-provider stream handlers remain a tracked, multi-day design migration —
  **not** a mechanical quick win (re-confirms the proposal's "Rejected findings").
- **Logger / platform / surface.** `@logger` imports nothing from `@platform` (a single
  `writeLine` emission point; host-injected sink factory; pre-init-tolerant). The
  `@platform` composition root (8 vscode-free ports + node defaults + frozen single-call
  init) is the strongest SDK-aligned piece. The `@agent/core/stateStore`/`config` facades and
  `@agent/trace/helpers` sugar are boundary isolation, not indirection. `@texra/core` is the
  curated 8-section host-neutral barrel; deep `@agent/*` imports still work and migrate
  incrementally.

**Subagent split points — unchanged and still accurate** (§5 + proposal "Subagent split
points"): config-driven YAML agents over two flows (reflection/tool-use) + the `delegate_*`
tools are the existing subagent mechanism; the `agentCategory` dispatch in `executeAgent` is
the cleanest internal seam; helper-model tasks remain the lowest-risk tools-as-data extraction.

**Net for 2026-06-02:** the structural surface is done (proposal Steps 1–6 landed); the
codebase has the shape it would have had if designed for these hosts from the start. What
remains is exactly three independently-shippable tidies (§2.6 relocate, §4 usage de-dup,
redaction-contract doc) plus the larger multi-session-isolation work (proposal Step 7a–7d:
relocate the three module-globals onto a per-run handle). **No refactor was applied in this
pass** — every remaining item is either behavior-sensitive (§4, Step 7) or non-trivial
(§2.6 is CLI machinery, not a straight move; §5 is a multi-day primitive), exactly the items
five prior passes deliberately deferred. No rewrite warranted.

---

## 12. Re-verification addendum — 2026-06-03 (+ two tidies applied)

A seventh pass — three parallel fresh-eyes audits (agent core/runtime, model handlers,
logger/public-surface) plus a direct line-by-line re-check of every open item against
`main` at HEAD `08e63af`. **All 2026-05-28 → 06-02 findings hold without change. No new
structural over-abstraction surfaced.** The three independent audits each, on their own,
re-reached the prior verdict: TeXRA is well-architected and SDK-aligned; the gaps are
incremental. Unlike the prior six confirmation-only passes, this one **applied two of the
backlog's safest, behavior-neutral items** (below) so the ledger actually moves.

### Applied this pass (behavior-preserving; `npm run typecheck` + `eslint` green)

- **`@platform` public surface — realized.** CLAUDE.md instructs core code to "reach host
  services through `platform()` from `@platform`", and the alias is configured
  (`tsconfig.json:46` → `"@platform": ["src/platform"]`), but `src/platform/` had **no
  `index.ts`** — so the documented import was a phantom: **0 files import bare `@platform`**;
  all **52** importers reach into `@platform/platform`. Added `src/platform/index.ts`
  re-exporting `initPlatform`/`platform`/`tryPlatform`/`tryGlobalState`/`type Platform`. Purely
  additive (the deep path still works; no consumer migrated) — it makes the documented single
  import surface real, matching what `@texra/core` already re-exports.
- **Redaction host-responsibility contract — documented (§9 finding #1).** Added a TSDoc
  block to `logUtils.ts` stating that the logger does **not** redact at emit time by design and
  that hosts persisting/shipping logs MUST run text through `redactSecrets` in their sink
  (pointing at the `desktopAppLog.ts` / CLI reference wiring), and that SDK consumers wiring a
  custom `setOutputChannelFactory` inherit the same contract. This is exactly the fix four
  prior passes prescribed ("a documented contract, not forced redaction"). No behavior change.

### Genuinely-new findings recorded for the backlog (none are blockers)

- **`IModelHandler` leaks three internal provider booleans (low, surface trim).** _[APPLIED
  2026-06-04 — see §13.]_ The port (`types/IModelHandler.ts`) declared `isDeepSeek`/`isKimi`/
  `isMiniMax`; their **only** reader is `openrouter/modelHandlerOpenRouterNative.ts` (internally,
  `:240/:250`). They were an implementation detail on the public port — now removed from the port
  and made `protected` on the `ModelHandler` base. Complements §7 (the behavioral identity gates
  were already converted; this was the residual port-shape trim).
- **`RunStorageService` is a one-boolean port (low).** `runtime/RunStorageService.ts` (~24 LOC)
  is a full interface + module-global setter/getter + no-op default for a single `isViewVisible()`
  read. **Correction (2026-06-04): it has _two_ readers, not one** — `executeAgent.ts:445` **and**
  `packages/extension/src/frontend/events/agentEventListeners.ts:115` (both the
  `!getRunStorageService().isViewVisible()` fallback-notification guard) — plus two host
  implementations (`desktopAgentExecution.ts:187` hardcodes `() => true`;
  `ProgressViewProvider.ts:512`) and test mocks. Folding `isViewVisible` onto `AgentRuntimeHost`
  therefore touches ~6 sites across both hosts + tests, not a single caller — it is a
  behavior-sensitive host-port change, **not** the "delete 24 LOC" quick win this entry first
  implied. Reassessed to **low value / skip unless reworking the host port**.
- **`createChannelTrace` as a 26-site module-singleton logger (medium, judgment call).** 26
  modules do `const logger = createChannelTrace('X'); logger.info(…)`. For a plain log line that
  routes through the full `TraceEmitter` event/`AsyncLocalStorage`/subscriber path (~6 hops + an
  event allocation) when the functional `logUtils.info('Channel', msg)` API reaches the same sink
  in ~2 hops — these singletons never subscribe, stage, or stream. _Tension:_ prior passes
  endorsed `createChannelTrace` as justified DRY; it is, for **runs**. The narrow win is migrating
  the 26 plain-log call sites to the functional API (mechanical, but a signature change across 26
  files). Recorded, not pursued — judgment call.
- **`@agent/index` barrel mixes discovery API with directory-wiring internals (low–med).** The
  barrel (`index.ts`) re-exports ~15 composition-root symbols (`AgentDirectoryService` + 7 satellite
  interfaces, `BundledAgentDirectorySync`, `GlobalStorageAgentDirectoryStorage`,
  `PathAgentDirectoryBundleSource` + their interfaces) consumed by only 1–2 callers, alongside the
  read-only discover/run API. Splitting the directory-bootstrap into an internal (non-public) module
  would roughly halve the symbols an SDK consumer sees. Surface polish, not a correctness issue.
- **Shared persisted-flow boilerplate across the two runners (low–med, DRY).** `runReflectionFlow`
  and `runToolUseFlow` each repeat the same ~40-line scaffold (`getExecutionStore`,
  interrupt register/unregister, `flowKey` read + migrate, retry/plan-approval clears, the
  `kv.delete(flowKey)` finally). A shared `runPersistedAgentFlow` helper in `flows/common/` could
  hold it. **Not** a wrapper-to-inline (the runners carry real distinct logic) — a DRY extraction,
  consistent with the §2.4 "extract the trivial bookkeeping, leave the orchestration" guidance.

### False-positive ledger (re-confirmed this pass — do not re-flag)

- **`redactSecrets` is NOT dead.** One audit re-flagged it as "possibly unwired" (it greps clean
  from the `@logger` barrel and `writeLine` never calls it). This is the same trap §7 already
  retracted: it is used by `packages/desktop/src/main/desktopAppLog.ts` (4 call sites) and
  referenced by the CLI log sinks. Confirmed present at HEAD. Audits of `src/` must grep
  `packages/**` before declaring a logger symbol unused.
- The thin OpenAI-compatible subclasses (DashScope/XAI/GLM + the heavier Kimi/MiniMax/DeepSeek)
  remain a **lean-keep** (§9 #2): each maps 1:1 to a `ModelProvider` arm in the exhaustive
  `PROVIDER_HANDLERS`; the prior OpenRouter merge of this flavor was deliberately reverted.
- The cycle-flow factories (`createResponseCycleFlow`/`createToolUseCycleFlow`) are the prescribed
  `Node.exec()→createFlow()→run()` shape (§8); `IModelHandler` is **not** a redundant duplicate of
  `ModelHandler` (load-bearing optional `createBatchedToolUseFollowUpMessages?`); the two run
  entries (`runAgent`/`runAgentStream`) serve different consumer classes — all re-confirmed.

### Open items still present at HEAD `08e63af` (verified)

- **§2.6** — `modelHandlerValidation.ts` still in the dispatch dir, gated by
  `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL` (`ModelFactory.ts:22`, dynamic-imported `:211`).
- **§4** — token usage still double-emitted in `src/agent/utils/UsageMonitor.ts`
  (`runtimeHost.emit('updateStreamUsage', …)` `:155` + `logger.usage(payload, …)` `:164`).
- **§5 / proposal Step 7** — no `delegateTo(...)` primitive (`grep` empty); delegation remains a
  tool call. The three module-global registries are unchanged (the gating blocker for concurrent
  in-process sessions — relocate onto a per-run handle, never delete).
- **§3.1** — still no `@agent/runtime/index.ts` barrel; still optional polish (the new
  `src/platform/index.ts` above closes the analogous gap for `@platform`).

**Subagent split points — unchanged and accurate** (§5 + proposal): config-driven YAML agents
over the two flows (reflection/tool-use) + the `delegate_*` tools are the existing subagent
mechanism; the `agentCategory` dispatch in `executeAgent` is the cleanest internal seam; the
helper-model tasks (session-desc / polish / agent-creation) remain the lowest-risk
tools-as-data extraction. The three fresh-eyes audits independently surfaced the same node-level
candidates (`MediaExtractionNode`, `TeXCountNode`, `OutputNode`, the sessionDescription
background call) as cleanly-isolatable units, each gated by the same coupling blocker: they read
the ALS `RunContext` + module-global registries, which Step 7 must thread through context first.

**Net for 2026-06-03:** thesis reaffirmed — incremental, not structural. Two backlog tidies
applied (`@platform` surface, redaction contract); the remaining ledger is §2.6 (relocate),
§4 (one consumer rewire), §5/Step 7 (multi-session isolation), and the five small new items
above. No rewrite warranted.

---

## 13. Re-verification addendum — 2026-06-04 (+ two tidies applied, one ledger correction)

An eighth pass — four parallel fresh-eyes audits (model handlers, agent core/runtime,
logger/trace/eventBus, public surface) plus a direct line-by-line re-check of every open
item against `main` at HEAD `bf32964`. **All 2026-05-28 → 06-03 findings hold without
change. No new structural over-abstraction surfaced.** TeXRA remains well-architected and
SDK-aligned; the gaps are incremental. One additive, behavior-neutral tidy was applied
(below), addressing the single genuinely-new finding this pass.

### Drift since the 2026-06-03 pass (HEAD `08e63af` → `bf32964`) — audited clean

The 30-odd commits between passes are CLI fixes plus **simplification** refactors that move
_with_ the audit, not against it — none adds a wrapper, barrel, or surface:

- `3c959c8` "refactor(latex): simplify LaTeX-processing helpers — inline wrappers, drop dead
  code" (PR #5234) and `e0ef81b` "refactor(cli/tui): simplify TUI subsystem — inline
  single-use helpers, drop dead code" are textbook applications of the repo's own
  flatten/anti-shim rules.
- `c619ca4` "refactor: simplify recently-changed CLI/agent code" net-trimmed
  `modelHandlerAnthropic.ts` (−more than added) and touched `BasePromiseCoordinator`,
  `executeAgent`, `userVars`, follow-up queue — all reductions, no new indirection.
- `git log --since` over `src/agent`, `src/logger`, `src/platform`, `packages/core/src`
  shows **no new `index.ts` barrel and no new run-entry wrapper** added since the fifth pass.

### Applied this pass (behavior-preserving; `npm run typecheck` + `eslint` green)

- **`AgentRuntimeHost` headless contract — documented (new finding #1 below).** Added a TSDoc
  block to the `AgentRuntimeHost` port (`runtime/AgentRuntimeHost.ts`) — the interface an SDK
  embedder implements — stating the two-tier event contract: the **essential streaming
  surface** (stream lifecycle / usage / task state, the `show*`/`resolve*` approval pairs,
  conversation progress) versus the **frontend-bound, ignorable** group (the
  `── Frontend-bound events ──` events in `ProgressEventPayloads`: `requestOpenFile`,
  `requestShowInstruction`, `showAgentConfigBanner`, `requestShowError`,
  `requestEnsureProgressView`, plus the `*SubscriptionsChanged` / `toolAvailabilityChanged`
  UI-refresh signals), which a headless consumer may drop without affecting the run. Points
  at `noopAgentRuntimeHost` as the valid drop-everything host. This is the same
  "document-the-contract, don't force structure" fix shape as §12's redaction contract — no
  behavior change, no event re-routing.
- **`IModelHandler` port-boolean trim — applied (§12 new finding #1).** Removed
  `isDeepSeek`/`isKimi`/`isMiniMax` from the public `IModelHandler` port
  (`types/IModelHandler.ts`) and made the corresponding getters `protected` on the
  `ModelHandler` base (`ModelHandler.ts`). Their sole reader is the
  `ModelHandlerOpenRouterNative` subclass (`:240/:250`), which still reads them via `this.`;
  `isGoogle`/`isOpenai`/`isAnthropic` stay on the port for their external display-flag callers
  (§8/§10). Verified behavior-preserving: `config.provider` is unchanged, OpenRouter's
  `requiresBatchedParallelToolResults`/`supportsReasoningLevelOverride` derivations are
  identical, and no call site outside the handler hierarchy read these (grep clean).
  `typecheck` + `eslint` green.

### Genuinely-new finding recorded for the backlog (not a blocker)

1. **`AgentRuntimeHost.emit()` mixes UI-only events with the essential streaming surface
   (low, surface clarity).** The single `emit` port carries ~40 `ProgressEventPayloads`
   arms spanning two concerns: stream/approval/usage (which an embedder must observe to
   drive a run) and pure host-UI requests (`requestOpenFile`, `requestEnsureProgressView`,
   `showAgentConfigBanner`, …, already grouped under the interface's
   `── Frontend-bound events ──` header). A headless SDK consumer has to know which to
   ignore. **Applied fix:** the headless contract is now documented on the port (above).
   **Optional future polish (not pursued):** split the frontend-bound arms into a separate
   optional `UIRuntimeHost` so the essential surface stands alone in the type. Deferred for
   the same reason as §4 / Step 7 — it is a multi-site host-interface change, behavior-
   sensitive across all three hosts, not a quick win; the documented contract resolves the
   immediate discoverability gap.

### False-positive ledger — two re-surfaced this pass, both re-verified and rebutted

The fresh model-handler audit independently re-flagged the two findings the prior passes
already adjudicated as false positives. Recorded with **fresh line-level verification at
HEAD `bf32964`** so they are not re-litigated a ninth time:

- **"`IModelHandler` is a redundant duplicate of `ModelHandler` — delete the 473-line port."**
  **Refuted, verified.** The port is **not** the same shape as the base class: the optional
  `createBatchedToolUseFollowUpMessages?(...)` is declared on the port
  (`types/IModelHandler.ts:395`, with `?`) and is **not** implemented on the base
  `ModelHandler`. `ToolUseCycleFlow.ts:810-815` **feature-detects** it on the port-typed
  handler (`modelHandler.requiresBatchedParallelToolResults && !!modelHandler.createBatchedToolUseFollowUpMessages`
  then calls it with `!`). Re-typing those call sites to the concrete `ModelHandler` (which
  lacks the method) would fail to compile — the port's optional-method surface is exactly what
  enables provider-agnostic feature detection. (Consistent with §9/§12.) Not redundant.
- **"Collapse the thin OpenAI-compatible subclasses into a provider-config table (~87 LOC)."**
  **Re-confirmed lean-keep** (§9 #2, §12). Each maps 1:1 to a `ModelProvider` arm in the
  exhaustive `PROVIDER_HANDLERS` record, and the prior OpenRouter merge of this flavor was
  deliberately reverted. Even the fresh audit conceded that only DashScope (14 LOC) / XAI (38)
  / GLM (35) are pure-config, while Kimi / MiniMax / DeepSeek (~130 each) carry genuine deltas
  (Kimi's token-count API, MiniMax's `reasoning_details`, DeepSeek's content-format + effort
  validation). The collapse still needs a class per provider for the registry — it trades small
  LOC for a less-obvious dispatch table. Do not pursue.

### Open items still present at HEAD `bf32964` (verified, line numbers refreshed)

- **§2.6** — `modelHandlerValidation.ts` still in the production handler dir, gated by
  `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL` (`ModelFactory.ts`). Relocate-with-injection
  (it is CLI machinery, not vitest-only) still recommended; still low priority.
- **§4** — token usage still double-emitted in `src/agent/utils/UsageMonitor.ts`:
  `runtimeHost.emit('updateStreamUsage', …)` at `:155` and `logger.usage(payload, …)` at
  `:164`. Single-source-of-truth onto `AgentTrace` remains a progress-view consumer rewire.
- **§5 / proposal Step 7** — no `delegateTo(...)` primitive (`grep` over `src/**` +
  `packages/**` empty); delegation remains a tool call. The three module-globals are
  unchanged: `runCoordinators.bridgeState` (`:27`), `executionRegistry` module Maps, and the
  interrupt registry still named `ToolUseAgentRegistry` (Step 7a rename not landed). Still the
  gating blocker for concurrent in-process sessions — relocate onto a per-run handle, never
  delete.
- **§3.1** — still no `@agent/runtime/index.ts` barrel; still optional polish (the `@texra/core`
  - `src/platform/index.ts` surfaces already cover the underlying concern).
- **§12 residual port trim** — **APPLIED this pass.** `isDeepSeek`/`isKimi`/`isMiniMax` removed
  from the `IModelHandler` port and made `protected` on the `ModelHandler` base (see "Applied
  this pass" above). `isGoogle`/`isOpenai`/`isAnthropic` remain on the port (external display
  callers).
- **§12 `RunStorageService`** — **corrected & reassessed (was overstated as "one caller").** It
  has **two** `isViewVisible()` readers (`executeAgent.ts:445` + `agentEventListeners.ts:115`),
  two host implementations (`desktopAgentExecution.ts:187`, `ProgressViewProvider.ts:512`), and
  test mocks. Folding onto `AgentRuntimeHost` is a ~6-site, behavior-sensitive host-port change,
  not a 24-LOC deletion — **reclassified low-value / skip** unless the host port is being
  reworked anyway.
- **§9 finding #1 (redaction contract)** — addressed 2026-06-03 (TSDoc on `logUtils`); unchanged.

> **Latest-main note.** This addendum was rebased onto and re-verified against `origin/main`
> at `17d229860` (the §13 work began at `bf32964`). The diff `bf32964..17d229860` over
> `src/agent`, `src/logger`, `src/platform`, `src/eventBus`, `packages/core/src` is **empty** —
> the ~10 intervening commits are CLI/webview fixes and a Lean-LSP decouple (`src/tools/lean`,
> #5260) — so every `file:line` below holds unchanged on latest main.

### Deeper trace (latest main `17d229860`) — two ledger items refined to ground truth

Eight prior passes carried §4 and §5/Step 7 forward by description. A direct line-level
trace of both this pass shows the **conclusions hold but the prior framing was imprecise**;
the refinements below change what the eventual fix must do, so they are recorded explicitly.

**Finding A — §4 is a deliberately-gated two-sink fan-out, _not_ a duplicated signal.**
The two emissions in `UsageMonitor.recordUsage` (`utils/UsageMonitor.ts:155` and `:164`) are
documented in-code (`:151-167`) as targeting **two different sinks with different scope**, not
the same signal twice:

- `runtimeHost.emit('updateStreamUsage', …)` (`:155`) → the progress-view **sidebar**, for
  **all** agents (the `ProgressEventBus`/UI accumulation surface).
- `logger.usage(payload, …)` (`:164`) → the transcript **statistics line** via the `AgentTrace`
  channel, **gated to `AgentCategory.Workflow` only** (`:160`) — tool-use agents deliberately
  skip it because their UI surface is the tool-use cards, not a stats line.

So §0's "genuinely duplicated signal (token usage)" overstates it: there is one _payload_ built
once, fanned to two _consumers_ with different audiences and a workflow-only gate. Consolidating
onto `AgentTrace` (the SDK-aligned single channel) is therefore **not** a dead-emit deletion —
it requires (a) the sidebar consumer to subscribe to the trace `usage`/`domain` channel, and
(b) preserving the workflow-only gate so tool-use transcripts don't grow a stats line. **Ledger
update:** keep §4 open, but reclassify it from "remove the duplicate" to "consolidate two sinks
onto one channel, preserving the `AgentCategory.Workflow` gate" — a UI consumer rewire, larger
than a one-line deletion. (This matches, and sharpens, the standing "progress-view consumer
rewire" note.)

**Finding B — the Step-7 "concurrent in-process sessions" blocker is narrowly the _unscoped
sweep/all_ operations, not the keyed registries.** Tracing all three module-globals shows every
_lookup/resolve_ path is already concurrency-safe, because each is **keyed by a unique id** and
each entry points at the correct per-run object:

- `executionRegistry` — `Map<executionId, ExecutionHandle>` (`executionRegistry.ts:32`); handles
  carry their own per-run `runtimeHost`. No cross-session key collision.
- `runCoordinators.bridgeState` — 8 `Map`s keyed by `streamId`/`approvalId`/`proposalId`
  (`runCoordinators.ts:27-36`), each pointing at that run's `RunCoordinators`. The resolve-side
  UI callers (`resolveProposal`/`resolvePlanApproval`/`triggerRetry`) run outside the run's ALS
  and key by id — which is _why_ the bridge exists (§7); it is not collision-prone.
- `ToolUseAgentRegistry` — `Map<streamId, IInterruptible>` (`ToolUseAgentRegistry.ts:27`).
- `StreamStatusService` — `Map<streamId, StreamStatus>` (`StreamStatusService.ts:13`).

Operations that iterate a whole map are then either **already scoped** or **shutdown-only**, and
thus also safe for multiple in-process sessions:

- `interruptActiveChildren(parentStreamId)` filters by `isChildOf(handle, parentStreamId)`
  (`ExecutionHandle.ts:178-187`) — parent-scoped, not a global sweep; likewise
  `collectChildSummary`/`updateActiveSubagents`.
- `killBackgroundProcesses()` is wired only to process shutdown (`extension.ts:190`
  `onShutdown(BEFORE)`, desktop `index.ts:620`) — the process is tearing down, so cross-session
  scope is moot.

The genuine cross-session leaks for a hypothetical multi-session-in-one-process SDK embedder are
therefore a **short, enumerable list** — the explicit _all/sweep_ entry points, not the maps:

1. At the original §13 pass, `getActiveExecutionIds()` (`executionRegistry.ts:124` at that
   revision) returned **every** session's executions; consumed by the orchestrator's
   `ExecutionsTool` listing (`tools/ExecutionsTool.ts:382,441`) and the delete-all guards
   (`SettingsViewMessageHandler.ts:1201/1227`, `desktopSettingsIpc.ts:449/463`). A second
   session's runs would have been visible/selectable. This seam is now removed; see §15.
2. `cleanupAllCoordinatorRequests()` + `clearAll*` (`runCoordinators.ts:115/216/237`), reached via
   `cleanupAllApprovals()` ("delete all streams", `tools/approval/index.ts:49-57`). A reset in one
   session would clear another's pending approvals. **Note:** the per-session variant already
   exists — `cleanupCoordinatorRequestsForStream(streamId)` (`runCoordinators.ts:231`,
   `tools/approval/index.ts:42`) — so the scoped path is built; only the "all" sweep leaks.
   _(Item-2 names/line numbers are from the §13 pass; the methods were since renamed
   `cleanupAllRequests`/`cleanupRequestsForStream` and the current reset path is
   `runCoordinators.ts:142-193` per §15.)_
3. The single module-level `StreamStatusRegistry.onDidChange(...)` subscription in
   `executionRegistry.ts:118` — one process-wide listener (its body is keyed-safe; the subscription
   registration is the global).

**Ledger update:** the §5/Step-7 prescription "relocate the three module-globals onto a per-run
handle, never delete" is directionally right but heavier than needed. The minimal correctness fix
for concurrent sessions is to **scope the unscoped sweep/list/subscribe seams by session/owner**
(route "clear-all" through a per-session set and own the status subscription per session) — the
keyed entries themselves need not move for correctness. _(At the §13 pass this was ~3 seams; the
`getActiveExecutionIds` listing seam in item 1 has since been removed — see §15 — leaving ~2.)_ This is a smaller, lower-risk change than a wholesale registry relocation, and it is
why none of the current single-session-per-process hosts (extension, CLI, desktop) exhibit any bug
today. Recorded as a precise scope for Step 7; **not applied** (still a behavior-sensitive,
multi-host change, consistent with the prior deferral).

### Independently re-confirmed clean by the four parallel maps (recorded, not re-flagged)

- **Model handlers.** `ModelFactory` is a clean three-path router over an exhaustive
  `PROVIDER_HANDLERS`; the `support/` collaborators (`AnthropicStreamHandler`,
  `MediaAttachmentProcessor`, `ProxyConfigResolver`, `UsageNormalizer`, `sdkErrorAdapters`) are
  each multi-caller, non-trivial, and correctly shared — zero single-caller forwarders.
  `ReasoningModelHandlerOpenAI` is a justified DRY intermediate base. The hand-rolled streaming
  is necessary multi-provider glue, not a reimplementation of any single SDK's loop.
- **Agent core / runtime.** The two-tier run entry (`runAgent` → `executeAgent`/`runAgentStream`),
  the coordinator hierarchy, the `Node.exec()→createFlow()→run()` cycle factories, and the
  composed `AgentWorkspaceState` sub-objects all re-audited clean — no god-objects, no
  wrapper-to-inline. (Consistent with the §8/§9 false-positive ledger.)
- **Logger / trace / eventBus.** `@logger` stays decoupled from `platform()`; `AgentTrace` is
  the single per-run discriminated event channel; `ProgressEventBus` is orthogonal UI/state
  pub/sub; the only overlap remains the §4 usage emission — now traced (Finding A above) to be a
  deliberate two-sink fan-out with a workflow-only gate, not a duplicated signal. `redaction.ts`
  centralized and **not** dead (re-confirmed: `desktopAppLog.ts` is the live consumer).
- **Public surface.** Agent core is `vscode`-free (grep clean); the `@texra/core` 8-section
  barrel, the `Platform` 8-port composition root, and the `src/platform/index.ts` surface (added
  06-03) are the strongest SDK-aligned pieces. The would-be SDK callable
  (`initPlatform` → `validateExecutionRequest` → `runAgent`/`executeAgent` with an
  `AgentRuntimeHost` + `AgentTrace`) is ~95% pure; the only residual host leak is the UI-event
  mixing now documented as new finding #1.

**Subagent split points — unchanged and accurate** (§5 + proposal): config-driven YAML agents
over the two flows (reflection / tool-use) + the `delegate_*` tools are the existing subagent
mechanism; the `agentCategory` dispatch in `executeAgent` is the cleanest internal seam; the
helper-model tasks remain the lowest-risk tools-as-data extraction. The node-level
candidates (`MediaExtractionNode`, `TeXCountNode`, `OutputNode`, the `sessionDescription`
background call) stay gated behind the same Step-7 coupling blocker (they read the ALS
`RunContext` + module-global registries).

**Net for 2026-06-04:** thesis reaffirmed for the eighth pass — incremental, not structural;
the post-06-03 drift is pure simplification, moving the codebase further _toward_ the audit's
target (re-verified on latest main `17d229860`). Two behavior-preserving tidies applied
(`AgentRuntimeHost` headless-contract TSDoc; the `IModelHandler` provider-boolean port trim), and
one ledger correction: the §12 `RunStorageService` item was overstated as "one caller" — it has
two readers + two host impls + tests, so it is reclassified low-value/skip. The two highest-value
open items were traced to ground truth rather than carried by description: **§4** is a
deliberately-gated two-sink fan-out (Finding A), so its fix is a sink consolidation that must
preserve the workflow-only gate — not a duplicate deletion; and **§5/Step 7's**
"concurrent-session blocker" narrows to ~3 unscoped sweep/list/subscribe seams
(`getActiveExecutionIds`, the `clearAll*` reset, the module-level status subscription) over
otherwise concurrency-safe keyed registries (Finding B), so the minimal fix is to scope those
seams by session, not relocate the registries. The remaining ledger is just §2.6 (relocate) plus
the deliberately-deferred behavior-sensitive items (§4, §5/Step 7). No rewrite warranted.

---

## 14. Re-verification addendum — 2026-06-06 (ninth pass — confirmation)

A ninth pass — three parallel fresh-eyes audits (agent core/runtime, model handlers,
logger/platform/surface) plus a direct line-by-line re-check of every open item against
`main` at HEAD `f5d1fc6` (branched as `claude/eager-noether-vaT5l`). **All 2026-05-28 →
06-04 findings hold without change. No new structural over-abstraction surfaced.** Each of
the three independent audits, on its own, re-reached the standing verdict: TeXRA is
well-architected and SDK-aligned; the gaps are incremental, not structural. Like §12/§13, this
pass **applied one behavior-neutral refactor** — the SDK-008 `core/stateStore` inline (below),
the documented next increment after #5349 removed the `core/config` sibling. The remaining open
items stay deferred: each is either behavior-sensitive (§4, §5/Step 7) or non-trivial (§2.6 is
CLI machinery; §5 is a multi-day primitive), exactly the items eight prior passes deliberately
deferred, and the one genuinely-new audit candidate this pass (below) is a §2.4 _keep_, not a
removal.

### Applied this pass (behavior-preserving; root + test-kernel + extension + CLI `tsc --noEmit`, `eslint`, and the full Vitest test-kernel suite — 2013 pass — all green)

- **SDK-008 `core/stateStore` inline — completed.** The proposal's SDK-008 item flagged the
  `getGlobalState()` / `getWorkspaceState()` passthroughs over `platform().globalState` /
  `platform().workspaceState` as removable ("inline or drop"); #5349 had already removed the
  `core/config` sibling. This pass inlined the two state passthroughs at all repo call sites
  found by `rg`, including the CLI TUI harness (`ModelFactory`, `helperModel`, `registerMemory`,
  `agentRegistry`, `diffCommandExecutor`, `texFormatter`, `executionLifecycle`, `OutputNode`,
  `LatexDiffManager`, `compileCheck`, `executionListing`, `indent`, `ExecutionsTool`,
  `goalStore`, `enumConfig`, `tui-harness`)
  to read `platform()` directly — the documented `@platform` accessor — and reduced
  `stateStore.ts` to just `tryGetWorkspaceState()` (the genuine pre-initialization escape hatch,
  which must stay). Behavior-preserving: every passthrough was a one-line return of the same
  `platform()` field. The one test that double-mocked `@agent/core/stateStore`
  (`LatexdiffShadowStorage.vitest.ts`) already installs a fake platform via `initPlatform`, so the
  redundant module mock was dropped and the real `tryGetWorkspaceState` now reads that fake
  platform (latex suite: 15 pass). Three stale doc-comment references to the removed accessors
  were refreshed (`common/state/index.ts`, `agent/features/index.ts`, `latex/latexdiff.ts`,
  `agent/core/README.md`). This is the same "remove the trivial passthrough, use the source
  directly" shape as #5349; SDK-008 is now fully closed.

### Drift since the 2026-06-04 pass (last verified main `17d229860` → HEAD `f5d1fc6`) — audited clean

The 12 commits touching the audited tree (`src/agent`, `src/logger`, `src/platform`,
`src/eventBus`, `packages/core/src`; net +904/−466 over 37 files) are CLI/webview fixes,
**simplification** refactors that move _with_ the audit, and one new feature — none adds a
wrapper, barrel, or run-entry indirection:

- **`c9d7ae7` "Remove trivial `@agent/core/config` re-export, import `getConfig` directly"
  (#5349) — closes half of SDK-008.** The proposal's SDK-008 item flagged `core/config.ts` and
  `core/stateStore.ts` as pure passthroughs ("inline or drop"); `src/agent/core/config.ts` is
  now **removed** (verified absent) and callers import `getConfig` directly. The `stateStore.ts`
  half remains open (see ledger below).
- **`aa9b79d` "simplify SDK error adapters" (#5381)** and **`ad44aa9` "consolidate `ensureArray`
  utility"** are textbook applications of the repo's own flatten/anti-shim rules — reductions,
  no new indirection.
- **`acac22a` "repair compile-failed workflow rounds"** added the three new feature files
  (`output/compileFailureRoundContext.ts`, `implementations/flows/tooluse/modelSwitchState.ts`,
  `runtime/mediaVisionWarning.ts`) and the `xmlExtraction.ts` → `outputFileExtraction.ts` rename.
  Feature work, not abstraction churn.
- **Guardrails intact:** `git diff --name-status` over the audited dirs shows **no new
  `index.ts` barrel and no new run-entry wrapper**; `@texra/core` is still the curated 13-export
  barrel (not the old stub); and `src/agent`/`src/model`/`src/latex`/`src/tools` remain
  **`vscode`-free** (grep clean).

### Three parallel fresh-eyes audits — independently re-reached the verdict; re-surfaced the documented false-positives

As in prior passes, the fresh audits re-discovered several items the ledger already
adjudicated. Re-verified with fresh `file:line` evidence at HEAD `f5d1fc6` so they are not
re-litigated a tenth time:

- **"Consolidate `modelHandlerOpenAIResponse.ts` (~2.5k LOC) into the OpenAI base."**
  **Re-confirmed reject** (proposal "Rejected findings"; §11): the two share mutable conversation
  state, background polling spans the transports, and the test suite subclasses the handler —
  a multi-day design migration, not a mechanical consolidation. Not a quick win.
- **"`ReasoningModelHandlerOpenAI` (38 LOC) is a one-trick intermediate — collapse it."**
  **Re-confirmed justified DRY base** (§13): it has **four** real subclasses
  (`modelHandlerDeepSeek/Kimi/GLM/MiniMax`, verified by `extends ReasoningModelHandlerOpenAI`),
  each carrying genuine deltas. A shared two-flag base across four subclasses is the DRY pattern,
  not over-abstraction.
- **"Thin OpenAI-compatible subclasses (DashScope/XAI/GLM) are wrapper-only — table them."**
  **Re-confirmed lean-keep** (§9 #2/§12/§13): each maps 1:1 to a `ModelProvider` arm in the
  exhaustive `PROVIDER_HANDLERS`; the prior OpenRouter merge of this flavor was deliberately
  reverted. The collapse still needs a class per provider — trades small LOC for a less-obvious
  dispatch table.
- **"`ModelFactory` post-construction wrapping (`withReasoningOverride` /
  `withModelHandlerCompatibilityKey`) is a two-layer factory — move into the constructor."**
  **Rebutted, verified.** `withReasoningOverride` (`ModelFactory.ts:137`) is **capability-gated**
  on `supportsReasoningLevelOverride` (`:138`, the §8 flag) and only mutates capabilities when
  the handler opts in; `withModelHandlerCompatibilityKey` tags a cross-provider compatibility key.
  These are capability-driven decorators applied by the §10 "single-purpose three-path router,"
  not a `buildX→createX` two-layer factory — moving them into each provider constructor would
  _duplicate_ the gate across every handler. Keep.
- **"Most handlers don't use the `UsageNormalizer` template (partial adoption)."**
  **Factually wrong — verified.** `support/UsageNormalizer.normalizeUsage` is imported and called
  by `anthropic/anthropicUsage.ts:165`, `openai/openAIUsage.ts:68`, and `google/googleUsage.ts:90`
  (each supplies only a per-provider `extract`/`computePrice` config). The template **is** the
  single normalization path the prior passes described — no migration pending.
- **"`IModelHandler` is a redundant duplicate of `ModelHandler`."** **Re-confirmed not a
  duplicate** (§9/§12/§13): the optional `createBatchedToolUseFollowUpMessages?`
  (`types/IModelHandler.ts:392`) is feature-detected on the port-typed handler at
  `ToolUseCycleFlow.ts:822/826` and is **not** on the base class — re-typing those sites to the
  concrete class fails to compile.

The §13-applied tidies all remain in place: the `IModelHandler` port carries only
`isOpenai`/`isAnthropic`/`isGoogle` (the three provider booleans are `protected` on the base,
`ModelHandler.ts:437/442/447`), and the `AgentRuntimeHost` headless-contract TSDoc is present.

### One genuinely-new candidate this pass — a §2.4 _keep_, recorded so it is not re-flagged as inline

The agent-core audit flagged the two single-purpose `AgentFlowResult` builders in
`runtime/executeAgent.ts` — `buildWorkflowFlowResult` (defined `:112`, called once at `:523`)
and `buildTerminalFlowResult` (defined `:303`, called **twice** at `:267` and `:276`) — as
candidates to inline at their call sites. **Recorded as a non-finding / keep.** This is exactly
the §2.4 guidance ("extract the trivial result→`AgentFlowResult` mapping … so the _loop_ reads
cleanly; leave the orchestration in place"): named result-mappers that keep the dispatch loop
readable are endorsed to keep. Moreover `buildTerminalFlowResult` has two callers, so inlining it
would _duplicate_ the mapping. No action; logged so a future pass does not re-propose the inline.

### Open ledger at HEAD `f5d1fc6` (line numbers refreshed; all still present)

- **§2.6** — `src/agent/modelHandlers/modelHandlerValidation.ts` still in the production handler
  dir, gated by `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL` (`ModelFactory.ts:52`,
  dynamic-imported `:326`). Relocate-with-injection (CLI machinery, not vitest-only) still
  recommended; still low priority.
- **§4** — token usage still two-sink fan-out in `src/agent/utils/UsageMonitor.ts`:
  `runtimeHost.emit('updateStreamUsage', …)` `:155` (sidebar, all agents) and `logger.usage(…)`
  `:164` gated to `AgentCategory.Workflow` `:160` (transcript stats line). Per §13 Finding A this
  is a deliberate two-audience fan-out, not a duplicate — its fix is a sink consolidation onto
  `AgentTrace` that preserves the workflow-only gate (a progress-view consumer rewire).
- **§5 / proposal Step 7** — no `delegateTo(...)` primitive (`grep` over `src/**` + `packages/**`
  empty); delegation remains a tool call. The three module-globals are unchanged:
  `runCoordinators.bridgeState` (`:27`), `executionRegistry` module Maps, and the interrupt
  registry still named `ToolUseAgentRegistry` (Step 7a rename not landed). Per §13 Finding B the
  minimal correctness fix is scoping the ~3 unscoped sweep/list/subscribe seams by session, not
  relocating the keyed registries.
- **SDK-008 — CLOSED this pass.** `core/config.ts` removed (`c9d7ae7` / #5349); the
  `core/stateStore.ts` `getGlobalState()`/`getWorkspaceState()` passthroughs are now inlined to
  `platform()` at all repo call sites found by `rg` (see "Applied this pass"). Only
  `tryGetWorkspaceState()` remains (real pre-init null-tolerance). No SDK-008 residual.
- **§3.1** — still no `@agent/runtime/index.ts` barrel; still optional polish (the `@texra/core`
  - `src/platform/index.ts` surfaces already cover the underlying concern).
- **§13 finding #1 (`AgentRuntimeHost.emit` mixes UI + essential events)** — unchanged;
  addressed by the documented headless contract, structural split deferred.

### Independently re-confirmed clean (recorded, not re-flagged)

- **Agent core/runtime.** The two-tier run entry (`runAgent` → `executeAgent`/`runAgentStream`)
  is the documented high/low split; `buildAgentLaunchContext`'s saga-style assembly and
  `runFlowWithLifecycle`'s cross-cutting lifecycle are load-bearing (not wrappers to inline);
  PocketFlow nodes create+run flows directly (`createToolUseCycleFlow`/`createResponseCycleFlow`
  in `Node.exec`); `createRunContext` is the endorsed frozen-object factory (§2.5). No core
  abstraction recommended for removal.
- **Model handlers.** `ModelFactory` is the exhaustive three-path router; `support/` collaborators
  (`AnthropicStreamHandler`, `MediaAttachmentProcessor`, `ProxyConfigResolver`, `UsageNormalizer`,
  `sdkErrorAdapters`) are each multi-caller and correctly shared; tool conversion shares one schema
  flattener (`convertToolSchema`) with per-provider formatters. The hand-rolled streaming is
  necessary multi-provider glue, not a reimplementation of any single SDK's loop.
- **Logger / trace / eventBus / platform.** `@logger` stays decoupled from `platform()` (single
  `writeLine` emission point; host-injected sink); `AgentTrace` is the single per-instance
  discriminated event channel (per-instance `AsyncLocalStorage` for stage isolation);
  `@transcript` adds product subscribers without polluting the host-neutral trace; `ProgressEventBus`
  is an orthogonal buffered pub/sub; `redaction.ts` centralized and **not** dead
  (`desktopAppLog.ts` is the live consumer). The `Platform` 8-port composition root + frozen
  single-call init + `src/platform/index.ts` surface remain the strongest SDK-aligned pieces.

**Subagent split points — unchanged and accurate** (§5 + proposal): config-driven YAML agents
over the two flows (reflection / tool-use) + the `delegate_*` tools are the existing subagent
mechanism; the `agentCategory` dispatch in `executeAgent` is the cleanest internal seam; the
helper-model tasks remain the lowest-risk tools-as-data extraction; the node-level candidates
(`MediaExtractionNode`, `TeXCountNode`, `OutputNode`, the `sessionDescription` background call)
stay gated behind the Step-7 coupling blocker.

**Net for 2026-06-06:** thesis reaffirmed for the ninth pass — incremental, not structural. The
post-06-04 drift is pure simplification + one feature, moving the codebase further _toward_ the
audit's target. The three fresh audits re-surfaced only documented rejects/lean-keeps (re-rebutted
with fresh line evidence) plus one new candidate that is a §2.4 _keep_. **One behavior-neutral
refactor was applied — the SDK-008 `core/stateStore` inline, closing SDK-008** (the `core/config`
sibling had landed in #5349). The remaining ledger is exactly §2.6 (relocate), §4 (gated two-sink
consolidation), and §5/Step 7 (multi-session isolation) — all behavior-sensitive or non-trivial,
consistent with the prior deferrals. No rewrite warranted.

---

## 15. Re-verification addendum — 2026-06-09 (tenth pass — confirmation; Step-7 surface advanced by intervening simplification)

A tenth pass — three parallel fresh-eyes audits (agent core/runtime, model handlers,
logger/platform/surface) plus a direct line-by-line re-check of every open item against
branch `claude/eager-noether-dv2bch` at HEAD `c096237`. **All 2026-05-28 → 06-06 findings
hold. No new structural over-abstraction surfaced.** Each of the three independent audits, on
its own, re-reached the standing verdict: TeXRA is well-architected and SDK-aligned; the gaps
are incremental. **No refactor was applied this pass** — but the intervening team commits
landed simplifications that materially advance the §5/Step-7 ledger (below), so this pass is a
confirmation _plus_ a ledger update to ground truth, not a re-scoping.

> **Baseline note.** The §14 addendum was written against `f5d1fc6` (branch
> `claude/eager-noether-vaT5l`), which is **not reachable** from this branch; the audit doc
> itself landed via merge `87052f9` (PR #5595). Drift below is measured from `87052f9`
> over `src/agent`, `src/logger`, `src/platform`, `src/eventBus`, `packages/core/src`
> (77 commits total; ~33 files / +525/−346 in the audited dirs). Two of §14's open-item
> `file:line` references (`runCoordinators.bridgeState (:27)`, `getActiveExecutionIds`) were
> already stale at the doc's own merge commit — corrected below.

### Drift since the §14 doc baseline (`87052f9` → `c096237`) — audited clean; advances Step 7

The audited-dir commits are CLI/follow-up-queue fixes, declarative refactors, and one feature —
none adds a wrapper, barrel, or run-entry indirection (`git diff --name-status` shows the only
new files are `runtime/ProgressViewBridge.ts`, `toolUse/followUpMessages.ts`,
`types/AttachedMemory.ts` — none a barrel). Three of these **materially advance** the §5/Step-7
and §13 Finding-B ledger toward its prescription ("relocate the keyed registries onto an
injectable per-session handle; scope the sweep/list seams"); a fourth, listed last, is a pure
relabel:

- **`runCoordinators.bridgeState` (module-global free Maps) → `RunCoordinatorBridge` class
  (`runCoordinators.ts:33`).** Now an injectable class with three instance Maps
  (`planApprovals`/`proposals`/`retries`, `:34-36`), a constructor that takes a `registry`
  dependency defaulting to the `executionRegistry` singleton (`:38-43`), and a module singleton
  `runCoordinatorBridge` for the current single-session hosts (`:220`). This is exactly the
  Step-7 "relocate onto an injectable handle" direction realized for the coordinator bridge —
  a second instance can be constructed with a different registry for session isolation. (Per the
  baseline note, §14's "`bridgeState (:27)`" framing was already stale at `87052f9`.)
- **`ToolUseAgentRegistry` → `runtime/InterruptRegistry.ts` — the Step-7a rename has LANDED.**
  `class InterruptRegistry` wraps `Map<StreamTabId, IInterruptible>` and gained a
  `retainOnly(streamIds)` scoping method (`InterruptRegistry.ts:24-32`) that is **actively
  used** by `ProgressViewState.ts:151` (`interruptRegistry.retainOnly(...)`) and the registry is
  now **injected as a dependency** into `executionRegistry` (`:104 interrupts = interruptRegistry`).
- **`executionRegistry.getActiveExecutionIds()` — REMOVED.** This was §13 Finding-B's first
  unscoped sweep seam ("returns _every_ session's executions"). It is gone; the bridge now reads
  `getAgentHandles()` (`executionRegistry.ts:310`) and `getAgentHandleByStream()` internally. One
  of the three Finding-B cross-session leaks is therefore eliminated.
- **`RunStorageService` → `ProgressViewBridge` (`f89f2fa`, "clearer ownership").** Same narrow
  port shape (a single `isViewVisible()` read, default no-op, two host impls), so the §13
  low-value/skip item is simply **relabeled**, not structurally changed. Still two readers
  (`executeAgent.ts:285`, `agentEventListeners.ts:115`).

### New feature audited clean — live confirmation of the §5 subagent thesis

**Software Engineer multi-agent team (`5fdc970`, #5667).** Four new subagents
(`engineer`/`coder`/`codeReviewer`/`testEngineer`) were added **purely as
`packages/extension/resources/tool_use_agents/*.yaml` + a `multiAgentPresets` entry + `agentRegistry` wiring**
(+30 LOC) — zero new agent-type code, zero new flow. This is a textbook live confirmation of
§5's core claim: with config-driven YAML agents over the two shared flows, **new subagents are a
YAML + tool-list concern, not new code.** No new abstraction introduced.

### Open ledger at HEAD `c096237` (line numbers refreshed; all still present)

- **§2.6** — `src/agent/modelHandlers/modelHandlerValidation.ts` still in the production handler
  dir, gated by `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL` (`ModelFactory.ts:51-52`,
  dynamic-imported at `:326`). Relocate-with-injection (CLI machinery, not vitest-only) still
  recommended; still low priority.
- **§4** — token usage still a deliberate two-sink fan-out in `src/agent/utils/UsageMonitor.ts`,
  now with an explicit in-code comment (`:150-154`): `runtimeHost.emit('updateStreamUsage', …)`
  `:155` (progress-view sidebar, **all** agents) and `logger.usage(payload, …)` `:164` gated to
  `AgentCategory.Workflow` `:160` (transcript stats line). Per §13 Finding A this is two
  audiences, not a duplicate — its fix is a sink consolidation onto `AgentTrace` that preserves
  the workflow-only gate (a progress-view consumer rewire).
- **§5 / proposal Step 7** — still no first-class `delegateTo(...)` primitive (`grep delegateTo`
  over `src/**` + `packages/**` empty); delegation remains a tool call inside the LLM loop. **But
  the Step-7 plumbing advanced this period** (above): the interrupt registry renamed + gained
  `retainOnly` scoping, the coordinator bridge became an injectable class, and the
  `getActiveExecutionIds` sweep seam was removed. Per §13 Finding B the remaining cross-session
  seams narrow to the **`clearAll*` reset path** (`runCoordinators.ts:142-193`
  `cleanupAllRequests`, reachable via `tools/approval`) and the **single module-level
  `StreamStatusRegistry.onDidChange` subscription** in `executionRegistry.ts:118` — scope these by
  session and the in-process multi-session blocker closes. The keyed registries themselves need
  not move for correctness (no current single-session host exhibits a bug).
- **§3.1** — still no `@agent/runtime/index.ts` barrel; still optional polish (the `@texra/core`
  and `src/platform/index.ts` surfaces already cover the underlying concern).
- **§13 finding #1 (`AgentRuntimeHost.emit` mixes UI + essential events)** — unchanged; the
  headless-contract TSDoc is present (`AgentRuntimeHost.ts:1-27`, "Frontend-bound events"
  grouping), structural split deferred.
- **SDK-008** — remains CLOSED (`core/config` removed #5349; `core/stateStore` inlined §14).

### Settled rejects / lean-keeps re-confirmed (do not re-flag)

The fresh model-handler and logger/surface audits re-rediscovered no new removable abstraction.
Re-confirmed with current line evidence: `IModelHandler` is **not** a duplicate of `ModelHandler`
(optional `createBatchedToolUseFollowUpMessages?` feature-detected on the port-typed handler);
the thin OpenAI-compatible subclasses are a lean-keep (1:1 with the exhaustive
`PROVIDER_HANDLERS`; prior OpenRouter merge reverted); `ReasoningModelHandlerOpenAI` is a DRY base
(four subclasses); the `modelHandlerOpenAIResponse.ts` consolidation stays a rejected multi-day
migration; the cycle-flow factories are the prescribed `Node.exec()→createFlow()→run()` shape;
the two-tier `runAgent`/`runAgentStream` entries serve different consumer classes; `redactSecrets`
is **not** dead (`desktopAppLog.ts`, 4 sites); `@texra/core` is still the curated `vscode`-free
barrel; `createChannelTrace` (now ~48 module-singleton call sites) remains the recorded
judgment-call, not pursued. The agent core/runtime audit independently confirmed the
recently-reworked `RunCoordinatorBridge`, `InterruptRegistry`, `ProgressViewBridge`, and
follow-up-queue files (`FollowUpQueue`, `ToolUseFollowUp`, `ToolUseFollowUpQueueManager`,
`followUpMessages`) are each load-bearing with no single-use forwarder.

**Subagent split points — unchanged and accurate** (§5 + proposal): config-driven YAML agents
over the two flows (reflection / tool-use) + the `delegate_*` tools are the existing subagent
mechanism — now newly evidenced by the Software Engineer team landing as pure YAML; the
`agentCategory` dispatch in `executeAgent` is the cleanest internal seam; the helper-model tasks
and the node-level candidates (`MediaExtractionNode`, `TeXCountNode`, `OutputNode`, the
`sessionDescription` background call) stay the lowest-risk extractions, gated behind the same
Step-7 coupling blocker.

**Net for 2026-06-09:** thesis reaffirmed for the tenth pass — incremental, not structural. No
refactor was applied this pass, but the team's intervening simplification commits
(`ProgressViewBridge`/`InterruptRegistry` renames, the injectable `RunCoordinatorBridge` class,
the `getActiveExecutionIds` removal, the `retainOnly` scoping) have moved the §5/Step-7 surface
meaningfully toward its target on their own, and the Software Engineer team confirmed §5's
"new subagents are config, not code" thesis in practice. The remaining ledger is exactly §2.6
(relocate), §4 (gated two-sink consolidation), and §5/Step 7 — now narrowed to the `clearAll*`
reset path and the one module-level status subscription. No rewrite warranted.

---

## 16. Re-verification addendum — 2026-06-10 (eleventh pass — confirmation; two dead-shim removals applied)

An eleventh pass — three parallel fresh-eyes audits (agent core/runtime, model handlers,
logger/public-surface) plus a direct line-by-line re-check of every open item against branch
`claude/eager-noether-eoozsh` at HEAD `8b868e3` (baseline: §15's `c096237`, reachable from this
branch). **All 2026-05-28 → 06-09 findings hold without change. No new structural
over-abstraction surfaced.** Each of the three independent audits, on its own, re-reached the
standing verdict: TeXRA is well-architected and SDK-aligned; the gaps are incremental, not
structural. Like §12/§13/§14, this pass **applied two of the backlog's safest, behavior-neutral
items** — both anti-shim dead-export removals freshly created/exposed by the intervening drift.

### Applied this pass (behavior-preserving; full `npm run typecheck` ×4 projects + `eslint` green)

- **Dead re-export shim removed — `helperModel.ts` `export { getHelperModelName }`.** The
  `getHelperModelName` accessor was extracted into its own `runtime/helperModelName.ts` this
  period (new file in the `c096237..8b868e3` drift), and `runtime/helperModel.ts:30` carried a
  re-export `export { getHelperModelName };`. Both **external** importers
  (`packages/extension/src/frontend/agents/optionsLoader.ts:2`,
  `packages/extension/src/commands/agent/mergeCommands.ts:5`) already import directly from
  `@agent/runtime/helperModelName` — **zero** files route through the re-export
  (`grep "from '@agent/runtime/helperModel'"` for the name → empty). Deleted the dead re-export;
  the local `import { getHelperModelName }` (still used internally at `:34`) stays. Exactly the
  repo's anti-shim convention ("don't leave re-export shims behind").
- **Dead namespace barrel line removed — `@logger/index.ts` `export * as logUtils`.** The barrel
  re-exported `logUtils` as a namespace, but **no file imports `{ logUtils } from '@logger'`** —
  all ~124 logging consumers use the deep `@logger/logUtils` path, and every **bare** `@logger`
  importer pulls only `createChannelTrace` (22 sites) or `redactSecrets` (desktop/CLI sinks). The
  namespace line was pure dead surface (re-confirms the logger audit's L3 and the prior §12 "two
  ways to log" tension). Deleted line 1 of `src/logger/index.ts`; left `redactSecrets` and
  `createChannelTrace` (both live). The migration of `@logger/logUtils` → a single `@logger`
  entry stays the larger, deferred consistency question — only the dead line was removed.

### Drift since the §15 baseline (`c096237` → `8b868e3`) — audited clean; no new abstraction

93 files / +1094/−992 across the audited dirs. The new files are a **declarative SDK-error split**
(`anthropic/anthropicSdkError.ts`, `google/googleSdkError.ts`, `openai/openAISdkError.ts`,
`openrouter/openRouterSdkError.ts` + shared `support/sdkErrorMetadata.ts` / `sdkErrorTagging.ts`,
landed with the ESM-safe startup fix `a6bd0c2`), the goal/odyssey collapse (`6fb5b3d` — `features/registerGoal.ts`,
`goal/maybeBuildGoalContinuation.ts`, `goal/promptLoader.ts`; `runtime/idleContinuation.ts` **removed**),
the `helperModelName.ts` extract, and a streaming-hot-path perf pass (`e70adb9`, `TraceEmitter.ts`
−net). The per-provider `sdkError` files are each shared by the base `ModelHandler` + multiple
provider handlers (`grep` confirms multi-caller) — a clean extraction, **not** a single-use
forwarder. `git diff --name-status` shows **no new `index.ts` barrel and no new run-entry
wrapper**; the agent core / `src/model` / `src/latex` / `src/tools` stay **`vscode`-free** (grep
clean); `@texra/core` is still the curated 13-export barrel.

### Re-rebutted false positive (sixth time — fresh model-handler audit re-flagged it as HIGH)

- **"`IModelHandler` is a redundant duplicate of `ModelHandler` — delete the port, make the
  abstract class the contract."** **Refuted, verified at HEAD.** The fresh audit's grep is
  correct as far as it goes (`implements IModelHandler` → only the base class; everything else
  `extends ModelHandler`), but it misses what makes the port non-redundant: the **optional**
  `createBatchedToolUseFollowUpMessages?(...)` is declared on the port
  (`types/IModelHandler.ts:392`, with `?`) and is **not** on the abstract base.
  `ToolUseCycleFlow.ts:830-831` **feature-detects** it on the port-typed handler
  (`modelHandler.requiresBatchedParallelToolResults && !!modelHandler.createBatchedToolUseFollowUpMessages`)
  then calls it with `!` at `:835`. Re-typing those sites to the concrete `ModelHandler` (which
  lacks the method) fails to compile — the port's optional-method surface is exactly the
  provider-agnostic feature-detection seam. Consistent with §9/§12/§13/§14/§15. **Not redundant;
  do not delete.** (The audit-endorsed _sliver_ — extracting the standalone option/result type
  aliases into a pure types module — remains available, but is cosmetic, not a removal.)

### Genuinely-new candidates recorded for the backlog (none are blockers; none applied)

1. **`agentRegistry.ts` mixes the Lit-UI options builder into the SDK-exported core
   (low–med, surface altitude).** `src/agent/index/agentRegistry.ts` (~723 LOC) bundles
   load/cache/lookup (the `@texra/core`-exported core) with `computeAgentOptionsData` /
   `entryToOptionData` / `sortAgentEntries` — pure dropdown-presentation policy ("preferred
   agents first") consumed only by UI hosts — plus remote-meta `globalState` persistence and
   legacy-key migration. An SDK consumer importing `loadAgents`/`getAgent` pulls a module that
   also knows Lit dropdown ordering. **Suggested (move-only, deferred):** split the UI options
   builder into a UI-side module and the remote-meta/migration into internal modules, leaving the
   SDK-exported core baggage-free. Move-only across several consumers — not a quick line-removal.
   _(Distinct from, and complementary to, §13's `@agent/index` barrel-leakage item, which is the
   directory-wiring DI interfaces; this is the registry module's internal altitude mix.)_
2. **Redundant idempotent `ensureAgentCategoryForSource` call (low, judgment — leans keep).**
   `loadAgentSettingAndPrompts` already applies it at `agentLoad.ts:123`; `AgentLaunchContext.ts:188`
   re-applies it with the **same** `resolution.entry.source` right after calling that loader.
   `ensureAgentCategoryForSource` is idempotent, so the outer call is a no-op today. **Recorded,
   not applied** — it is a behavior-touching call site (not a dead export), and the outer call is
   cheap defensive depth that becomes load-bearing if the loader ever stops defaulting. The
   audit's discipline is to apply only pure dead-code/anti-shim removals (above) and defer
   behavior-touching ones; this is the latter.
3. **`createRedactingSink` safety affordance (low, optional).** Re-surfaces the §9/§12 redaction
   contract from the consumer-ergonomics angle: emit-time redaction is intentionally off, and
   desktop + CLI each hand-roll the `redactSecrets`-in-sink wrapper. A `createRedactingSink(inner)`
   helper from `@logger` would make the safe path the easy path for SDK consumers wiring a custom
   `setOutputChannelFactory`. The documented contract (§12 TSDoc) already covers correctness; this
   is an affordance, not a fix. Deferred.
4. **`@logger ↔ @agent/trace` package-level import cycle (low, latent).** `logger/runTrace.ts`
   imports `TraceEmitter` from `@agent/trace`, while `@agent/trace`'s `TraceEmitter.ts:16` imports
   `@logger/logUtils` for subscriber-error logging. Harmless at the file level today, but a latent
   layering smell for anyone extracting `@logger` or `@agent/trace` as a standalone SDK package.
   Recorded for the eventual package-extraction step; no action now.

### Settled rejects / lean-keeps re-confirmed (do not re-flag)

The three fresh audits independently re-reached the standing verdict and re-discovered only
documented items. Re-confirmed with current line evidence at HEAD `8b868e3`: there are exactly
**two** agent-implementation strategies (`Workflow`/`ToolUse`), not six — "Direct/CoT/Merge" are
config/prompt variations inside the reflection flow sharing one `BaseFlowContextInit` contract,
not separate classes (agent-core audit, consistent with §5); the `Node.exec()→createFlow()→run()`
cycle factories, the `runAgent`/`runAgentStream` two-tier entry, `buildAgentLaunchContext`'s
saga assembly, `RunContext`'s frozen-object factory, and the coordinator hierarchy are all
load-bearing, not wrappers to inline; `ModelFactory` is the exhaustive three-path router with
justified capability-gated decorators (`withReasoningOverride`/`withModelHandlerCompatibilityKey`,
§14); the 40 KB `ModelHandler` base is legitimate shared logic with collaborators already
composed out (`MediaAttachmentProcessor`/`ProxyConfigResolver`/`UsageNormalizer`/`sdkErrorTagging`),
not a god-class; the thin OpenAI-compatible subclasses are a lean-keep (each carries genuine
deltas — Kimi's token-count API, MiniMax's `reasoning_details`, DeepSeek's effort mapping — and
maps 1:1 to a `PROVIDER_HANDLER_ROUTES` arm); `createChannelTrace`'s 22 module-singletons remain
the recorded judgment-call (§12/§15); `redactSecrets` is **not** dead (`desktopAppLog.ts`, 4 sites).

### Open ledger at HEAD `8b868e3` (line numbers refreshed; all still present)

- **§2.6** — `src/agent/modelHandlers/modelHandlerValidation.ts` still in the production handler
  dir, gated by `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL` (`ModelFactory.ts:52`,
  dynamic-imported at `:326`). Relocate-with-injection (CLI machinery, not vitest-only) still
  recommended; still low priority.
- **§4** — token usage still a deliberate two-sink fan-out in `src/agent/utils/UsageMonitor.ts`:
  `runtimeHost.emit('updateStreamUsage', …)` `:155` (progress-view sidebar, **all** agents) and
  `logger.usage(payload, …)` `:164` gated to `AgentCategory.Workflow` `:160` (transcript stats
  line). Per §13 Finding A this is two audiences, not a duplicate — its fix is a sink
  consolidation onto `AgentTrace` preserving the workflow-only gate (a progress-view consumer
  rewire).
- **§5 / proposal Step 7** — still no first-class `delegateTo(...)` primitive (`grep delegateTo`
  over `src/**` + `packages/**` empty); delegation remains a tool call. The Step-7 plumbing
  landed in prior periods (`RunCoordinatorBridge` injectable class `runCoordinators.ts:33`,
  `InterruptRegistry.retainOnly` `:25`, `getActiveExecutionIds` removed). Per §13 Finding B the
  remaining cross-session seams narrow to the **`clearAll*` reset path**
  (`runCoordinators.ts:142` `cleanupAllRequests`, reachable via `tools/approval`) and the **single
  module-level `StreamStatusRegistry.onDidChange` subscription** (`executionRegistry.ts:115`) —
  scope these by session and the in-process multi-session blocker closes. The keyed registries
  themselves need not move for correctness (no current single-session host exhibits a bug).
- **§3.1** — still no `@agent/runtime/index.ts` barrel; still optional polish (the `@texra/core`
  and `src/platform/index.ts` surfaces already cover the underlying concern).
- **§13 finding #1 (`AgentRuntimeHost.emit` mixes UI + essential events)** — unchanged; the
  headless-contract TSDoc is present, structural split deferred.
- **SDK-008** — remains CLOSED (`core/config` removed #5349; `core/stateStore` inlined §14).

**Subagent split points — unchanged and accurate** (§5 + proposal): config-driven YAML agents
over the two flows (reflection / tool-use) + the `delegate_*` tools are the existing subagent
mechanism; the `agentCategory` dispatch in `executeAgent` is the cleanest internal seam; the
helper-model tasks (now including the freshly-extracted `helperModelName`) and the node-level
candidates (`MediaExtractionNode`, `TeXCountNode`, `OutputNode`, the `sessionDescription`
background call) stay the lowest-risk extractions, gated behind the same Step-7 coupling blocker.

**Net for 2026-06-10:** thesis reaffirmed for the eleventh pass — incremental, not structural.
The post-06-09 drift is a declarative SDK-error split, a goal/odyssey collapse, a hot-path perf
pass, and the `helperModelName` extract — all moving _with_ the audit, none adding a wrapper,
barrel, or run-entry indirection. **Two behavior-neutral anti-shim removals applied** (the dead
`helperModel` re-export exposed by the new `helperModelName.ts`; the dead `@logger` `logUtils`
namespace line), each verified by `typecheck` ×4 + `eslint`. The fresh model-handler audit's
`IModelHandler`-is-redundant claim was re-rebutted a sixth time with fresh line evidence; four
genuinely-new low-priority candidates were recorded (the `agentRegistry` UI-altitude split, the
idempotent double category call, the `createRedactingSink` affordance, the `@logger`↔`@agent/trace`
cycle), none a blocker. The remaining ledger is unchanged: §2.6 (relocate), §4 (gated two-sink
consolidation), and §5/Step 7 (multi-session isolation, narrowed to two unscoped seams). No
rewrite warranted.

---

## 17. Re-verification addendum — 2026-06-11 (twelfth pass — confirmation; a large modularization wave applied the audit's own recommendations)

A twelfth pass — four parallel fresh-eyes audits (agent core/runtime, model handlers, logger,
platform/public surface) plus a direct line-by-line re-check of every open item against branch
`claude/eager-noether-3mei4j` at HEAD `06cc9cb` (baseline for drift: `7893b2c`, the commit that
landed §16 on this lineage; §16's own `8b868e3` is on an unreachable branch, consistent with the
recurring cross-branch baseline note). **All 2026-05-28 → 06-10 findings hold without change. No
new structural over-abstraction surfaced.** Each of the four independent audits, on its own,
re-reached the standing verdict: TeXRA is well-architected and SDK-aligned; the gaps are
incremental, not structural. Like §15, this is a **confirmation-only pass — no refactor applied**
— because the intervening drift was an unusually large team-driven simplification wave that
already executed many of this audit's own recommendations, leaving no pure dead-code/anti-shim
item for this pass to safely remove (the discipline is to apply only those and defer
behavior-touching ones).

### Drift since the §16 baseline (`7893b2c` → `06cc9cb`) — a large simplification wave, audited clean

100 files / +2525/−2068 across the audited dirs. This is the heaviest drift any pass has seen,
and it moves entirely _with_ the audit — a monolith-modularization + dead-code campaign, none of
it adding a wrapper, barrel, or run-entry indirection:

- **`2f062af` "split tool-use cycle flow and agent registry into modules" + `4bb4bbe` (PR #5803,
  `refactor/modularize-monoliths`).** The tool-use cycle flow was decomposed into
  `core/flows/toolUseRound/{ToolUseRoundPrepNode,ToolUseProcessNode,ToolUseDispatchNode,roundShared,toolCallParsing}.ts`
  (the §16 backlog had no item here — this is proactive monolith-splitting), and the agent
  registry was split into `index/{agentEntry,agentOptionsBuilder,agentYamlScanner,remoteAgentMeta,agentRegistryConstants}.ts`.
  The latter **largely closes §16 new-finding #1** (the `agentRegistry` UI-altitude mix): the
  dropdown-ordering policy (`sortAgentEntries`/`entryToOptionData`) now lives in
  `index/agentOptionsBuilder.ts` (46 LOC) and the remote-meta persistence/migration in
  `index/remoteAgentMeta.ts` (79 LOC), so `agentRegistry.ts` (491 LOC, was ~723) imports them
  rather than embedding the policy. Only the thin `computeAgentOptionsData` orchestrator
  (`agentRegistry.ts:477`) still sits beside the SDK-exported core — a minor residual, downgraded
  from the §16 finding to optional polish.
- **`5cf2297` "extract provider helpers."** New `modelHandlers/{google/googleMessageHelpers,
openai/openAIChatHelpers,openrouter/openRouterStreaming}.ts` carve message/stream glue out of
  the three provider handlers. Each has its parent handler as sole caller — but these are
  monolith-reducing _moves_ (logic relocated out of 1.4–1.7k-line files), not single-use
  forwarders, so they are not a §-anti-shim concern.
- **`69b57ce` "flatten overengineered factories and remove dead indirection," `91114e5`
  "eliminate pass-through thin layers," `e87d65e` "remove pass-through helpers," `5f89dfd` "prune
  dead code surfaced by knip audit," `1bcd821` "prune logger redaction barrel export," `7893b2c`
  "remove dead re-export shims."** These are the repo's own flatten/anti-shim rules applied
  wholesale — and they explain why this pass finds nothing left to prune: the barrels
  `src/agent/remote/index.ts`, `src/agent/types/ResultTypes.ts`, `src/agent/utils/index.ts`, and
  `src/eventBus/index.ts` are all now **deleted** (verified gone), and the `@logger`
  redaction-barrel line flagged historically is pruned.
- **`a79295f` "Break circular dependencies and fix upward layering (#5775)."** A layering pass;
  note it did **not** resolve §16 new-finding #4 — the `@logger/runTrace.ts:10` → `@agent/trace`
  / `@agent/trace/TraceEmitter.ts:18` → `@logger/logUtils` cycle is still present (latent, low;
  recorded for the eventual package-extraction step).
- **`8e04a80` "centralize agent run outcomes"** and **`1fdbb67` "Rename chat agent to assistant
  with maximal toolset and holistic prompt"** — the latter is another live confirmation of §5's
  thesis: an agent identity change landed as a YAML/prompt + alias-migration concern (`bda1dc5`,
  `073097c`, `2403176`), zero new agent-type code.
- **Guardrails intact:** `git diff --name-status` over the audited dirs shows **no new
  `index.ts` barrel and no new run-entry wrapper**; `@texra/core` is still the curated host-neutral
  barrel (8 labeled sections, ~40 symbols over 12 `export` statements, no `corePackageReady` stub —
  the bare "13-export" count carried since §14 was stale and is dropped here for the stable
  section-based descriptor §9 used); `src/agent`/`src/model`/`src/latex`/`src/tools` remain
  **`vscode`-free** (grep clean).

### Step-7 plumbing advanced again by the drift (no action; ledger update)

§15 recorded the `RunCoordinatorBridge` injectable class and `InterruptRegistry.retainOnly`. This
period, **`executionRegistry` itself became an injectable `ExecutionRegistry` class** with a
constructor that injects `interrupts`/`processOutput`/`streamStatus` (defaulting to the singletons,
`executionRegistry.ts:108-119`) and an **instance-scoped** status subscription
(`this.disposeStatusListener = this.streamStatus.onDidChange(...)`, `:123`) — so §13 Finding-B's
"single module-level `StreamStatusRegistry.onDidChange` subscription" is no longer a module global;
a second `ExecutionRegistry` could be constructed with its own `streamStatus`/`interrupts` for
session isolation. Combined with §15's bridge and registry work, **nearly all of the Step-7
relocate-onto-an-injectable-handle direction is now realized by intervening simplification.** The
genuine remaining cross-session seam narrows to the **`clearAll*` reset sweep**
(`runCoordinators.ts:142` `cleanupAllRequests`, reachable via `tools/approval`); the scoped
per-stream variant already exists alongside it. Still no first-class `delegateTo(...)` primitive
(`grep` over `src/**` + `packages/**` empty); delegation remains a tool call inside the LLM loop.

### Re-rebutted false positives (an independent uninformed audit re-surfaced the recurring set)

A fresh agent-core audit run **without** sight of this document independently re-flagged the exact
candidates the ledger has adjudicated repeatedly. Re-confirmed with current line evidence at HEAD
`06cc9cb` so they are not re-litigated:

- **"`ResponseCycleNode`/`ToolUseCycleNode` are thin flow-wrappers — inline them" + "the
  `createResponseCycleFlow`/`createToolUseCycleFlow` factories are wrappers."** **Re-confirmed the
  prescribed shape** (§8/§9/§14/§16): these are the `Node.exec() → createFlow() → flow.run()`
  pattern CLAUDE.md's "Flattening Abstraction Layers" mandates — the same shape the deleted
  `ResponseCycle.ts`/`ToolUseCycle.ts` wrappers were refactored _into_. The post-split factories
  now wire the `toolUseCycle/` node graph (`ToolUseCycleFlow.ts:40-70`); they are entry points,
  not wrappers to inline.
- **"`CycleServices.ts` is an unnecessary interface layer — merge into `BaseFlowServices`."**
  **Keep.** `ResponseCycleServices`/`ToolUseCycleServices` add the per-flow `client`/`fileService`/
  `run`/`workspace`/`toolRegistry`/`session` fields that `BaseFlowContextInit` (the shared
  `AgentCore` contract) deliberately does not carry; collapsing them would push flow-specific
  fields onto every consumer of the base contract. Thin ≠ redundant.
- **"`buildWorkflowFlowResult`/`buildTerminalFlowResult`/`buildToolUseFlowResult` and the
  `toOutputSummaries`/`toCompileFailureSummaries` projections in `executeAgent.ts` are
  single-call factory helpers — inline them."** **Re-confirmed §2.4/§14 _keep_:** named
  result-mappers that keep the dispatch loop readable are endorsed, and `buildTerminalFlowResult`
  has multiple callers, so inlining would _duplicate_ the mapping.
- **"`helperModelName.ts` is a single-call helper — inline."** **Keep:** it has three external
  importers (`optionsLoader.ts`, `mergeCommands.ts`, `desktopProgressFileActions.ts`) plus the
  internal `helperModel.ts` caller — exactly why §16 extracted it from `helperModel.ts` and removed
  the dead re-export.

(The other agents, fed the audit context, re-confirmed the standing model-handler / logger /
platform verdicts: `IModelHandler` is not a duplicate of `ModelHandler`, the thin
OpenAI-compatible subclasses are a lean-keep, `redactSecrets` is not dead, `@texra/core` +
`src/platform/index.ts` remain the strongest SDK-aligned pieces. `createChannelTrace`
module-singletons now number 23 — the recorded judgment-call, not pursued.)

### Open ledger at HEAD `06cc9cb` (line numbers refreshed; all still present)

- **§2.6** — `src/agent/modelHandlers/modelHandlerValidation.ts` still in the production handler
  dir, gated by `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL` (`ModelFactory.ts:53`,
  dynamic-imported at `:327`). Relocate-with-injection (CLI machinery, not vitest-only) still
  recommended; still low priority.
- **§4** — token usage still a deliberate two-sink fan-out in `src/agent/utils/UsageMonitor.ts`:
  `runtimeHost.emit('updateStreamUsage', …)` `:155` (progress-view sidebar, **all** agents) and
  `logger.usage(payload, …)` `:164` gated to `AgentCategory.Workflow` `:160` (transcript stats
  line). Per §13 Finding A this is two audiences, not a duplicate — its fix is a sink
  consolidation onto `AgentTrace` preserving the workflow-only gate (a progress-view consumer
  rewire).
- **§5 / proposal Step 7** — no `delegateTo(...)` primitive; delegation remains a tool call. The
  Step-7 plumbing advanced again this period (the injectable `ExecutionRegistry` class with a
  per-instance status subscription, above); the remaining cross-session seam narrows to the
  `clearAll*` reset path (`runCoordinators.ts:142`). The keyed registries themselves need not move
  for correctness (no current single-session host exhibits a bug).
- **§3.1** — still no `@agent/runtime/index.ts` barrel; still optional polish.
- **§13 finding #1 (`AgentRuntimeHost.emit` mixes UI + essential events)** — unchanged; the
  headless-contract TSDoc is present, structural split deferred.
- **§16 #1 (`agentRegistry` UI-altitude)** — **mostly closed** by `2f062af` (the ordering policy
  and remote-meta are now separate modules); only the thin `computeAgentOptionsData` orchestrator
  residual remains — downgraded to optional polish.
- **§16 #2 (idempotent double `ensureAgentCategoryForSource`)** — **resolved (2026-06-13)**.
  The `assembleAgentLaunchContext` call was a provable no-op: `loadAgentSettingAndPrompts`
  already applies `ensureAgentCategoryForSource` before `AgentSettingSchema.parse`, and the
  schema prefaults `agentCategory` (to Workflow when absent), so `setting.agentCategory` is
  always populated by then; the only mutating branch (`source === 'builtInToolUse' &&
!agentCategory`) is therefore unreachable at that site, and remote agents (the early-return
  path) carry `source === 'remote'` which the function ignores regardless. Removed the second
  call + its import (`agentLoad.ts:123` remains the single, load-bearing call). Behavior-neutral.
- **§16 #4 (`@logger`↔`@agent/trace` import cycle)** — still present (`runTrace.ts:10` ↔
  `TraceEmitter.ts:18`); `a79295f`'s layering pass did not break it. Latent, low; for the eventual
  package-extraction step.
- **SDK-008** — remains CLOSED.

**Subagent split points — unchanged and accurate** (§5 + proposal): config-driven YAML agents
over the two flows (reflection / tool-use) + the `delegate_*` tools are the existing subagent
mechanism — re-evidenced this period by the chat→assistant rename landing as YAML/prompt + alias
migration; the `agentCategory` dispatch in `executeAgent` is the cleanest internal seam; the
helper-model tasks and the node-level candidates (`MediaExtractionNode`, `TeXCountNode`,
`OutputNode`, the `sessionDescription` background call) stay the lowest-risk extractions, gated
behind the same Step-7 coupling blocker.

**Net for 2026-06-11:** thesis reaffirmed for the twelfth pass — incremental, not structural. The
post-06-10 drift is the largest yet (100 files), and it is a team-driven monolith-modularization +
dead-code campaign that executed many of this audit's own recommendations (tool-use-cycle and
agent-registry splits, pass-through/factory flattening, four barrel deletions, knip dead-code
prune) and advanced Step-7 again (injectable `ExecutionRegistry`). It also **closed/downgraded**
§16 new-finding #1. **No refactor was applied this pass** — for the same reason §15 applied none:
every remaining item is behavior-sensitive (§4, §5/Step 7, §16 #2) or non-trivial (§2.6 is CLI
machinery; §5 is a multi-day primitive; §16 #4 is a package-extraction concern), and the team's
own simplification wave already removed the pure dead-code/anti-shim slack a tidy pass would
target. The remaining ledger shrinks to §2.6 (relocate), §4 (gated two-sink consolidation),
§5/Step 7 (now one unscoped reset-sweep seam), and three low-priority residuals (§16 #1
orchestrator move, #2 idempotent call, #4 import cycle). No rewrite warranted.

---

## 18. Re-verification addendum — 2026-06-14 (thirteenth pass — confirmation; the model-handler de-duplication recommendations are landing on main)

A thirteenth pass — four parallel fresh-eyes audits (agent core/runtime, model handlers,
logger, platform/public surface) plus a direct line-by-line re-check of every open-ledger
item against branch `claude/eager-noether-ahal3o` at HEAD `4f75594`. **All 2026-05-28 →
06-11 findings hold without change. No new structural over-abstraction surfaced.** Each
of the four independent audits, on its own, re-reached the standing verdict: TeXRA is
well-architected and SDK-aligned; the gaps are incremental, not structural. Like §15 and
§17 this is a **confirmation-only pass — no refactor applied** — because the intervening
drift is once again a team-driven simplification wave that executed several of this
audit's own model-handler de-duplication recommendations, leaving no pure
dead-code/anti-shim item for this pass to safely remove (the discipline is to apply only
those and defer behavior-touching ones).

### Drift since the §17 baseline — model-handler de-duplication + god-file decomposition, audited clean

The commits touching the audited dirs since §17 move entirely _with_ the audit — none adds
a wrapper, barrel, or run-entry indirection:

- **`774a63b` "Refactor client-side compaction into shared `ModelHandler` base class
  (#5950)."** Directly executes the proposal's §3.3 ("duplicated OpenAI streaming logic")
  and §3.5 ("hand-rolled Anthropic context management") de-duplication theme. The
  client-side compaction scaffold is hoisted to `ModelHandler.runClientCompaction()`
  (`ModelHandler.ts:795`) and `getCompactionThresholdPercent()` (`:778`); OpenAI-chat and
  OpenRouter now supply provider-specific summarize/message-build callbacks instead of
  copy-pasting ~100 LOC each, the two byte-identical threshold copies (OpenAI-chat,
  OpenAI-Response) are gone, and `addContinueMessageWithPrefill` became a concrete base
  no-op removing the redundant overrides. A pure de-duplication win — fewer LOC, no new
  indirection.
- **`ff5fcd5` "decompose OpenAI Responses `createResponseImpl` (#5954)."** The proposal's
  **Rejected-findings #2** ("split `modelHandlerOpenAIResponse.ts` — real smell, but a
  multi-day design migration, not a mechanical extraction; keep as a tracked refactor")
  is now being executed _exactly_ as prescribed: incrementally, in place,
  behavior-preserving. The 510-line `createResponseImpl` was split into a flat orchestrator
  plus focused private methods (`tryResumeBackgroundIfPending` / `executeWebSocketPath` /
  `executeStreamingPath` / `executeNonStreamingPath` / `handleCreateResponseError`),
  cutting try/catch nesting 4→1. The file is now **2610 LOC** (was 3328 when the proposal
  flagged it); the in-place collaborators (`OpenAIResponseWebSocketTransport`,
  `ResponseStreamProcessor`, `openAIResponseContent/Errors/FileUploads`,
  `responseStreamEvents`) remain the right home. Not a quick win was the right call — and
  the team is paying it down the prescribed way.
- **`0332bd9` "Rename `ToolUseCycleFlow` to `ToolUseRoundFlow` for clarity (#5947)."** Pure
  clarity rename: `core/flows/ToolUseCycleFlow.ts` → `ToolUseRoundFlow.ts` and
  `core/flows/toolUseCycle/` → `toolUseRound/` (`cycleShared.ts` → `roundShared.ts`). The
  §17 feature-detect site relocated intact to
  `toolUseRound/ToolUseDispatchNode.ts:433-438` (see the re-rebuttal below). No structural
  change.
- **`d7d6bc2` "simplify code changed since v0.38.7 (#5949)," `d6d4182` "share
  `clampOptional` and `joinNonEmpty."** Repo flatten/DRY rules applied — small, additive,
no surface change. **`4f75594` "Replace async-lock with async-mutex (#5953)"** is a
  dependency swap, not a structural change to the audited surface.

**Guardrails intact:** `find src/agent -name index.ts` shows **no new barrel** (the eight
pre-existing ones — `types`/`node`/`trace`/`goal`/`features`/`implementations/flows/tooluse`/
`storage`/`index` — are unchanged; `src/agent/runtime/index.ts` is still absent, §3.1); no
new run-entry wrapper; `grep` for `vscode` imports over `src/agent`/`src/model`/`src/latex`/
`src/tools` is **clean** (vscode-free).

### Re-rebutted false positive (`IModelHandler` redundant — re-flagged a seventh time)

The fresh model-handler audit again re-surfaced "`IModelHandler` is a redundant duplicate
of `ModelHandler` — delete the port." **Refuted, verified at HEAD.** The optional
`createBatchedToolUseFollowUpMessages?(...)` is still declared only on the port
(`types/IModelHandler.ts:392`, with `?`), not on the abstract base, and is still
feature-detected on the port-typed handler at
`toolUseRound/ToolUseDispatchNode.ts:433-434`
(`modelHandler.requiresBatchedParallelToolResults && !!modelHandler.createBatchedToolUseFollowUpMessages`)
then called with `!` at `:438`. The site simply moved with the §17→§18 `ToolUseRoundFlow`
rename; the seam is unchanged. Consistent with §9/§12/§13/§14/§15/§16/§17. **Not redundant;
do not delete.**

### Open ledger at HEAD `4f75594` (line numbers refreshed; all still present)

- **§2.6** — `src/agent/modelHandlers/modelHandlerValidation.ts` still in the production
  handler dir, gated by `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL` (`ModelFactory.ts:53`,
  dynamic-imported at `:327`). Relocate-with-injection (CLI machinery, not vitest-only)
  still recommended; still low priority.
- **§4** — token usage still a deliberate two-sink fan-out in
  `src/agent/utils/UsageMonitor.ts`: `runtimeHost.emit('updateStreamUsage', …)` `:154`
  (progress-view sidebar, **all** agents) and `logger.usage(payload, …)` `:163` gated to
  `AgentCategory.Workflow` `:159` (transcript stats line). Per §13 Finding A this is two
  audiences, not a duplicate — its fix is a sink consolidation onto `AgentTrace` preserving
  the workflow-only gate (a progress-view consumer rewire).
- **§5 / proposal Step 7** — no first-class `delegateTo(...)` primitive (`grep delegateTo`
  over `src/**` + `packages/**` empty); delegation remains a tool call. The Step-7 plumbing
  landed in prior periods (injectable `ExecutionRegistry` / `RunCoordinatorBridge` /
  `InterruptRegistry`); the remaining cross-session seam is still the **`clearAll*` reset
  sweep** (`runCoordinators.ts:142` `cleanupAllRequests` → `clearAll{PlanApprovals,Proposals,
RetryRequests}` `:148/:171/:181`, reachable via `tools/approval`). The keyed registries
  themselves need not move for correctness (no current single-session host exhibits a bug).
- **§3.1** — still no `@agent/runtime/index.ts` barrel; still optional polish (the
  `@texra/core` and `src/platform/index.ts` surfaces already cover the underlying concern).
- **§13 finding #1 (`AgentRuntimeHost.emit` mixes UI + essential events)** — unchanged; the
  two-tier headless-contract TSDoc is present (`AgentRuntimeHost.ts:4-23`), structural split
  deferred.
- **§16 #1 (`agentRegistry` UI-altitude)** — unchanged from §17: only the thin
  `computeAgentOptionsData` orchestrator (`agentRegistry.ts:477`) still sits beside the
  SDK-exported core; the ordering policy (`sortAgentEntries`/`entryToOptionData`) lives in
  `index/agentOptionsBuilder.ts`. Optional polish (mostly closed).
- **§16 #2 (idempotent double `ensureAgentCategoryForSource`)** — still present
  (`agentLoad.ts:123` + `AgentLaunchContext.ts:214`, drifted from `:188`); deliberately
  deferred as behavior-touching.
- **§16 #4 (`@logger`↔`@agent/trace` import cycle)** — still present (`runTrace.ts:10`
  imports `TraceEmitter` from `@agent/trace`; `TraceEmitter.ts:18` imports
  `@logger/logUtils`). Latent, low; for the eventual package-extraction step.
- **SDK-008** — remains CLOSED (`core/config.ts` absent; `core/stateStore.ts` retains only
  the pre-init-tolerant `tryGetWorkspaceState` `:19`, the audit-endorsed keep).

**Subagent split points — unchanged and accurate** (§5 + proposal): config-driven YAML
agents over the two flows (reflection / tool-use — now `ToolUseRoundFlow`) + the `delegate_*`
tools are the existing subagent mechanism; the `agentCategory` dispatch in `executeAgent` is
the cleanest internal seam; the helper-model tasks and node-level candidates
(`MediaExtractionNode`, `TeXCountNode`, `OutputNode`, the `sessionDescription` background
call) stay the lowest-risk extractions, gated behind the same Step-7 coupling blocker.

**Net for 2026-06-14:** thesis reaffirmed for the thirteenth pass — incremental, not
structural. The post-06-11 drift is a focused model-handler de-duplication wave that
executed proposal §3.3/§3.5 (shared client-side compaction in the base class) and began
paying down Rejected-finding #2 the prescribed in-place way (OpenAI Responses god-file
510-line method decomposed; file down to 2610 LOC), plus a clarity rename
(`ToolUseRoundFlow`) and small DRY shares — none adding a wrapper, barrel, or run-entry
indirection. **No refactor was applied this pass** — for the same reason §15 and §17 applied
none: every remaining item is behavior-sensitive (§4, §5/Step 7, §16 #2) or non-trivial
(§2.6 is CLI machinery, not a straight move; §5 is a multi-day primitive; §16 #4 is a
package-extraction concern), and the team's own simplification wave already removed the pure
dead-code/anti-shim slack a tidy pass would target. The remaining ledger is unchanged:
§2.6 (relocate), §4 (gated two-sink consolidation), §5/Step 7 (one unscoped reset-sweep
seam), and three low-priority residuals (§16 #1 orchestrator move, #2 idempotent call, #4
import cycle). No rewrite warranted.

---

## 19. Re-verification addendum — 2026-06-15 (fourteenth pass — confirmation; F-2 control handle + F-1 emit re-route land, two long-standing items close)

A fourteenth pass — a fresh-eyes model-handler + agent-core/runtime audit (independent, no
sight of this document) plus a direct line-by-line re-check of every open-ledger item and the
logger/platform surface against branch `claude/eager-noether-bpuuje` at HEAD `00d2414`
(baseline for drift: §18's `4f75594`, **reachable** from this branch — the first time in
several passes the prior baseline is an ancestor, so the diff _range_ `4f75594..00d2414` is
exactly computable, not approximated across lineages as prior passes had to). That range is
~60 non-merge commits over the audited surfaces; the **Drift** section below enumerates only
the SDK-_structural_ subset (the new run-entry/handle/emit/state work). The unenumerated
remainder is behavior fixes (subagent handoffs, approval gating, blank-tool-result turns) and
tests, plus further simplification that moves _with_ the audit — DRY/flatten/dependency swaps
such as `fad5fd6` (replace hand-rolled utilities with `p-debounce`/Zod), `bb8b6d1` (share
tool-edit approval prompt emission across hosts), `68c3809` (flatten nested try/catch via
helper extraction) — **none adding a wrapper, barrel, or abstraction** (the guardrail greps
below — no new `index.ts`, vscode-free — are what back the "no new structural over-abstraction"
conclusion, not the enumerated list). **All 2026-05-28 → 06-14 findings hold without change.
No new structural over-abstraction surfaced.** TeXRA remains well-architected and SDK-aligned; the gaps are incremental, not
structural. Like §15/§17/§18 this is a **confirmation-only pass — no refactor applied** —
because no pure dead-code/anti-shim item remains for a tidy pass to safely remove (the
independent audit found **zero** `export … from` re-export lines and **zero** dead modules
across `modelHandlers/`, `core/`, `runtime/`; counts of live importers run 1–18). But unlike
the recent confirmation passes, the intervening drift is **SDK-meaningful**: it advances or
closes four ledger items, including the two largest open structural gaps (the per-run
streaming handle and the F-1 host-path emit re-route).

### Drift since the §18 baseline (`4f75594` → `00d2414`) — SDK-boundary work landing, audited clean

The commits touching the audited dirs move entirely _with_ the audit — none adds a wrapper,
barrel, or run-entry indirection:

- **`84052a4` "F-2 — expose the per-run control handle (onRun + trace + result)."** This is
  the proposal's **SDK-002** gap ("there is no streaming run entry … neither is an
  async-iterable … progress is a side channel") substantially closing. `AgentExecutionHandle`
  (`runtime/ExecutionHandle.ts:70`) now carries `trace` (the run's discriminated `AgentEvent`
  channel, `:99`) and `result: Promise<ResultEvent>` (`:86`) — an always-resolving deferred
  settled exactly once via the idempotent `settleResult` (`:108`), in both lifecycle arms; and
  `onRun?(handle)` fires once after the handle is tracked. The return type is **unchanged**
  (still `Promise<AgentFlowResult>`), so this is purely additive. `@texra/core` re-exports the
  **narrowed** `type AgentRunHandle` (`packages/core/src/index.ts:80`) + `type ResultEvent`
  (`:105`) — _not_ the concrete `AgentExecutionHandle` class, which stays internal (re-exported
  only from `executionRegistry`). The public handle is deliberately a
  `Pick<AgentExecutionHandle, 'executionId' | … | 'trace' | 'result' | 'getProgress'>`
  (`ExecutionHandle.ts:148`), and `onRun` itself hands consumers that `AgentRunHandle`, not the
  impl class (`AgentRunLifecycle.ts:47`) — the narrowed-surface-over-impl distinction is the
  point. So an SDK consumer can now await a run's typed terminal outcome and read its event
  channel by handle — the SDK `query() → Query` handle shape, over the existing engine rather
  than a rewrite. The §10/Step-6 "infeasible-as-scoped without Step 7" note is now overtaken:
  Step 7d landed and the handle followed.
- **`96f63e8` "SDK Step 7d: per-session `SessionHandle` + terminal `result` event
  (consolidated) (#5960)"** and **`c0b7478` "Extract `IToolUseSession` to core/flows module
  (#5968)."** Step 7d's consolidated train is in this lineage's history (the proposal already
  marked 7d landed 2026-06-13; re-confirmed in tree — `runtime/SessionHandle.ts`,
  `terminalResultToast.ts` present). The independent audit re-confirmed both new handle files
  are **composition records, not facades**: `SessionHandle` composes four landed owners in a
  forced dependency order; `ExecutionHandle` holds two distinct concrete classes
  (`AgentExecutionHandle` / `ProcessExecutionHandle`) over one interface with real polymorphic
  behavior. Neither re-exposes per-concern methods.
- **`ee4645e` "centralize tool progress emits (#5975)."** Directly executes the proposal's
  **Step-7d "Remaining for F-1" criterion (a)** ("one emission path for run-scoped events").
  New `runtime/emitRuntimeEvent.ts` (`emitRuntimeEvent(event, payload, session?)`) replaces the
  direct `src/tools` progress-`bus.emit` sites that CLAUDE.md grandfathered "until SDK Step 7d,"
  preserving explicit `SessionHandle` routing for the host-path external-inquiry events. Adopted
  in `tools/goal/goalStore.ts`, `tools/inquiry/ExternalInquiryTool.ts`,
  `tools/inquiry/inquiryContinuation.ts` (grep). The remaining `this.emit(...)` calls in
  `src/tools/github/*PollingSource.ts` are those classes' **own** `EventEmitter`, not the
  run-scoped `ProgressEventBus` — out of scope for F-1, correctly untouched.
- **`cf1479d` "residues — scope desktop approval delete-all per stream."** **Fixes the §5
  multi-session reset-sweep bug**, not just narrows it: desktop `cleanupAllApprovals` (whose
  tool/bypass controllers are `streamId`-keyed and global) now loops the per-stream
  `cleanupApprovalsForStream(streamId, this.session)` over its own streams, so one window's
  "delete all" no longer rejects **every** window's pending approvals. The process-wide
  `cleanupAllApprovals` / `runCoordinators.cleanupAllRequests` (`runCoordinators.ts:142`) is
  **kept and documented** as single-session-reset / test / shutdown — the audit's standing
  "relocate-or-scope, never delete" prescription, applied.
- **`a982e72` "move `tryWorkspaceState` to platform" (2026-06-15).** **Deepens SDK-008
  past CLOSED.** `src/agent/core/stateStore.ts` is now **deleted entirely** (was the last
  domain-layer state accessor); `tryWorkspaceState()` joins its twin `tryGlobalState()` in
  `src/platform/platform.ts` (`:+5`), the `@platform` barrel exports it
  (`src/platform/index.ts:+1`), and the `core/README.md` + `common/state/index.ts` comments
  that called out the split path are reconciled. `@agent/core/` no longer owns a platform
  concern. Grep confirms no dead `core/stateStore` references in `src/agent/**` (the surviving
  `stateStore` hits are the unrelated desktop-auth `createStateStore` / CLI
  `createCliStateStores`).
- **`00d2414` "surface agent review in source control."** A new user-facing review feature —
  product code, **not** an abstraction change to the audited surface (no new barrel/wrapper).

**Guardrails intact:** `find src/agent -name index.ts` shows the **same eight** pre-existing
barrels (no new one); `src/agent/runtime/index.ts` still absent (§3.1); `grep` for `vscode`
imports over `src/agent`/`src/model`/`src/latex`/`src/tools` is **clean**; `@logger` imports
nothing from `@platform` (decoupled); `@texra/core` is still the curated host-neutral barrel
(now 16 `export` statements — grown only by additive handle/session re-exports: the narrowed
`AgentRunHandle` (F-2) and the Step-7d `SessionHandle`/`defaultSession`; no surface removed).

### Two long-standing ledger items close/advance this period

- **§16 #2 (idempotent double `ensureAgentCategoryForSource`) — RESOLVED on this lineage.**
  The second call in `AgentLaunchContext` is **gone**; only an explanatory comment remains
  (`AgentLaunchContext.ts:224-227`: "`loadAgentSettingAndPrompts` already applies … a second
  pass would be a guaranteed no-op"). `agentLoad.ts:123` is the single, load-bearing call.
  (§17 had resolved it on the `3mei4j` lineage 2026-06-13; §18's `ahal3o` lineage still
  carried it; this branch has it removed — the two lineages have now converged on resolved.)
- **§5 / Step 7 reset-sweep seam — the genuine bug is fixed** (`cf1479d`, above). What
  remains is the deliberately-retained process-wide reset for single-session/shutdown, no
  longer reachable as a cross-window foot-gun. Still no first-class `delegateTo(...)` primitive
  (`grep` over `src/**` + `packages/**` empty); delegation remains a tool call inside the LLM
  loop — the one structurally-open item, and a multi-day primitive by design.

### Re-rebutted false positive (`IModelHandler` redundant — would have been the eighth)

The independent fresh-eyes audit did **not** re-flag it this pass — it verified
`IModelHandler` is typed into `AgentCore.modelHandler` (`core/flows/BaseFlowServices.ts:24-30`)
and recorded it as load-bearing, not a `ModelHandler` duplicate. Consistent with §9–§18.

### One marginal observation (NOT a finding — recorded so it is not re-discovered)

`modelHandlers/utils/usageNormalization.ts` is a single 6-line pure function
(`computeCachePercentage`) in its own file with exactly one importer
(`support/UsageNormalizer.ts`). Inlinable in principle, but it is genuine named shared logic
with no wrapper/delegation/factory/shim smell — it violates no CLAUDE.md anti-pattern. **Not
worth a change** (consistent with the §16 `helperModelName` lean-keep reasoning).

### Open ledger at HEAD `00d2414` (line numbers refreshed; all still present unless noted)

- **§2.6** — `src/agent/modelHandlers/modelHandlerValidation.ts` still in the production
  handler dir, gated by `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL` (`ModelFactory.ts:53`,
  dynamic-imported at `:327`). Relocate-with-injection (CLI machinery, not vitest-only) still
  recommended; still low priority.
- **§4** — token usage still a deliberate two-sink fan-out in `src/agent/utils/UsageMonitor.ts`:
  `runtimeHost.emit('updateStreamUsage', …)` `:167` (progress-view sidebar, **all** agents) and
  `logger.usage(payload, …)` `:176` gated to `AgentCategory.Workflow` `:172` (transcript stats
  line; the two-audience rationale is documented at `:63`). Per §13 Finding A this is two
  audiences, not a duplicate — its fix is a sink consolidation onto `AgentTrace` preserving the
  workflow-only gate. **Note:** `ee4645e`'s `emitRuntimeEvent` is the routing primitive this
  consolidation will eventually ride; the producer-side de-dup (criterion (b)) is still deferred
  as behavior-touching.
- **§5 / proposal Step 7** — no `delegateTo(...)` primitive; the cross-window reset-sweep bug is
  **fixed** (`cf1479d`); the retained `cleanupAllRequests` (`runCoordinators.ts:142`) is the
  documented single-session/shutdown reset. The keyed registries need not move for correctness.
- **§3.1** — still no `@agent/runtime/index.ts` barrel; still optional polish.
- **§13 finding #1 (`AgentRuntimeHost.emit` mixes UI + essential events)** — unchanged; the
  two-tier headless-contract TSDoc is present (`AgentRuntimeHost.ts:6-23`), structural split
  deferred.
- **§16 #1 (`agentRegistry` UI-altitude)** — unchanged from §17/§18: only the thin
  `computeAgentOptionsData` orchestrator (`agentRegistry.ts:477`) still sits beside the
  SDK-exported core; the ordering policy (`sortAgentEntries`/`entryToOptionData`) lives in
  `index/agentOptionsBuilder.ts`. Optional polish (mostly closed).
- **§16 #2** — **RESOLVED** on this lineage (above).
- **§16 #4 (`@logger`↔`@agent/trace` import cycle)** — still present (`runTrace.ts:10` imports
  `TraceEmitter` from `@agent/trace`; `TraceEmitter.ts:18` imports `@logger/logUtils`). Latent,
  low; for the eventual package-extraction step.
- **SDK-008** — **CLOSED and deepened**: `core/stateStore.ts` removed entirely (`a982e72`);
  `tryWorkspaceState`/`tryGlobalState`/`tryPlatform` now live together in `@platform`.

**Subagent split points — unchanged and accurate** (§5 + proposal): config-driven YAML agents
over the two flows (reflection / `ToolUseRoundFlow`) + the `delegate_*` tools are the existing
subagent mechanism; the `agentCategory` dispatch in `executeAgent` is the cleanest internal
seam; the helper-model tasks and node-level candidates (`MediaExtractionNode`, `TeXCountNode`,
`OutputNode`, the `sessionDescription` background call) stay the lowest-risk extractions, gated
behind the same delegation-as-primitive (§5) work. The new F-2 per-run handle (`trace` +
`result` + `onRun`) is the consumer-facing surface a future `delegateTo(...)` primitive would
return.

**Net for 2026-06-15:** thesis reaffirmed for the fourteenth pass — incremental, not
structural — but this is the most SDK-meaningful drift in several passes. The post-06-14 work
lands the **F-2 per-run control handle** (closing the bulk of SDK-002 — a typed `result`
promise + `trace` channel + `onRun`, surfaced through `@texra/core`), **begins the F-1
host-path emit re-route** (`emitRuntimeEvent`, criterion (a)), **fixes the §5 cross-window
approval reset bug**, and **deepens SDK-008** (the domain-layer `stateStore.ts` deleted). Two
long-standing ledger items close (§16 #2 resolved here; §5's genuine bug fixed). An independent
fresh-eyes audit of model handlers + agent core found **no new over-abstraction** and **no dead
shim/barrel** to remove, so — consistent with the discipline — **no refactor was applied**: the
only remaining items are behavior-sensitive (§4 producer de-dup, §16 #4 cycle) or a multi-day
primitive (§5 `delegateTo`). The codebase continues to acquire exactly the SDK-shaped surface
the original audit projected, by its own team, without a rewrite.

## 20. Re-verification addendum — 2026-06-17 (fifteenth pass — confirmation; two dead re-export lines removed from the `agent/index` barrel, UI-altitude helpers relocated out of the registry)

A fifteenth pass — a fresh four-agent fan-out (independent, no sight of this document): a
Claude Agent SDK reference pass, a structural map + abstraction audit of `agent/core` +
`implementations/flows` + `runtime` + `node`, a model-handler + logger + `model/` audit, and a
public-surface (`@agent/*` consumer) map — plus a direct re-check of every open-ledger item and
the guardrail greps against branch `claude/eager-noether-pfab9a` at HEAD `df0ca92` (baseline for
drift: §19's `00d2414`, **reachable** from this branch, so the range `00d2414..df0ca92` is exactly
computable). That range is **61** non-merge commits (`git rev-list --no-merges --count
00d2414..df0ca92` = 61). As in §14/§19, the **Drift** section below enumerates only the
SDK-_structural_ subset (the new run-entry/handle/emit/state work); it is **not** the full list of
commits touching the audited dirs. The unenumerated remainder is behavior fixes (subagent
handoffs, goal-continuation, remote-loader null-tolerance such as `ea0f239`) and DRY/shared-helper
adoption (e.g. `a47b7c7`, `0b8d549` over `src/tools`) — **none adding a wrapper, barrel, or
abstraction** (the guardrail greps below — no new `index.ts`, vscode-free, unchanged `@texra/core`
surface — are what back the "no new structural over-abstraction" conclusion, not the enumerated
list). **All 2026-05-28 → 06-15 findings hold without change. No new structural over-abstraction
surfaced.** TeXRA remains well-architected and SDK-aligned; the gaps are
incremental, not structural. Like §15/§17/§18/§19 this is a **confirmation-only pass — no refactor
applied** — because no pure dead-shim/barrel item remains (the one that did surface this period the
team already removed itself; see `75154a3` below).

### The four independent agents re-reached the standing verdict (recorded, not re-flagged)

Consistent with §14/§16/§17, the fresh-eyes agents — given only the source, not this audit —
re-converged on "well-layered, incremental not structural" and re-surfaced the documented traps:

- The core/runtime agent flagged the `ToolUseCycleNode`/`ResponseCycleNode` "`exec()` marshals
  state → runs the inner cycle flow → interprets the outcome" shape as a removable wrapper
  (Medium). **Re-rebutted** (consistent with the proposal's "PocketFlow flow layer — do NOT
  refactor" row): `ToolUseCycleNode.exec` (`tooluse/nodes/ToolUseCycleNode.ts:44-132`) is not
  trivial indirection — it owns real per-round orchestration (the `getClient`/`refreshClient`
  closure pair, the `workPlan.setOnUpdate` todo/plan wiring with a drained `todoPersistChain`,
  and the outcome→`shared` state mapping in `post`). This is the legitimate node-runs-subflow
  composition, not a layer to inline.
- The model-handler agent re-flagged `IModelHandler` (471 LOC / ~50 methods) as a "large /
  could-be-partitioned" surface — the **eighth** re-surfacing of the `IModelHandler`-is-redundant
  family. **Re-rebutted** (consistent with §9–§19): the interface is typed into
  `AgentCore.modelHandler` (`core/flows/BaseFlowServices.ts:24-30`) and declares the optional
  `createBatchedToolUseFollowUpMessages?` (`IModelHandler.ts:392`) the abstract class omits and
  `ToolUseDispatchNode` feature-detects (`ToolUseDispatchNode.ts:434`, `!!modelHandler.…`) —
  load-bearing, not a `ModelHandler` duplicate. Surface size is SDK-maturity,
  not redundancy; no member is dead.
- The public-surface agent reported the `core/`/`runtime/` "no-barrel" deep-import sprawl
  (~178 files, hundreds of deep `@agent/*` imports) as a surface-narrowing opportunity via new
  barrels. **Re-rebutted** (consistent with §3.1 / Step 4 / Step 5): the team's anti-shim
  convention is deliberate, `@texra/core` _is_ the curated barrel, and a `core/`/`runtime/index.ts`
  was explicitly rejected as "pure churn" without a lint gate (risks TS init-order cycles on the
  value exports). The one runtime barrel proposed every pass stays unbuilt by design.

### Drift since the §19 baseline (`00d2414` → `df0ca92`) — moves with the audit; one team-applied anti-shim removal

None of the audited-dir commits add a wrapper, barrel, or run-entry indirection:

- **`75154a3` "move stream metadata helpers out of agent registry" (2026-06-16).** **Advances
  §16 #1** and applies the audit's own anti-shim discipline: it **removed the two now-dead
  `streamTabInfo`/`worktreeInfo` re-export lines from the `agent/index` barrel**
  (`src/agent/index/index.ts` −2 lines; the barrel file itself stays — it is one of the eight
  live barrels counted in the guardrails below) and relocated `streamTabInfo.ts`
  → `shared/progressView/backend/` (next to the progress-view backend that consumes it) and
  `worktreeInfo.ts` → `utils/git/`, so callers hit the canonical locations directly. UI-altitude
  stream/worktree display logic no longer sits in the SDK-exported agent registry — exactly the
  §16 #1 "move the UI-altitude helpers off the core surface" prescription, applied by the team.
- **`8ff982f` / `b7164d8` "make agent lookup context explicit" / "clarify CLI agent lookup
  priority"** and **`1454787` "centralize CLI agent launch validation."** Clarity/DRY refactors of
  the agent-lookup + CLI launch-validation paths; `git show --stat` shows **no** new `index.ts`
  and no new file in the audited dirs — naming/centralization, not new abstraction.
- **`e18f842` / `2a0ea45` "keep goal continuation guards in wait node" / "simplify goal
  continuation rendering"**, **`ee6a27a` "summarize subagent XML in CLI transcript"**, **`68989e7`
  "drop google tool-call control glyphs"**, **`efcc228` "adopt shared text and extension
  helpers."** Behavior fixes + DRY (shared-helper adoption) — move _with_ the audit; no wrapper.

**Guardrails intact:** `find src/agent -name index.ts` shows the **same eight** pre-existing
barrels (no new one); `src/agent/runtime/index.ts` still absent (§3.1); `grep` for `vscode`
imports over `src/agent`/`src/model`/`src/latex`/`src/tools`/`src/controllers`/`src/shared`/
`src/eventBus`/`src/hosts` is **clean**; `@logger` imports nothing from `@platform`; `@texra/core`
is still **16** `export` statements (unchanged — no surface added or removed this period). The lone
`export … from` in the audited dirs (`runtime/executionRegistry.ts:37`,
`export type { ExecutionHandle } from './ExecutionHandle'`) is a **type-only** re-export of the
§19-documented F-2 handle — load-bearing narrowed surface, not a dead shim (§19 already noted
`ExecutionHandle` is "re-exported only from `executionRegistry`").

### Open ledger at HEAD `df0ca92` (line numbers refreshed; all still present unless noted)

- **§2.6** — `modelHandlers/modelHandlerValidation.ts` still in the production handler dir
  (`TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL`-gated); relocate-with-injection still low priority.
- **§4** — `UsageMonitor` two-sink fan-out **unchanged**: `runtimeHost.emit('updateStreamUsage', …)`
  (`UsageMonitor.ts:167`, all agents) + `logger.usage(…)` gated to `AgentCategory.Workflow`
  (`:172/:176`). Two audiences, not a duplicate; producer-side de-dup (criterion (b)) still
  deferred as behavior-touching; `emitRuntimeEvent` remains the routing primitive it will ride.
- **§5 / Step 7** — still no `delegateTo(...)` primitive (`grep` over `src/**` + `packages/**`
  empty); delegation remains a tool call inside the LLM loop — the one structurally-open item,
  multi-day by design. Cross-window reset-sweep bug stays fixed (§19, `cf1479d`).
- **§3.1** — still no `@agent/runtime/index.ts`; still optional polish, re-rejected this pass.
- **§13 finding #1** (`AgentRuntimeHost.emit` mixes UI + essential events) — unchanged; two-tier
  headless-contract TSDoc present; structural split deferred.
- **§16 #1** (`agentRegistry` UI-altitude) — **advanced** by `75154a3` (stream/worktree helpers
  relocated out, dead re-export shim removed); only the thin `computeAgentOptionsData` orchestrator
  (`agentRegistry.ts:481`) still sits beside the SDK-exported core. Closer to closed.
- **§16 #2** — RESOLVED (§19); unchanged.
- **§16 #4** (`@logger`↔`@agent/trace` cycle) — still present (`src/logger/runTrace.ts:10`
  imports `TraceEmitter` from `@agent/trace`); latent, low; for the eventual package-extraction
  step.
- **SDK-008** — CLOSED and deepened (§19); unchanged.

**Subagent split points — unchanged and accurate** (§5 + proposal): config-driven YAML agents over
the two flows (reflection / `ToolUseRoundFlow`) + the `delegate_*` tools are the existing subagent
mechanism; the `agentCategory` dispatch in `executeAgent` is the cleanest internal seam; the
helper-model tasks and node-level candidates stay the lowest-risk extractions, gated behind the
delegation-as-primitive (§5) work. The F-2 per-run handle (`trace` + `result` + `onRun`) remains
the consumer-facing surface a future `delegateTo(...)` would return.

**Net for 2026-06-17:** thesis reaffirmed for the fifteenth pass — incremental, not structural.
The intervening drift is small and moves entirely _with_ the audit: the team removed two dead
re-export lines from the `agent/index` barrel and relocated those UI-altitude stream/worktree
helpers out of the SDK-exported registry (`75154a3`, advancing §16 #1), plus clarity/DRY refactors
that add no abstraction. Four independent fresh-eyes agents re-reached the standing verdict and re-surfaced
the recurring traps (node-runs-subflow "wrapper", `IModelHandler` redundant for the eighth time,
`core/runtime` barrels) — all re-rebutted as in prior passes. Guardrails are intact; no dead
shim/barrel remains for a tidy pass to remove, so no refactor was applied. The remaining open
items are behavior-sensitive (§4 producer de-dup, §16 #4 cycle) or the multi-day §5 `delegateTo`
primitive — exactly the residue the original audit projected.

## 21. Re-verification addendum — 2026-06-20 (sixteenth pass — confirmation; small net-new core backlog candidates recorded)

A sixteenth pass — a fresh three-agent fan-out (independent, given only the source, not this
document): an `agent/core` + `implementations/flows` abstraction audit, a `modelHandlers/` +
`toolConversion` audit, and a logger + `platform/` + run-entry surface audit — run against branch
`claude/eager-noether-eb5m6f` at HEAD `5a5f6f8` (no audited-dir drift vs §20's `df0ca92`
baseline reachable on this branch; `5a5f6f8` is the recent edit-approval/output-policy/extract
train: `#6332`/`#6330`/`#6325`/`#6324`/`#6323` — pure DRY/extract refactors, no new abstraction).
**All 2026-05-28 → 06-17 findings hold without change. No new structural over-abstraction
surfaced; the standing verdict is reaffirmed for the sixteenth time** — TeXRA is well-architected
and SDK-aligned, the gaps are incremental not structural. Like §15/§17–§20 this is a
**confirmation-only pass — no refactor applied** — because the genuinely-new items below are all
behavior-touching (union-shape, threaded type-params, host-port arity, batched-semantics), none a
zero-risk dead-shim/barrel removal.

### The three independent agents re-reached the standing verdict and re-surfaced the recurring traps

Consistent with §14/§16/§17/§20, the fresh-eyes agents re-converged on "well-layered, incremental
not structural" and re-surfaced the documented traps — all re-rebutted as before:

- The model-handler agent re-flagged **`IModelHandler` (471 LOC / ~45 members) as a redundant
  duplicate of the `ModelHandler` abstract base** and recommended deleting it — the **ninth**
  re-surfacing of the `IModelHandler`-is-redundant family. **Re-rebutted** (consistent with
  §9–§20 and the proposal's rejected-findings table): the interface declares the _optional_
  `createBatchedToolUseFollowUpMessages?` (`IModelHandler.ts:392`) the abstract class omits and
  `ToolUseDispatchNode` feature-detects (`ToolUseDispatchNode.ts:434`); it is typed into
  `AgentCore.modelHandler` (`BaseFlowServices.ts:24-30`). Load-bearing, not a duplicate. (See the
  one constructive net-new angle on this below.)
- The model-handler agent re-proposed **`ModelHandler → ModelHandlerOpenAIBase → {Chat, Responses}`
  consolidation** and **folding `OpenRouterNative` into the OpenAI base**. The OpenAI-base
  consolidation is the **already-tracked** multi-day migration (proposal "Split
  `modelHandlerOpenAIResponse`" rejected-as-quick-win; §18 notes the de-dup is _landing on main_);
  the OpenRouter merge is the proposal's **explicitly rejected** finding (two real SDK type
  families + OpenRouter-only `reasoningDetails`; the exact subclassing was deliberately deleted in
  PR #2962). Not net-new; do not re-flag as a fresh structural win.

### Genuinely-new candidates recorded for the backlog (verified first-hand; none are blockers, none applied)

These are small and do **not** appear in any prior section (grep'd: zero hits for
`ToolSessionState`/`FlowParams`/`CycleParams`/`agentResume`/`recordRound` across both audit docs).
Each is behavior-touching, so each is recorded for a future tidy pass, not applied here:

- **`ToolSessionState` is a vestigial empty type threaded through the `TaskState` union.**
  `ToolSessionStateSchema = z.object({})` (`core/execution/TaskState.ts:11`), surfaced at `:33`/`:55`,
  type at `:63`. The only production writer sets it to `{}` (`agent/utils/agentConfigToTaskState.ts:35`);
  it carries no data and the `ToolUseTaskState` branch is already distinguishable by `agentCategory`.
  The empty schema + field + type export are dead weight. _Not zero-risk:_ removing the field
  changes the union shape and a test fixture (`ChildStreamProgressEvents.vitest.ts`) sets it — a
  tidy-with-test-update, not a pure shim delete.
- **`TaskState` re-derives the category split via `.refine()` + `as z.ZodType<…>` casts**
  (`TaskState.ts:18-75`, escape-hatch casts at `:41`/`:46`) over the same `agentCategory` field that
  `AgentSettingSchema` already models as a proper `z.discriminatedUnion('agentCategory', …)`
  (`AgentDataclass.ts:69-75`). The wrapper adds a second, weaker discriminator (refine, not
  discriminated union) plus `isWorkflowTaskState`/`isToolUseTaskState` guards over an
  already-discriminated concept. Candidate to rebuild on a real discriminated union (removes the
  two casts).
- **Empty params-bag aliases — `FlowParams`/`CycleParams` + the two re-export aliases.**
  `CycleParams = Record<string, unknown>` (`core/flows/CycleServices.ts:59`); `FlowParams` is the same
  `{ [key: string]: unknown }` (`BaseFlowServices.ts`), re-exported under two more names
  `ToolUseFlowParams` (`tooluse/ToolUseServices.ts:52`) and `ReflectionFlowParams`
  (`reflection/ReflectionServices.ts:38`) and threaded as a type-param through ~13 node signatures
  (every `tooluse/nodes/*` + `reflection/nodes/*`). The bag is **never populated** — no flow passes
  params. Three names for an unused `Record`; candidate to collapse to one (or drop the type-param).
- **`platform().agentResume` is a required host port with only two production call sites.**
  `ToolUseFollowUp.ts:67` and `inquiry/inquiryContinuation.ts:138` — yet every production host must
  implement it (`extension.ts:207`, `cli/.../initPlatform.ts:206`,
  `packages/desktop/src/main/platform/index.ts:136`). It abstracts a
  host-command "resume the stream" UI-orchestration concern that sits on the always-present core
  `Platform` port set. Candidate to demote to an optional/nullable port (3-host touch), narrowing
  the SDK-exported surface. (Companion observation: `toolAvailability` is similarly two booleans
  each used once, but it ships a frozen `NO_TOOL_AVAILABILITY_HOST` default — lower priority.)
- **`AgentState.recordRound` is a trivial 3-field forwarding wrapper** over `recordCycleMetrics`
  (`core/execution/AgentState.ts:49-59`; two callers — `ResponseCycleFlow.ts`, `ResponseCycleNode.ts`).
  The CLAUDE.md "trivial forwarding wrapper" shape; inline-or-merge candidate (trivial).

### One constructive net-new angle on the recurring `IModelHandler` trap (recorded, not applied)

The model-handler agent independently noted that `createBatchedToolUseFollowUpMessages` — the
single optional member that makes `IModelHandler` load-bearing (the basis of every prior rebuttal)
— is a **Google-batched-tool-results quirk** the runtime must probe with
`!!modelHandler.createBatchedToolUseFollowUpMessages` (`ToolUseDispatchNode.ts:434`). Making it a
**non-optional** member with a base default that loops `createToolUseFollowUpMessages` would
(a) delete the runtime feature-probe and (b) **remove the one divergence that keeps `IModelHandler`
from collapsing into the abstract base** — i.e. it is the principled path to eventually retiring the
parallel interface the audit has rejected deleting nine times. _Not applied:_ the base-default loop
must preserve Google's batched-parallel-tool-result semantics
(`requiresBatchedParallelToolResults`), so this is a behavior-sensitive change, not a mechanical
de-dup. Recorded as the correct sequencing for the `IModelHandler` question rather than a fresh
"delete it" re-flag.

### Re-confirmed clean / settled (recorded, not re-flagged)

- Logger emission path (`logUtils.ts` single `writeLine` sink), `channelTrace`, the redaction-at-sink
  host contract (documented trade-off, §-covered), the `@texra/core` curated barrel, and the
  `runAgent`/`runAgentStream` two-tier run entry — all re-confirmed thin and correct.
- `support/UsageNormalizer.ts`, `support/sdkErrorTagging.ts`, the `createResponse → sdkErrorTagger`
  template-method seam, `ResponseStreamProcessor`/`OpenAIResponseWebSocketTransport` collaborator
  extraction, `toolConversion.ts` (Zod-v4-JSONSchema compensation, reusable by SDK `tool()` defs) —
  all re-confirmed justified.
- `tryGlobalState`/`tryWorkspaceState` pre-init accessors — the symptom of module-level state reads
  already tracked under SDK-008 (CLOSED/deepened, §19); the `tryX` pair remains as documented
  null-tolerance, not a fresh finding.

**Guardrails intact:** `find src/agent -name index.ts` shows the **same seven** pre-existing
barrels (§20 counted eight against the sibling branch; this branch's `5a5f6f8` carries seven — no
_new_ barrel either way; `src/agent/runtime/index.ts` still absent, §3.1); `grep` for `vscode`
imports over `src/agent`/`src/model`/`src/latex`/`src/tools`/`src/controllers`/`src/shared`/
`src/eventBus`/`src/hosts` is **clean**; `@texra/core` is **16** `export` statements (unchanged).

**Subagent split points — unchanged and accurate** (§5 + proposal): the config-driven YAML agents
over the two flows (reflection / `ToolUseRoundFlow`) plus the `delegate_*` tools remain the existing
subagent mechanism; the `agentCategory` dispatch in `executeAgent` is the cleanest internal seam;
helper-model tasks and node-level candidates stay the lowest-risk extractions, gated behind the
still-open multi-day §5 `delegateTo(...)` primitive.

**Net for 2026-06-20:** thesis reaffirmed for the sixteenth pass — incremental, not structural.
Three independent fresh-eyes agents re-reached the standing verdict and re-surfaced the recurring
traps (`IModelHandler` redundant for the ninth time, OpenAI-base / OpenRouter-merge consolidation) —
all re-rebutted/cross-referenced to their tracked-or-rejected status. The genuinely-new material is
five small core-domain backlog candidates (vestigial `ToolSessionState`, the refine-vs-discriminated
`TaskState`, the empty `FlowParams`/`CycleParams` aliases, the near-single-use `agentResume` port,
the `recordRound` passthrough) plus the constructive `createBatchedToolUseFollowUpMessages`-non-optional
sequencing for the long-recurring `IModelHandler` question — all behavior-touching, all recorded for
a future tidy pass rather than applied. No dead shim/barrel remains, so no refactor was applied.

## 22. Re-verification addendum — 2026-06-22 (seventeenth pass — confirmation; the model-handler native-SDK-type / SSOT wave and a new Codex subscription handler land on main, all moving with the audit)

A seventeenth pass — a fresh four-agent fan-out (independent, given only the source, not this
document): an `agent/core` + `implementations/flows` abstraction audit, a `modelHandlers/` audit
(17.2k LOC), a `runtime/` + `node/` + `output/` + `toolUse/` audit, and a logger + public-surface
audit — plus a direct re-check of every open-ledger item and the guardrail greps, run against
branch `claude/eager-noether-4b8khl` at HEAD `729255f`. **All 2026-05-28 → 06-20 findings hold
without change. No new structural over-abstraction surfaced; the standing verdict is reaffirmed
for the seventeenth time** — TeXRA is well-architected and SDK-aligned, the gaps are incremental
not structural. Like §15/§17–§21 this is a **confirmation-only pass — no refactor applied**: the
one genuinely-new "shim" candidate the agents surfaced is a mixed control-point file (below), not a
dead shim, and no other zero-risk dead-shim/barrel item remains.

### Drift baseline note (this branch forks main, not the §20/§21 sibling branches)

The §20/§21 baselines (`df0ca92`, `5a5f6f8`) are on sibling `claude/eager-noether-*` branches and
are **not reachable** from this branch (`git merge-base --is-ancestor` = false for both). This
branch forks `main` at `729255f`. The computable drift baseline is therefore the last commit that
touched this audit doc, **`67d83af`** ("move orchestrator catalog logic to controller"); the range
`67d83af..729255f` is **27** non-merge commits touching the audited dirs (`src/agent`,
`src/logger`, `packages/core`). As in §14/§19/§20 the enumeration below is the SDK-_structural_
subset; the remainder is behavior fixes and DRY/SSOT adoption — none adding a wrapper, barrel, or
abstraction (the guardrail greps are what back the conclusion, not the list).

### Drift since `67d83af` — a model-handler native-SDK-type / SSOT wave + one new subscription handler; all moves _with_ the audit

The dominant theme this period is **model-handler de-duplication and native-SDK-type adoption** —
exactly the §18 "the model-handler de-duplication recommendations are landing on main" trend
continuing, plus a new ChatGPT-subscription (Codex) handler that follows the established subclass
pattern. None adds an abstraction layer:

- **`modelHandlerCodex.ts` — new, but follows the established subclass pattern (no new abstraction).**
  The one file added to the audited dirs this period (`modelHandlers/openai/modelHandlerCodex.ts`,
  236 LOC) **`extends ModelHandlerOpenAIResponse`** (`:147`) — the same subclass-an-existing-base
  shape as every other OpenAI-compatible handler. It is wired into `createModelHandler` as a fourth
  routing arm (ChatGPT-subscription / Codex backend, gated by `shouldUseCodexSubscription` +
  `isCodexSignedIn`, `ModelFactory.ts:336-345`) ahead of the existing Responses-API / OpenRouter /
  direct paths — a new _route_, not a new _layer_. Consistent with the §9 #2 / §3.4 / §21 verdict
  that the OpenAI-compatible handler family maps 1:1 to a real provider/route and stays a class.
- **`60217e8` "native Codex streaming, drop hand-rolled SSE parser."** Replaced a bespoke SSE
  parser with the native SDK stream — a **de-duplication win of exactly the kind the audit
  endorses** (lean on SDK natives, retire hand-rolled equivalents), not new indirection.
- **`a7dd34b` "use native SDK types in model handlers"** (Anthropic usage/handler, validation,
  OpenRouter streaming, `AnthropicStreamHandler`; net −20 LOC) and **`bc85845` "adopt more native
  SDK types in handler bodies"** (Google/OpenAI-Response/`AnthropicStreamHandler`/`ServerToolTypes`;
  net −4 LOC). These tighten handler bodies onto provider SDK types — SDK alignment moving _with_
  the audit, removing hand-maintained shapes.
- **`154bc2f` "derive duplicated types from their zod schemas (SSOT)"** (tooluse node `types.ts`,
  `SessionResumeRetrieval`, `StreamLogStore`) and **`ad46d48` "validate Kimi token-count response
  with a zod schema."** The repo's own "Zod schema as single source of truth" guidance applied —
  DRY, not abstraction.
- **`9ca6137`/`67d0c7f` Codex routing/auth-status single-sourcing + command/helper simplification.**
  Clarity/DRY refactors of the new Codex paths; `git show --stat` shows no new `index.ts` and no new
  abstraction in the audited dirs.

**Guardrails intact:** `find src/agent -name index.ts` shows the **same seven** pre-existing barrels
(no new one; `src/agent/runtime/index.ts` still absent, §3.1); `grep` for `vscode` imports over
`src/agent`/`src/model`/`src/latex`/`src/tools`/`src/controllers`/`src/shared`/`src/eventBus`/
`src/hosts` is **clean**; `@texra/core` is still **16** `export` statements (unchanged — no surface
added or removed this period).

### The four independent agents re-reached the standing verdict and re-surfaced the recurring traps

Consistent with §14/§16/§17/§20/§21, the fresh-eyes agents — given only the source — re-converged
on "well-layered, incremental not structural" and re-surfaced the documented traps, all re-rebutted:

- The model-handler agent re-flagged **`IModelHandler` (470 LOC) as partially redundant with the
  `ModelHandler` abstract base** — the **tenth** re-surfacing of the `IModelHandler`-is-redundant
  family — but this time _itself concluded "no collapse safe; interface is essential for SDK seams
  and type narrowing,"_ matching §9–§21. Re-confirmed: the optional
  `createBatchedToolUseFollowUpMessages?` (the load-bearing divergence) and the typing into
  `AgentCore.modelHandler` keep it non-redundant. The §21 constructive sequencing
  (make `createBatchedToolUseFollowUpMessages` non-optional with a base default first) remains the
  correct path to eventually retiring the parallel interface — still not applied (behavior-sensitive).
- The model-handler agent re-proposed **collapsing the config-only OpenAI-compatible subclasses**
  (`DashScope` 14 LOC, `XAI` 38, `GLM` 43, `Kimi` 157, `MiniMax` 128) into a data-driven config.
  **Re-rebutted / already-tracked** (§9 #2 "leans keep", §3.4, §21): each maps 1:1 to a
  `ModelProvider` route in the exhaustive `PROVIDER_HANDLER_ROUTES` record, several carry genuine
  deltas (Kimi token-count API, MiniMax reasoning extraction, GLM thinking/effort), and the
  registry still needs a class per provider — the collapse trades small LOC for a less-obvious
  dispatch table. Not a fresh win. (The agent independently re-noted `ReasoningModelHandlerOpenAI`,
  37 LOC, as a _justified_ intermediate base shared by 4 reasoning handlers — recorded, not flagged.)
- The model-handler agent re-recommended **replacing `isDeepSeek`/`isKimi`/`isMiniMax` provider
  checks with capability flags** — this is **§7, already resolved**: the _behavioral_ gates were
  converted to `requiresBatchedParallelToolResults` / `supportsReasoningLevelOverride` (§8); the
  surviving identity getters are the endorsed display allow-list + the internal `OpenRouterNative`
  capability mapping. No behavioral dispatch on identity remains. Not net-new.
- The core/runtime agents re-flagged the `ResponseCycleNode`/`ToolUseCycleNode` "exec marshals
  state → runs inner flow → interprets outcome" shape as a removable wrapper. **Re-rebutted**
  (consistent with §20 and the proposal's "PocketFlow flow layer — do NOT refactor"): the nodes own
  real per-round orchestration (model prefill, todo/plan wiring, outcome→shared mapping), the
  legitimate node-runs-subflow composition, not a layer to inline.

**One genuinely-new "shim" candidate — verified as a mixed control-point file, KEEP.** The
runtime/output agent flagged a re-export block in `output/workflowOutputLayout.ts:26-32`
(re-exporting `WORKFLOW_OUTPUT_BASENAME`/`workflowOutputPath`/… from
`@shared/constants/workflowOutput`) as a possible barrel/shim. **Verified first-hand:** the file is
**90 LOC and mixed** — alongside the re-export it defines real legacy-migration logic
(`normalizeLegacyModel` `:39`, `getAgentFirstNameChunk` `:44`, `legacyWorkflowOutputStem` `:56`,
`midEraWorkflowOutputStem` `:73`, `legacyWorkflowOutputRoundRegex` `:82`). The re-export co-locates
the current-format constants next to the legacy helpers so agent-layer callers have one import for
output-path semantics across both eras. Removing it would scatter the migration logic and force
two-source imports. **Not a dead shim — KEEP** (the agent reached the same verdict). No zero-risk
tidy here, so no refactor applied — consistent with the pass discipline.

### §21 net-new candidates — all still present, unaddressed (re-verified at HEAD `729255f`)

None of the five §21 backlog candidates were touched this period (no audited-dir drift addressed
them); all re-confirmed present, none applied (each behavior-touching, per §21):

- **Vestigial `ToolSessionState`** — `ToolSessionStateSchema = z.object({})` (`TaskState.ts:11`),
  field at `:33`/`:55`, type export at `:63`. Unchanged.
- **`TaskState` refine-vs-discriminated split** (`TaskState.ts:18-75`) — unchanged.
- **Empty `FlowParams`/`CycleParams` bags** (`CycleServices.ts:59`, `BaseFlowServices.ts:62`,
  re-aliased as `ToolUseFlowParams`/`ReflectionFlowParams`) — unchanged; never populated.
- **`platform().agentResume` near-single-use required port** (two call sites:
  `ToolUseFollowUp.ts`, `inquiry/inquiryContinuation.ts`; every host implements it) — unchanged.
- **`AgentState.recordRound` 3-field forwarding wrapper** over `recordCycleMetrics`
  (`AgentState.ts:49/53`, two callers) — unchanged; trivial inline-or-merge candidate.

### Open ledger at HEAD `729255f` (line numbers refreshed; all still present unless noted)

- **§2.6** — `modelHandlers/modelHandlerValidation.ts` still in the production handler dir; the
  `ModelFactory.ts` gate is now wrapped in env-var indirection
  (`TEXRA_CLI_INTERNAL_VALIDATION_MODEL_HANDLER_*`, `:205-213`) but the handler still ships in the
  dispatch tree. Relocate-with-injection still low priority.
- **§4** — `UsageMonitor` two-sink fan-out **unchanged**: `runtimeHost.emit('updateStreamUsage', …)`
  (`UsageMonitor.ts:167`) + `logger.usage(…)` gated to `AgentCategory.Workflow` (`:176`). Two
  audiences, not a duplicate; producer-side de-dup (criterion (b)) still deferred as
  behavior-touching.
- **§5 / Step 7** — still no `delegateTo(...)` primitive (`grep` over `src/**` + `packages/**`
  empty); delegation remains a tool call inside the LLM loop — the one structurally-open item,
  multi-day by design.
- **§3.1** — still no `@agent/runtime/index.ts`; still optional polish (the `@texra/core` barrel is
  the shielded surface), re-rejected this pass.
- **§13 finding #1** (`AgentRuntimeHost.emit` mixes UI + essential events) — unchanged.
- **§16 #1** (`agentRegistry` UI-altitude) — unchanged from §20: only the thin
  `computeAgentOptionsData` orchestrator (`agentRegistry.ts:474`) still sits beside the SDK-exported
  core. Close to closed.
- **§16 #4** (`@logger`↔`@agent/trace` value coupling) — **cite drifted, finding survives.**
  `src/logger/runTrace.ts` (the file §20 cited) **no longer exists** (relocated under Step 2). The
  underlying `@logger → @agent/trace` value import persists at **`src/logger/channelTrace.ts:10`**
  (`import { TraceEmitter } from '@agent/trace'`); `logUtils.ts` only takes type-only imports. Still
  latent, low; for the eventual package-extraction step.
- **SDK-008** — CLOSED and deepened (§19); unchanged.

**Subagent split points — unchanged and accurate** (§5 + proposal): config-driven YAML agents over
the two flows (reflection / `ToolUseRoundFlow`) + the `delegate_*` tools remain the existing
subagent mechanism; the `agentCategory` dispatch in `executeAgent` is the cleanest internal seam;
helper-model tasks and node-level candidates stay the lowest-risk extractions, gated behind the
still-open multi-day §5 `delegateTo(...)` primitive. The F-2 per-run handle remains the
consumer-facing surface a future `delegateTo(...)` would return. The new Codex subscription handler
does not change this picture — it is a new model route, orthogonal to subagent boundaries.

**Net for 2026-06-22:** thesis reaffirmed for the seventeenth pass — incremental, not structural.
The intervening drift is a model-handler **native-SDK-type / SSOT de-duplication wave** plus a new
ChatGPT-subscription (Codex) handler that subclasses `ModelHandlerOpenAIResponse` and adds a routing
arm, not a layer — all moving _with_ the audit (continuing the §18 trend; one commit even retired a
hand-rolled SSE parser for the native SDK stream). Four independent fresh-eyes agents re-reached the
standing verdict and re-surfaced the recurring traps (`IModelHandler` redundant for the tenth time —
this time the agent itself concluded "keep"; config-only OpenAI subclasses; `isX` → capability
flags, already §7-resolved; node-runs-subflow "wrapper") — all re-rebutted or already-tracked. The
one new shim candidate was verified as a mixed control-point file (KEEP), and the five §21
candidates remain present and unapplied. Guardrails intact; no dead shim/barrel remains, so no
refactor was applied.

## 23. Re-verification addendum — 2026-06-24 (eighteenth pass — confirmation; the model-handler share-config de-duplication wave continues, all moving with the audit; two net-new core backlog candidates recorded + one re-surfaced trap retracted)

An eighteenth pass — a fresh three-agent fan-out (independent, given only the source, not this
document): an `agent/core` abstraction audit (definition / execution / usage / tools / flows +
toolUseRound nodes), a `modelHandlers/` audit (17.2k LOC, `IModelHandler` port + base class + the
thin OpenAI-compatible subclasses + `support/` / `utils/`), and a logger + `agent/trace` + run-entry
surface audit — plus a direct re-check of every open-ledger item and the guardrail greps, run
against branch `claude/eager-noether-ndrbio` at HEAD `5ad87cb`. **All 2026-05-28 → 06-22 findings
hold without change. No new structural over-abstraction surfaced; the standing verdict is reaffirmed
for the eighteenth time** — TeXRA is well-architected and SDK-aligned, the gaps are incremental not
structural. Like §15/§17–§22 this is a **confirmation-only pass — no refactor applied**: every
net-new candidate below is behavior-touching (launch-entry unify, interface merge, default-logger
swap), and no zero-risk dead-shim/barrel item remains. (One candidate the fan-out surfaced — extract
the `ModelHandler` credential block — was **retracted** as a re-surfaced trap; see N1 below.)

### Drift baseline note (this branch forks at the ink-upgrade commit)

The §20/§21/§22 baselines (`df0ca92`, `5a5f6f8`, `729255f`) are on sibling `claude/eager-noether-*`
branches. The computable drift baseline reachable on this branch is the last commit that touched this
audit doc, **`f93641f`** ("chore(cli): upgrade ink to 7.1.0 …", #6515); the range `f93641f..5ad87cb`
is **23** non-merge commits touching the audited dirs (`src/agent`, `src/logger`, `packages/core`).
As in §14/§19/§20/§22 the enumeration below is the SDK-_structural_ subset; the remainder is behavior
fixes (the agent-picker / startup-roster canonicalization train — `#6557`–`#6582`,
`bd3656b`/`27ea712`/`0ea5092`/`7bba4df` agent-key migration and duplicate-name guards) and DRY/SSOT
adoption — none adding a wrapper, barrel, or abstraction (the guardrail greps back the conclusion,
not the list).

### Drift since `f93641f` — the model-handler "share the default into the base" de-duplication wave continues; all moves _with_ the audit

The dominant theme this period continues the §18/§22 trend: **model-handler de-duplication by hoisting
shared config/behavior into the base or the intermediate reasoning base.** None adds a layer:

- **`91c7c16` "share pricing config fields" (#6544).** Hoists duplicated pricing-config fields into
  the `ModelHandler` base (`ModelHandler.ts` +10) and removes the per-handler copies from Anthropic /
  Google / OpenAI / OpenRouter (net **−24 LOC** across 5 files). Exactly the audit's "config not
  duplication" prescription, applied by the team.
- **`879bb06` "share reasoning batching default" (#6543).** Moves the
  `requiresBatchedParallelToolResults` default out of DeepSeek / Kimi / MiniMax (−8 each) into the
  shared `reasoningModelHandlerOpenAI.ts` intermediate base (+15). This is the §3.4/§7 capability-flag
  family converging further — the per-provider duplication collapses into the one intermediate base
  the audit already endorsed (§9 #2, §22). Note it touches the **batching default**, _not_
  `createBatchedToolUseFollowUpMessages` — the §21 non-optional-method sequencing for the
  `IModelHandler` question is still untouched.
- **`02546dc` "inline compaction trigger checks" (#6545)** and **`7a8e5a4` "decouple chat export
  normalization from provider SDK shapes" (#6513).** Inline-a-trivial-helper + decouple-from-SDK-shape
  refactors — DRY and SDK-shape-hygiene, no new indirection.
- **Cite-only relocation (no behavior, advances nothing, breaks one §4 line ref):** `UsageMonitor.ts`
  moved `src/agent/runtime/` → **`src/agent/utils/UsageMonitor.ts`** (in `f93641f`). The §4 two-sink
  finding survives verbatim at the new path; line numbers refreshed in the ledger below. (Same
  cite-drift-without-finding-change pattern as §22's `runTrace.ts` → `channelTrace.ts` move for §16 #4.)

**Guardrails intact:** `find src/agent -name index.ts` shows the **same seven** pre-existing barrels
(`features`, `goal`, `index`, `node`, `storage`, `trace`, `types` — no new one; `src/agent/runtime/index.ts`
still absent, §3.1); `grep` for `vscode` imports over `src/agent`/`src/model`/`src/latex`/`src/tools`/
`src/controllers`/`src/shared`/`src/eventBus`/`src/hosts` is **clean**; `@texra/core` is still **16**
`export` statements (unchanged — no surface added or removed this period).

### The three independent agents re-reached the standing verdict and re-surfaced the recurring traps

Consistent with §14/§16/§17/§20/§21/§22, the fresh-eyes agents — given only the source — re-converged
on "well-layered, incremental not structural" and re-surfaced the documented traps, all re-rebutted:

- The core agent re-examined whether the **`flows/` decomposition (ResponseCycleFlow / ToolUseRoundFlow
  / the toolUseRound nodes / `ModelInvocationNode` / `RetryState` / CycleServices) is over-engineered**
  and **itself concluded "genuinely layered, earning its keep"** — the Node/Flow split models two real
  cyclic graphs with shared exit routing (single `ResponseCycleFinalizeNode`, continuation back-edges),
  `ModelInvocationNode` is instantiated twice with materially different config (the per-flow deltas),
  and `RetryState` concentrates the retry/401-relay/compaction logic both flows share. Matches the
  proposal's "PocketFlow flow layer — do NOT refactor" row and the §8 false-positive ledger (the
  cycle-flow factories are the prescribed `Node.exec() → createFlow() → flow.run()` shape, not
  wrappers). Not re-flagged.
- The model-handler agent re-flagged **`IModelHandler` (470 LOC / ~50 members) as a wide, partially
  redundant port** — the **eleventh** re-surfacing of the `IModelHandler`-is-redundant family — but,
  like §22, _itself concluded "no method is a true one-provider leak on the public port except the
  already-guarded `createBatchedToolUseFollowUpMessages?`,"_ matching §9–§22. The optional batched
  member (`types/IModelHandler.ts:392`) that `ToolUseDispatchNode` feature-detects remains the load-bearing
  divergence; the §21 non-optional-with-base-default sequencing is still the correct (unapplied) path
  to eventually retiring the parallel interface. Re-confirmed essential, not re-flagged for deletion.
- The model-handler agent re-flagged the **config-only OpenAI-compatible subclasses** (DashScope 14
  LOC, XAI ~39, etc.) as collapsible into data. **Re-rebutted / already-tracked** (§9 #2, §3.4, §21,
  §22): each maps 1:1 to a `ModelProvider` route, several carry genuine method-level deltas (Kimi
  token-count API, MiniMax reasoning extraction), and `ReasoningModelHandlerOpenAI` already captures
  the shared reasoning overrides (now also the batching default, `879bb06` above). Not a fresh win.
- The model-handler agent re-asserted **usage normalization is duplicated across six files**. **Verified
  false (re-confirming §22):** `support/UsageNormalizer.ts` owns the single generic assembly; the
  per-provider `*Usage.ts` are thin `{ extract, computePrice }` config objects fed into it;
  `utils/usageNormalization.ts` is one 23-line pure helper. Config-driven, not duplicated.

### Genuinely-new candidates recorded for the backlog (verified first-hand; none are blockers, none applied)

These were grep-checked against both audit docs (zero prior hits for `BaseFlowContextInit`-as-finding,
the ctor `createChannelTrace('Agent')` default, or `resumeToolUseFromSnapshot`-as-finding) — but note
the **proposals doc must be cross-checked by hand, not just grepped**: N1 below grep'd clean for
`shouldUseServerSideKeys` yet was already rejected there under different wording
(`auth/tiers/relay-quota`, `getServerSideKeyService()`), which is why it is retracted. Each surviving
candidate is behavior-touching, so each is recorded for a future tidy pass, not applied here:

- **N1 (RETRACTED — re-surfaced a documented trap; do not pursue).** This pass's model-handler agent
  proposed extracting the provider-agnostic credential block out of the `ModelHandler` base
  (`ModelHandler.ts:304-441`, ~110 LOC of server-side-key / relay / tier-access logic —
  `shouldUseServerSideKeys` `:321`, `getApiKey` `:361`, `getBaseUrl` `:430`, `fetchApiKeyOrThrow` `:337`)
  into a `getApiKey()`-style injected collaborator, by analogy to the already-extracted
  `MediaAttachmentProcessor` / `ProxyConfigResolver`. **This is the exact extraction the companion
  proposals doc already evaluated, adversarially verified, and rejected as a trap** —
  [`docs/proposals/2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md) "Rejected findings
  (traps — do not pursue)", line 46: _"`ModelHandler` and `@auth/*` are **already vscode-free**; the
  relay/tier logic is shared core consumed identically by CLI and extension (not host-specific);
  `getServerSideKeyService()` is already a swappable, test-mocked singleton. The 'extract a port'
  proposal would add indirection over a working, injectable seam."_ The `MediaAttachmentProcessor` /
  `ProxyConfigResolver` analogy does **not** hold: those were extracted as genuine collaborators, not
  to decouple the base from a host — whereas the credential seam is already injectable and host-neutral,
  so a port adds indirection over a working seam. This pass surfaces **no new evidence** overturning
  that adversarial verification (the credential code is unchanged this period), so N1 is **withdrawn**
  and recorded here — in the audit's false-positive-ledger discipline (cf. §8) — so the same trap is
  not re-flagged a future pass. _Methodology note:_ the fresh-eyes agents are given the source but
  **not** the proposals doc, so its rejected-findings table must be cross-checked by hand each pass;
  this one slipped through and is corrected here. (Credit: caught by the TeXRA `review` agent on
  PR #6589.)
- **N2 (MEDIUM, borderline) — a third top-level launch entry duplicates the lifecycle/result-build
  boilerplate.** `resumeToolUseFromSnapshot` (`runtime/executeAgent.ts:438`) repeats ~80% of
  `executeAgent`'s body (`buildAgentLaunchContext` → `withExecutionRunContext` → `runFlowWithLifecycle`
  → `runToolUseFlow` + `buildToolUseFlowResult`), differing only in resume-snapshot wiring and
  persisted child-lineage lookup. Candidate to unify as `executeAgent` with a `resumeSnapshot` option.
  _Caveat / honest framing:_ the `runAgent` / `runAgentStream` two-tier split itself was re-confirmed
  "thin and correct" in §21 and is **not** the finding — the net-new sliver is only the resume path as
  a near-duplicate of the engine body. Behavior-touching (resume wiring); record, don't over-claim.
- **N3 (MEDIUM/LOW, interface-only) — merge `BaseFlowContextInit` into `AgentCore`.**
  `core/flows/BaseFlowServices.ts:31` (`AgentCore`) and `:73` (`BaseFlowContextInit extends AgentCore`)
  split the run-scoped facts from exactly four lifecycle callbacks (`checkInterruption`,
  `setAbortController`, `onInterrupt?`, `onRoundFinalized?`). Every concrete services type extends
  `BaseFlowContextInit`, never `AgentCore` directly; `AgentCore` is referenced standalone in only two
  spots. The two-interface split buys little — the four callbacks could live on `AgentCore` itself.
  Interface-only (no runtime cost); the closest thing to redundant layering in `core/`, but
  type-shape-touching, so deferred.
- **N4 (LOW) — `ModelHandler` constructs a base channel-trace logger.** `ModelHandler.ts:160`
  defaults `this.logger = createChannelTrace('Agent')`. Normal launch handlers overwrite it with
  `setLogger` (`AgentLaunchContext` injects the run trace), but helper-model handlers created by
  `createHelperModelKit()` currently run without a later `setLogger()` call. Therefore this is not a
  pure noop-default tidy: either exclude helper-model handlers from the change or first add an explicit
  helper-model logger path. Deferred; touches the import graph and live helper-model logging behavior.
- **N5 (LOW) — stale JSDoc.** `types/IModelHandler.ts:379` says `createBatchedToolUseFollowUpMessages` is
  "optional and primarily used by Google handlers"; it now has three implementers (Google, OpenAI,
  OpenRouter) and GLM explicitly opts _out_. Fix the comment when next touching the file.
- **N6 (LOW) — `core/` micro-tidies the core agent surfaced:** inline the single-use `getDebugContext`
  (`CommonCycleTypes.ts`) into its one caller `saveCycleDebug`; factor the `run` / `workspace` /
  `fileService` trio that `ResponseCycleServices` and `ToolUseRoundServices` re-declare independently
  (`CycleServices.ts:47-50` / `:69-70`) into a shared mixin; rename the private `type CycleServices`
  alias in `CommonCycleTypes.ts` so it stops shadowing the `CycleServices.ts` filename concept.

### §21 net-new candidates — all still present, unaddressed (re-verified at HEAD `5ad87cb`)

None of the five §21 backlog candidates were touched this period; all re-confirmed present first-hand,
none applied (each behavior-touching, per §21):

- **Vestigial `ToolSessionState`** — `ToolSessionStateSchema = z.object({})` (`TaskState.ts:11`),
  field at `:33`/`:55`, type export at `:63`. Unchanged.
- **`TaskState` refine-vs-discriminated split** (`TaskState.ts:18-75`) — unchanged.
- **Empty `FlowParams`/`CycleParams` bags** — `CycleParams = Record<string, unknown>`
  (`CycleServices.ts:73`), `FlowParams` (`BaseFlowServices.ts:80`), re-aliased as
  `ToolUseFlowParams`/`ReflectionFlowParams`; never populated. Unchanged.
- **`platform().agentResume` near-single-use required port** — two production call sites:
  `agent/followUp/ToolUseFollowUp.ts` and `tools/inquiry/inquiryContinuation.ts`; every host implements
  it (`extension.ts`, CLI `initPlatform.ts`, desktop `platform/index.ts`). Unchanged.
- **`AgentState.recordRound` 3-field forwarding wrapper** over `recordCycleMetrics`
  (`AgentState.ts:48`; two callers — `ResponseCycleFlow.ts:447`, `ResponseCycleNode.ts:131`).
  Unchanged; trivial inline-or-merge candidate.

### Open ledger at HEAD `5ad87cb` (line numbers refreshed; all still present unless noted)

- **§2.6** — `modelHandlers/modelHandlerValidation.ts` still in the production handler dir;
  relocate-with-injection still low priority.
- **§4** — `UsageMonitor` two-sink fan-out **unchanged** but **relocated** to
  `src/agent/utils/UsageMonitor.ts`: `runtimeHost.emit('updateStreamUsage', …)` (`:166`, all agents) +
  `logger.usage(payload, …)` gated to `AgentCategory.Workflow` (`:171`/`:175`). Two audiences, not a
  duplicate; producer-side de-dup (criterion (b)) still deferred as behavior-touching.
- **§5 / Step 7** — still no `delegateTo(...)` primitive (`grep` over `src/**` + `packages/**` empty);
  delegation remains a tool call inside the LLM loop — the one structurally-open item, multi-day by
  design.
- **§3.1** — still no `@agent/runtime/index.ts`; still optional polish (the `@texra/core` barrel is the
  shielded surface), re-rejected this pass.
- **§13 finding #1** (`AgentRuntimeHost.emit` mixes UI + essential events) — unchanged.
- **§16 #1** (`agentRegistry` UI-altitude) — unchanged from §20/§22: only the thin
  `computeAgentOptionsData` orchestrator still sits beside the SDK-exported core. Close to closed.
- **§16 #4** (`@logger`↔`@agent/trace` value coupling) — unchanged from §22: the value import persists
  at `src/logger/channelTrace.ts:10` (`import { TraceEmitter } from '@agent/trace'`). Still latent,
  low; for the eventual package-extraction step.
- **SDK-008** — CLOSED and deepened (§19); unchanged.

**Subagent split points — unchanged and accurate** (§5 + proposal): config-driven YAML agents over the
two flows (reflection / `ToolUseRoundFlow`) + the `delegate_*` tools remain the existing subagent
mechanism; the `agentCategory` dispatch in `executeAgent` is the cleanest internal seam; the
`ModelInvocationNode` (model-invocation) and `ToolUseDispatchNode` (tool-execution) nodes are the two
cleanest node-level extraction points — both already have serializable I/O contracts; their only
obstacle to independent runnability is the shared mutable `shared` state + ambient `RunContext`
(AsyncLocalStorage), not the node boundaries. All gated behind the still-open multi-day §5
`delegateTo(...)` primitive; the F-2 per-run handle remains the surface it would return.

**Net for 2026-06-24:** thesis reaffirmed for the eighteenth pass — incremental, not structural. The
intervening drift is the model-handler **share-config de-duplication wave** continuing (pricing fields
and the reasoning-batching default hoisted into the base / intermediate base; a compaction-check
inlined; chat-export decoupled from SDK shapes) plus the agent-picker/startup-roster canonicalization
train — all moving _with_ the audit, none adding a layer. Three independent fresh-eyes agents
re-reached the standing verdict (two of them — the core flows agent and the model-handler
`IModelHandler` agent — independently concluding "keep" themselves) and re-surfaced the recurring traps
(`IModelHandler` width for the eleventh time, config-only OpenAI subclasses, usage-normalization
"duplication") — all re-rebutted or already-tracked. The genuinely-new material is two small-to-medium
candidates (N2: unify the `resumeToolUseFromSnapshot` launch entry; N3: merge `BaseFlowContextInit`
into `AgentCore`) plus three LOW tidies (noop default logger, stale batched JSDoc, the `core/`
micro-tidies) — all behavior-touching, all recorded for a future tidy pass. A third candidate (N1,
extract the `ModelHandler` credential block) was **retracted** this pass: it re-surfaced an extraction
the proposals doc already adversarially rejected as a trap (line 46), recorded in the false-positive
ledger so it is not re-flagged.
The five §21 candidates remain present and unapplied. Guardrails intact; no dead shim/barrel remains,
so no refactor was applied.

## 24. Re-verification addendum — 2026-06-27 (nineteenth pass — confirmation; cross-doc reconciliation: several §21/port items the §23 pass left open were CLOSED by the intervening `proposals/` checkpoints; the SSOT/DRY + maintained-library-adoption wave continues, all moving with the audit)

A nineteenth pass — a fresh three-agent fan-out (independent, source-only, not given this document):
an `agent/core` + runtime abstraction audit (definition / execution / usage / tools / flows + the
toolUseRound nodes + runtime entrypoints), a `modelHandlers/` audit (the `IModelHandler` port + base
class + OpenAI-compatible subclasses + `support/` / `utils/`), and a logger + `agent/trace` + platform
surface audit — plus a direct re-check of every open-ledger item, the guardrail greps, and a
first-hand reconciliation against the parallel `docs/proposals/agent-sdk-readiness*` checkpoint series,
run against branch `claude/eager-noether-0cghgc` at HEAD **`d594ed3`**. **All 2026-05-28 → 06-24
findings hold or have been actively closed by the team; no new structural over-abstraction surfaced;
the standing verdict is reaffirmed for the nineteenth time** — TeXRA is well-architected and
SDK-aligned, the gaps are incremental not structural. Confirmation-only pass — **no refactor applied**
(every still-open candidate is behavior-touching, and the zero-risk dead-shim/barrel items the master
ledger tracked were already consumed by the intervening checkpoints, below).

### Two parallel doc series — reconciled this pass

Since §22 a second strand of this same recurring request has been answered under `docs/proposals/`:
the canonical `2026-05-30-agent-sdk-readiness.md` plus a delta (`-delta-2026-06-24.md`) and two checkpoints
(`-checkpoint-2026-06-25.md` at base `b2dcd42`, `-checkpoint-2026-06-26.md` at HEAD `93af483`). Those
checkpoints **applied** behavior-neutral cleanups and recorded backlog. This master ledger (the
§-numbered strand) had not yet reflected them; §24 reconciles the two. The proposals strand's
adjudicated-traps table (06-26, lines 156-164) is the companion to this doc's §8 false-positive ledger
and must be cross-checked by hand each pass (cf. §23 N1).

### Drift baseline note (this branch reaches the master doc's §23 commit)

The master doc's last commit reachable here is **`f777495`** (the §23 N1 retraction). The §23 pass
verified at HEAD `5ad87cb`; the proposals checkpoints advanced independently to `93af483`. The range
`5ad87cb..d594ed3` is **38** non-merge commits touching the audited dirs (`src/agent`, `src/logger`,
`src/platform`, `packages/core`); of those, **7** post-date the 06-26 checkpoint commit (`3de601c`)
and are recorded in **no** prior doc. As in §14/§19/§20/§22/§23 the enumeration below is the
SDK-_structural_ subset; the remainder is behavior fixes and DRY/SSOT adoption — none adds a wrapper,
barrel, or abstraction (the guardrail greps back the conclusion, not the list).

### Cross-doc reconciliation — master-ledger items §23 left open that the team has since CLOSED (each verified GONE first-hand at HEAD `d594ed3`)

- **§21(b) the re-aliases `ToolUseFlowParams` / `ReflectionFlowParams` — CLOSED.** PR #6620 (`0d08aca`
  P3a, "drop empty FlowParams aliases") deleted both empty-type re-export aliases; `grep` over
  `src/agent` is now empty. The base `CycleParams = Record<string, unknown>` (`CycleServices.ts:112`,
  relocated from `:73`) and `interface FlowParams` (`BaseFlowServices.ts:80`) **remain** — but those
  are the `Flow<Shared, Params, Services>` generic Params slot itself (the PocketFlow type position),
  not the §21-flagged re-aliasing. The §21(b) sub-finding is retired; the generic-placeholder residue
  is load-bearing and was never the target.
- **`withModelClient` closure DRY — landed liveness-safe.** The same PR #6620 (`0d08aca` P3b) executed
  the deferred §-cleanup that earlier passes parked as risky: the live-rebinding model-client closure
  shared by the two cycle-wrapper nodes is now `CycleServices.withModelClient`, defined so the `client`
  getter + `refreshClient` stay live (no eager spread), preserving relay-401 mid-run rebinding. The
  `Node.exec → createFlow → flow.run` shape is untouched. Matches the audit's own prescription.
- **Port narrowing — `isOutputStreamingEnabled()` getter removed** (06-26 checkpoint, `3de601c`):
  declared on `IModelHandler`, defined on `ModelHandler`, never read; `grep` now empty. One fewer member
  on the over-wide port — a concrete step on the §9/§21 "trim `IModelHandler`" track.
- **Dead `PersistedFlow.step()` wrapper removed** (06-26, `3de601c`): the one-line `step()` over
  `stepWithResult()` had a single caller (the base `run()` loop) and was inlined; `grep` for a bare
  `step()` in `persistedFlow.ts` is empty.
- **Dead `agentRegistry` re-exports dropped** (06-26): the `BUNDLED_/REMOTE_ORCHESTRATOR_AGENT_NAMES`
  re-export-of-a-re-export removed; narrows the registry surface.
- **`AgentCreator` two blueprint nodes collapsed into one** (`cee3eb6`, #6624) — another
  abstraction-collapse landing _with_ the audit, not against it.

### Drift since the 06-26 checkpoint (`3de601c`) — 7 commits, recorded in no prior doc; all SSOT/DRY + maintained-library adoption, none adds a layer

- **`d594ed3` "Replace ad-hoc utilities with maintained npm packages" (#6659)** — library adoption
  (the §18/§22 "retire hand-rolled code for the maintained dep" trend), not a new abstraction.
- **`102b961` single-source the `debugMode` setting via `isDebugModeEnabled` (#6647)**, **`74ed65b`
  single-source the optional-flow-result inclusion rule (#6649)**, **`1119f4c` single-source two
  duplicated reads in the run path (#6643)**, **`b3ce3d0` single-source the KV read-validate-or-null
  policy (#6645)**, **`a5ff60b` consolidate duplicate logic via shared schemas + utils (#6632)** —
  the SSOT/DRY wave continuing across logger / runtime / storage; each collapses a duplicated read or
  policy into one owner. No wrapper, no barrel.
- **`5ac74f7` Fix agent resolution to match validation and launch within category (#6657)** — behavior
  fix in the agent-picker/category train, orthogonal to abstraction layering.

**Guardrails intact at `d594ed3`:** `find src/agent -name index.ts` shows the **same seven** pre-existing
barrels (`features`, `goal`, `index`, `node`, `storage`, `trace`, `types` — no new one;
`src/agent/runtime/index.ts` still absent, §3.1); `grep` for `vscode` imports over
`src/agent`/`src/model`/`src/latex`/`src/tools`/`src/controllers`/`src/shared`/`src/eventBus`/`src/hosts`
is **clean**; `@texra/core` is still **16** `export` statements (unchanged — no surface added or removed).

### The three independent agents re-reached the standing verdict and re-surfaced the recurring traps

Consistent with §14/§16/§17/§20–§23, the fresh-eyes agents — given only the source — re-converged on
"well-layered, incremental not structural" and re-surfaced the documented traps, all re-rebutted or
already-tracked:

- **`IModelHandler` width re-flagged (the twelfth re-surfacing)** — the model-handler agent itself
  partly concluded "keep," matching §9–§23: the optional `createBatchedToolUseFollowUpMessages?`
  (`types/IModelHandler.ts`) feature-detected by `ToolUseDispatchNode` remains the load-bearing
  divergence; the §21 non-optional-with-base-default sequencing is still the correct (unapplied) path.
  Not re-flagged for deletion.
- **`buildAgentLaunchContext → assembleAgentLaunchContext` flagged as a "two-layer wrapper that adds no
  logic" — VERIFIED FALSE first-hand and re-rebutted.** The public `buildAgentLaunchContext`
  (`AgentLaunchContext.ts:491`) is _not_ a pass-through: it generates the `executionId` and validates
  required fields (`:497-502`), reserves + `acquireStreamOrThrow`s the stream lock — the transactional
  commit point (`:504-514`) — and wraps the private `assembleAgentLaunchContext` (`:222`) in saga-style
  failure compensation that disposes the run-trace and routes post-commit failures to
  `compensateFailedActivation` (`:516-544`). This is the documented load-bearing high/low (commit-point
  vs. assembly) split the master ledger already rebuts (§ cites at 479 / 1227 / 1490). Re-rebutted in
  the §8 false-positive discipline so it is not re-flagged next pass.
- **Config-only OpenAI-compatible subclasses** and the **node-runs-subflow "wrapper"** — re-surfaced,
  re-rebutted exactly as §9 #2 / §3.4 / §21–§23 (1:1 `ModelProvider` routes with real method deltas;
  the cycle factories _are_ the prescribed `Node.exec → createFlow → flow.run` shape).

### Open ledger at HEAD `d594ed3` (line numbers refreshed; all still present unless noted)

- **06-26 backlog `RetryState` (HIGH) — CLOSED by #6671** (see the post-write-drift note below). As pinned
  at `d594ed3` (this branch's base, before #6671) it was still present: `interface RetryState`
  (`RetryState.ts:29`) a one-field bag (`lastError?`, `:30`), with the sole non-test caller passing the same
  object for both params: `handleInvocationResult(execRes, shared, shared, …)` (`ModelInvocationNode.ts:123`).
  #6671 (`357182d`) applied **exactly the proposed collapse** — deleted the `interface RetryState`, widened the
  inline `state` param to carry `lastError?`, and dropped the duplicate `retryState` arg (the call is now the
  single-`shared` `handleInvocationResult(execRes, shared, { logger, operationName })`).
- **§2.6** — `modelHandlers/modelHandlerValidation.ts` still in the production handler dir; the
  `ModelFactory.ts` CI override was **extracted** to `src/agent/runtime/internalValidationOverride.ts`
  (`eb4ff93`) — cite drift, finding survives (the handler itself still ships in the dispatch tree;
  relocate-with-injection still low priority).
- **§4** — `UsageMonitor` two-sink fan-out **unchanged** at `src/agent/utils/UsageMonitor.ts`; two
  audiences (sidebar vs. transcript), agentCategory-gated, not a duplicate; producer-side de-dup deferred.
- **§5 / Step 7** — still no `delegateTo(...)` primitive (`grep` over `src/**` + `packages/**` empty);
  the structural pre-work the 06-26 checkpoint cited (`d32be3b`/`a15dd86` per-category flow-runner
  extraction) is in-tree; delegation remains a tool call. The one structurally-open item, multi-day by design.
- **§16 #4** (`@logger`↔`@agent/trace` value coupling) — unchanged: the value import persists at
  `src/logger/channelTrace.ts:10` (`import { TraceEmitter, type AgentTrace } from '@agent/trace'`).
  Latent, low; for the eventual package-extraction step.
- **N4** — `ModelHandler` still defaults `this.logger = createChannelTrace('Agent')`
  (`ModelHandler.ts:160`, import `:40`). Normal launch handlers overwrite it through `setLogger`, but
  helper-model handlers do not yet have a separate logger injection path; the default-logger tidy is still
  open (low, touches the import graph and helper-model logging behavior).
- **§21 remainder** — `ToolSessionState` empty schema (`TaskState.ts:11`/`:33`/`:55`/`:63`), the
  `TaskState` refine-vs-discriminated split, and the `AgentState.recordRound` 3-field forwarder
  (`AgentState.ts:48`) — all unchanged.
- **06-26 design-track backlog — partly CLOSED by #6671.** The **four leaking `IModelHandler` port members**
  (`getAgentCategory`, `canProcessToolResultAttachments`, `createMediaContent`, `createAssistantMessage`) were
  **all removed from the port** by #6671 (`357182d`, `IModelHandler.ts` −11), and the **duplicated
  `createResponse` template body** in the two override handlers (`modelHandlerOpenAIResponse`,
  `modelHandlerGoogleInteractions`) was **deduped** in the same commit. Still open: the three `public`→
  `protected` base-method visibility tightenings, the over-wide `@agent/index` barrel, and
  `PlatformAgentDirectoryBootstrapOptions` — deliberate surface decisions, deferred.
- **Carried from §23 (ledger unity — unchanged, neither closed nor newly drifted at `d594ed3`):**
  `platform().agentResume` near-single-use required port (§21; two call sites, every host implements it);
  §13 finding #1 (`AgentRuntimeHost.emit` mixes UI + essential events); §3.1 (no `@agent/runtime/index.ts` —
  also noted in this pass's guardrails). Listed explicitly so none is silently dropped from the open ledger.
- **SDK-008** — CLOSED and deepened (§19); unchanged.

### Post-write drift — #6671 landed on `main` during PR #6677's review window and closed three documented-open items

§24 was written and pinned to `d594ed3` (this branch's fork point). While PR #6677 (the §24 docs change) was in
review, **#6671 `357182d` "refactor(agent): collapse RetryState, narrow IModelHandler port, dedup createResponse
template"** merged to `main` (2026-06-27 12:49, between this branch's base at 01:22 and `main` HEAD `07f522d`).
It applies **three items §24 records as open**, so the audited-code claims above are accurate against the
`d594ed3` pin but describe code the merge target has since refactored. The automated PR reviewers correctly
flagged the mismatch (they review against the PR-merge preview / `main`, which contains #6671; this branch's
working tree does not). Reconciled in the open ledger above; the three closures are:

1. **`RetryState` collapse (the §24 HIGH item)** — `interface RetryState` deleted; `lastError?` folded into the
   inline `handleInvocationResult` `state` param; the duplicate `retryState`/double-`shared` arg removed. The
   team applied the audit's proposed shape verbatim.
2. **`IModelHandler` port narrowing** — the four leaking members (`getAgentCategory`,
   `canProcessToolResultAttachments`, `createMediaContent`, `createAssistantMessage`) removed from the port.
3. **`createResponse` template dedup** — the copied error-tag wrap in the two override handlers consolidated.

This is the audit's thesis in motion (the team executing the documented backlog), not a contradiction of it; the
next §-pass should re-pin to a HEAD containing #6671 and move these from "open" to the closed-items reconciliation.

**Subagent split points — unchanged and reconfirmed** (§5 + 06-26 checkpoint ranking): config-driven
YAML agents over the two flows + the `delegate_*` tools / `executeSubagent` remain the existing
isolated-context subagent mechanism; the `agentCategory` dispatch in `executeAgent` is the cleanest
internal seam; `ModelInvocationNode` and `ToolUseDispatchNode` remain the two cleanest node-level
extraction points (serializable I/O; only obstacle is shared mutable `shared` + ambient `RunContext`).
The ranked value/effort order is unchanged: (1) wire the existing `review` tool-use agent as a
post-draft Verifier delegation (lowest risk, reuses `executeSubagent`); (2) introduce a typed
`delegateTo(subagent, input, { maxDepth, tools })` over the existing plumbing; (3) formalize the
workflow agents (`polish`/`correct`/`merge`) as SDK actors with typed I/O; (4) relocate the
module-global registries onto the per-session handle (_relocate, never delete — load-bearing_) to gate
concurrent in-process sessions; (5) decompose the multi-phase workflow agents — gated by #4.

**Net for 2026-06-27:** thesis reaffirmed for the nineteenth pass — incremental, not structural. The
material development since §23 is **cross-doc**: the parallel `proposals/` checkpoints (06-25/06-26)
**closed** several items the master ledger had left open (the §21(b) flow-param re-aliases, the
`withModelClient` DRY, the `isOutputStreamingEnabled` port member, the dead `PersistedFlow.step()`
wrapper, the `agentRegistry` re-exports) and collapsed the two `AgentCreator` nodes — the team is
executing the plan, all moving _with_ the audit. The seven post-checkpoint commits continue the SSOT/DRY

- maintained-library-adoption wave, none adding a layer. Three independent fresh-eyes agents re-reached
  the standing verdict and re-surfaced the recurring traps (`IModelHandler` width for the twelfth time;
  the `buildAgentLaunchContext` two-layer split — verified false first-hand and re-rebutted as documented
  saga-compensation; config-only OpenAI subclasses) — all re-rebutted or already-tracked. **Post-write, #6671
  landed on `main` and closed three documented-open items** (the `RetryState` HIGH collapse — applied exactly as
  proposed — plus the four-member `IModelHandler` port narrowing and the `createResponse` template dedup);
  reconciled in the open ledger and the post-write-drift note above. The remaining backlog (the `public`→
  `protected` visibility track, §2.6 handler relocation, the §21 remainder, the `@agent/index` barrel curation,
  the typed `delegateTo`) is behavior-touching. Guardrails intact; no dead shim/barrel remains, so no refactor
  was applied to the codebase this pass — only the §24 ledger correction recording #6671's closures.

## 25. Re-verification addendum — 2026-06-29 (twentieth pass — re-pin to a HEAD containing #6671; three documented-open items moved open → closed; confirmation-only, no refactor applied)

A twentieth pass against branch `claude/eager-noether-bfxlhs` at HEAD **`e1bfb60`** (2026-06-29) — a fresh
three-agent fan-out (independent, source-only, not given this document): an `agent/core` + runtime
abstraction audit (definition / execution / usage / tools / flows + runtime entrypoints), a
`modelHandlers/` audit (the `IModelHandler` port + base class + OpenAI-compatible subclasses + `support/`
/ `utils/` / `ModelFactory`), and a logger + `agent/trace` + `agent/index` + `platform` surface audit —
plus a direct re-check of every open-ledger item, the guardrail greps, and a first-hand reconciliation
against the parallel `docs/proposals/agent-sdk-readiness*` checkpoint series. **All 2026-05-28 → 06-27
findings hold or have been actively closed by the team; no new structural over-abstraction surfaced; the
standing verdict is reaffirmed for the twentieth time** — TeXRA is well-architected and SDK-aligned, the
gaps are incremental not structural. Confirmation-only pass — **no refactor applied** (the one candidate
that looked like zero-caller dead code was verified live, every other still-open candidate is
behavior-touching, and no dead shim/barrel remains; greps below).

### §24's instruction executed — re-pinned to a post-#6671 HEAD; three items moved open → closed

§24 was pinned to `d594ed3` (its branch's fork point, **before** #6671) and recorded — in the post-write
drift note — that **#6671 `357182d`** had since landed on `main`, closing three items §24 still listed as
open, with the explicit instruction: _"the next §-pass should re-pin to a HEAD containing #6671 and move
these from 'open' to the closed-items reconciliation."_ This pass does exactly that. HEAD `e1bfb60`
contains #6671; each closure verified **GONE/landed first-hand**:

- **`RetryState` collapse (the §24 HIGH item) — CLOSED.** `grep -c "interface RetryState"
src/agent/core/flows/RetryState.ts` → **0**. The one-field `lastError?` bag is gone; the sole caller is
  now the single-`shared` form `handleInvocationResult(execRes, shared, { logger, operationName })`
  (`ModelInvocationNode.ts:123`), and `handleInvocationResult`'s signature is `(result, state: { …;
lastError? }, options)` (`RetryState.ts:342`) — the proposed collapse applied verbatim.
- **`IModelHandler` four-member port narrowing — CLOSED.** `grep -c` for `getAgentCategory` /
  `canProcessToolResultAttachments` / `createMediaContent(` / `createAssistantMessage(` on
  `types/IModelHandler.ts` → **0**. The four members that only had `this.` callers are off the port.
- **`createResponse` template dedup — CLOSED.** Both override handlers now supply only the single-turn
  `inFlight` guard via the `protected createResponseImpl` hook (`modelHandlerOpenAIResponse.ts:349/1210`,
  `modelHandlerGoogleInteractions.ts:368/1460`); the base keeps owning the `withSdkErrorTag` wrap. The
  copied error-tag template body is gone.

**One further item the 06-26 checkpoint listed as open is also already CLOSED at HEAD:** the **three
`public` → `protected` base-method visibility tightenings** — `getApiKey` (`ModelHandler.ts:357`),
`createMediaMessage` (`:591`), `containCutOffMessage` (`:672`) are all `protected` at HEAD (no `public`
declaration remains). Move from open → closed.

### Guardrails intact at `e1bfb60`

- `find src/agent -name index.ts` → the **same seven** pre-existing barrels (`features`, `goal`, `index`,
  `node`, `storage`, `trace`, `types`); no new barrel; `src/agent/runtime/index.ts` still **absent** (§3.1).
- `grep` for `vscode` imports over
  `src/agent`/`src/model`/`src/latex`/`src/tools`/`src/controllers`/`src/shared`/`src/eventBus`/`src/hosts`
  → **clean**.
- `packages/core/src/index.ts` → **16** `export` statements (unchanged — no surface added or removed).
- The SDK-idiomatic spine re-confirmed in-tree: `Node.exec → createFlow().run`, the `AgentTrace`
  emit/subscribe channel, the `platform()` 10-port composition root, the `createModelHandler`
  (`PROVIDER_HANDLER_ROUTES`) factory, and the lead-and-specialists delegation model.

### Drift since the §24 pin — fix/SSOT/DRY wave continuing, none adds a layer

Recent commits over the audited dirs (`git log` over `src/agent src/logger src/platform packages/core`):
`#6738` route state-backed reads through the catalog schema (SSOT), `#6731` unify model-handler output
cleanup + dedupe end-tag + finalize-on-error (DRY + robustness), `#6730` centralize helper-model one-shot
calls (the SSOT/DRY wave — cf. §18/§22 maintained-helper consolidation), plus behavior fixes
(`#6715`/`#6711`/`#6709`/`#6708`). All moving **with** the audit; the guardrail greps back the conclusion.

### The three fresh-eyes agents re-reached the standing verdict and re-surfaced the recurring traps

Consistent with §14/§16/§17/§20–§24, the source-only agents re-converged on "well-layered, incremental
not structural" (the core and surface agents explicitly self-concluding "keep") and re-surfaced the
documented traps — all re-rebutted or already-tracked:

- **`IModelHandler` width / "delete the redundant single-impl interface" (the thirteenth re-surfacing)** —
  still load-bearing: `types/IModelHandler.ts:174` `SdkToolCall` union + the **optional**
  `createBatchedToolUseFollowUpMessages?` (`:385`, feature-detected by `ToolUseDispatchNode`) make the
  interface non-removable (deletion breaks `tsc`, proposal "Rejected findings" line 44). The agents'
  "promote the missing methods / split into provider-local tool-call types" is the **§9/§21 trim-the-port
  track** — behavior-touching, still the correct unapplied path. Not re-flagged for deletion.
- **"Extract auth/relay/billing out of base `ModelHandler` into an `ApiCredentialResolver`"** — re-surfaced
  (model-handler agent finding 4); **already adversarially rejected** (proposal "Rejected findings" line 46;
  §23 N1 retraction): `ModelHandler` + `@auth/*` are already vscode-free, the relay/tier logic is shared
  core consumed identically by CLI + extension, and `getServerSideKeyService()` is already a swappable
  test-mocked singleton — the "extract a port" adds indirection over a working injectable seam. Re-rebutted.
- **`@agent/index` barrel dead type re-exports / dual registry surface** (logger-surface agent findings
  6–7) — this is the §21 / 06-26 "over-wide `@agent/index` barrel" item: trimming the ~10 zero-consumer
  `AgentDirectory*` type re-exports and resolving the barrel-vs-deep-import duality. **Tracked, deferred —
  barrel curation is a deliberate surface decision, not a mechanical delete** (06-26 checkpoint). Unchanged.
- **`agentResume` near-single-use required port; `buildAgentLaunchContext → assembleAgentLaunchContext`
  two-layer split; config-only OpenAI subclasses; node-runs-subflow "wrapper"** — re-surfaced, re-rebutted
  exactly as §21–§24 (the `assemble*` split is the documented saga-compensation high/low; the cycle
  factories _are_ the prescribed `Node.exec → createFlow → flow.run` shape).

### New false positive recorded (so it is not re-flagged next pass)

- **"`isOReasoningModel` / `isGrokReasoningModel` are unused dead getters on the base" — VERIFIED FALSE.**
  The model-handler agent's scoped grep missed the OpenAI subclass. Both are read **6×** in
  `modelHandlerOpenAI.ts` (`:276`, `:281`, `:602`, `:608`, `:615`) and `modelHandlerOpenAIResponse.ts`
  (`:1459`) — they gate reasoning-param shape and the `max_tokens`/`max_completion_tokens` key choice. Not
  dead; recorded in the §8 false-positive discipline.

### Genuinely-new micro-candidates (not in any prior doc) — all behavior-touching, recorded for a future tidy pass

None is a zero-risk dead-shim/barrel delete, so none was applied this confirmation-only pass:

- **P25-1 — `ModelFactory` compatibility-key side-channel** _(MEDIUM, behavior-touching)_. Every handler is
  branded post-construction via `Object.defineProperty(handler, '__texraModelHandlerCompatibilityKey', …)`
  (`ModelFactory.ts:51`, `withModelHandlerCompatibilityKey` `:305`), read back by
  `activeModelHandlerCompatibilityKey()` (`:297`) at the one mid-session model-switch detector
  (`runToolUseFlow.ts`). The same key is computable from the handler's own `config` via the pure
  `modelHandlerCompatibilityKey(config)`. Candidate: replace the non-enumerable monkey-patch with a plain
  `readonly compatibilityKey` field set in the constructor (the Codex override — `ModelHandlerOpenAIResponse`
  from a non-Responses config — must keep its distinct key, so derive-from-config is not a pure swap).
  Touches the handler construction path; not mechanical.
- **P25-2 — `@agent/types/index.ts` pass-through shim over `@shared/schemas`** _(LOW-MEDIUM)_. Re-exports 7
  symbols straight from `@shared/schemas`, adding only the local `NormalizedUsage`; **2** files import the
  barrel. Candidate: move `NormalizedUsage` to `@shared/schemas` and drop the shim, or stop re-exporting the
  `@shared` symbols. Surface-curation decision, deferred.
- **P25-3 — `core/usage/ResponseUsage.ts:58-66` provider-SDK type re-export block** _(LOW)_. A bare
  `export type { CompletionUsage, AnthropicUsage, … }` pass-through couples a `core/` module to four vendor
  SDK type surfaces purely to forward them; handlers could import these from their own SDK. Keep the
  TeXRA-owned `NativeUsagePayload` union (which legitimately needs the imports); trim only the forwarding block.
- **P25-4 — `@logger/index.ts` exposes one symbol** _(LOW, cosmetic)_. `export { createChannelTrace }` only,
  while the real functional API lives at the deep path `@logger/logUtils` (~70 callers). Either drop the
  index (2 callers deep-import `@logger/channelTrace`) or widen it to the curated entry.
- **P25-5 — Anthropic compaction-threshold config read duplicated** _(LOW)_. `modelHandlerAnthropic.ts:501`
  re-reads `texra.model.compactionThresholdPercent` inline instead of calling the base
  `getCompactionThresholdPercent()` (`ModelHandler.ts:822`). One-line DRY when next touching the file.
- **P25-6 — registry one-time migrations on the lookup hot-path** _(LOW)_. `agentRegistry.ts` embeds three
  `migrateLegacy*` routines (~250 LOC) writing `workspaceState`; extracting to `agentRegistry.migrations.ts`
  (called once from `doLoad`) isolates VS-Code-era persisted-key baggage from the SDK-facing lookup surface.

### Open ledger at HEAD `e1bfb60` (still present unless noted)

- **§24's three #6671 items — now CLOSED** (see above); the **public→protected** visibility track — also
  **CLOSED** (above). The model-handler design-track backlog is not fully drained: §2.6
  `modelHandlerValidation.ts` still sits under `src/agent/modelHandlers/` and is still imported by
  `ModelFactory` for the validation route; keep that relocation item open alongside the port-width work.
- **§9/§21 trim the over-wide `IModelHandler` port** — still the one model-handler item of substance:
  458 LOC, the flattened `SdkToolCall` union + the load-bearing optional `createBatchedToolUseFollowUpMessages?`.
  Behavior-touching (the non-optional-with-base-default sequencing); unapplied.
- **§4** `UsageMonitor` two-sink fan-out — unchanged (sidebar vs. transcript, agentCategory-gated, intentional).
- **§5 / Step 7** — still no `delegateTo(...)` primitive (`grep` empty); delegation remains a tool call; the
  per-category flow-runner pre-work (`d32be3b`/`a15dd86`) is in-tree. The one structurally-open item, multi-day by design.
- **§16 #1** — the `agentRegistry` UI-altitude residue is still present only as the thin
  `computeAgentOptionsData` orchestrator beside the SDK-exported core. Close to closed, but still open until
  that last view-model helper moves out of the registry surface.
- **§16 #4** (`@logger`↔`@agent/trace` value coupling, `channelTrace.ts:10`) — unchanged; latent, low.
- **N4** `ModelHandler` default `createChannelTrace('Agent')` (`:160`) — unchanged; normal launch handlers
  overwrite it through `setLogger`, but helper-model handlers created by `createHelperModelKit()` still use
  this path unless an explicit helper-model logger is added. Low, but live; touches the import graph and
  helper-model logging behavior.
- **§21 remainder** — `ToolSessionState` empty schema, the `TaskState` refine-vs-discriminated split, the
  base `FlowParams` / `CycleParams` placeholder bags (the §21 re-export aliases are closed, but the base
  placeholders remain), and the `AgentState.recordRound` 3-field forwarder — all unchanged.
- **`@agent/index` barrel curation** + **`PlatformAgentDirectoryBootstrapOptions`** export — deliberate
  surface decisions, deferred (re-surfaced this pass as logger-agent 6–7).
- **§23 backlog still open** — N2 `resumeToolUseFromSnapshot` remains a third launch entry duplicating much
  of `executeAgent`'s lifecycle/result assembly; N3 `BaseFlowContextInit extends AgentCore` remains a
  near-empty services split; N5 stale `createBatchedToolUseFollowUpMessages` JSDoc and N6 core-flow
  micro-tidies remain low-priority. All are behavior- or type-shape-touching; none was applied here.
- **Carried from §23 / §21** (`platform().agentResume` near-single-use required port; §13 #1
  `AgentRuntimeHost.emit` mixes UI + essential events; §3.1 no `@agent/runtime/index.ts`) — unchanged.
  **SDK-008** — CLOSED (§19).

### Subagent split points — unchanged and reconfirmed

No change to §5 + the 06-26 ranking. Config-driven YAML agents over the two flows (reflection,
`ToolUseRoundFlow`) + the `delegate_*` tools / `executeSubagent` remain the existing isolated-context
subagent mechanism (own `RunContext`, KV store, usage accumulator, depth-gating, async result delivery);
the `agentCategory` dispatch in `executeAgent` is the cleanest internal seam; `ModelInvocationNode` and
`ToolUseDispatchNode` remain the two cleanest node-level extraction points (serializable I/O; only obstacle
is the shared mutable `shared` + ambient `RunContext`). Ranked value/effort order unchanged: (1) wire the
existing `review` tool-use agent as a post-draft **Verifier** delegation (lowest risk, reuses
`executeSubagent`, no new flow code); (2) introduce a typed `delegateTo(subagent, input, { maxDepth, tools })`
over the existing plumbing; (3) formalize the workflow agents (`polish`/`correct`/`merge`) as SDK actors with
typed I/O; (4) **relocate** the module-global registries onto the per-session handle (_relocate, never delete
— load-bearing_) to gate concurrent in-process sessions; (5) decompose the multi-phase workflow agents —
gated by #4.

**Net for 2026-06-29:** thesis reaffirmed for the twentieth pass — incremental, not structural. The material
development since §24 is the **reconciliation §24 asked for**: re-pinned to a HEAD containing #6671 and moved
its three closures (RetryState HIGH collapse, four-member `IModelHandler` port narrowing, `createResponse`
template dedup) plus the `public→protected` visibility track from open → closed. The fix/SSOT/DRY wave
continues across settings/model-handlers/runtime, none adding a layer. Three independent fresh-eyes agents
re-reached the standing verdict and re-surfaced the recurring traps (the `IModelHandler` width/removal for the
thirteenth time, the rejected `ModelHandler` auth-extraction, the tracked `@agent/index` barrel) — all
re-rebutted or already-tracked; one new false positive (`isOReasoningModel`/`isGrokReasoningModel` "dead
getters" — verified used 6×) is recorded. Six genuinely-new micro-candidates (P25-1–P25-6) are all
behavior-touching and recorded for a future tidy pass. Guardrails intact; no dead shim/barrel remains, so no
refactor was applied to the codebase this pass — only the §25 ledger reconciliation.

---

## 26. Re-verification addendum — 2026-07-04 (twenty-first pass — confirmation; re-pinned to a new branch lineage, §4 observability-unification now landing in code)

A twenty-first pass, run on branch `claude/eager-noether-5uum43` at HEAD **`1ab46ab`** (2026-07-04). Note the
lineage change: this is a **different feature branch** from §25's `claude/eager-noether-bfxlhs` (whose pin was
`e1bfb60`) — a fresh feature-branch lineage, not a continuation of §25's branch. (The exact commit-ancestry
between the two pins is left unstated deliberately: it depends on shared-history depth that a shallow working
clone truncates, so a local `git merge-base` here is not authoritative — the branch identity is the reliable
signal.) A three-agent
fresh-eyes fan-out (independent, source-only, **not** given this document) re-covered the four task areas: an
`agent/core` + `agent/runtime` + `implementations/flows` abstraction audit, a `modelHandlers/` port + base +
OpenAI-compatible subclass audit, and a `packages/core` surface + `logger` + `agent/trace` + `eventBus`
observability audit. **All three re-reached the standing verdict independently** — the core agent
self-concluded "already well-aligned," the model-handler agent "well-factored internally … the problem is the
port shape, not duplication," the surface agent "genuinely SDK-shaped … heavier … mainly in plumbing
exposure, not architecture." The thesis holds for the twenty-first time: **incremental, not structural.**
Confirmation-only — **no refactor applied** (every still-open item is behavior- or type-shape-touching; the
guardrail greps below show no dead shim/barrel to delete).

### Material development since §25 — §4 observability-unification is now landing in code

The one substantive change over the audited dirs since the last lineage is the run-fact routing rework, on
this branch as of today:

- **`cbf5a39` "route run facts through session event hub" (Closes #6962, 2026-07-04)** introduces
  `runtime/runFactEvents.ts`, `runtime/SessionRunFactProjector.ts`, and expands `runtime/SessionEventHub.ts`.
  Run-scoped progress facts (`updateTodos`, `updatePlan`, `addOutputFiles`, `updateMissingOutputs`,
  `updateCompileFailures`, `goalPaused`) are now emitted as `AgentTrace` **domain** events under a
  `runFact.*` key (`emitRunFact`, `runFactEvents.ts:33-42`), re-published through `SessionEventHub`, decoded
  back by string-prefix (`fromRunFactDomainKey`, `SessionRunFactProjector.ts:56`), and re-emitted on
  `runtimeHost.emit(...)`; token usage is projected the same way to `updateStreamUsage`
  (`SessionRunFactProjector.ts:51`). This is the team **executing the §4 direction** — run facts leave the
  VS Code-free flow code via the trace/host seam rather than a direct `bus.emit`, consistent with the
  CLAUDE.md "new run-scoped facts extend `AgentTrace` or `ProgressEventPayloads`, never a new `bus.emit`"
  rule. Recorded as movement **with** the audit, not against it.

### One genuinely-new micro-candidate on the just-landed code (behavior-touching; not applied)

- **P26-1 — the `runFact.*` trace round-trip is a stringly-typed bounce of an already-typed payload**
  _(MEDIUM, behavior-touching)_. A fact that is already a typed `ProgressEventPayloads[K]` is wrapped into a
  `domain` trace event under the stringly key `runFact.<name>` and then decoded by prefix-parse back into the
  identical typed payload on the other side (`runFactEvents.ts:19-42` ↔ `SessionRunFactProjector.ts:56-64`).
  For an embedder the same fact is now observable on **two** channels — a `domain` `AgentEvent`
  (`key: "runFact.*"`) on `trace.subscribe(...)` and a typed `ProgressEvent` via `runtimeHost` — with no
  signpost for which to consume. This is the §4 "two overlapping observability channels" theme, now sharper
  because the bridge exists in code. Candidate: promote the ~6 run-facts to real first-class `AgentEvent`
  union arms (deleting the encode/decode), **or** route them straight to `runtimeHost` and keep them off the
  trace — one home per fact. Behavior-touching (every `emitRunFact` producer + the desktop/extension
  projector wiring); the surface agent reached this without the doc. Related: **`SessionEventHub`'s
  `export type SessionFact = never` (`SessionEventHub.ts:9`)** leaves the `{ scope: 'session' }` arm of the
  event union carrying no payload — a live placeholder; the run-scope re-publish is a pass-through of
  `trace.subscribe` until a real `SessionFact` materializes. Keep the hub for the multi-window
  session-isolation seam it is documented to be; the round-trip above is the trimmable part.

### SDK-lens observation re-recorded — the tool-definition primitive is not on the curated surface

Measured against the Anthropic Claude Agent SDK shape ({ run/query, **tool definitions**, streaming
messages, hooks }), `@texra/core` covers run (`runAgent`), streaming/hooks (`trace` + `runtimeHost`), and
outcome-as-data (`ResultEvent`), but exports **no** way to define or register a tool — `src/tools/core/define.ts`
and `src/tools/registry.ts` are not re-exported (`grep` of `packages/core/src/index.ts` → none). An embedder
can run the built-in YAML agents but cannot extend the tool set without reaching into `@tools/*` internals.
This is a **product-scope decision, not a defect**: either curate `defineTool` + the registration entry into
`@texra/core` if custom tools are in scope for embedders, or state the boundary in the `index.ts` header
(which today implies a full SDK). Near-zero effort to document; recorded, not flagged as an abstraction to
remove.

### P25-1–P25-6 ledger reconciled first-hand at HEAD `1ab46ab`

- **P25-1 (compat-key monkey-patch → `readonly` field) — PARTIALLY ADDRESSED, still open.**
  `PROVIDER_HANDLER_ROUTES` now carries a declarative per-route `compatibilityKey`
  (`ModelFactory.ts:59-101`), but the post-construction non-enumerable brand still exists — the
  `__texraModelHandlerCompatibilityKey` property and its tagged-type read-back remain (`ModelFactory.ts:43-49`).
  The declarative source landed; the monkey-patch tagging did not go away. Keep open.
- **P25-2 (`@agent/types/index.ts` pass-through shim) — LARGELY TRIMMED since §25** (correction on first-hand
  re-read at this HEAD). §25 described a 7-symbol re-export plus a local `NormalizedUsage`; the file now
  re-exports **only** `export type { FileOpResult } from '@shared/schemas/opResults'` (`NormalizedUsage` no
  longer lives here). A single-symbol pass-through remains — either drop it or fold `FileOpResult` into the
  importing sites — but the bulk of the P25-2 shim is already gone; not "unchanged." (Flagged by Codex + the
  `texra-review` bot; verified.)
- **P25-3 (`core/usage/ResponseUsage.ts` provider-SDK type re-export block) — effectively MOOT / not present
  as described** (correction). There is **no** bare `export type { CompletionUsage, AnthropicUsage, … }`
  forwarding block at `:58-66` (those lines are the internal `ResponseUsageBase` interface). The
  `CompletionUsage` / `AnthropicUsage` symbols that remain are **imports that are load-bearing** —
  `ExtendedCompletionUsage extends CompletionUsage` (`:29`) and the `NativeUsagePayload` union (`:44-46`) — so
  there is no forwarding-only surface left to trim. Close P25-3. (Flagged by Codex; verified first-hand.)
- **P25-4 (`@logger/index.ts` exposes one symbol) — unchanged, confirmed** (`export { createChannelTrace }`
  only; the functional `debug/info/warn/error` API is the deep `@logger/logUtils` path, ~70+ callers — the
  barrel still misrepresents its module). Low, cosmetic.
- **P25-5 (Anthropic inline compaction-threshold read) — unchanged, present**
  (`modelHandlerAnthropic.ts` still reads `texra.model.compactionThresholdPercent` inline instead of the
  base `getCompactionThresholdPercent()`). One-line DRY when next touching the file. **False positive to
  record:** a review bot (`texra-review`, deepseek) claimed `getCompactionThresholdPercent` "does not exist
  anywhere" — verified **wrong first-hand**: `grep -rn getCompactionThresholdPercent src/agent/modelHandlers`
  finds it defined `protected` on the base `ModelHandler` and called from **5 sites** — one in
  `ModelHandler` itself and four across `modelHandlerOpenAI` / `modelHandlerOpenAIResponse`. The method
  exists; the inline Anthropic read genuinely bypasses it. Claim stands. _(Exact line numbers are omitted
  deliberately: this shallow branch checks out at `1ab46ab`, but the reviewers see the PR's merge-with-main
  state where `ModelHandler.ts` sits ~56 lines lower — the method is at `:864` on this branch and `:920` on
  the merged tree, both correct to their own checkout. A grep by symbol name is stable across both; line
  pins are not.)_
- **P25-6 (registry one-time migrations on the lookup hot-path) — unchanged** (not re-inspected in depth this
  pass; carried forward as recorded).

### Guardrails intact at `1ab46ab`

- `find src/agent -name index.ts` → the **same seven** pre-existing barrels (`features`, `goal`, `index`,
  `node`, `storage`, `trace`, `types`); no new barrel; `src/agent/runtime/index.ts` still **absent** (§3.1).
- `grep` for `vscode` imports over
  `src/agent`/`src/model`/`src/latex`/`src/tools`/`src/controllers`/`src/shared`/`src/eventBus`/`src/hosts`
  → **clean**.
- `packages/core/src/index.ts` → **16** `export` statements (unchanged from §25 — no surface added or removed).

### The three fresh-eyes agents re-surfaced the recurring traps — all re-rebutted or already-tracked

- **`IModelHandler` width / god-interface (the fourteenth re-surfacing)** — model-handler agent re-proposed
  splitting the ~44-member port into a core inference contract + `ContinuationProtocol` / `MessageEnrichment`
  mixins + a queried `capabilities` value object. This is the **§9/§21 trim-the-port track**, still the
  correct unapplied path; the load-bearing `SdkToolCall` union + optional
  `createBatchedToolUseFollowUpMessages?` keep the interface non-removable (deletion breaks `tsc`). Tracked,
  behavior-touching, unapplied — **not** re-flagged for deletion.
- **"Extract auth/relay out of base `ModelHandler`"** — not raised this pass by name, but the port-decomposition
  finding brushes it; the standing **rejection** (proposal "Rejected findings"; §23 N1; §25) stands.
- **Config-only OpenAI subclasses collapse** — model-handler agent re-confirmed the mix precisely:
  `modelHandlerDashScope.ts` (14 LOC, one config field) and `modelHandlerXAI.ts` (38 LOC, a debug-log-only
  `extractResponse` override) are effectively pure config and could route to `ModelHandlerOpenAI` with an
  injected config row; GLM is mostly config + 2 small maps; **DeepSeek/Kimi/MiniMax carry genuine behavioral
  overrides and stay classes.** Same §21–§24 conclusion (thin ones are collapsible-to-data, but the
  `PROVIDER_HANDLER_ROUTES` table still needs a constructor per provider) — partial, behavior-touching,
  unapplied.
- **Two full Google handlers (`modelHandlerGoogleGenAI` 1.2k + `modelHandlerGoogleInteractions` 2.2k)** —
  re-surfaced as migration debt gated on the `texra.model.useGoogleInteractionsAPI` flag rollout finishing;
  retire the legacy handler (or fold both onto a `ModelHandlerGoogleBase`) once Interactions is the committed
  default. High effort, flag-gated — tracked, not actioned.
- **`runAgent`/`executeAgent` two-headed entry; `buildAgentLaunchContext → assembleAgentLaunchContext`
  saga-split; node-runs-subflow "wrapper"** — core agent re-examined and **explicitly kept all three**: the
  `runAgent`/`runAgentStream` split has distinct real callers (batteries-included hosts vs. delegation /
  streaming callers) and `runAgent` adds genuine executionId-defaulting + register-on-fresh + `openWorkflowOutput`
  logic; the `assemble*` split is the documented reserve→assemble→compensate saga boundary; the cycle
  factories _are_ the prescribed `Node.exec → createFlow → flow.run` shape. Re-rebutted exactly as §21–§25.

### One re-surfaced DRY item worth carrying — `resumeToolUseFromSnapshot` duplication (= §23 N2)

The core agent independently re-found what §23 recorded as **N2**: `resumeToolUseFromSnapshot`
(`executeAgent.ts:489-569`) rebuilds the same `runToolUseFlow(...)` invocation shape as `runToolUseAgent`
(`executeAgent.ts:203-277`) — identical `onSetup` attach/detach, `onFollowUpConsumed` emit, and
`buildToolUseFlowResult(...)` return, differing only by the resume snapshot/`setupSession`. Extract one
`runToolUseFlowForHandle(ctx, handle, setting, { resumeSnapshot?, setupSession? })` called from both. Low–med,
covered by `resumeToolUseSnapshot.vitest.ts`. Still open (N2 remains on the §23 backlog); not applied here.

### Subagent split points — unchanged and reconfirmed

No change to §5 + the §25 ranking. Config-driven YAML agents over the two flows (reflection,
`ToolUseRoundFlow`) + the `delegate_*` tools / `executeSubagent` remain the existing isolated-context
subagent mechanism; `ModelInvocationNode` / `ToolUseDispatchNode` remain the cleanest node-level extraction
points; there is still **no `delegateTo(...)` primitive** (delegation remains a tool call — the one
structurally-open item, multi-day by design). Ranked value/effort order unchanged: (1) wire the existing
`review` agent as a post-draft Verifier delegation; (2) introduce a typed
`delegateTo(subagent, input, { maxDepth, tools })`; (3) formalize `polish`/`correct`/`merge` as SDK actors
with typed I/O; (4) relocate the module-global registries onto the per-session handle (**relocate, never
delete** — load-bearing); (5) decompose the multi-phase workflow agents (gated by #4).

**Net for 2026-07-04:** thesis reaffirmed for the twenty-first pass — incremental, not structural. The one
material development is that **§4's observability-unification direction is now landing in code** (`cbf5a39`
routes run facts through the trace/session-event-hub seam instead of a direct `bus.emit`) — movement _with_
the audit — which simultaneously makes the two-channel duplication concrete enough to record as **P26-1**
(the `runFact.*` stringly round-trip + the dead `SessionFact = never` arm). Three independent fresh-eyes
agents re-reached the standing verdict and re-surfaced every recurring trap (the `IModelHandler` width for the
fourteenth time, the config-only subclasses, the two Google handlers, the kept two-headed entry, the §23-N2
resume duplication) — all re-rebutted or already-tracked. P25-1 moved to **partially-addressed** (declarative
route keys landed; the monkey-patch brand did not); a first-hand re-read this pass **corrected two carried
labels** — P25-2 is largely trimmed (now a single `FileOpResult` re-export, not the 7-symbol shim) and P25-3
is effectively moot (no bare forwarding block remains; the surviving imports are load-bearing) — with P25-4–P25-6
unchanged. The tool-definition primitive
absent from `@texra/core` is re-recorded as a product-scope/documentation decision, not an abstraction to
remove. Guardrails intact (7 barrels, vscode-clean agnostic zones, 16 surface exports); no dead shim/barrel
remains, so **no refactor was applied** this pass — only the §26 ledger reconciliation and the P26-1 record.

---

## 27. Re-verification addendum — 2026-07-07 (twenty-second pass — confirmation on a fresh branch lineage; one dead-method deletion applied; the `@texra/core` removal + `SessionRunFactProjector` deletion reconciled)

A twenty-second pass, run on branch `claude/eager-noether-vo30tx` at HEAD **`a6f31fb`** (2026-07-07). Fresh
feature-branch lineage past §26's `claude/eager-noether-5uum43` / `1ab46ab` (2026-07-04); the shallow working
clone (95 commits) does not reach `1ab46ab`, so — as in §26 — branch identity, not a local `git merge-base`,
is the reliable signal. A four-agent fresh-eyes fan-out (independent, source-only, **not** given this
document) re-covered the four task areas: an `agent/core` + `agent/runtime` + `implementations/flows`
abstraction audit, a `modelHandlers/` port + base + OpenAI-compatible-subclass audit, a `logger/` + surface
(`platform`/`runtime` entrypoints) audit, and a subagent-boundary map. **All four re-reached the standing
verdict independently** — core "already heavily and correctly refactored … no high-value abstraction to
remove," model-handler "the layer has already been aggressively de-abstracted … no port bloat, no redundant
per-provider helpers," surface "genuinely SDK-shaped … most `Platform` ports are genuinely multi-impl,"
subagent "the tool-use YAML agents are the natural near-zero-cost SDK subagent boundary." The thesis holds
for the twenty-second time: **incremental, not structural.**

### Applied this pass (behavior-preserving; `npm run typecheck` ×5 projects + `eslint` + 386 model-handler vitests green) — net −16 LOC

- **Dead `ModelHandler.emitWebFetchResult` deleted** (`ModelHandler.ts`, was `:338-347`) + its two
  now-orphaned imports (`logWebFetch` from `@agent/trace`, `WebFetchResult` from `./types/ServerToolTypes`).
  Verified **0 callers** first-hand: repo-wide the only `this.emitWebFetchResult` site
  (`support/AnthropicStreamHandler.ts:391`) resolves to that collaborator's **own** `private`
  `emitWebFetchResult` (`:456`) — `AnthropicStreamHandler` is a collaborator, **not** a `ModelHandler`
  subclass — and no subclass, closure-dep, or `ResponseStreamProcessor` wiring reaches the base method. Pure
  deletion, no behavior change, no new indirection — the §2.1/§16/§20-class line-removal this audit applies.
  The sibling `emitWebSearchResult` is **kept**: it has one real caller (the OpenAI-Responses closure at
  `modelHandlerOpenAIResponse.ts:484`).

### Material drift since §26 (`1ab46ab` → `a6f31fb`) — all moving _with_ the audit

1. **`@texra/core` package removed (#7099).** `packages/core` is **absent** at this HEAD (`packages/` =
   cli, desktop, extension, trace-viewer); no `@texra/core` importer remains anywhere. The doc's 2026-07-05
   packaging note anticipated this; it is now ground truth on this lineage. **The "16 surface exports"
   guardrail (§25/§26) retires** — the host-facing surface is now the repo-root path aliases, not a curated
   package. The §26 "tool-definition primitive absent from `@texra/core`" observation is re-framed
   accordingly: there is no core package to curate, so the SDK-surface question becomes whether
   `defineTool`/registry get a curated alias vs. staying `@tools/*` internals — a product-scope/documentation
   decision, unchanged in substance.
2. **`SessionRunFactProjector.ts` deleted (`a6f31fb`).** P26-1 is **half-closed**: the `SessionFact = never`
   placeholder (§26) is **resolved** — `SessionEventHub.ts:16` now declares a real 5-arm `SessionFact` union
   (`goalStateChanged`, `inquiryThreadUpdated`, `clearMissingOutputs`, `updateQueuedFollowUps`,
   `setActiveStream`), so the `{ scope: 'session' }` event arm finally carries a payload. The **`runFact.*`
   stringly round-trip persists**, relocated from the deleted 77-LOC projector into
   `sessionProgressEventProjection.ts:90` (`emitRunFact` → `trace.domain({ key: 'runFact.<name>' })`, decoded
   by `fromRunFactDomainKey` prefix-parse). P26-1's round-trip half stays open; its dead-placeholder half
   closes.
3. **Provider-identity getters deleted (#7346, `a1e3237`).** The base `ModelHandler`'s six
   `isAnthropic/isOpenai/isGoogle/isDeepSeek/isKimi/isMiniMax` getters (each 1–2 callers, all with
   `config.provider` already in scope) are gone — the team executing the audit's own
   single-caller-base-method de-abstraction. Movement **with** the audit.
4. **New `src/agent/workflowScript/` module + eighth barrel.** Guardrail barrel count moves **7 → 8**:
   `workflowScript/index.ts` joins `features/goal/index/node/storage/trace/types`. It is a **legitimate
   module barrel** (a 7-file engine: `parseScript`, `runWorkflowScript`, `sandbox`, `journal`, `types`),
   **not** a shim — it re-exports live functions/types and is imported via the `@agent/workflowScript` alias
   (today by its vitest; internal files use relative imports). Recorded as a real new module, not a
   violation.
5. Other SSOT/DRY commits over the audited dirs — `a244b5b` (route progress backend through session events),
   `3795e96` (collapse duplicated `SessionFact` switch + inline trivial stream wrapper), `fe11aaa` (extract
   app signals from progress bus), `7bcf380` (share one usage-payload parser) — all consolidation, none adds
   a layer.

### Guardrails at `a6f31fb`

- `find src/agent -name index.ts` → **eight** barrels (§26's seven + the new `workflowScript`);
  `src/agent/runtime/index.ts` still **absent** (§3.1).
- `grep` for `vscode` imports over
  `src/agent`/`src/model`/`src/latex`/`src/tools`/`src/controllers`/`src/shared`/`src/eventBus`/`src/hosts`
  → **clean**.
- `packages/core` → **absent** (guardrail retired — drift item 1).

### Genuinely-new candidates recorded (verified first-hand; none applied — all behavior/type-touching)

- **P27-1 — web-search emit cluster: single base method + duplicated guard** _(LOW, behavior-touching)_. With
  the dead fetch method gone (applied above), `emitWebSearchResult` (`ModelHandler.ts:332`) is now a
  1-caller base method whose `if (progressViewEnabled) logWebSearch(...)` guard is privately re-implemented in
  `AnthropicStreamHandler.ts:447` — that collaborator can't reach the `protected` base method. Candidate: one
  shared `support/` free function `emitServerToolResult(logger, enabled, result)`, route both through it, drop
  the base method. ≈ −10 LOC; deferred (touches the Anthropic stream path).
- **P27-2 — `createContinuationPrompt` single-caller hook** (`ModelHandler.ts:793`) _(LOW)_. 0 provider
  overrides, 1 internal caller (`addContinueMessage:943`). Inlineable (≈ −6) but a plausible future override
  seam — §2.5-class "leave or inline," recorded not applied.
- **P27-3 — `createChannelTrace` is a heavyweight duplicate of the functional `logUtils` logger**
  _(MEDIUM, behavior-touching)_. 25 non-test log-only singletons each allocate a full `TraceEmitter`
  (`Set`-of-subscribers + ALS stage scope) only to call `.debug/.info/.warn/.error`; the functional
  `@logger/logUtils` path (144 importers) reaches the same `writeLine`. Candidate: make `createChannelTrace`
  a closure over the functional fns, dropping 25 `TraceEmitter` allocations and the "which logger?" fork.
  Behavior-touching (the trace path suppresses `INTERNAL` console lines — unused by these plain-log sites).
  Same theme as the still-open **P25-4** single-symbol `@logger/index.ts` barrel.
- **P27-4 — four single-implementer `Platform` ports** (`platform.ts:51-57`: `linter`, `addCriticismSink`,
  `toolMissingHandler`, `toolNotificationHandler`) _(LOW)_. Real impls only in VS Code (`extension.ts`); both
  node hosts force-no-op all four (`nodeHost.ts:98-101`). Candidate: make optional (core treats absent as
  no-op) and/or collapse the two tool-notification ports into one host-notification port. ≈ −10 LOC + 4 fewer
  mandatory host concepts. Behavior-touching (host-contract shape).
- **P27-5 — `RunAgentOptions` hand-mirrors `ExecuteAgentOptions`** (`runAgent.ts:15-46`)
  _(LOW, type-hygiene)_. ~9 fields re-declared purely to forward to `ExecuteAgentOptions:87-97`; should
  `extends Pick<ExecuteAgentOptions, …>` to drift-proof. The layer itself is justified (§21 kept
  `runAgent`/`executeAgent`). ≈ −10.
- **P27-6 — `@platform` barrel bypassed by ~95%** (4 importers of `@platform` vs 86 of `@platform/platform`,
  the node hosts and `initPlatform.ts` among the deep importers). Documented-vs-actual convention mismatch;
  standardize one way. Trivial LOC.

### Ledger reconciliation at `a6f31fb`

- **P26-1** — **half-closed** (drift item 2): `SessionFact = never` resolved to a real 5-arm union; the
  `runFact.*` stringly round-trip persists (relocated into `sessionProgressEventProjection.ts`). Keep the
  round-trip half open.
- **P25-1** — carried (declarative route keys present; the monkey-patch compat-key brand not re-inspected this
  pass).
- **P25-2 / P25-3** — as §26 (largely-trimmed single `FileOpResult` re-export / effectively moot).
- **P25-4** — unchanged, present; folded into P27-3's theme.
- **P25-5 / P25-6** — carried.
- **§23-N2** (`resumeToolUseFromSnapshot` duplication) — carried, still open (not re-inspected this pass).

### Recurring traps re-rebutted (do not re-flag)

- **`IModelHandler` width / god-interface (the fifteenth re-surfacing)** — the model-handler agent re-measured
  it first-hand: **35 picked members + 1 optional, every one with a real consumer call through the port**
  (grepped `AgentCore.modelHandler`, `withModelClient`, `followUpMessages` sites) — _not_ bloated. The
  `Pick`-from-class derivation is a drift guard, and the `SdkToolCall` union + optional
  `createBatchedToolUseFollowUpMessages` make deletion break `tsc`. The port-decomposition track (core
  inference contract + mixins + queried `capabilities`) remains the correct _unapplied_ path, not a deletion.
- **`runAgent`/`executeAgent` two-headed entry; cycle-node-runs-subflow "wrapper"; `assemble*` saga-split** —
  core agent explicitly **kept all three** (distinct real callers; genuine executionId-defaulting +
  register-on-fresh + `openWorkflowOutput` logic; the prescribed `Node.exec → createFlow → flow.run` shape).
  Re-rebutted exactly as §21–§26.
- **Config-only OpenAI subclasses collapse; two Google handlers** — reconfirmed as partial / flag-gated
  behavior-touching debt, unapplied.

### Subagent split points — unchanged and reconfirmed (§5)

Config-driven YAML agents over the two flows (`reflection`, `ToolUseRoundFlow`) remain the isolated-context
subagent mechanism; the tool-use YAMLs (`research`, `engineer`, `review`, …) are 1:1 with an SDK subagent
definition (`{ systemPrompt, tools }`) and `runToolUseFlow` is already `isSubagent`-aware. The
`src/tools/delegation/` stack (`delegate_workflow`/`delegate_agent`, `executeSubagent`,
`NativeSubagentStrategy`, depth-gating, cost roll-up, durable result manifest) is a **full reimplementation**
of the SDK subagent-orchestration pattern with **extra** semantics the stock SDK subagent doesn't model —
resumable **WAITING** subagents (async `FollowUpQueue` delivery vs. synchronous tool return), human-in-the-loop
approval (`proposalFlow`), and depth policy — so the real SDK is already treated as one delegation target
among these (`src/tools/claudeAgent.ts` via `@anthropic-ai/claude-agent-sdk`, `codex.ts`). Ranked
value/effort order unchanged: (1) wire the existing `review` agent as a post-draft Verifier delegation;
(2) a typed `delegateTo(subagent, input, { maxDepth, tools })` primitive — the one structurally-open item
(delegation is still a tool call, not an API primitive); (3) formalize `polish`/`correct`/`merge` as SDK
actors with typed I/O; (4) relocate the module-global registries onto the per-session handle (relocate,
never delete — load-bearing); (5) decompose the multi-phase workflow agents (gated by #4).

**Net for 2026-07-07:** thesis reaffirmed for the twenty-second pass — incremental, not structural. One pure
line-removal applied (dead `emitWebFetchResult`, net −16 LOC, all gates green). Material drift reconciled:
`@texra/core` gone (#7099 — surface guardrail retires), `SessionRunFactProjector` deleted (P26-1 half-closed),
provider-identity getters deleted (#7346), a legitimate new `workflowScript` module (barrels 7 → 8). Four
independent fresh-eyes agents re-reached the standing verdict and re-rebutted every recurring trap (the
`IModelHandler` width for the fifteenth time). Six new low/medium candidates recorded (P27-1…P27-6), all
behavior/type-touching, none applied.
