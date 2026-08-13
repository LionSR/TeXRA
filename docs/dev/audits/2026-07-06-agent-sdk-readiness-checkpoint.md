# Agent SDK Readiness — Verification Checkpoint (2026-07-06)

**Status:** Verification checkpoint. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the detailed
[`./2026-05-29-agent-sdk-readiness-audit.md`](./2026-05-29-agent-sdk-readiness-audit.md), the
[`2026-06-24-agent-sdk-readiness-delta.md`](../../proposals/2026-06-24-agent-sdk-readiness-delta.md)
addendum, and the `-2026-06-25` → `-2026-07-05` checkpoints (most recently
[`-2026-07-05`](./2026-07-05-agent-sdk-readiness-checkpoint.md)).

This pass re-verified the standing audit against the working tree at HEAD
(`8cfff2e`, branch `claude/eager-noether-s4152q`). Since the 07-05 checkpoint the
tree is structurally unchanged in the four audit areas — the SDK-aligned spine
(`ModelFactory` / `IModelHandler`, `src/logger/**`, `src/agent/trace/**`, the
`platform()` composition root, the `Node.exec → createFlow().run` shape) is
byte-for-byte unchanged in shape.

## Why this exists

The recurring "review and refactor the codebase for Agent SDK readiness" request
landed again, scoped (as before) against the same four areas: **agent core +
runtime**, **`modelHandlers/`**, **logger + platform/public surface**, and
**subagent boundaries**. As on every prior pass, this checkpoint ran a **fresh,
uninformed 4-way fan-out audit** — one reader each for (1) `agent/core` +
`runtime` + `implementations/flows`, (2) `modelHandlers/`, (3) `logger` +
`agent/index` + `output` + `node` + `platform`, and (4) an Agent-SDK-pattern
mapping / subagent-boundary reader — then reconciled every finding against the
adjudicated rulings. The uninformed audit re-surfaced the known traps (filtered
out below) and re-confirmed the tracked candidates — **and it surfaced two
genuine items absent from all prior docs: one unattended-safe pure deletion in
`output/extraction/markdownFences.ts` (applied this pass) and one 3-site DRY
duplication in the `SessionFact` legacy fan-out (recorded, not swept).**

## Verdict — unchanged

**The codebase remains well-aligned and SDK-ready in shape. No structural
refactoring is warranted.** The four fresh readers independently reached the
standing conclusion:

- The **core/runtime** reader found **no** `Node.exec → wrapper → coreFunction →
createFlow → flow.run` ladders — `ResponseCycleNode.exec()` and
  `ToolUseCycleNode.exec()` call `createXFlow()` → `setServices(...)` → `run(...)`
  directly with no intermediate hop — **no** trivial identity factories, and
  **no** two-layer `buildX`-only-from-`createX` factories in the flow/node layer.
  It ranked every `*Coordinator` / `*Bridge` / `*Hub` / `*Projection` / `*Binder`
  runtime file **KEEP** except the already-adjudicated `runReflectionAgent`
  (ruling held: **keep**, see traps table).
- The **`modelHandlers`** reader affirmed the already-shared spine
  (`UsageNormalizer`, `toolConversion`, `ProxyConfigResolver`,
  `MediaAttachmentProcessor`, the `createResponse` template) and the exemplary
  OpenAI-compatible subclass tree (`ModelHandlerDashScope` 14 LOC,
  `ReasoningModelHandlerOpenAI` capturing only the shared overrides) — and
  rejected collapsing it. It re-derived the tracked `ModelHandler`/`IModelHandler`
  role-split angle from scratch (see traps + reviewed-train mapping).
- The **logger/surface** reader confirmed the logger is a clean thin facade
  (single `writeLine` emit point, `makeLogFn` a justified micro-factory, the old
  `consoleSubscriber` pass-through shim already removed), the `node/` PocketFlow
  tiers each add real behavior, and `output/` carries no render-time-workaround
  anti-patterns.
