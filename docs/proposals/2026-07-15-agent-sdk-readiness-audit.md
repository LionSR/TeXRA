# Agent SDK Readiness Audit

_Audit of the TeXRA agent core, model handlers, logger, and platform surface for
readiness to be consumed as a reusable Agent SDK (`@texra/core`). Findings are
file:line-anchored and caller-count-verified._

## TL;DR

**The hard part is already done.** The agent core is genuinely host-agnostic —
no `vscode` imports and no scattered `console.*` logging in any VS-Code-free
zone, and none of the repo's explicitly-banned abstraction patterns (trivial
identity factories, two-layer-called-once factories, re-export barrels,
redundant single-impl ports) survive at any material scale. The flow/node
layering, the `ModelHandler` base class, and the `runAgent → executeAgent`
split were each checked and are justified, not ceremony.

**The remaining work is _shape_, not coupling.** For SDK extraction the gaps
are: (1) two process-global service locators (`platform()` + the logger) that
fight dependency injection, (2) no curated public boundary — the CLI reaches
24+ internal paths directly, and (3) one concrete anti-shim violation
(`IModelHandler.ts`) flagged independently by two separate audits.

**Subagents are not a gap to build — they are a shipped subsystem.** The
child-run machinery (lineage, depth, detach/cascade, cost roll-up, resume) is
already SDK-grade. Two things stand between it and Agent-SDK-style composition:
surfacing a subagent's result as an _awaitable value_ instead of only a queued
follow-up, and optional session isolation.

---

## 1. Abstractions to remove / simplify (ranked)

### P1 — Mechanical, low-risk

**1.1 Delete the `IModelHandler.ts` re-export shim.** _(converged: flagged by
both the model-handler and agent-core audits)_
`src/agent/types/IModelHandler.ts:16-29` re-exports 9 data contracts
(`SdkToolCall`, `OpenAIToolCall`, `CreateResponseOptions`, `ExtractResponseResult`,
the six per-provider `*ToolCall` types) that actually live in
`ModelHandlerContracts.ts`. **22 files import them via `@agent/types/IModelHandler`;
only 1 imports the true source `@agent/types/ModelHandlerContracts`.** The README
claims this subtree has "no re-export shims per the repo's anti-shim convention"
— this is exactly that shim, kept "for existing consumers."
_Fix:_ repoint consumers at `ModelHandlerContracts` and delete the re-export
block. Mechanical (~import-line churn only).

**1.2 Inline `isGrokReasoningModel`** — single-caller extraction (banned per
checklist §13). `src/agent/modelHandlers/ModelHandler.ts:742` has exactly one
consumer, `openai/modelHandlerOpenAI.ts:300`. Its doc sells it as a DRY sibling
of `isOReasoningModel` (which genuinely has 4 sites) but it has none.
_Fix:_ inline at the call site, delete the getter.

**1.3 Inline `isCodexSessionRoutableForAgent`** — single-caller wrapper.
`src/agent/runtime/ModelFactory.ts:572` is a 12-line function called once at
`:482`; it only wraps `isCodexSessionRoutable()` in a `CodexAuthError`-retagging
try/catch. _Fix:_ inline into the one call site.

### P2 — Provider-specific rules leaking into the abstract base

**2.1 Move the xAI reasoning-effort clamp out of the base.**
`src/agent/modelHandlers/ModelHandler.ts:754` (`validateReasoningEffort`)
hardcodes Grok's `low|medium|high` vocabulary and the `xhigh→high` clamp in the
abstract base, gated on `provider !== XAI`. `ModelHandlerXAI` deliberately keeps
_no_ override (comment at `openai/modelHandlerXAI.ts:16`) so a provider rule
lives in the base while the provider file stays empty. _Fix:_ move the clamp
into a `ModelHandlerXAI.validateReasoningEffort` override; base default becomes
`return effort`. (Sibling `getEffectiveReasoningEffort` at `:774` embeds a GPT-5
rule but is called by 4 handlers and is inert off GPT-5 — leave it.)

**2.2 Move 3 session-bound host-UI ports off the `Platform` interface.**
`linter?`, `addCriticismSink?`, and `toolNotificationHandler?` are used only by
agent tools and belong to the active session's host interaction adapter. Move
them onto `SessionHandle.interactions`, following the tool-edit approval
precedent. `toolMissingHandler?` remains process-host scoped: its direct caller
in `toolUtils.ts` serves non-agent commands, formatters, media, and LaTeX code,
so routing it through `SessionHandle` would create a lower-layer dependency on
the agent runtime. Drops the Platform interface from 16 to 13 members without
introducing a subsystem cycle.

