# Agent SDK Readiness — Verification Checkpoint (2026-06-30)

> **Packaging note (2026-07-05):** #7099 later demotes/deletes the unused
> `@texra/core` package. Mentions below are historical checkpoint observations,
> not current workspace layout.

**Status:** Verification checkpoint, not a new audit. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the
[`2026-06-24-agent-sdk-readiness-delta.md`](../../proposals/2026-06-24-agent-sdk-readiness-delta.md)
addendum, and the
[`2026-06-25-agent-sdk-readiness-checkpoint.md`](./2026-06-25-agent-sdk-readiness-checkpoint.md)
/ [`-2026-06-26.md`](./2026-06-26-agent-sdk-readiness-checkpoint.md) checkpoints.
This pass re-verified the standing audit against the working tree at HEAD
(`0a23055`, branch `claude/eager-noether-0hzm51`, ahead of `origin/main` base
`fcc1fdc`) and records **only** what is genuinely new since the 2026-06-26
checkpoint. It does not re-audit or re-litigate adjudicated findings. (The
2026-06-26 checkpoint's cited base `93af483` was rebased away and is no longer a
named object; this pass cites by file content, not by that hash.)

## Why this exists

Another "review and refactor for Agent SDK readiness" request landed, scoped (as
before) against the same four areas: agent core + runtime, `modelHandlers/`,
logger/platform, and the public surface. Exactly as the 2026-06-25 and 2026-06-26
checkpoints predicted for a recurring request, four independent uninformed
fan-out audits re-surfaced several already-adjudicated traps. Those are filtered
out here and listed under "Already adjudicated — do NOT re-litigate." What remains
is a small set of genuinely-new, additive micro-findings; the two safest were
applied this pass under the established behavior-neutral discipline.

## Verdict — unchanged

**The codebase remains well-aligned and continues to converge on the plan.** The
SDK-idiomatic spine is intact and re-confirmed in-tree: the PocketFlow
`Node.exec → createFlow().run` shape, the `AgentTrace` emit/subscribe channel,
the `platform()` composition root, the `createModelHandler` factory, and the
lead-and-specialists delegation model. The four audits independently reached the
same conclusion the canonical plan already holds — there are no barrels, no
re-export shims, and no trivial/two-layer identity factories of consequence; the
logger is a single sink funnel; the `IModelHandler` port is load-bearing (the
optional-method feature-detection seam, now refuted **seven** times); and the
OpenAI-compatible subclasses carry real per-provider behavior, not URL/id shims.
The live work remains **surface curation and per-session state relocation**.

## The plan kept landing — 2026-06-26 backlog largely closed

Verified in-tree at HEAD: most of the 2026-06-26 "genuinely-new findings — NOT
applied" backlog has since **landed** through the PR train.

- **`RetryState` interface collapsed (was HIGH).** The one-field `RetryState`
  interface is gone from `src/agent/core/flows/RetryState.ts`;
  `handleInvocationResult(result, state, options)` now takes a single `state`
  (carrying `lastError`) plus an options object — the redundant third param and
  the `handleInvocationResult(execRes, shared, shared, …)` double-pass at the
  sole call site (`ModelInvocationNode.ts`) are both gone. Confirmed: no
  `state, retryState` / `shared, shared` call sites remain.
- **Four port members trimmed (was MEDIUM).** `getAgentCategory`,
  `canProcessToolResultAttachments`, `createMediaContent`, and
  `createAssistantMessage` are **no longer on `IModelHandler`**; they survive as
  `protected` members on the `ModelHandler` base (e.g. `ModelHandler.ts:140`
  `canProcessToolResultAttachments`, `:176` `getAgentCategory`). One step further
  on the "trim the over-wide port" track.
- **Base-method visibility tightened (was LOW).** `getApiKey`
  (`ModelHandler.ts:357`), `createMediaMessage` (`:591`), and
  `containCutOffMessage` (`:672`) are now `protected`.
