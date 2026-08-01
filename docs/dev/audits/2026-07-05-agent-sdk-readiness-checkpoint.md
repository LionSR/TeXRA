# Agent SDK Readiness — Verification Checkpoint (2026-07-05)

> **Packaging note (2026-07-05):** #7099 later demotes/deletes the unused
> `@texra/core` package. Mentions below are historical checkpoint observations,
> not current workspace layout.

**Status:** Verification checkpoint. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the detailed
[`./2026-05-29-agent-sdk-readiness-audit.md`](./2026-05-29-agent-sdk-readiness-audit.md), the
[`2026-06-24-agent-sdk-readiness-delta.md`](../../proposals/2026-06-24-agent-sdk-readiness-delta.md)
addendum, and the `-2026-06-25` → `-2026-07-03` checkpoints (most recently
[`-2026-07-03`](./2026-07-03-agent-sdk-readiness-checkpoint.md)).

This pass re-verified the standing audit against the working tree at HEAD
(`5d17006`, branch `claude/eager-noether-vib9ap`). The 07-03 checkpoint ran on a
sibling branch (`11e063e`, not an ancestor of this HEAD), so the delta is
characterized by the merged PR train rather than a commit range. Since 07-03 the
merged train (#7049–#7107) includes a **non-structural** model-handler follow-up
(#7073: `ModelFactory.ts` +5/−2, a `ModelHandler.ts`/`modelHandlerCodex.ts`
trim) plus diff/schema/sync/dedup work (#7091/#7105/#7107). None of it disturbs
the four audit areas structurally — the SDK-aligned spine (`IModelHandler`,
`src/logger/**`, the then-present `packages/core/src/index.ts`,
`src/agent/trace/**`) is byte-for-byte unchanged in shape.

## Why this exists

Another recurring "review and refactor for Agent SDK readiness" request landed,
scoped (as before) against the same four areas: **agent core + runtime**,
**`modelHandlers/`**, **logger + platform/public surface**, and **subagent
boundaries**. As on every prior pass, this checkpoint ran a **fresh, uninformed
3-way fan-out audit** (one reader for core+runtime, one for `modelHandlers/`, one
for logger+public surface) plus a fresh Claude Agent SDK pattern reference, then
reconciled every finding against the adjudicated rulings. The uninformed audit
re-surfaced the known traps (filtered out below) and re-confirmed the tracked
candidates — **and it surfaced one genuine, unattended-safe pure deletion in
`ModelFactory.ts` that no prior pass or doc had recorded** (0 grep hits across the
canonical doc, the detailed audit, the delta, and every `-06-25` → `-07-03`
checkpoint). That deletion is applied this pass; everything else is recorded as
reviewed-train class.

## Verdict — unchanged

**The codebase remains well-aligned and SDK-ready in shape. No structural
refactoring is warranted.** The three fresh readers independently reached the
standing conclusion — most notably the `modelHandlers` reader affirmed the
already-shared spine (`UsageNormalizer`, `toolConversion`, the OpenAI-compatible
subclass tree, the `createResponse` template) and rejected collapsing it, and the
core reader found **no** `Node.exec → wrapper → coreFunction → createFlow →
flow.run` ladders, **no** trivial identity factories, and **no** two-layer
`buildX`-only-from-`createX` factories in the flow/node layer. The SDK-idiomatic
spine is re-confirmed in-tree at HEAD:

- **`createModelHandler` factory** — `PROVIDER_HANDLER_ROUTES` exhaustive
  `Record<ModelProvider, …>` (`ModelFactory.ts:48`), single `createModelHandler`
  entry (`:371` after this pass's −6 LOC). Compatibility-key routing means an
  SDK-backed handler can drop in behind one case with zero caller changes.
- **`platform()` composition root** — `initPlatform` / frozen `platform()`
  accessor (`platform.ts`), with the single-call-site ports each still backed by
  three genuinely different implementations (VS Code UI / Node no-op / test fake).
- **`AgentTrace` emit/subscribe channel** — `src/agent/trace/index.ts` still the
  single `emit()`/`subscribe()` surface; `debug/info/warn/error`, stages, streams
  are sugar over `emit()`, mapping ~1:1 onto the Agent SDK streamed-message model.
- **No barrel regression at checkpoint time** — `src/agent/core/index.ts`
  remains **absent**. This checkpoint observed the then-present
  `packages/core/src/index.ts` barrel; #7099 later demotes/deletes that unused
  package rather than preserving an unenforced SDK surface.
- **PocketFlow `Node.exec → createFlow().run` shape** and the
  **lead-and-specialists delegation model** — unchanged.

## Applied this pass — one confirmed-safe cleanup

### `ModelFactory.ts` dead re-export block deleted (pure dead code + one repoint) — net −6 LOC

`src/agent/runtime/ModelFactory.ts:23-27` re-exported three symbols from its
sibling `./modelHandlerCompatibilityKey`:

```ts
export {
  MODEL_HANDLER_COMPATIBILITY_KEYS,
  ModelHandlerCompatibilityKeySchema,
} from './modelHandlerCompatibilityKey';
export type { ModelHandlerCompatibilityKey } from './modelHandlerCompatibilityKey';
```

This is exactly the CLAUDE.md "don't re-export files — point imports at the source
of truth" anti-pattern, and it was measurably dead-or-misrouted:

- **The two value re-exports are dead.** All four real consumers of
  `ModelHandlerCompatibilityKeySchema` import it straight from the source module
  (`SessionResumeRetrieval.ts:36`, `ToolUseSessionTypes.ts:8`,
  `ReflectionFlowState.ts:11`, `executeCommand.ts:7`), and
  `MODEL_HANDLER_COMPATIBILITY_KEYS` has **no importer anywhere** outside its
  source. Zero callers reach either symbol through `ModelFactory`.
- **The type re-export was misrouted through the factory** by exactly two callers
  — `implementations/flows/tooluse/nodes/types.ts:16` and
  `runtime/AgentLaunchContext.ts:38` (the second one the core reader missed;
  caught by `tsc`). Both repointed to `@agent/runtime/modelHandlerCompatibilityKey`,
  the source of truth. `ModelFactory`'s own internal `import type` at line 21
  (used at `:43/:51/:275/…`) is untouched.

The whole block deletes; `activeModelHandlerCompatibilityKey` /
`createModelHandlerForCompatibilityKey` (genuine `ModelFactory` functions) remain
the correct compatibility-key entry points.

**Verified green:** `npm run typecheck` exit 0 (all four projects); `eslint` on
the three changed files clean; `ModelFactoryRouting.vitest.ts` 36/36 pass. Diff:
`ModelFactory.ts` −6, `nodes/types.ts` ±1 import, `AgentLaunchContext.ts` ±1
import (net −6 LOC, behavior-preserving).

## Genuinely-new candidates — surfaced by this fan-out, absent from all prior docs

Grep-confirmed absent from the canonical doc, the detailed audit, the delta, and
the `-06-25` → `-07-03` checkpoints. All are reviewed-train class (signature /
surface changes or design-direction notes); **none is unattended-safe** — do not
sweep.

### Core / runtime

1. **`StreamStatusMachine as StreamStatusRegistry` test-only alias** _(LOW;
   resolved by Checkpoint A, 2026-07-05)_. This checkpoint originally found
   `src/agent/runtime/StreamStatusService.ts:303` re-exporting the same-file
   class under a legacy name consumed **only** by test-kernel vitest files; no
   production code used `StreamStatusRegistry`. Checkpoint A repointed the tests
   to `StreamStatusMachine` and deleted the alias. (Distinct from the
   `StreamStatusRegistry.onDidChange` module-subscription item already tracked
   in the detailed audit §; that references the pre-rename name.)

2. **`executionRegistry.ts` handle re-export facade** _(LOW — arguable, keep)_.
   `executionRegistry.ts:41-50` surfaces `ExecutionHandle` / `AgentExecutionHandle`
   / `ProcessExecutionHandle` / `AgentRunHandle` from the sibling `./ExecutionHandle`,
   and external callers (`tools/childStream.ts:7`,
   `tools/delegation/subagentExecution.ts:17`, then-current
   `packages/core/src/index.ts:80`)
   import through it. Same anti-shim smell as candidate #0 above, **but**
   `executionRegistry` legitimately constructs these handles and reads as the
   intended public facade for the execution subsystem — this is the same "facade
   barrel" shape the standing rulings **keep** (cf. the `@texra/core` and runtime
   barrel adjudications). Recorded as a judgment call, ruling: **keep**.

### Model handlers

3. **`*WithPrefill` / `*WithoutPrefill` capability-split port pairs** _(MEDIUM —
   the concrete symptom of the tracked role-split angle)_.
   `types/IModelHandler.ts:289-331` declares `updateMessageContentWithPrefill` /
   `…WithoutPrefill` and `addContinueMessageWithPrefill` / `…WithoutPrefill`. The
   sole caller (`core/flows/ResponseCycleFlow.ts:418-432`, `:582-594`) picks
   between each pair with `if (modelHandler.capabilities.supportsAssistantPrefill)`
   — a fact the handler already owns. Collapsing each pair to one port method that
   branches internally on `this.capabilities.supportsAssistantPrefill` removes two
   port members and turns two caller `if/else` blocks into unconditional calls.
   This is one mechanically-fixable instance of the **already-tracked**
   `IModelHandler` role-split candidate (07-03 candidate #4); it's a port + caller
   refactor, so reviewed-train, not unattended-safe.

4. **`usesProviderManagedAutoRetry` getter + `isAutoRetryManagedByProvider(error)?`
   method express one concept** _(LOW)_. `types/IModelHandler.ts:226/233`; the base
   method just returns the flag (`ModelHandler.ts`), and the sole caller ORs both
   (`core/flows/ModelInvocationNode.ts:81-82`). Keep only the (non-optional)
   `isAutoRetryManagedByProvider(error)` whose base returns the flag; drop
   `usesProviderManagedAutoRetry` from the port (or demote to a protected field).
   Port change → reviewed-train.

5. **Two full Google handlers for one provider** _(HIGH surface, STRATEGIC — note
   only)_. `google/modelHandlerGoogleGenAI.ts` (~1,116) and
   `google/modelHandlerGoogleInteractions.ts` (~2,090) are parallel handlers gated
   on `texra.model.useGoogleInteractionsAPI` (default on). Their shared mechanics
   are already hoisted into `googleHandlerShared.ts` + `googleUsage.ts` (clean);
   what remains duplicated is inherent (different message models). If Interactions
   is the committed steady state, the GenAI sibling + flag are redundant surface
   kept alive by the flag. **Product decision, not a mechanical fix** — schedule
   removal once Interactions is blessed; no code change recommended blind.

### Logger / public surface

6. **`formatChatAsHtml` bypasses the `chatExportFormatter.ts` "single stable
   surface"** _(LOW — coherence)_. `chatExportFormatter.ts` documents itself as the
   one entry for chat export and re-exports `formatChatAsMarkdown` /
   `formatChatAsLatex`, but the third renderer `formatChatAsHtml` is reached via a
   deep `@agent/export/htmlExport/htmlFormatter` import instead. Re-export
   `formatChatAsHtml` through `chatExportFormatter.ts` so all three formats share
   one surface (or drop the "single surface" claim). Cosmetic.

7. **`@logger` barrel is a 1-of-3 partial entry, not just a 1-symbol barrel**
   _(LOW — refines tracked P25-4)_. The detailed audit tracks `@logger/index.ts`
   as "exposes one symbol" (`createChannelTrace`). Refinement: that barrel has
   **25 real importers**, while the primary functional API (`debug/info/warn/error`
   - `setOutputChannelFactory`, ~70 callers) and `redactSecrets` are reached only
     via deep `@logger/logUtils` / `@logger/redaction`. So the smell is a _partial_
     barrel (surfaces the least-used concern), not a dead one — folding the real API
     into the index collapses ~75 deep imports onto one specifier. Same disposition
     as P25-4 (opportunistic); the importer count is the only correction.

## Adjudicated traps the fan-out re-surfaced — rulings held

The uninformed audit raised, and the standing rulings correctly filter, all of
the following. No change.

| Re-surfaced candidate                                                                           | Ruling                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collapse OpenAI-compatible subclasses (DeepSeek/Kimi/MiniMax/GLM) to a config table             | **Trap** — each carries real per-provider override points; only DashScope/XAI are genuinely thin. The `modelHandlers` reader rejected this itself.             |
| Remove `IModelHandler` as a "duplicate" of `ModelHandler`                                       | **Trap** — optional `createBatchedToolUseFollowUpMessages?` + `Pick<>` consumer narrowing keep it load-bearing (candidate #3 is the distinct _split_ angle).   |
| Inline `createResponse → withCreateResponseGuard → sdkErrorTagger`                              | **Keep** — each hook has a distinct real overrider.                                                                                                            |
| Per-provider SDK-error taggers (`googleSdkError`/`openRouterSdkError` empty-mapping one-liners) | **Keep** — the split exists only to keep provider SDK imports out of the base graph (documented lazy-load boundary).                                           |
| `SessionEventHub` `SessionFact = never` scope-arm is "dead"                                     | **Keep** — already adjudicated in the detailed audit as an intentional multi-window extensibility placeholder.                                                 |
| `ModelFactory` two-layer / trivial-identity factories                                           | **No violation** — `createModelHandler` + `createModelHandlerForCompatibilityKey` are two real entries sharing logic; routes give compile-time exhaustiveness. |
| Collapse `runAgent` / `runAgentStream` dual entry / add a `runtime/index.ts` barrel             | **Trap** — deliberate naming; `@texra/core` **is** the curated barrel.                                                                                         |
| `AgentTrace` over-layered / platform single-call-site ports are over-abstraction                | **Keep** — trace is one `emit()` SSoT (SDK-shaped); thin ports each have three divergent host impls.                                                           |
| `@platform` barrel / `@logger` barrel are "redundant facades"                                   | **Known / tracked** (07-03 candidates #5/#6) — pick-one import-path churn, opportunistic; refined here by candidate #7.                                        |

## Structural divergence from the Agent SDK loop — re-stated (no new action)

Unchanged and still justified capability, not over-abstraction: (1) **nested
two-flow execution** (inner cycle flow ≈ the SDK's model-call+tool-dispatch loop;
outer persisted flow drives rounds for durable resume); (2) **persistence-first
design** (every node step `structuredClone`'d to KV so a run resumes after reload
— no SDK counterpart, and the reason the loop can't be a plain generator); (3)
**rich human-in-the-loop coordination** (`BasePromiseCoordinator` + plan-approval
/ proposal / manual-retry coordinators vs the SDK's single `canUseTool` callback
— additive). The highest-leverage SDK-alignment move remains converging the two
round-loop mechanisms (07-03 candidate #2), which is a direction, not a sweep.

## Subagent split points — re-confirmed, unchanged

No change to the canonical/delta analysis. TeXRA already ships a **mature subagent
mechanism**: YAML agent profiles ≈ SDK `AgentDefinition`; `delegate_agent` /
`delegate_workflow` + `executeSubagent` = the isolated-context delegation
primitive (with `NESTED_DELEGATION_DEPTH_RANGE` depth policy walked on resume via
`delegationPolicy.ts`, and worktree isolation); the `claude_agent` tool embeds
`@anthropic-ai/claude-agent-sdk` directly, `codex` mirrors it. The three
highest-confidence already-isolated units a formal decomposition would draw on are
unchanged: **`ModelFactory.createModelHandler`** (the model-provider unit),
**`assembleAgentLaunchContext`** (the "define an agent" half of the SDK model),
and **`agentToolResolution`** (the tools-as-data resolver). Split points ranked by
value/effort are unchanged from 06-26 → 07-03:

1. Wire the existing `review` tool-use agent as a post-draft Verifier delegation
   (lowest risk; reuses `executeSubagent`, no new flow code).
2. Introduce a typed `delegateTo(subagent, input, { maxDepth, tools })` primitive
   over the existing plumbing.
3. Formalize workflow agents (`polish` / `correct` / `merge`) as SDK actors with
   typed I/O contracts.
4. Relocate the remaining module-global registries onto the per-session handle.
5. Decompose in-agent multi-phase workflow agents (`devise`, `verifyFix`) into
   draft → Verifier → apply hand-offs — gated by #4.

## Recommendation

**SDK-ready in shape; no structural refactoring warranted.** One confirmed-safe
cleanup applied this pass — the `ModelFactory.ts` dead re-export block (net −6 LOC,
typecheck + lint + routing test green), a pure-deletion the 07-03 fan-out missed,
in the same class as that pass's `PersistedFlow.attach`/`getRunId` deletion.
Everything else the fresh audit surfaced is reviewed-train (port narrowing incl.
the `*WithPrefill` collapse and the auto-retry-ownership merge, the
`formatChatAsHtml` / `@logger` surface coherence, the strategic Google-handler
consolidation). The `StreamStatusRegistry` alias drop has since landed through
Checkpoint A. Fold the remaining items into the canonical plan's surface /
multi-tenant track through the reviewed PR train. Do not re-open the adjudicated
traps, and do not sweep the remaining reviewed-train items unattended.

## Verified (this checkpoint)

- Spine re-confirmed at HEAD `5d17006`: `PROVIDER_HANDLER_ROUTES` +
  `createModelHandler` (`ModelFactory.ts`), `initPlatform` / `platform`
  (`platform.ts`), `AgentTrace` emit/subscribe (`trace/index.ts`),
  `src/agent/core/index.ts` **absent** (no barrel regression), and the
  then-present `@texra/core` barrel was the one curated public surface.
- Applied deletion verified: the two `ModelFactory` value re-exports had **0**
  importers through the factory (all 4 `ModelHandlerCompatibilityKeySchema`
  consumers hit the source module; `MODEL_HANDLER_COMPATIBILITY_KEYS` has 0
  importers outside source); the type re-export had exactly **2** misrouted
  callers (`nodes/types.ts:16`, `AgentLaunchContext.ts:38`), both repointed to
  `@agent/runtime/modelHandlerCompatibilityKey`. Absent from all prior readiness
  docs (0 grep hits for the block). `activeModelHandlerCompatibilityKey` /
  `createModelHandlerForCompatibilityKey` retained.
- Change verified green: `npm run typecheck` **exit 0** (all four projects);
  `eslint` on the three changed files clean; `npx vitest run
ModelFactoryRouting.vitest.ts` — **36 passed**.
- New candidates verified in-tree at checkpoint time: the now-resolved
  `StreamStatusMachine as StreamStatusRegistry` alias; `*WithPrefill` /
  `*WithoutPrefill` pairs (`IModelHandler.ts:289-331`, sole caller
  `ResponseCycleFlow.ts:418/582`); auto-retry pair (`IModelHandler.ts:226/233`,
  caller `ModelInvocationNode.ts:81`); `formatChatAsHtml` deep-imported around
  `chatExportFormatter.ts`; `@logger` barrel 25 importers vs ~70 `logUtils` /
  deep `redaction` imports.
- PR-train non-interference confirmed: `git diff --stat` since the last-known
spine over `ModelFactory.ts` / `IModelHandler.ts` / `src/logger` /
then-current `packages/core/src/index.ts` / `src/agent/trace` shows only the #7073
non-structural `ModelFactory.ts` follow-up; the four audit-area interfaces are
unchanged in shape.
</content>
