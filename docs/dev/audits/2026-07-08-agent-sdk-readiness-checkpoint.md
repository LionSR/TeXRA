# Agent SDK Readiness — Verification Checkpoint (2026-07-08)

**Status:** Verification checkpoint. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the detailed
[`./2026-05-29-agent-sdk-readiness-audit.md`](./2026-05-29-agent-sdk-readiness-audit.md), the
[`2026-06-24-agent-sdk-readiness-delta.md`](../../proposals/2026-06-24-agent-sdk-readiness-delta.md)
addendum, and the `-2026-06-25` → `-2026-07-06` checkpoints (most recently
[`-2026-07-06`](./2026-07-06-agent-sdk-readiness-checkpoint.md)).

This pass re-verified the standing audit against the working tree at HEAD
(`401a5ce`, branch `claude/eager-noether-acxa1g`). The SDK-aligned spine
(`ModelFactory` / `IModelHandler`, `src/logger/**`, `src/agent/trace/**`, the
`platform()` composition root, the `Node.exec → createFlow().run` shape) is
unchanged in shape. **The notable delta since 07-06 is that the maintainers'
reviewed PR train has since _resolved_ two of the top items the standing audit
tracked** — see [What the PR train resolved](#what-the-pr-train-resolved-since-07-06).

## Why this exists

The recurring "review and refactor the codebase for Agent SDK readiness" request
landed again, scoped (as before) against the same four areas: **agent core +
runtime**, **`modelHandlers/`**, **logger + platform/public surface**, and
**subagent boundaries**. As on every prior pass, this checkpoint ran a **fresh,
uninformed multi-way fan-out audit** — separate readers for (1) `agent/core` +
`runtime` + `implementations/flows`, (2) `modelHandlers/`, and (3) `logger` +
`agent/index` + `node` + `platform` + public surface — then reconciled every
finding against the adjudicated rulings and re-checked the tracked candidates
against the current tree.

## Verdict — unchanged

**The codebase remains well-aligned and SDK-ready in shape. No structural
refactoring is warranted.** The fresh readers independently reached the standing
conclusion:

- The **core/runtime** reader found **no** `Node.exec → wrapper → coreFunction →
createFlow → flow.run` ladders (`ResponseCycleNode.exec()` /
  `ToolUseCycleNode.exec()` call `createXFlow()` → `setServices(...)` → `run(...)`
  directly), **no** trivial identity factories, and **no** two-layer
  `buildX`-only-from-`createX` factories. It confirmed the services hierarchy
  (`AgentCore → BaseFlowContextInit → CycleRunServices → {ResponseCycle,
ToolUseRound}Services`) has genuine multi-consumer DRY at every level,
  `withModelClient` keeps its getter+`refreshClient` for relay-401 liveness, and
  no `index.ts` barrel exists in `core/`, `runtime/`, or `implementations/flows/`.
- The **`modelHandlers`** reader affirmed `IModelHandler` is `Pick<ModelHandler>`
  (derived, cannot drift), every picked member has ≥1 live caller, the
  `createResponse → withCreateResponseGuard → withSdkErrorTag → createResponseImpl`
  template has real multi-handler overrides at each seam, and the
  OpenAI-compatible subclass tree carries genuine per-provider behavior
  (`ReasoningModelHandlerOpenAI` captures exactly the shared reasoning overrides;
  only DashScope is thin, and it is enum-mandated by the exhaustive
  `PROVIDER_HANDLER_ROUTES`). Max inheritance depth is 4 — appropriate.
- The **logger/surface** reader confirmed the logger is a small, mostly-justified
  facade (redaction clean, functional logger clean), `runAgent` is a thin
  validate-register entry over `executeAgent`, and the platform ports / `emit`
  sink / `HostInteractions` gates are essential host-bridging that must stay.

The SDK-idiomatic spine is re-confirmed in-tree at HEAD: `createModelHandler` +
`PROVIDER_HANDLER_ROUTES` exhaustive route table; `initPlatform` / frozen
`platform()` accessor with single-call-site ports each backed by divergent host
impls; `AgentTrace` `emit()`/`subscribe()` as the one streamed-message SSoT;
`src/agent/core/index.ts` **absent** (no barrel regression); and the
lead-and-specialists delegation model — all unchanged.

## What the PR train resolved since 07-06

The two highest-value items the 07-06 checkpoint carried — one recorded as
genuinely-new, one as the standing "highest-leverage SDK move" — have been
**delivered in-tree** by the reviewed PR train. This is the substantive change
this pass records.

### 1. The 07-06 `SessionFact` triplication is gone — resolved by the Stage 5 backend-observer removal

The 07-06 checkpoint recorded a reviewed-train DRY candidate: the `SessionFact`
union was hand-re-listed across three sites (`emitLegacyHostFact`,
`emitLegacySessionFact`, and the outer `emitRuntimeEvent` routing switch) with no
exhaustiveness guard, so a sixth fact would silently drop. The Stage 5 progress
work (`refactor(progress): remove backend session observer` and the
`consume session facts` PRs, #7558 / #7561 / #7565) **removed the fan-out
entirely**:

- `LegacyProgressEventProjection.ts` — **deleted** (was the byte-identical
  second switch).
- `emitLegacyHostFact` / `emitLegacySessionFact` — **gone** (0 grep hits).
- `emitRuntimeEvent.ts` — collapsed from ~112 LOC of per-`type` switches to
  **32 LOC**: a single generic emit path,
  `emitRuntimeEvent<K extends SessionFact['type']>(event, payload, session?)`
  that resolves a target session and calls `target.events.emit({ scope:
'session', event: { type: event, payload } })`. There is no per-type switch
  left to drift, so the union (now 10 members, up from 5) is **drift-proof by
  construction** — exactly the fix the 07-06 checkpoint recommended, delivered a
  better way (eliminate the switches, not annotate them).

### 2. Round-loop convergence advanced — F6 "one child-run loop, N strategies"

The standing "highest-leverage SDK-alignment move" (every checkpoint since
`-06-26`) was **converge the two round-loop mechanisms** and **expose a typed
`delegateTo` primitive over the delegation plumbing**. F6 (`refactor(runtime):
one child-run loop, N strategies`, #7523 / #7536) lands the concrete substrate:

- New `src/agent/runtime/childRunLoop.ts` (665 LOC) — **one driver for every
  child-run type** (agent-CLI codex/claude sessions, native tool-use subagents,
  native workflow subagents). Each turn source supplies a
  `ChildRunStrategy<TTurn>` (`childRunLoop.ts:75`); the loop owns the parts
  previously duplicated per driver: follow-up queue acquire/drain, one
  lifetime-scoped interruptible, per-turn delivery choreography, and the terminal
  call into the shared finalizer. Consumed by `AgentRunLifecycle`,
  `executionRegistry`, and `ExecutionHandle`.

`childRunLoop` / `ChildRunStrategy` are **new relative to every prior readiness
doc** (0 grep hits) — the abstractly-tracked recommendation now has a named,
tested (`ChildRunLoop.vitest.ts`, 589 LOC) in-tree home. The remaining
SDK-alignment step is to surface a typed `delegateTo(subagent, input,
{maxDepth, tools})` **over** this strategy substrate rather than building it from
scratch; the plumbing has moved materially closer.

### Also landed (bridge-only cleanup, same direction)

- `refactor(cli): remove session progress wrapper` (#7560) — **−356 LOC**,
  deleting a CLI-side session-progress subscription wrapper as hosts move to
  consuming `SessionEventHub` facts directly. This is the surface reader's B2
  "per-host session choreography" gap being paid down incrementally.

## Applied this pass — one confirmed-safe cleanup

### Private `CycleServices` alias renamed `WorkspaceScopedCore` — same-folder name collision removed

`src/agent/core/flows/CommonCycleTypes.ts:84` declared a **private, non-exported**
type alias literally named `CycleServices`:

```ts
type CycleServices = AgentCore & { workspace: AgentWorkspaceState };
```

This collides, inside the same `flows/` folder, with the **exported** service
interfaces in the sibling `CycleServices.ts` (`ResponseCycleServices` /
`ToolUseRoundServices`, which model the live model client) — two unrelated
"CycleServices" meanings one file apart, a documented readability trap the fresh
core reader flagged. The alias has exactly **3 references, all in
`CommonCycleTypes.ts`** (lines 84, 113, 148) and **0 external importers**
(grep-confirmed: nothing imports `CycleServices` from `CommonCycleTypes`). Renamed
to `WorkspaceScopedCore` at all three sites, with a doc comment noting why it is
named distinctly from the sibling.

This is a **type-only, behavior-preserving** change on a non-exported symbol
scoped to one file — the same unattended-safe class as prior passes' one-cleanup
moves (the 07-06 `markdownFences.ts` dead-wrapper deletion, the 07-05
`ModelFactory.ts` dead re-export). Grep-confirmed absent from the canonical doc,
the detailed audit, the delta, and every `-06-25` → `-07-06` checkpoint (0 hits
for `WorkspaceScopedCore`).

**Verified green:** `npm run typecheck` **exit 0** (all projects: root,
test-kernel, `texra`, `@texra-ai/cli`, `@texra/trace-viewer`); `eslint` on the
changed file **clean**; `vitest run src/test-kernel/agent/ -t
"cycle|ResponseCycle|ToolUse"` — **21 files / 109 tests passed**.

## Genuinely-new candidates — surfaced by this fan-out, absent from all prior docs

Grep-confirmed absent from the canonical doc, the detailed audit, the delta, and
the `-06-25` → `-07-06` checkpoints (0 hits each). **Reviewed-train, not
unattended-safe** — each touches a signature or drops observable behavior; record,
don't sweep.

1. **`ModelHandlerXAI.extractResponse` is a diagnostic-only override** _(LOW)_.
   `src/agent/modelHandlers/openai/modelHandlerXAI.ts:23-37` overrides
   `extractResponse` solely to call `super.extractResponse(...)` and then
   `logger.debug` the reasoning-token count — no effect on the returned result.
   It is the one override in the OpenAI-compatible set that adds nothing
   behavioral. Fold the debug log into the base `extractResponse` (guarded on
   the usage field's presence) and delete the override, or drop the log.
   Reviewed-train because deleting it as-is removes an observable debug line.

2. **Duplicated `INTERNAL`-suppression rule in the logger** _(LOW; DRY)_.
   `toChannelLog` (`src/logger/channelTrace.ts:33`) and `attachChannelSubscriber`
   (`src/logger/logUtils.ts:236`) each independently re-implement "drop
   `MESSAGE_TYPES.INTERNAL`-tagged lines before the sink." Two copies of one
   policy that must stay in sync. Collapse to a single shared predicate.

3. **`TextConnectionService` is a single-member, single-extender exported
   interface** _(LOW)_. `src/agent/core/flows/CycleServices.ts:63-72` is a
   one-method interface (`bestConnectionMethod`) extended by exactly one
   interface (`ResponseCycleServices`, `CycleServices.ts:87`) with one impl
   (`textConnection.ts`). The port _member_ is needed (core can't import
   runtime), but the named wrapper interface adds nothing over declaring the
   member directly on `ResponseCycleServices`. Reviewed-train because it is an
   exported type-surface change, not a dead-code deletion.

## Reviewed-train / strategic candidates re-confirmed — already tracked

The fresh fan-out independently re-derived the following; each is already
recorded and adjudicated. Rulings held, no new action.

| Re-derived this pass                                                                                                           | Already tracked at                                          | Standing disposition                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Extract `getApiKey` rule-table into a `support/ApiKeyResolver` / `ApiCredentialResolver` (symmetry with `ProxyConfigResolver`) | audit `:2546-2547`, `:2928`; checkpoints `-06-26`, `-06-30` | **Reviewed-train** — placement/signature change, not blind-safe.                                      |
| No single `runTurn()` entry over the ~38-member `IModelHandler` port                                                           | `-07-05`, `-07-06` (structural-divergence section)          | **Strategic** — add a thin `runTurn`/`streamTurn` façade over the primitives; keep the port internal. |
| Narrow `createChannelTrace` to a 4-method `ChannelLogger` (drops the ~14 fabricated inert `AgentTrace` members)                | `-07-05` #7; `logger-surface-cleanup` PRD                   | **Reviewed-train** — ~30 call sites; deliberate polymorphism tradeoff.                                |
| `@logger` partial barrel vs deep `@logger/logUtils` imports (split import surface)                                             | `-07-05` #7 (refines P25-4)                                 | **Reviewed-train / opportunistic** — importer count already corrected.                                |
| Per-host session choreography duplicated 3× + session-scoped tool-edit-approval shim → a `runSession()` façade                 | `-07-03` `:54` (`toolHostUi`); surface B2/B5                | **Strategic** — the F6 / Stage 5 / #7560 train is already paying this down incrementally.             |
| Single-caller helpers `handleInvocationResult` (`RetryState.ts:353`), `replaceMessagesInPlace` (`CommonCycleTypes.ts:79`)      | new-derived; colocation-justified                           | **Keep** — non-trivial narrowing colocated with its union / documented in-place rationale.            |

## Adjudicated traps the fan-out re-surfaced — rulings held

No change.

| Re-surfaced candidate                                                               | Ruling                                                                                                                             |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Collapse OpenAI-compatible subclasses (DeepSeek/Kimi/MiniMax/GLM) to a config table | **Trap** — each carries real per-provider overrides; only DashScope is thin, and it is enum-mandated.                              |
| Remove `IModelHandler` as a "duplicate" of `ModelHandler`                           | **Trap** — it is `Pick<ModelHandler>` (derived, breaks a real import cycle) + optional `createBatchedToolUseFollowUpMessages`.     |
| Inline `createResponse → withCreateResponseGuard → sdkErrorTagger`                  | **Keep** — each hook has distinct real overriders (impl ×6, tagger ×5, guard ×2).                                                  |
| `runReflectionAgent` / `runToolUseAgent` single-caller wrappers                     | **Keep** — each owns category-specific wiring; inlining bloats `executeAgent`.                                                     |
| `runAgent` / `executeAgent` dual entry is redundant                                 | **Keep** — `runAgent` owns executionId + register + workflow-output; `executeAgent` owns the run. Two documented responsibilities. |
| `ModelFactory` two-layer / trivial-identity factories                               | **No violation** — two real entries sharing a routing switch with compile-time exhaustiveness.                                     |
| `DashScope` near-empty subclass should be deleted                                   | **Keep** — its one line (`convertContentToString`) changes persisted history format; the class is enum-mandated.                   |

## Subagent split points — re-confirmed, with F6 as new substrate

No change to the canonical/delta ranking. The three highest-confidence
already-isolated units a formal decomposition would draw on are unchanged
(`ModelFactory.createModelHandler`, `assembleAgentLaunchContext`,
`agentToolResolution`). Ranked split points unchanged from `-06-26` → `-07-06`:

1. Wire the existing `review` tool-use agent as a post-draft Verifier delegation.
2. Introduce a typed `delegateTo(subagent, input, {maxDepth, tools})` primitive
   — **now materially cheaper**: F6's `ChildRunStrategy` / `childRunLoop` is the
   substrate to expose it over, rather than net-new loop code.
3. Formalize workflow agents (`polish` / `correct` / `merge`) as SDK actors with
   typed I/O contracts.
4. Relocate the remaining module-global registries onto the per-session handle.
5. Decompose in-agent multi-phase workflow agents (`devise`, `verifyFix`) into
   draft → Verifier → apply hand-offs — gated by #4.

## Recommendation

**SDK-ready in shape; no structural refactoring warranted.** The tree is _cleaner_
than at 07-06: the maintainers' reviewed PR train resolved the 07-06 `SessionFact`
triplication (Stage 5, single generic emit path — drift-proof) and delivered the
concrete substrate for round-loop convergence (F6 `childRunLoop` /
`ChildRunStrategy`), plus a −356 LOC CLI wrapper removal (#7560), all in the
audit's own recommended direction. One confirmed-safe cleanup applied this pass —
the private `CycleServices → WorkspaceScopedCore` rename (type-only,
behavior-preserving, typecheck + lint + flow tests green). Three genuinely-new
low-severity items (XAI diagnostic override, logger `INTERNAL`-rule duplication,
`TextConnectionService` single-member interface) are recorded as reviewed-train.
Everything else maps to already-tracked reviewed-train / strategic items
(`getApiKey`→resolver, `runTurn` façade, `ChannelLogger` narrowing, `@logger`
barrel, the `runSession()` session-choreography façade) or adjudicated traps
(held). Do not re-open the traps; do not sweep the reviewed-train items unattended.

## Verified (this checkpoint)

- Spine re-confirmed at HEAD `401a5ce` (branch `claude/eager-noether-acxa1g`):
  `createModelHandler` + `PROVIDER_HANDLER_ROUTES` (`ModelFactory.ts`),
  `initPlatform` / `platform` (`platform.ts`), `AgentTrace` emit/subscribe
  (`trace/index.ts`), `src/agent/core/index.ts` **absent**, `Node.exec →
createFlow().run` shape intact.
- 07-06 `SessionFact` candidate verified **resolved**:
  `LegacyProgressEventProjection.ts` absent, `emitLegacyHostFact` /
  `emitLegacySessionFact` 0 grep hits, `emitRuntimeEvent.ts` now a single generic
  32-LOC emit path (`SessionEventHub.ts:27` union has 10 arms, no routing switch).
- F6 verified in-tree: `childRunLoop.ts` (665 LOC) with
  `ChildRunStrategy<TTurn>` (`:75`), used by `AgentRunLifecycle` /
  `executionRegistry` / `ExecutionHandle`; `ChildRunLoop.vitest.ts` present.
  0 grep hits across all prior readiness docs (genuinely new-in-tree).
- Applied rename verified: `CycleServices` alias
  (`CommonCycleTypes.ts:84`) was **non-exported**, had exactly **3 refs** (all in
  the same file) and **0 external importers**; renamed to `WorkspaceScopedCore`.
  0 grep hits for `WorkspaceScopedCore` in any prior readiness doc.
- Change verified green: `npm run typecheck` **exit 0** (all projects, after a
  `corepack pnpm install` to restore `@types/*` the fresh clone had not
  materialized); `eslint` on the changed file clean; `vitest run
src/test-kernel/agent/ -t "cycle|ResponseCycle|ToolUse"` — **21 files / 109
  tests passed**.
- New candidates verified in-tree and novel:
`modelHandlerXAI.ts:23-37` (diagnostic-only override),
`channelTrace.ts:33` + `logUtils.ts:236` (duplicated `INTERNAL` rule),
`CycleServices.ts:63-72` (`TextConnectionService` single-member interface) —
0 grep hits each across all prior readiness docs.
</content>

</invoke>