- **`createResponse` poll-loop duplication addressed.** The shared
  `BackgroundPoller` collaborator (`modelHandlers/support/BackgroundPoller.ts`,
  PR #6739) was extracted for the duplicated poll loops — another
  abstraction-collapse landing in the SDK direction.

Other in-direction drift since the prior checkpoint: #6746 moved chat-export
formatters into host-neutral core; the CLI structured-output train
(init/tools/version) landed (outside the four audit areas, no spine regression).

## Applied this pass (#this-PR) — two new behavior-neutral micro-cleanups

Each was traced to ground truth and confirmed behavior-neutral before editing.
Verified: `npm run typecheck` exit 0 across all four projects (root,
test-kernel, `texra`, `@texra-ai/cli`); `npx vitest run src/test-kernel/agent`
→ **765 passed, 4 skipped** (126 files); `npx eslint` over the two touched files
→ 0 errors.

1. **Dead `nodeWorkspace` singleton export removed.**
   (`src/platform/defaults/nodeWorkspace.ts`). `export const nodeWorkspace:
WorkspaceProvider = createNodeWorkspace();` had **zero** importers anywhere in
   `src`/`packages` — every consumer (desktop `index.ts`, CLI `initPlatform.ts`,
   three test-kernel suites) calls `createNodeWorkspace(() => root)` with an
   explicit root. The bare `cwd`-defaulted singleton was pure surface bloat.
   Deleted the export; kept `createNodeWorkspace`. (The sibling `nodeFilesystem`
   singleton **is** used by desktop/CLI fallbacks — untouched.)

2. **Single-use `getDebugContext` two-layer factory inlined.**
   (`src/agent/core/flows/CommonCycleTypes.ts`). `getDebugContext(services,
params)` was a pure field-projection called from exactly one place
   (`saveCycleDebug`) — the repo's explicit "two-layer factory called once"
   anti-pattern. Inlined the `{ logger, executionId, modelName, isRemote }`
   literal into the `maybeSaveDebugObject({ context: {…} })` call and dropped the
   now-unused `DebugContext` / `AgentTrace` / `ExecutionId` type imports.
   Behavior-identical.

## Genuinely-new findings — NOT applied (additive backlog)

None of these are in the existing ledger/delta/checkpoint docs. They are ranked;
all are deferred to the reviewed PR train rather than applied unattended (each is
a signature/type change or a deliberate surface decision, not a pure dead-code
deletion).

### Core / runtime

- **`agentContextToRunContext` single-use projection** _(HIGH — but a known
  seam)_. `AgentLaunchContext.ts:136-154` is a pure field-spread whose only
  caller is `withExecutionRunContext` two functions later (`:156-164`) — the
  "two-layer factory called once" pattern. Candidate to inline the literal into
  `withExecutionRunContext`. Flagged in the standing audit (§2.2) under the older
  name `createExecutionRunContext` and left intact each pass; inline only with a
  reviewer's eye on readability of the surrounding activation saga.
- **`ModelClientServices` 2-field contract restated three ways** _(LOW —
  surface)_. The `{ client, refreshClient? }` shape is declared as an interface
  (`CycleServices.ts:30`) and re-stated inline in `ModelInvocationNode.ts:40-43`
  (`InvocationServices`) and `RetryState.ts:56-63` (`RetryableNodeServices`).
  Have the latter two reference/extend `ModelClientServices` so the model-client
  contract has one home. Drift risk, not a bug.
- **`createWorkspaceStateWorkflowOutputPolicy` single-use factory** _(LOW)_.
  `runReflectionFlow.ts:351-360`, called once as a `??` default at `:291`. A
  trivial settings-reading object literal; inlineable, but it does document
  intent — lowest priority.

### Model handlers (port-narrowing / surface curation track)

- **Three public `is*` provider booleans on the port** _(LOW — design)_.
  `isOpenai` / `isAnthropic` / `isGoogle` (`IModelHandler.ts:206-226`) are
  provider-identity flags on a provider-agnostic port. The `is*` booleans for the
  OpenAI-compatible families were already kept `protected` and off the port; these
  three remain because they have external readers (media wiring, usage/UI keying).
  A cross-cutting change, not a local one — backlog, not a quick win.
- **Two oversized handlers as split candidates** _(tracked design migration)_.
  `openai/modelHandlerOpenAIResponse.ts` (~2730 LOC) and
  `google/modelHandlerGoogleInteractions.ts` (~2168 LOC) are the only genuine
  concentration left — peel the Responses WebSocket/background-poll path and the
  Interactions resend-`Step[]` path into collaborators the way the stream
  processors already are. Same "real smell, not a quick win" the canonical plan
  tracks (shared mutable state + background polling + test subclassing).

### Public surface (barrel curation — carried from 2026-06-26, still open)

- **Over-wide `@agent/index` barrel** _(LOW)_. `src/agent/index/index.ts`
  re-exports zero-consumer type symbols (`AgentDirectoryServiceOptions`,
  `CustomAgentDirectoryStore`, `BundledAgentDirectoryName`, and the others listed
  in the 2026-06-26 checkpoint). Re-verified zero external consumers this pass.
  Deferred because barrel curation is a deliberate surface decision.
- **`PlatformAgentDirectoryBootstrapOptions` exported, zero external consumers**
  _(LOW)_ (`platformAgentDirectories.ts:23`). Re-confirmed zero external
  importers. Inline as the parameter type or drop the `export`.

## Already adjudicated — do NOT re-litigate

The uninformed passes re-surfaced these; the standing rulings hold at HEAD. See
the canonical doc's "Rejected findings" table and the delta-2026-06-24 citations.

| Re-surfaced candidate                                                        | Ruling                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove `IModelHandler` as a "duplicate" of `ModelHandler`                    | **Trap (7th refutation)** — optional `createBatchedToolUseFollowUpMessages?` + `Pick<>` consumer narrowing make it load-bearing; removal breaks `tsc`.                                                                                   |
| Collapse OpenAI-compatible subclasses to a config/data table                 | **Trap** — DeepSeek/Kimi/MiniMax/GLM each carry ~12 real per-provider override points (reasoning channels, temperature policy, token-count API); not URL/id shims.                                                                       |
| Inline the `createResponse → withCreateResponseGuard → sdkErrorTagger` chain | **Keep** — each layer is a real override seam used by `modelHandlerOpenAIResponse` / `modelHandlerGoogleInteractions`.                                                                                                                   |
| Collapse `runAgent` / `executeAgent` (`runAgentStream`) dual entry           | **Trap** — the Step-6 deliberate "make the surface say which entry is which" naming; the facade merge hits a real type wall (`registerExecution` needs parsed `AgentConfig`; callers hold `AgentConfigPayload`; 6-arg lineage register). |
| Add a `src/agent/runtime/index.ts` public barrel                             | **Trap** — Step 4 rejected standalone runtime/toolUse barrels as "pure churn" without a lint gate; `@texra/core` **is** the curated barrel.                                                                                              |
| Split `assembleAgentLaunchContext` / `buildAgentLaunchContext`               | **Keep** — a genuine commit-point + saga-compensation high/low split, not a forwarder (verified first-hand in the standing audit).                                                                                                       |
| Inline the cycle-wrapper nodes / `createXCycleFlow` factories                | **Keep** — this _is_ the mandated `Node.exec → createFlow → flow.run` shape.                                                                                                                                                             |
| `@logger` not routed through `platform()`                                    | **Intentional, documented** — logging is its own host-injected subsystem.                                                                                                                                                                |

## Subagent split points — re-confirmed and sharpened

No change to the canonical/delta analysis: TeXRA already has a **mature subagent
mechanism** (YAML profiles ≈ SDK `AgentDefinition`; `delegate_*` + `executeSubagent`
= the isolated-context delegation primitive; teams = the "available subagents"
roster). The runtime audit this pass sharpened the **internal seam map** — the
three highest-confidence, already-isolated units a formal subagent decomposition
would draw on:

- **`ModelFactory.createModelHandler`** — `(modelName) → handler`. One entry,
  exhaustive `PROVIDER_HANDLER_ROUTES`, pure routing predicate, already used
  independently by helper-model / mid-session switch / launch. The "model
  provider" unit.
- **`assembleAgentLaunchContext`** — `(launchInput) → launchContext`. The single
  "resolve agent YAML + build prompts + create handler + user vars" unit; the
  "define an agent" half of the SDK model.
- **`agentToolResolution`** — `(declaredTools, gates) → effectiveTools`. Documented
  single source of truth for the effective tool list; the SDK's tools-as-data
  resolver, already a pure 7-stage pipeline.

Wrapping these: `runFlowWithLifecycle` is the run-executor (`(launchContext,
flowRunner) → terminalResult`), and `runReflectionAgent` / `runToolUseAgent` are
the two category runner bodies — the workflow vs tool-use subagent boundary.

Split points ranked by value/effort (unchanged from 2026-06-26):

1. **Wire the existing `review` tool-use agent as a post-draft Verifier
   delegation** — lowest risk, reuses `executeSubagent`, no new flow code.
2. **Introduce a typed `delegateTo(subagent, input, { maxDepth, tools })`
   primitive** over the existing plumbing.
3. **Formalize workflow agents (`polish`/`correct`/`merge`) as SDK actors with
   typed I/O contracts.**
4. **Relocate the remaining module-global registries onto the per-session handle**
   — gates concurrent in-process sessions.
5. **Decompose in-agent multi-phase workflow agents** (`devise`, `verifyFix`)
   into draft → Verifier → apply hand-offs — gated by #4.

## Recommendation

**The codebase is SDK-ready in shape; no structural refactoring is warranted.**
This pass applied two behavior-neutral cleanups (a dead export deletion and a
single-use factory inline) and recorded the remaining additive micro-findings as
backlog for the reviewed PR train. Continue executing the canonical plan's
surface/multi-tenant track (port narrowing, per-session state relocation, the
typed `delegateTo` primitive, and wiring `review` as the first Verifier
delegation). Do not re-open the adjudicated traps.

## Verified (this checkpoint)

- `npm run typecheck` — exit 0 across all four projects.
- `npx vitest run src/test-kernel/agent` — 765 passed, 4 skipped (126 files).
- `npx eslint` over the two touched files — 0 errors.
- Grep-confirmed zero callers for each applied deletion: named `nodeWorkspace`
  import (none; only `createNodeWorkspace`), `getDebugContext` (only its own
  definition + the single `saveCycleDebug` call site).
- Grep-confirmed the 2026-06-26 backlog landings in-tree: `interface RetryState`
  (absent), the four trimmed port members (absent from `IModelHandler`, present
  `protected` on the base), and the three tightened base-method visibilities.
