# Agent SDK Readiness — Verification Checkpoint (2026-07-02)

> **Packaging note (2026-07-05):** #7099 later demotes/deletes the unused
> `@texra/core` package. Mentions below are historical checkpoint observations,
> not current workspace layout.

**Status:** Verification checkpoint, not a new audit. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the detailed
[`./2026-05-29-agent-sdk-readiness-audit.md`](./2026-05-29-agent-sdk-readiness-audit.md), the
[`2026-06-24-agent-sdk-readiness-delta.md`](../../proposals/2026-06-24-agent-sdk-readiness-delta.md)
addendum, and the `-2026-06-25` / `-2026-06-26` / `-2026-06-30` /
[`-2026-07-01`](./2026-07-01-agent-sdk-readiness-checkpoint.md) checkpoints.

This pass re-verified the standing audit against the working tree at HEAD
(`0fac656`, branch `claude/eager-noether-74k469`), which sits **at or ahead of**
the 07-01 checkpoint's base — it already contains the 07-01 checkpoint commit
(`bba96d9`, #6848) plus the subsequent usage-accounting / stream-labeling PR
train (#6859, #6861, #6862, #6826, …). None of those touch the four audit areas
structurally.

## Why this exists

Another recurring "review and refactor for Agent SDK readiness" request landed,
scoped (as before) against the same four areas: **agent core + runtime**,
**`modelHandlers/`**, **logger + platform surface**, and the **public surface**.
Exactly as the 06-25 → 07-01 checkpoints predicted, this pass deliberately ran a
**fresh, uninformed 4-way fan-out audit** (one reader per area plus an Agent SDK
pattern reference) to stress-test the standing plan, then reconciled every
finding against the adjudicated rulings. The uninformed audit re-surfaced the
known traps (filtered out below) — but it also went deeper into three files no
prior pass had opened (`textConnection.ts`, the `agentRegistry` resolver family,
`agentDirectoriesRegistry.ts`) and surfaced a short list of **genuinely-new but
minor, reviewed-train-class** candidates. Those are recorded here so future
passes treat them as tracked, not novel.

## Verdict — unchanged

**The codebase remains well-aligned and SDK-ready in shape. No structural
refactoring is warranted.** The SDK-idiomatic spine is intact and re-confirmed
in-tree at HEAD:

- **`createModelHandler` factory** — `PROVIDER_HANDLER_ROUTES` exhaustive
  `Record<ModelProvider, …>` at `ModelFactory.ts:55`, single `createModelHandler`
  entry at `:378`. The "model provider" routing unit, unchanged. The
  compatibility-key routing means an SDK-backed handler can drop in behind one
  case with zero caller changes.
- **`platform()` composition root** — `initPlatform` at `platform.ts:49`,
  frozen `platform()` accessor at `:57`.
- **`AgentTrace` emit/subscribe channel** — `src/agent/trace/index.ts` still the
  single `emit()`/`subscribe()` surface; `debug/info/warn/error`, stages,
  streams, and domain helpers are sugar over `emit()`.
- **No barrel regression** — `src/agent/core/index.ts` remains **absent**;
  `@texra/core` (`packages/core/src/index.ts`) is still the one curated surface,
  exposing `runAgent` (high-level) + `runAgentStream` (streaming engine).
- **PocketFlow `Node.exec → createFlow().run` shape** and the
  **lead-and-specialists delegation model** — unchanged. `ResponseCycleNode` /
  `ToolUseCycleNode` still build and run their inner flows directly in `exec()`.

## Applied this pass — none (and why)

**No code changes were applied.** This is the disciplined outcome, consistent
with 07-01. Every genuinely-new candidate below is a type/signature/surface
change or would remove a live (dev-test) code path — the class the standing
discipline defers to the reviewed PR train, never applies unattended. There is
no carried pure-deletion left (the two safe 06-30 items landed), and this pass
found no equivalent unattended-safe deletion.

## Genuinely-new candidates — surfaced by this fan-out, absent from all prior docs

Confirmed by grep to appear in **none** of the canonical doc, the 232 KB
detailed audit, the delta, or the 06-25 → 07-01 checkpoints. All are
reviewed-train class (ranked by value/effort); none is unattended-safe.

### Core / runtime

1. **Dead-in-production provider branches in `textConnection.ts`** _(MEDIUM)_.
   `bestConnectionMethod(str1, str2, openaiApiKey?, n?)`
   (`src/agent/runtime/textConnection.ts:102-134`) has an `openaiApiKey` branch
   that hand-builds an `OpenAI` client with `gpt-4.1`, but the only production
   caller invokes it 2-arg (`ResponseCycleFlow.ts:305` via
   `this.services.bestConnectionMethod(str1, str2)`), so that branch is never
   reached in a real run. `bestConnectionMethodAnthropic` (`:144-182`) is a
   near-complete Claude copy reachable **only** from the dev command
   `packages/extension/src/commands/tests/connectionTests.ts`. Collapsing the
   production path to the helper-model call and dropping the direct-SDK twins
   would remove direct `openai` / `@anthropic-ai/sdk` client construction from
   the runtime module. _Deferred:_ not pure dead code — removal drops the
   connection-test command's coverage; needs a reviewer's call on keeping or
   repointing that test.

2. **Helper-model concern fragmented across three tiny modules** _(LOW)_.
   `helperModel.ts` / `helperModelName.ts` (33 LOC) / `helperModelPreference.ts`
   (49 LOC) each export one thing for one concern; `helperModelName` is imported
   by both others. Each has real logic (not a shim), so consolidating
   name-resolution + kit-creation into `helperModel.ts` is a churn-reduction
   nicety, worth doing only when the area is next touched.

3. **`RetryRequestCoordinatorImpl` naming inconsistency** _(LOW nitpick)_.
   `RetryRequestCoordinator.ts:46` carries an `...Impl` suffix its siblings
   (`PlanApprovalCoordinator`, `AgentProposalCoordinator`) do not; the suffix
   implies a separate interface that does not exist. Behavior-neutral rename;
   defer to the reviewed train per the standing "no unattended type/naming
   changes" rule.

### Public surface

4. **Five overlapping public agent resolvers + a trivial-factory spread**
   _(MEDIUM surface)_. `agentRegistry.ts` exports `getAgent` (`:350`),
   `resolveAgent` (`:428`), `resolveAgentForLaunch` (`:627`), `resolveAgentKey`
   (`:488`), and `findAgentByIdentifier` (`:538`) — five ways to turn an
   identifier into an agent, each with TSDoc explaining when _not_ to use the
   others. `resolveAgent` is `getAgent` + `toResolvedAgent`, and `toResolvedAgent`
   (`:433`) is a near-identity spread (the trivial-factory pattern CLAUDE.md
   discourages); `resolveAgentKey` is `getAgent` + `agentKeyOf`. Verified caller
   counts: `resolveAgentKey` 2, `findAgentByIdentifier` 3, `resolveAgentForLaunch`
   4 external callers — so a collapse to one options-driven
   `resolveAgent(id, { category?, forLaunch?, source? })` is a real multi-site
   refactor, not a deletion. _Deferred:_ reviewed surface-curation track (same
   class as #6841).

5. **`agentDirectoriesRegistry` — a second composition-root global** _(MEDIUM)_.
   `agentDirectoriesRegistry.ts:8-22` (`let agentDirectories`, `set/get`) is a
   second global-injection singleton alongside `platform()`, even though
   `platformAgentDirectories.ts:24-54` already _builds_ the
   `AgentDirectoryService` entirely out of `platform().fs` + `GlobalStorageFS`.
   Folding agent directories into a `platform()` port (or the per-session handle)
   removes the separate global. _Ties directly to the standing backlog item
   "relocate the remaining module-global registries onto the per-session handle"_
   — record here as the concrete second instance of that item.

6. **Per-service `Logger` sub-interfaces in the directory layer** _(LOW)_.
   `AgentDirectoryService.ts` / `AgentDirectorySync.ts` define
   `AgentDirectoryServiceLogger { debug; error }` and
   `AgentDirectorySyncLogger { info; warn }` — a third logger abstraction (after
   `logUtils` and `createChannelTrace`) wired in `platformAgentDirectories.ts` as
   pure pass-throughs to `logger.debug/error/info/warn`. Drop the sub-interfaces;
   have the (already host-agnostic) services use the functional logger directly.

### Model handlers

7. **Provider-specific reasoning logic in the host-agnostic base
   `ModelHandler`** _(LOW — layering, not dead code)_. `isGrokReasoningModel`
   (`ModelHandler.ts:544`, XAI-only; sole reader `modelHandlerOpenAI.ts:282`),
   the `if (this.config.provider !== ModelProvider.XAI)` branch of
   `validateReasoningEffort` (`:557`), and the `isDeepSeek`/`isKimi`/`isMiniMax`
   protected getters (`:469-481`, read only by `ModelHandlerOpenRouterNative`)
   are provider identity/behavior sitting one layer too high. **Note — do not
   re-file as dead code:** the detailed audit (§ `2026-05-29-agent-sdk-readiness-audit.md`
   line 2940) already ruled the "`isOReasoningModel`/`isGrokReasoningModel` are
   unused dead getters" claim **VERIFIED FALSE** (they are used). The _new,
   weaker_ angle here is placement: push the XAI/DeepSeek/Kimi/MiniMax branches
   down into the owning subclass (or a capability flag) so the shared base stops
   carrying provider enums. Reviewed-train, low priority.

## Adjudicated traps the fan-out re-surfaced — rulings held

The uninformed audit raised, and the standing rulings correctly filter, all of
the following. No change.

| Re-surfaced candidate                                                               | Ruling                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove `IModelHandler` as a "duplicate" of `ModelHandler`                           | **Trap** — optional `createBatchedToolUseFollowUpMessages?` + `Pick<>` consumer narrowing make it load-bearing; removal breaks `tsc`.             |
| Collapse OpenAI-compatible subclasses (DeepSeek/Kimi/MiniMax/GLM) to a config table | **Trap** — each carries ~12 real per-provider override points.                                                                                    |
| Inline `createResponse → withCreateResponseGuard → sdkErrorTagger`                  | **Keep** — each layer is a real override seam.                                                                                                    |
| Collapse `runAgent` / `runAgentStream` dual entry                                   | **Trap** — Step-6 deliberate naming; facade merge hits a real type wall.                                                                          |
| Add a `src/agent/runtime/index.ts` public barrel                                    | **Trap** — `@texra/core` **is** the curated barrel.                                                                                               |
| Inline the cycle-wrapper nodes / `createXCycleFlow` factories                       | **Keep** — this _is_ the mandated `Node.exec → createFlow → flow.run` shape.                                                                      |
| `@logger` not routed through `platform()`                                           | **Intentional, documented** — logging is its own host-injected subsystem.                                                                         |
| Two logging idioms (`logUtils` vs `createChannelTrace`) are "redundant"             | **Known / tracked** — the run-scope vs module-singleton split is targeted by `docs/prds/2026-05-17-logger-surface-cleanup.md`; not a new finding. |
| `isOReasoningModel` / `isGrokReasoningModel` are "dead getters"                     | **VERIFIED FALSE** (detailed audit line 2940) — they are used; see new candidate #7 for the distinct layering angle.                              |
| Sweep knip's "unused exports"                                                       | **Trap** — dominated by dynamically-wired false positives (string-registered commands, webview signals, channel IDs, test helpers).               |

## Carried backlog — re-confirmed at HEAD

All still stand; all reviewed-train class (signature/type/surface decisions).

- **`agentContextToRunContext` single-use projection** _(HIGH, known seam)_ —
  single caller `withExecutionRunContext` re-confirmed at
  `AgentLaunchContext.ts:170` (function defined `:145`). Left intact: it
  documents the activation-saga seam; inline only with a reviewer's eye.
- **`createWorkspaceStateWorkflowOutputPolicy` single-use factory** — **still
  GONE** (grep: absent under `src/agent/`).
- **`PlatformAgentDirectoryBootstrapOptions` exported, zero external consumers** —
  re-confirmed: only references are the declaration (`platformAgentDirectories.ts:18`)
  and its own parameter use (`:57`).
- **`ModelClientServices` 2-field contract restated inline** — re-confirmed at
  `ModelInvocationNode.ts:41` (`InvocationServices` restates `{ client,
refreshClient? }`). Have it extend `ModelClientServices<unknown>`.
- **Three public `is*` provider booleans on the port** — `isOpenai`/`isAnthropic`
  (`IModelHandler.ts:206-207`), `isGoogle` (`:243`); real external readers, kept.
- **Two oversized handlers as split candidates** — re-measured this pass:
  `modelHandlerOpenAIResponse.ts` **2739 LOC**, `modelHandlerGoogleInteractions.ts`
  **2155 LOC**. Tracked design migration (background-poll path / resend-`Step[]`
  path), not a quick win.

## Subagent split points — re-confirmed, unchanged

No change to the canonical/delta analysis. TeXRA already has a **mature subagent
mechanism** (YAML profiles ≈ SDK `AgentDefinition`; `delegate_*` +
`executeSubagent` = the isolated-context delegation primitive; teams = the
"available subagents" roster). The three highest-confidence already-isolated
units a formal decomposition would draw on:

- **`ModelFactory.createModelHandler`** — `(modelName) → handler`; the "model
  provider" unit.
- **`assembleAgentLaunchContext`** — `(launchInput) → launchContext`; the "define
  an agent" half of the SDK model.
- **`agentToolResolution`** — `(declaredTools, gates) → effectiveTools`; the SDK's
  tools-as-data resolver, a pure pipeline.

Split points ranked by value/effort (unchanged from 06-26/30/07-01):

1. Wire the existing `review` tool-use agent as a post-draft Verifier delegation
   (lowest risk; reuses `executeSubagent`, no new flow code).
2. Introduce a typed `delegateTo(subagent, input, { maxDepth, tools })` primitive
   over the existing plumbing.
3. Formalize workflow agents (`polish`/`correct`/`merge`) as SDK actors with
   typed I/O contracts.
4. Relocate the remaining module-global registries onto the per-session handle —
   gates concurrent in-process sessions (**agent registry + the new
   `agentDirectoriesRegistry` candidate #5 above are the concrete targets**).
5. Decompose in-agent multi-phase workflow agents (`devise`, `verifyFix`) into
   draft → Verifier → apply hand-offs — gated by #4.

## Recommendation

**SDK-ready in shape; no structural refactoring warranted.** Continue the
canonical plan's surface/multi-tenant track through the reviewed PR train: port
narrowing, per-session state relocation (now with two concrete registry targets),
the typed `delegateTo` primitive, and wiring `review` as the first Verifier
delegation. Fold the seven new candidates above into that train — none is an
unattended sweep. Do not re-open the adjudicated traps.

## Verified (this checkpoint)

- Spine re-confirmed by grep at HEAD `0fac656`: `PROVIDER_HANDLER_ROUTES` +
  `createModelHandler` (`ModelFactory.ts:55/378`), `initPlatform` / `platform`
  (`platform.ts:49/57`), `AgentTrace` emit/subscribe (`trace/index.ts`),
  `src/agent/core/index.ts` **absent** (no barrel regression).
- New candidates verified in-tree: `bestConnectionMethod` 2-arg-only production
  call (`ResponseCycleFlow.ts:305`) + `bestConnectionMethodAnthropic` reachable
  only from `connectionTests.ts`; resolver caller counts (2/3/4 external);
  `agentDirectoriesRegistry` global vs `platform()`-derived service;
  base-class provider getters (`ModelHandler.ts:469/544/557`, XAI reader
  `modelHandlerOpenAI.ts:282`).
- Absence-from-prior-docs confirmed by grep across canonical + 232 KB detailed
  audit + delta + all checkpoints (0 hits for `bestConnectionMethod`,
  `resolveAgentKey`, `findAgentByIdentifier`, `agentDirectoriesRegistry`,
  `RetryRequestCoordinatorImpl`, `AgentDirectoryServiceLogger`).
- Carried backlog re-confirmed at HEAD (line refs above).
- `npm run typecheck` — **exit 0** across all projects at HEAD `0fac656` (tree
  green; this checkpoint is a docs-only change, no source touched).
