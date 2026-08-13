# Agent SDK Readiness — Verification Checkpoint (2026-06-26)

**Status:** Verification checkpoint, not a new audit. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the
[`2026-06-24-agent-sdk-readiness-delta.md`](../../proposals/2026-06-24-agent-sdk-readiness-delta.md)
addendum, and the [`2026-06-25-agent-sdk-readiness-checkpoint.md`](./2026-06-25-agent-sdk-readiness-checkpoint.md)
checkpoint. This pass re-verified the standing audit against the working tree at
HEAD (`93af483`) and records **only** what is genuinely new since the 2026-06-25
checkpoint. It does not re-audit or re-litigate adjudicated findings.

## Why this exists

Another "review and refactor for Agent SDK readiness" request landed, scoped (as
before) against the same four areas: agent core + runtime, `modelHandlers/`,
logger/trace, and the public surface. Exactly as the 2026-06-25 checkpoint
predicted for a recurring request, four independent uninformed fan-out audits
re-surfaced several already-adjudicated traps. Those are filtered out here and
listed under "Already adjudicated — do NOT re-litigate." What remains is a small
set of genuinely-new, additive micro-findings; the three safest were applied this
pass under the established behavior-neutral discipline.

## Verdict — unchanged

**The codebase remains well-aligned and continues to converge on the plan.** The
SDK-idiomatic spine is intact and re-confirmed in-tree: the PocketFlow
`Node.exec → createFlow().run` shape, the `AgentTrace` emit/subscribe channel,
the `platform()` composition root, the `createModelHandler` factory, and the
lead-and-specialists delegation model. The four audits independently reached the
same conclusion the canonical plan already holds — there are no barrels, no
re-export shims, and no trivial/two-layer identity factories in `modelHandlers/`;
the logger is already a single hop (host-injected sink, no `platform().log`
port); and the cycle-wrapper nodes are the _mandated_ shape, not the anti-pattern.
The live work remains **surface curation and per-session state relocation**.

## Drift since 2026-06-25

The plan keeps landing through the PR train. Since the `b2dcd42` checkpoint base:

- **PR #6620 merged** (`b62eb1f`) — lands the deferred delta cleanups P3a
  (empty-type flow-param aliases removed) and P3b (`withModelClient` closure DRY,
  liveness-safe). Both now present at HEAD, confirming the prior checkpoint's
  "this PR" rows.
- **`cee3eb6`** `refactor(agent): collapse the two AgentCreator blueprint nodes
into one` — another abstraction-collapse landing in the same direction.
- **`93af483`**, **`b9bd9b5`**, **`7043749`** — CLI module split + config-catalog
  unification plan; unrelated to the four audit areas, no regressions to the spine.

## Applied this pass (#this-PR) — three new behavior-neutral micro-cleanups

Each was traced to ground truth and confirmed a **pure dead-code deletion** (zero
production and test callers) before editing. Verified: `npm run typecheck` exit 0
across all four projects (root, test-kernel, `texra`, `@texra-ai/cli`); `npx
vitest run src/test-kernel/agent` → **649 passed, 4 skipped** (116 files);
`npx eslint` over the four touched files → 0 errors.

1. **Dead `PersistedFlow.step()` wrapper removed.**
   (`src/agent/node/persistedFlow.ts`). The one-line `step()` —
   `const result = await this.stepWithResult(); return result.hasMore;` — had a
   single caller: the base-class `run()` loop in the same file (`RoundPersistedFlow`
   overrides `run()` and calls `stepWithResult()` directly, never `step()`).
   Inlined into `run()` as `while ((await this.stepWithResult()).hasMore) {}`.
   Removes one method from the class surface; no behavior change.

2. **Dead registry re-exports dropped.**
   (`src/agent/index/agentRegistry.ts`). The block re-exported
   `BUNDLED_ORCHESTRATOR_AGENT_NAMES` and `REMOTE_ORCHESTRATOR_AGENT_NAMES` from
   `agentRegistryConstants` — a re-export of a re-export. Grep confirms **no
   consumer imports either via the registry path**: the one real consumer
   (`src/tools/setup/ApplyTeamTool.ts`) imports `REMOTE_ORCHESTRATOR_AGENT_NAMES`
   directly from `@shared/constants/agents`, `BUNDLED_…` has zero importers
   anywhere outside the constants chain, and the `@agent/index` barrel does not
   re-export either. `BUILTIN_TEAM_ROOT_AGENT_NAMES` (consumed via the barrel by
   `packages/cli/.../multiAgentPresets.ts`) was kept. Narrows the registry's
   public surface.

