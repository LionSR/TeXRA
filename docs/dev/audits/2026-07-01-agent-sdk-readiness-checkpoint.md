# Agent SDK Readiness — Verification Checkpoint (2026-07-01)

> **Packaging note (2026-07-05):** #7099 later demotes/deletes the unused
> `@texra/core` package. Mentions below are historical checkpoint observations,
> not current workspace layout.

**Status:** Verification checkpoint, not a new audit. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the
[`2026-06-24-agent-sdk-readiness-delta.md`](../../proposals/2026-06-24-agent-sdk-readiness-delta.md)
addendum, and the
[`-2026-06-25.md`](./2026-06-25-agent-sdk-readiness-checkpoint.md) /
[`-2026-06-26.md`](./2026-06-26-agent-sdk-readiness-checkpoint.md) /
[`-2026-06-30.md`](./2026-06-30-agent-sdk-readiness-checkpoint.md) checkpoints.
This pass re-verified the standing audit against the working tree at HEAD
(`4525a79`, branch `claude/eager-noether-uh9acx`, ahead of `origin/main` base
`fcc1fdc`) and records **only** what is genuinely new since the 2026-06-30
checkpoint. It does not re-audit or re-litigate adjudicated findings.

## Why this exists

Another "review and refactor for Agent SDK readiness" request landed, scoped (as
before) against the same four areas: agent core + runtime, `modelHandlers/`,
logger/platform, and the public surface. Exactly as the 2026-06-25 → 2026-06-30
checkpoints predicted for a recurring request, a fresh uninformed audit would
re-surface the same already-adjudicated traps. Those are filtered out here under
"Already adjudicated — do NOT re-litigate." What remains is smaller than any
prior pass: **two of the seven 2026-06-30 backlog items have since landed** through
the reviewed PR train, and **no genuinely-new, unattended-safe cleanup exists**
this pass. Nothing was applied — see the reasoning below.

## Verdict — unchanged

**The codebase remains well-aligned and continues to converge on the plan.** The
SDK-idiomatic spine is intact and re-confirmed in-tree at HEAD:

- **`createModelHandler` factory** — `PROVIDER_HANDLER_ROUTES` exhaustive
  `Record<ModelProvider, …>` at `ModelFactory.ts:55`, single `createModelHandler`
  entry at `:378`. The "model provider" routing unit, unchanged.
- **`platform()` composition root** — `initPlatform` at `platform.ts:49`,
  frozen `platform()` accessor at `:57`.
- **`AgentTrace` emit/subscribe channel** — `src/agent/trace/index.ts` still the
  single `emit()`/`subscribe()` surface with the domain helpers as sugar.
- **No barrel regression** — `src/agent/core/index.ts` remains **absent** (deleted
  in Step 1); `@texra/core` is still the one curated surface.
- **PocketFlow `Node.exec → createFlow().run` shape** and the
  **lead-and-specialists delegation model** — unchanged.

The live work remains **surface curation and per-session state relocation**, both
deliberate reviewed-PR-train tracks — not unattended sweeps.

## The plan kept landing — 2026-06-30 backlog converging

Verified in-tree at HEAD. Since the 2026-06-30 checkpoint, the PR train closed
two of that checkpoint's seven deferred backlog items and shrank the tracked
god-file concentration:

- **`createWorkspaceStateWorkflowOutputPolicy` single-use factory (was LOW) —
  GONE.** No longer present anywhere under `src/agent/`; the settings-reading
  object literal was inlined. One less two-layer-factory-called-once.