### P3 — Redundant type-layer indirection

**3.1 Collapse the `IModelHandler` `Pick<>` port into the class.**
`src/agent/types/IModelHandler.ts:55-100` is `Pick<ModelHandler, …40 names…>`,
used as a type in exactly **3 places** (`core/flows/BaseFlowServices.ts:19`,
`core/flows/CycleServices.ts:46`, `followUp/followUpMessages.ts:16`). It carries
no independent contract — it's mechanically derived from the class — and the
"can't drift" claim is only half true: adding a method to `ModelHandler` does
_not_ surface here; the 40-name union is a hand-maintained allowlist. Its only
delta over the class is the optional `createBatchedToolUseFollowUpMessages`.
_Fix:_ annotate the 3 consumers against `ModelHandler<…>` directly and express
the one optional method inline; this also dissolves the `ModelHandler ⇄
IModelHandler` cycle that `ModelHandlerContracts` was split out to avoid.
Type-only, zero runtime — real but not urgent.

### Verified-clean (checked, do not touch)

- **`ModelHandler.ts` is a genuine shared base, not a god-class** — ~900 of its
  1795 lines are the `#7101` triage doc essays; the code is one responsibility
  (model-call lifecycle). Provider leaks are only findings 1.2/2.1.
- **Flow/node layering is real bridging**, not pass-through: `ResponseCycleNode`/
  `ToolUseCycleNode` do state hydration, outcome classification, and
  `recordRound` safety-nets; `Flow → PersistedFlow → RoundPersistedFlow` each
  adds distinct behavior.
- **`runAgent` over `executeAgent` earns its layer** (executionId assignment,
  `registerExecution`, `applyHelperModelPreference`, `openWorkflowOutput`).
- **`IToolUseSession`** (single impl) is a _justified_ port — it's what lets
  `core/flows` inject the session without importing `implementations/` (the
  inward-dependency rule). Keep.
- **`toolConversion.ts`, `support/`, `utils/`** — every helper spot-checked has
  ≥2 provider callers; correctly placed at root, none single-use.
- **No direct `vscode` imports** in any agnostic zone (grep exit 1). The four
  `console.warn` sites in agnostic code are leaf-schema deprecation warnings that
  deliberately avoid pulling the logger barrel into dependency-free schemas —
  documented exceptions, not violations.

---

## 2. Surface-area simplifications

### 2.1 Draw a curated public boundary (the missing `@texra/core`)

The real external consumer today is `packages/cli`, and it reaches **24+ distinct
`@agent/{runtime,core,implementations}` file paths directly.** Beyond the
legitimate entry points it imports internals that an SDK should hide:
`runtime/SessionHandle` (11×), `SessionEventHub`, `StreamStatusService`,
`HostInteractions`, `runtimeInteractionEvents` (9×), `executionRegistry`,
`implementations/flows/tooluse/ToolUseSessionTypes`. `executionRegistry.ts`
(1029 lines) exports the `ExecutionRegistry` god-class plus 8 supporting types,
all directly importable.

The no-barrel convention keeps _internal_ edges explicit (good) but means no
module declares "this is the public API." _Fix:_ introduce one thin curated SDK
surface exporting only the primitives below and mark the rest internal. This is
a **boundary declaration, not code deletion.**

**Minimal public entry points (the real API):**

| Symbol                                                                         | Location                      | Role                                                                    |
| ------------------------------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------- |
| `runAgent(request, options)`                                                   | `runtime/runAgent.ts`         | documented "START HERE"                                                 |
| `executeAgent(config, id, options)`                                            | `runtime/executeAgent.ts`     | lower engine (owns id/registration/lineage)                             |
| `resumeToolUseFromSnapshot` / `resumeQueuedToolUse` / `resolveAndResumeStream` | `runtime/`                    | resume entry points                                                     |
| `AgentRuntimeHost`                                                             | `runtime/AgentRuntimeHost.ts` | host-implemented DI seam                                                |
| `AgentFlowResult` / `AgentFinalResult`                                         | `runtime/`                    | result contracts (composed via `.pick().extend()`, correctly separated) |
| `AgentConfig` / `AgentConfigPayload` / `AgentDataclass`                        | `core/definition/`            | definition inputs                                                       |