3. **Dead `isOutputStreamingEnabled()` getter removed from the port + base.**
   (`src/agent/modelHandlers/types/IModelHandler.ts`,
   `src/agent/modelHandlers/ModelHandler.ts`). Declared on `IModelHandler` and
   defined on `ModelHandler`, but **never read anywhere** (the setter
   `setOutputStreaming` is used; the getter is not, and the `outputStreaming`
   field is read internally without it). Removed both declaration and
   implementation. One fewer member every provider must satisfy — a small step on
   the "trim the over-wide `IModelHandler` port" track.

## Genuinely-new findings — NOT applied (additive backlog)

None of these are in the existing ledger/delta/checkpoint docs. They are ranked;
all are deferred to the reviewed PR train rather than applied unattended.

### Core / runtime

- **`RetryState` interface + redundant third parameter** _(HIGH)_. `RetryState`
  (`src/agent/core/flows/RetryState.ts:29-31`) is a one-field interface
  (`lastError?`) whose only field is already on `BaseCycleFields`
  (`CommonCycleTypes.ts`). `handleInvocationResult(execRes, state, retryState, …)`
  takes `state` and `retryState` as separate params, but the sole non-test call
  site passes the **same object for both**: `handleInvocationResult(execRes,
shared, shared, …)` (`ModelInvocationNode.ts:123`). Collapse to a single
  `state` param widened to carry `lastError`, and delete the `RetryState`
  interface. Behavior-neutral; a function-signature change, so left for review.

### Model handlers (port-narrowing / surface curation track)

- **Four port members that leak internal surface** _(MEDIUM — design)_.
  `getAgentCategory()` (getter), `canProcessToolResultAttachments`,
  `createMediaContent`, and `createAssistantMessage` are on `IModelHandler` but
  are only ever invoked as `this.x` inside handler implementations — no external
  consumer calls them. They widen the contract every provider must expose.
  Candidates to drop from the port (keep as `protected`/abstract on the base).
  This is the same "trim the ~45-member flattened-union port" item the canonical
  plan tracks; advance it deliberately, not mechanically.
- **Three `public` base methods that should be `protected`** _(LOW)_.
  `createMediaMessage`, `containCutOffMessage`, `getApiKey` (`ModelHandler.ts`)
  have only `this.` callers in subclasses (plus one test). Tighten visibility.
- **`createResponse` template body duplicated in two handlers** _(LOW)_.
  `modelHandlerOpenAIResponse.ts` and `modelHandlerGoogleInteractions.ts` override
  `createResponse` itself and hand-copy the base's `withSdkErrorTag(this.