- **Over-wide `@agent/index` barrel zero-consumer type symbols (was LOW) —
  GONE.** `AgentDirectoryServiceOptions`, `CustomAgentDirectoryStore`, and
  `BundledAgentDirectoryName` are no longer exported from
  `src/agent/index/index.ts` (swept by the reviewed dead-export-cleanup train,
  #6841 / commits `3df8035`, `73c7720`). The barrel now re-exports only
  live-consumed symbols.
- **Two oversized handlers actively peeled down (tracked design migration).**
  `openai/modelHandlerOpenAIResponse.ts` is now **2694 LOC** (was ~2730 on
  06-30, ~3328 at the original audit) and
  `google/modelHandlerGoogleInteractions.ts` is **2155 LOC** (was ~2168). #6847
  ("consolidate provider helper flows") extracted shared usage normalization
  (`openai/openAIUsage.ts`, `support/UsageNormalizer.ts`), `googleHandlerShared`,
  and `agentCliShared` — another in-direction abstraction-collapse landing, not a
  regression.

## Applied this pass — none (and why)

**No code changes were applied this pass.** This is the disciplined outcome, not
an omission. The 2026-06-30 pass applied exactly two changes, and both were pure
dead-code: a zero-importer-**anywhere** export deleted entirely, and a single-use
two-layer factory inlined and confirmed behavior-identical. This pass found no
equivalent:

- The two safest 06-30 backlog items **already landed** (above), so there is no
  carried pure-deletion left.
- The remaining backlog is entirely **type/signature changes or deliberate
  surface decisions** (see below) — the class the standing discipline defers to
  the reviewed PR train, never applies unattended.
- A `knip --include exports,types` sweep reported 354 "unused exports," but the
  list is dominated by **dynamically-wired false positives** — VS Code commands
  registered by string ID, webview signal exports (`streamLogs$`, `inquiries$`,
  `activeStreamState$`), desktop channel-ID constants
  (`ELECTRON_WEBVIEW_MESSAGE_CHANNEL`), and test-only helpers
  (`__resetKeychainStateForTests`). None sit in the four audit areas as an
  obviously-safe deletion, and applying knip's output unattended would break
  dynamic wiring. This is precisely the deliberate, reviewed surface-curation
  territory the repo already handles in PRs like #6841 — not an unattended target.

## Genuinely-new findings — none

There are **no genuinely-new findings** this pass beyond the carried backlog.
Every candidate an uninformed fan-out would raise is either already adjudicated
(below) or already recorded in the 06-30 backlog (carried, unchanged).

## Carried backlog — re-confirmed at HEAD (deferred to the reviewed PR train)

Unchanged from 2026-06-30 except the two items that landed. All are
signature/type changes or deliberate surface decisions, not pure dead-code — so
they belong to the reviewed train, not this unattended pass.

### Core / runtime

- **`agentContextToRunContext` single-use projection** _(HIGH — but a known
  seam)_. `AgentLaunchContext.ts:145` is a pure field-spread whose only caller is
  `withExecutionRunContext` two functions later (`:170`, re-confirmed single
  caller). The "two-layer factory called once" pattern — but flagged in the
  standing audit (§2.2, older name `createExecutionRunContext`) and **left intact
  each pass** because it documents the activation-saga seam; inline only with a
  reviewer's eye on the surrounding readability. Not applied unattended.
- **`ModelClientServices` 2-field contract restated** _(LOW — surface)_. The
  `{ client, refreshClient? }` shape is declared as an interface
  (`CycleServices.ts:30`) and re-stated inline in `ModelInvocationNode.ts:40`
  (`InvocationServices`); `RetryState.ts:52` (`RetryableNodeServices`) overlaps
  only on `refreshClient?`. Have `InvocationServices` reference/extend
  `ModelClientServices<unknown>` so the model-client contract has one home. A
  type change (behavior-neutral), drift risk not a bug — reviewed train.

### Model handlers (port-narrowing / surface curation track)

- **Three public `is*` provider booleans on the port** _(LOW — design)_.
  `isOpenai` / `isAnthropic` / `isGoogle` (`IModelHandler.ts:206-226`) remain on
  the provider-agnostic port because they have external readers (media wiring,
  usage/UI keying). A cross-cutting change, not a local one — backlog.
- **Two oversized handlers as split candidates** _(tracked design migration)_.
  Now 2694 / 2155 LOC (shrinking, above). Peel the Responses
  WebSocket/background-poll path and the Interactions resend-`Step[]` path into
  collaborators the way the stream processors and #6847's helper flows already
  are. Real smell, not a quick win (shared mutable state + background polling +
  test subclassing).

### Public surface (barrel curation)

- **`PlatformAgentDirectoryBootstrapOptions` exported, zero external consumers**
  _(LOW)_ (`platformAgentDirectories.ts:18`). Re-confirmed this pass: the only two
  references are the declaration (`:18`) and its use as a parameter type in the
  same file (`:57`); zero external importers of the name. Drop the `export` or
  inline as the parameter type. A deliberate surface decision — reviewed train.

## Already adjudicated — do NOT re-litigate

The standing rulings hold at HEAD. See the canonical doc's "Rejected findings"
table, the delta-2026-06-24 citations, and the 2026-06-30 table.

| Re-surfaced candidate                                                        | Ruling                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove `IModelHandler` as a "duplicate" of `ModelHandler`                    | **Trap (8th refutation)** — optional `createBatchedToolUseFollowUpMessages?` + `Pick<>` consumer narrowing make it load-bearing; removal breaks `tsc`.           |
| Collapse OpenAI-compatible subclasses to a config/data table                 | **Trap** — DeepSeek/Kimi/MiniMax/GLM each carry ~12 real per-provider override points; not URL/id shims.                                                         |
| Inline the `createResponse → withCreateResponseGuard → sdkErrorTagger` chain | **Keep** — each layer is a real override seam.                                                                                                                   |
| Collapse `runAgent` / `runAgentStream` (`executeAgent`) dual entry           | **Trap** — Step-6 deliberate naming; the facade merge hits a real type wall (`registerExecution` needs parsed `AgentConfig`; callers hold `AgentConfigPayload`). |
| Add a `src/agent/runtime/index.ts` public barrel                             | **Trap** — Step 4 rejected standalone runtime/toolUse barrels as pure churn; `@texra/core` **is** the curated barrel.                                            |
| Split `assembleAgentLaunchContext` / `buildAgentLaunchContext`               | **Keep** — a genuine commit-point + saga-compensation high/low split, not a forwarder.                                                                           |
| Inline the cycle-wrapper nodes / `createXCycleFlow` factories                | **Keep** — this _is_ the mandated `Node.exec → createFlow → flow.run` shape.                                                                                     |
| `@logger` not routed through `platform()`                                    | **Intentional, documented** — logging is its own host-injected subsystem.                                                                                        |
| Sweep knip's "354 unused exports"                                            | **Trap** — dominated by dynamically-wired false positives (string-registered commands, webview signals, channel IDs, test helpers); reviewed-PR curation only.   |

## Subagent split points — re-confirmed, unchanged

No change to the canonical/delta analysis. TeXRA already has a **mature subagent
mechanism** (YAML profiles ≈ SDK `AgentDefinition`; `delegate_*` +
`executeSubagent` = the isolated-context delegation primitive; teams = the
"available subagents" roster). The three highest-confidence, already-isolated
units a formal decomposition would draw on remain:

- **`ModelFactory.createModelHandler`** — `(modelName) → handler`; the "model
  provider" unit.
- **`assembleAgentLaunchContext`** — `(launchInput) → launchContext`; the "define
  an agent" half of the SDK model.
- **`agentToolResolution`** — `(declaredTools, gates) → effectiveTools`; the SDK's
  tools-as-data resolver, a pure pipeline.

Split points ranked by value/effort (unchanged from 2026-06-26/30):

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
This pass applied **no** code changes — a deliberate, disciplined outcome: the two
safest 06-30 backlog items already landed through the reviewed train, and nothing
new qualifies as an unattended-safe pure-deletion (the remainder is
type/signature/surface decisions, and knip's 354 are dynamically-wired false
positives). Continue executing the canonical plan's surface/multi-tenant track
(port narrowing, per-session state relocation, the typed `delegateTo` primitive,
and wiring `review` as the first Verifier delegation) through the reviewed PR
train. Do not re-open the adjudicated traps.

## Verified (this checkpoint)

- `npm run typecheck` — exit 0 across all four projects (root, test-kernel,
  `texra`, `@texra-ai/cli`).
- `npx vitest run src/test-kernel/agent` — **799 passed, 4 skipped** (127 files;
  up from 765 on 06-30 — more coverage, no regression).
- Spine re-confirmed by grep at HEAD: `PROVIDER_HANDLER_ROUTES` +
  `createModelHandler` (`ModelFactory.ts:55/378`), `initPlatform`/`platform`
  (`platform.ts:49/57`), `AgentTrace` emit/subscribe (`trace/index.ts`),
  `src/agent/core/index.ts` **absent** (no barrel regression).
- 06-30 backlog landings confirmed in-tree: `createWorkspaceStateWorkflowOutputPolicy`
  (absent), the three `@agent/index` zero-consumer type symbols (absent from the
  barrel).
- Oversized-handler LOC re-measured: `modelHandlerOpenAIResponse.ts` 2694,
  `modelHandlerGoogleInteractions.ts` 2155 (both shrinking).
- Carried backlog re-confirmed at HEAD: `agentContextToRunContext` single caller
  (`AgentLaunchContext.ts:170`), `ModelClientServices` restated inline
  (`ModelInvocationNode.ts:40`), three `is*` booleans (`IModelHandler.ts:206-226`),
  `PlatformAgentDirectoryBootstrapOptions` zero external importers
  (`platformAgentDirectories.ts:18/57`).