**Machinery that leaks into the surface and should go behind the façade:**
`executionRegistry` (+ its 8 option/result types), `StreamStatusService`,
`SessionEventHub`, `runtimeInteractionEvents`, `SessionHandle` (a per-session
composition record — legitimately shared but deep internal state), the flow
factories (`ToolUseRoundFlow`/`ResponseCycleFlow`), `ToolUseSessionTypes`.

### 2.2 Eliminate the two global service locators

**`platform()` is a process-global service locator** (`src/platform/platform.ts:78-99`
— one module-level `_platform` singleton, `initPlatform()` "exactly once",
reached by ~78 sites). This is the single biggest SDK-extraction obstacle: an
embedder cannot run two differently-configured agent contexts in one process,
cannot inject per-call test doubles, and inherits a hidden global dependency in
every core module — the opposite of the handle injection an Agent SDK expects.
The throw-on-uninitialized contract also makes core modules unusable as plain
library functions.
_Direction:_ the in-repo escape hatch already exists — tool-edit approval and
run/session facts were deliberately moved off `Platform` onto
`SessionHandle`/`SessionEventHub`. Finish that pattern: keep `platform()` as the
host-bootstrap seam but have the SDK entrypoint accept a `Platform` value passed
into the session/run context so core reads it from the handle. At minimum, the
SDK-facing entrypoint should take `Platform` as an explicit argument.

**The logger is a second, parallel global** (`src/logger/logUtils.ts:46-48`
mutable module state, wired via `setOutputChannelFactory` separately from
`initPlatform()`). An SDK consumer must discover and correctly order _two_
independent global seams, and the mutable channel map is process-wide (no
per-session routing). _Fix:_ fold a `log`/`LogSink` port into `Platform`, or
expose the log factory as an explicit field of the SDK context.

**Minimal core-host contract ≈ 8 services:** `config, globalState,
workspaceState, fs, workspace, storage, secrets, lifecycle`.
`languageModel/toolAvailability/agentResume/agentDirectories` are host-capability
ports (keep, but optional/defaulted — the repo already models this well with
`UNAVAILABLE_LANGUAGE_MODEL_PORT` / `NO_TOOL_AVAILABILITY_HOST`). The three
session-bound host-UI ports (§2.2 above) should leave the core port entirely.

### 2.3 Provider surface: reduce the cost of adding a handler

Adding one provider today touches **4 files** and implements **~16-18 abstract
methods** (`getClient`, `initializeMessages`, `createRoundMessages`,
`createMediaContent`, `extractResponse`, `computePrice`, `normalizeUsage`,
`processThinkingBlock`, `extractToolUse`, the follow-up/message builders, …)
plus 6 generic type parameters, plus an `llm-zoo` enum value, a
`PROVIDER_HANDLER_ROUTES` entry (`ModelFactory.ts:59`), and a
`ModelHandlerCompatibilityKey` union member. There is no "minimal handler" base —
OpenAI-compatible providers escape the 16-method wall only by subclassing
`ModelHandlerOpenAI`. If an external SDK is a goal, a documented minimal-handler
base (chat/completions shaped, with defaults for the media/tool plumbing) would
be the highest-leverage addition to this surface.

### 2.4 Safety: make log redaction opt-out, not opt-in

`setOutputChannelFactory` now wraps sinks with `redactSecrets` by default, so an
SDK consumer cannot accidentally persist provider credentials by omitting a
host-side convention. The CLI's local operator terminal is the explicit
`{ trusted: true }` exception; extension and default console sinks remain
redacted.

---

## 3. Proposed subagent split points

**TeXRA already has a first-class subagent subsystem.** `delegate_agent` /
`delegate_workflow` (`src/tools/delegation/DelegationTools.ts`) route to `executeSubagent`
(`src/tools/delegation/subagentExecution.ts:114`). Each child gets its own
`AgentLaunchContext`, `streamId`, trace, and run lifecycle; recorded lineage via
`registerExecution(…, parentExecutionId, depth+1)` (`subagentExecution.ts:167`);
its own tools/model (`isSubagent: true` filters out proposal/delegation tools,
`executeAgent.ts:345`); configurable stop policy (detach vs cascade,
`detachSubagentsOnStop.ts`); and cost roll-up into the parent. On the four
Agent-SDK axes (independent context / own tools / own model / returns a result)
it is very close.