- The **subagent** reader re-confirmed that TeXRA already ships a mature
  delegation mechanism that **supersets** the SDK baseline (`delegate_agent` /
  `delegate_workflow` → `executeSubagent` → `executeAgent({isSubagent})`, isolated
  child context, durable `ResultMeta` manifests, `delegationPolicy` depth-lineage
  walked on resume, worktree isolation, and a proposal/approval handshake the SDK
  has no analog for).

The SDK-idiomatic spine is re-confirmed in-tree at HEAD: `createModelHandler` +
`PROVIDER_HANDLER_ROUTES` exhaustive route table; `initPlatform` / frozen
`platform()` accessor with single-call-site ports each backed by divergent host
impls; `AgentTrace` `emit()`/`subscribe()` as the one streamed-message SSoT;
`src/agent/core/index.ts` **absent** (no barrel regression); and the
lead-and-specialists delegation model — all unchanged.

## Applied this pass — one confirmed-safe cleanup

### `markdownFences.ts` dead private wrapper + redundant conjunct deleted — net −5 LOC

`src/agent/output/extraction/markdownFences.ts:34-36` defined a **private**
one-call helper subsumed by its own next-door neighbor:

```ts
function isMarkdownFenceDelimiter(line: string): boolean {
  return parseMarkdownFenceDelimiter(line) !== null;
}
```

Its sole call site was line 63, inside `stripSurroundingMarkdownFence`:

```ts
  firstContentIndex < lastContentIndex &&
  openingFence &&
  isMarkdownFenceDelimiter(lines[lastContentIndex]) &&      // ← deleted
  isClosingMarkdownFence(lines[lastContentIndex], openingFence) &&
  !lines.slice(...).some((line) => isClosingMarkdownFence(line, openingFence))
```

The removed conjunct is `parseMarkdownFenceDelimiter(last) !== null`; the very
next conjunct, `isClosingMarkdownFence(last, openingFence)`, is
`parseMarkdownFenceDelimiter(last) !== null && marker-match && length-match` —
**strictly stronger**. In `A && B` where `B ⟹ A`, `A && B === B`, so removing the
conjunct is provably behavior-preserving (it only elided a redundant second
`parseMarkdownFenceDelimiter` call). The helper is not exported and had no other
reader; the two other importers of this module (`contentSimilarity.ts`,
`filenameHeaders.ts`) reach only `parseMarkdownFenceDelimiter` /
`isClosingMarkdownFence`, both retained.

This is the same class as prior passes' one-safe-deletion moves (the 07-05
`ModelFactory.ts` dead re-export, the 07-03 `PersistedFlow.attach`/`getRunId`
deletion) — grep-confirmed absent from the canonical doc, the detailed audit, the
delta, and every `-06-25` → `-07-05` checkpoint (0 hits for
`isMarkdownFenceDelimiter` / `markdownFences`).

**Verified green:** `npm run typecheck` **exit 0** (all four projects: root,
test-kernel, `texra`, `@texra-ai/cli`, `@texra/trace-viewer`); `eslint`
on the changed file clean; `vitest run
src/test-kernel/agent/output/extraction/` — **2 passed**. Diff:
`markdownFences.ts` −5 LOC, behavior-preserving.

## Genuinely-new candidate — surfaced by this fan-out, absent from all prior docs

Grep-confirmed absent from the canonical doc, the detailed audit, the delta, and
the `-06-25` → `-07-05` checkpoints. **Reviewed-train, not unattended-safe** — a
multi-site refactor requiring an exhaustiveness guard; do not sweep.

### Core / runtime