sdkErrorTagger, …)` wrap just to add a single-turn `inFlight` guard. Add a
  `protected` guard hook so the base keeps owning the error-tag wrap and the two
  only supply the guard (~12 lines of copied template body removed, drift risk
  eliminated).

### Public surface (barrel curation)

- **Over-wide `@agent/index` barrel** _(LOW)_. `src/agent/index/index.ts`
  re-exports ~10 type symbols with zero cross-module consumers
  (`AgentDirectoryServiceOptions`, `CustomAgentDirectoryStore`,
  `AgentDirectoryDocsId`, `AgentDirectoryBundleSource`, `AgentDirectoryStorage`,
  `AgentDirectorySyncLogger`, `AgentDirectoryVersionStore`,
  `BundledAgentDirectorySyncOptions`, `BundledAgentDirectoryName`,
  `AgentDirectories`). Trimming them to the symbols with real consumers curates
  the SDK-facing surface. Deferred because barrel curation is a deliberate surface
  decision, not a mechanical delete.
- **`PlatformAgentDirectoryBootstrapOptions` exported, zero external consumers**
  _(LOW)_ (`platformAgentDirectories.ts:23`). Inline as the parameter type or drop
  the `export`.
- **NOTE — `sortAgentEntries` export is NOT removable.** The
  2026-06-26 audit flagged dropping its `export` (`agentOptionsBuilder.ts:34`) as
  internal-only; that is **wrong** — it is imported cross-file by
  `agentRegistry.ts:27` within the same module, so the `export` is load-bearing.
  Recorded here so the next uninformed pass does not re-propose it.

### Documentation drift

- **Stale `2026-05-22-agent-trace-sdk-surface.md`** _(doc fix)_. That proposal
  (`docs/proposals/2026-05-22-agent-trace-sdk-surface.md:26`) references a `@agent/core/logger`
  facade, an `AgentLogger` class, and `platform().log` — **none of which exist**
  (the logger was already flattened to a single host-injected sink). The proposal
  has been executed; the prose should be reconciled or marked landed.

## Already adjudicated — do NOT re-litigate

The uninformed passes re-surfaced these; the standing rulings hold at HEAD
(`93af483`). See the delta-2026-06-24 table for citations.

| Re-surfaced candidate                                                | Ruling                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Remove `IModelHandler` as a "duplicate" of `ModelHandler`            | **Trap** — optional `createBatchedToolUseFollowUpMessages` makes it load-bearing; removal breaks `tsc`.                   |
| Inline the cycle-wrapper nodes / `createXCycleFlow` factories        | **Keep** — this _is_ the mandated `Node.exec → createFlow → flow.run` shape.                                              |
| Merge `ModelHandlerOpenRouterNative` into the OpenAI base            | **Trap** — two real SDK type families; the merge was deliberately deleted in PR #2962.                                    |
| Dedup MiniMax `extractTextFromReasoningDetails` into the shared util | **Trap** — different input shapes; the shared util would return empty reasoning for MiniMax's `type: 'thinking'` items.   |
| Split `modelHandlerOpenAIResponse.ts` (god-file) into collaborators  | **Real smell, not a quick win** — shared mutable state + background polling + test subclassing. Tracked design migration. |
| `@logger` not routed through `platform()`                            | **Intentional, documented** — logging is its own host-injected subsystem (`platform.ts:23-28`).                           |
| UsageMonitor `updateStreamUsage` + `logger.usage` "double emit"      | **Documented dual-sink** (sidebar vs. transcript), agentCategory-gated, intentional.                                      |

## Subagent split points — re-confirmed

No change to the canonical/delta analysis. TeXRA already has a **mature subagent
mechanism**; the only gap is that it is a _tool call_, not a typed primitive:

- YAML agent profiles (`{ name, description, settings.tools, prompts.systemPrompt }`)
  are near-isomorphic to the SDK `AgentDefinition`; the two flow implementations
  (reflection, tool-use) run _all_ 6 workflow + ~18 tool-use agents — a new
  subagent is a YAML + tool-list, never new flow code.
- Teams (`AGENT_MODE_PRESETS`) are the SDK "available subagents" roster;
  `delegate_agent`/`delegate_workflow` + `executeSubagent`
  (`src/tools/delegation/DelegationTools.ts`) are the isolated-context delegation primitive
  (own `RunContext`, KV store, usage accumulator, depth-gating, cost roll-up,
  async result delivery via `FollowUpQueue`); read-only-by-tool reviewers
  (`changeReviewer`, no bash) already model SDK tool-scoping.

Split points ranked by value/effort (unchanged):

1. **Wire the existing `review` tool-use agent as a post-draft Verifier
   delegation** — lowest risk, reuses `executeSubagent`, no new flow code.
2. **Introduce a typed `delegateTo(subagent, input, { maxDepth, tools })`
   primitive** over the existing plumbing — decouples delegation from "did the
   model emit a tool call." Structural pre-work landed (`d32be3b`/`a15dd86`
   extracted per-category flow runners).
3. **Formalize workflow agents (`polish`/`correct`/`merge`) as SDK actors with
   typed I/O contracts** — already isolated single-turn deterministic actors.
4. **Relocate the three module-global registries onto the per-session handle**
   (`executionRegistry` Maps, `runCoordinators.bridgeState` — _relocate, never
   delete_, it is load-bearing — and the interrupt registry). Gates concurrent
   in-process sessions.
5. **Decompose in-agent multi-phase workflow agents** (`devise`, `verifyFix`)
   into draft → Verifier → apply hand-offs — gated by #4.

## Recommendation

**The codebase is SDK-ready in shape; no structural refactoring is warranted.**
This pass applied three behavior-neutral dead-code deletions and recorded the
remaining additive micro-findings as backlog for the reviewed PR train. Continue
executing the canonical plan's surface/multi-tenant track (port narrowing,
per-session state relocation, the typed `delegateTo` primitive, and wiring
`review` as the first Verifier delegation). Do not re-open the adjudicated traps.

## Verified (this checkpoint)

- `npm run typecheck` — exit 0 across all four projects.
- `npx vitest run src/test-kernel/agent` — 649 passed, 4 skipped (116 files).
- `npx eslint` over the four touched files — 0 errors.
- Grep-confirmed zero callers for each applied deletion: `.step(` (only the
  base `run()` loop), `BUNDLED_/REMOTE_ORCHESTRATOR_AGENT_NAMES` via the registry
  path (none), `isOutputStreamingEnabled` (only its own declaration + definition).
- `git log` since 2026-06-25 over `src/agent` (the PR #6620 / `cee3eb6` landings
  cited above).