**Delta vs. the SDK model — two blocking couplings:**

1. **Result delivery is a queued follow-up, not a return value.** A child's
   output is a formatted message enqueued onto the parent's `FollowUpQueue` by
   `parentStreamId` and then a _wake_ (`childRunLoop.ts:366-439`). An SDK
   boundary wanting `result = await subagent.run()` must go through the already-
   existing `AgentExecutionHandle.result` deferred (`ExecutionHandle.ts:110-111`)
   instead of the follow-up path. **This is the single biggest gap.**
2. **Parent and child share one `SessionHandle`** (`subagentExecution.ts:140,222`)
   — context is process-isolated but not session-isolated. Plus ambient parent
   state read from an AsyncLocalStorage `RunContext` frame
   (`subagentExecution.ts:124-159`), which means a _programmatically_ launched
   subagent (outside a live parent tool-call frame) fails fast at `:126-137`.
   Clean boundaries need these passed explicitly.

**Split points (ranked by readiness):**

1. **Workflow-script engine — already at the SDK seam (strongest, lowest cost).**
   `runWorkflowScript` (`src/agent/workflowScript/runWorkflowScript.ts:192`) is
   deterministic JS orchestration over an _injected_ `WorkflowAgentRunner` port
   (`types.ts:53`) returning a typed result. Its `agent()`/`parallel()`/
   `pipeline()` primitives are exactly SDK-style subagent composition, with a
   concurrency semaphore, resume journal, call cap, and `AbortSignal` timeout.
   The only remaining work is the _production_ binding of `WorkflowAgentRunner`
   to `executeSubagent`'s in-band path (only a test fake exists today). **This is
   the natural first programmatic SDK surface.**
2. **Agent review (find-issues + fix).** `AgentReviewService.reviewWorkingTree`
   (`AgentReviewService.ts:244-355`) is a bounded unit: diff → instruction →
   run the `changeReviewer` tool-use agent as a full subagent session
   (`stopAfterCycle: true`) → collect findings. Core is already host-neutral
   (`reviewDiff.ts`, `reviewIssues.ts`). _Coupling to cut:_ findings don't
   _return_ — they stream mid-run through the `report_review_issue` tool into
   the service's mutable `this.issues` + panel emitter. The run's result should
   carry the findings out (they're already created with stable ids at source).
3. **Agent creation.** `createAgentCreatorFlow` (`agentCreatorFlow.ts:493`) takes
   category + description and emits validated agent YAML. _Coupling to cut:_ the
   `AgentCreatorUI` port (prompts / tool picker / file open) is interleaved into
   the flow nodes; only `GenerateNode` is pure helper-model work. Lift the
   interactive gather/pick/register steps to the edges to run headless.
4. **Goal continuation** (`maybeBuildGoalContinuation.ts:24`) — not itself a
   subagent but the pure prompt-builder primitive that turns a single run into a
   long-running autonomous loop; already cleanly factored (host-neutral, no side
   effects). Noted as the SDK-analog of a subagent's internal iteration.

_(Not a split point: `ToolUseFollowUp`/`FollowUpQueue` is the message-passing
substrate subagent results travel through — the delivery channel a synchronous
SDK boundary would bypass, not an independent task.)_

---

## Recommended sequencing

1. **Now (mechanical, no behavior change):** 1.1 delete `IModelHandler` shim,
   1.2/1.3 inline the two single-caller helpers. One small PR.
2. **Next (leak cleanup):** 2.1 xAI clamp override and 2.2 move 3 host-UI ports
   off `Platform`. Each independently landable.
3. **Structural (the actual SDK enablers):** §2.1 curated boundary + §2.2 accept
   `Platform` as an explicit argument to the SDK entrypoint (dissolve the global
   locator). These unlock a real `@texra/core`.
4. **Composition (when programmatic subagents are wanted):** wire
   `WorkflowAgentRunner` to `executeSubagent`, and surface subagent results via
   `AgentExecutionHandle.result` instead of only the follow-up queue.

_Audit produced by parallel deep-dives over agent core, model handlers,
logger/platform, and the subagent/child-run subsystem; every claim above is
file:line-anchored and caller-count-verified against the tree at the time of
writing._