1. **`SessionFact` legacy fan-out is triplicated across 3 sites** _(LOW–MEDIUM;
   DRY + drift risk)_. The `SessionFact` discriminated union
   (`SessionEventHub.ts:10-30`) is the source of truth, but its five members are
   hand-re-listed in three places that will silently miss a sixth fact:
   - `emitLegacyHostFact` — `emitRuntimeEvent.ts:28-46`, a 5-case switch mapping
     each fact `type` to `host.emit(type, payload)`;
   - `emitLegacySessionFact` — `LegacyProgressEventProjection.ts:7-28`, a
     **byte-identical** 5-case switch;
   - `emitRuntimeEvent` itself — `emitRuntimeEvent.ts:66-112`, a third
     enumeration of the same five `type`s as an outer routing switch.

   None carries a `satisfies` / `assertNever` exhaustiveness guard, so adding a
   sixth `SessionFact` compiles clean while three sites silently drop it. Collapse
   the two identical `type → host.emit(type, payload)` switches into one shared
   helper keyed off the union, and add an exhaustiveness assertion so the outer
   `emitRuntimeEvent` routing can't drift from the union either. Because it is a
   3-file signature-touching refactor (not a pure deletion), it is reviewed-train
   — record and fold into the reviewed PR train, don't sweep blind.

## Reviewed-train candidates re-confirmed — already tracked, mapped here

The fresh 4-way fan-out independently re-derived, from scratch, the following —
each already recorded and adjudicated in a prior readiness doc. Listed so the
re-derivation is on the record and the mapping is explicit; **rulings held, no new
action**.

| Re-derived this pass (reader)                                                                                                                                                                 | Already tracked at                                                                      | Standing disposition                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Extract auth/relay/tier (`getApiKey`, `shouldUseServerSideKeys`, `getBaseUrl`, `fetchApiKeyOrThrow`) out of `ModelHandler` into an injected `ApiCredentialResolver` (modelHandlers reader #1) | audit §`:2546-2547`, §`:2928` (`ApiCredentialResolver`); checkpoints `-06-26`, `-06-30` | **Reviewed-train** — signature/placement change, not blind-safe.                                     |
| Narrow `IModelHandler` + drop provider-identity getters / `*WithPrefill` split (modelHandlers reader #2)                                                                                      | `-07-05` #3; `-07-03` #4 (role-split)                                                   | **Reviewed-train** — port + caller refactor.                                                         |
| `OpenRouterNative` couples to concrete `isDeepSeek`/`isKimi`/`isMiniMax` getters (modelHandlers reader #4)                                                                                    | audit `:413`; `-07-03` `:200` (placement, 07-02 candidate #7)                           | **Reviewed-train** — the getters are live, the angle is placement.                                   |
| Two full Google handlers (GenAI + Interactions) for one provider (modelHandlers reader #5)                                                                                                    | `-07-05` #5 (strategic); `2026-06-22-google-interactions-api.md`                        | **Strategic** — product decision, remove once Interactions is blessed; no blind change.              |
| `resumeToolUseFromSnapshot` duplicates `runToolUseAgent` → extract `runToolUseFlowForHandle(ctx, handle, setting, {resumeSnapshot?, setupSession?})` (core reader #2)                         | audit §23 N2, `:3006`, `:3182-3188`                                                     | **Reviewed-train** — callback-shape care needed.                                                     |
| Inline `runReflectionAgent` into `executeAgent`'s category switch (core reader #3)                                                                                                            | `-07-03` `:206`; `-06-30` `:192`                                                        | **Adjudicated KEEP** — owns category-specific follow-up wiring; inlining bloats `executeAgent`.      |
| Group platform tool-UI ports (`linter`, `addCriticismSink`, `toolMissingHandler`, `toolNotificationHandler`) behind a `toolHostUi` sub-port (surface reader #1)                               | `-07-03` `:54`                                                                          | **Reviewed-train** — surface-shaping, opportunistic.                                                 |
| `@logger` barrel is a partial 1-of-N entry (surface reader #4)                                                                                                                                | `-07-05` #7 (refines P25-4)                                                             | **Reviewed-train / opportunistic** — importer count already corrected.                               |
| `output/workflowOutputLayout.ts:26-32` re-export hop for pass-through-only importers (surface reader #5)                                                                                      | audit `:2374`                                                                           | **Reviewed-train** — file retained (owns legacy helpers); repoint the 3 pass-through importers only. |

## Adjudicated traps the fan-out re-surfaced — rulings held

The uninformed audit raised, and the standing rulings correctly filter, all of
the following. No change.

| Re-surfaced candidate                                                                                                      | Ruling                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collapse OpenAI-compatible subclasses (DeepSeek/Kimi/MiniMax/GLM) to a config table                                        | **Trap** — each carries real per-provider override points; only DashScope/XAI are genuinely thin. The `modelHandlers` reader rejected this itself.                    |
| Remove `IModelHandler` as a "duplicate" of `ModelHandler`                                                                  | **Trap** — optional `createBatchedToolUseFollowUpMessages?` + `Pick<>` consumer narrowing keep it load-bearing (the split angle is the distinct reviewed-train item). |
| Inline `createResponse → withCreateResponseGuard → sdkErrorTagger`                                                         | **Keep** — each hook has a distinct real overrider.                                                                                                                   |
| `runReflectionAgent` / `runToolUseAgent` are single-caller wrappers                                                        | **Keep** — each owns genuinely category-specific wiring; inlining bloats `executeAgent`.                                                                              |
| `runAgent` / `executeAgent` dual entry is redundant                                                                        | **Keep** — `runAgent` owns executionId assignment + `registerExecution` + `openWorkflowOutput`; `executeAgent` owns the run. Two documented responsibilities.         |
| `ModelFactory` two-layer / trivial-identity factories                                                                      | **No violation** — `createModelHandler` + `createModelHandlerForCompatibilityKey` are two real entries sharing a routing switch with compile-time exhaustiveness.     |
| `withModelClient` is a trivial identity spread                                                                             | **Keep** — deliberately defines `client` as a getter + `refreshClient` to preserve relay-401 live rebinding; spreading breaks liveness.                               |
| `AgentTrace` over-layered / `platform()` single-call-site ports are over-abstraction                                       | **Keep** — trace is one `emit()` SSoT (SDK-shaped); thin ports each have three divergent host impls.                                                                  |
| The `LegacyProgressEventProjection` / `SessionRunFactProjector` / `conversationProgressHub` projection trio is dead weight | **Keep (transitional)** — self-labeled "temporary Stage 3a bridge"; retire once host consumers read the `SessionEventHub` plane directly. Roadmap item, not a sweep.  |

## Structural divergence from the Agent SDK loop — re-stated (no new action)

Unchanged and still justified capability, not over-abstraction: (1) **nested
two-flow execution** (inner `ToolUseRoundFlow` ≈ the SDK's model-call +
tool-dispatch loop; outer persisted flow drives rounds for durable resume); (2)
**persistence-first design** (every node step `structuredClone`'d to KV so a run
resumes after reload — no SDK counterpart, and the reason the loop can't be a
plain generator); (3) **async follow-up delivery** (subagent results return via
the `FollowUpQueue` `onBeforeWaiting` path rather than a synchronous
`await spawn`, closer to an actor model); (4) **rich human-in-the-loop
coordination** (`BasePromiseCoordinator` + plan-approval / proposal / manual-retry
coordinators vs the SDK's single `canUseTool` callback — additive). The
highest-leverage SDK-alignment move remains **converging the two round-loop
mechanisms** (the `workflow`/reflection fixed-round generator vs the `tooluse`
agent loop; fork point is `AgentCategory`) and **exposing a typed
`delegateTo(subagent, input, {maxDepth, tools})` primitive** over the existing
delegation plumbing — both directions, not sweeps.

## Subagent split points — re-confirmed, unchanged

No change to the canonical/delta analysis. The three highest-confidence
already-isolated units a formal decomposition would draw on are unchanged:
`ModelFactory.createModelHandler` (the model-provider unit),
`assembleAgentLaunchContext` (the "define an agent" half of the SDK model), and
`agentToolResolution` (the tools-as-data resolver). Split points ranked by
value/effort are unchanged from `-06-26` → `-07-05`:

1. Wire the existing `review` tool-use agent as a post-draft Verifier delegation
   (lowest risk; reuses `executeSubagent`, no new flow code).
2. Introduce a typed `delegateTo(subagent, input, {maxDepth, tools})` primitive
   over the existing plumbing.
3. Formalize workflow agents (`polish` / `correct` / `merge`) as SDK actors with
   typed I/O contracts.
4. Relocate the remaining module-global registries onto the per-session handle.
5. Decompose in-agent multi-phase workflow agents (`devise`, `verifyFix`) into
   draft → Verifier → apply hand-offs — gated by #4.

The fresh subagent reader additionally itemized eight concrete
already-scoped candidate boundaries (reviewer/critic, agentCreator meta-agent,
goalContinuation, workflow document-rewrite agents, research/literature,
latexFixer/compile-repair, Lean prover, sessionDescriber) — all of which already
run through, or are cleanly reachable from, `executeSubagent`. This corroborates
the standing conclusion rather than adding new structure.

## Recommendation

**SDK-ready in shape; no structural refactoring warranted.** One confirmed-safe
cleanup applied this pass — the `markdownFences.ts` dead private wrapper + its
redundant conjunct (net −5 LOC, typecheck + lint + extraction tests green), a
pure-deletion the prior passes missed, in the same class as the 07-05
`ModelFactory.ts` re-export deletion. One genuinely-new DRY item (the `SessionFact`
triplicated fan-out) is recorded as reviewed-train — collapse the two identical
switches and add an exhaustiveness guard through the reviewed PR train, not blind.
Everything else the fresh 4-way fan-out surfaced maps to already-tracked
reviewed-train items (credential-resolver extraction, the `IModelHandler` /
`*WithPrefill` role-split, the OpenRouter placement coupling, the
`resumeToolUseFromSnapshot` §23-N2 dedup, the platform `toolHostUi` grouping, the
`@logger` partial barrel, the `workflowOutputLayout` re-export hop) or to
adjudicated traps (held). Do not re-open the traps, and do not sweep the
reviewed-train items unattended.

## Verified (this checkpoint)

- Spine re-confirmed at HEAD `8cfff2e` (branch `claude/eager-noether-s4152q`):
  `createModelHandler` + `PROVIDER_HANDLER_ROUTES` (`ModelFactory.ts`),
  `initPlatform` / `platform` (`platform.ts`), `AgentTrace` emit/subscribe
  (`trace/index.ts`), `src/agent/core/index.ts` **absent** (no barrel
  regression), `Node.exec → createFlow().run` shape intact.
- Applied deletion verified: `isMarkdownFenceDelimiter`
  (`markdownFences.ts:34-36`) was **private**, had exactly **one** caller
  (line 63) whose conjunct is subsumed by the next (`B ⟹ A ⟹ A && B === B`,
  behavior-preserving); the two other module importers
  (`contentSimilarity.ts`, `filenameHeaders.ts`) reach only retained exports.
  Absent from all prior readiness docs (0 grep hits).
- Change verified green: `npm run typecheck` **exit 0** (all four projects);
  `eslint` on the changed file clean; `vitest run
src/test-kernel/agent/output/extraction/` — **2 passed**.
- New candidate verified in-tree: `SessionFact` union
  (`SessionEventHub.ts:10-30`) re-listed by hand at `emitRuntimeEvent.ts:28-46`,
  `LegacyProgressEventProjection.ts:7-28` (byte-identical switch), and
  `emitRuntimeEvent.ts:66-112` (third enumeration) — no exhaustiveness guard.
  0 grep hits across all prior readiness docs.
- Reviewed-train mapping verified: each re-derived candidate's tracking anchor
  confirmed present in the cited doc/line (credential-resolver `:2546/:2928`,
  `resumeToolUseFromSnapshot` §23-N2 `:3006/:3182`, OpenRouter coupling `:413`,
  `runReflectionAgent` KEEP `-07-03:206`, `toolHostUi` `-07-03:54`,
  `workflowOutputLayout` `:2374`).
