# Agent SDK Readiness — Verification Checkpoint (2026-07-12)

**Status:** Verification checkpoint. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the plan of record
[`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md), the detailed
[`./2026-05-29-agent-sdk-readiness-audit.md`](./2026-05-29-agent-sdk-readiness-audit.md), the
[`2026-06-24-agent-sdk-readiness-delta.md`](../../proposals/2026-06-24-agent-sdk-readiness-delta.md)
addendum, and the `-2026-06-25` → `-2026-07-10` checkpoints (most recently
[`-2026-07-10`](./2026-07-10-agent-sdk-readiness-checkpoint.md)).

This pass re-verified the standing audit against the working tree at HEAD
`69f1b9f` (branch `claude/eager-noether-9nva8u`, well ahead of the `685f9fb`
tree the 07-10 checkpoint pinned — the whole `685f9fb..69f1b9f` window is
present). As on every prior pass it ran a **fresh, uninformed multi-way
fan-out audit** — three separate readers for (1) `agent/core` + `runtime` +
`implementations/flows`, (2) `agent/modelHandlers` + `ModelFactory` +
`helperModel*`, and (3) `logger` + `agent/index` + the public host↔core run
surface — then reconciled every finding against the adjudicated rulings and
re-checked the tracked candidates against the current tree.

## Verdict — unchanged

**The codebase remains well-aligned and SDK-ready in shape. No structural
refactoring is warranted.** The three fresh readers independently re-reached
the standing conclusion: the SDK-aligned spine is unchanged in shape —
`createModelHandler` + `PROVIDER_HANDLER_ROUTES` (`ModelFactory.ts:51`,`:380`),
`IModelHandler` still a `Pick<ModelHandler>` (`src/agent/types/IModelHandler.ts:54-60`),
`src/agent/core/index.ts` still absent (no barrel regression),
`emitRuntimeEvent` still retired (sole grep hit is the retirement guard test),
`RunScope` still the single `readonly` identity carrier (`RunScope.ts:13-20`),
and the `Node.exec → createFlow().run` shape intact (`ResponseCycleNode.ts:101,115`;
`ToolUseCycleNode.ts:91,138`). Every substantive candidate the fan-out
surfaced maps onto an **already-adjudicated trap** (ruling held), an
**already-tracked reviewed-train / strategic** item, or a **verified false
positive** (three this pass — two of them recurrences of the exact
`src/`-only-grep methodology error the 07-08→07-10 checkpoints keep catching).

## What the PR train advanced since 07-10

The tree is **cleaner** than at the 07-10 pin. The window is mostly CI /
dependabot / TUI-palette / host-parity merges, but several merges are the
maintainers paying down exactly the single-caller-wrapper and hand-rolled-
indirection debt these checkpoints track — the same discipline this pass
applies (below):

- `5961023` **inline single-caller `assertDesktopOutboundMessage`** (desktop).
- `95f9126` **inline single-caller exec poller**; assert exitCode on array-form abort.
- `d90ba57` / `4f12331` **consolidate `StreamSnapshotStore`'s per-stream maps
  into one record** and replace its write chains with a keyed async-mutex.
- `d38ed84` **converge `yaml.parse` sites on the `parseYamlWith` boundary**.
- `2c59187` **use `p-timeout` instead of a hand-rolled `Promise.race`** (workflowScript).
- `64124eb` / `a0eff2b` **route `CliSecrets` through the shared `JsonStore`**,
  serialize writes.

None touches the agent-core spine; all reduce indirection. The spine anchors
above were re-verified present at `69f1b9f`.

## Applied this pass — inline the single-caller `agentContextToRunContext`

The one **unattended-safe** cleanup the fan-out produced was applied and
verified (surface-reader finding #1):
`agentContextToRunContext` (`AgentLaunchContext.ts`, formerly `:131`) was a
**private, same-file, single-caller** projection helper — its only caller was
`withExecutionRunContext` two definitions below it — matching the repo's
banned "single-caller extraction". It is now inlined into
`withExecutionRunContext` (its sole owner), the ownership doc-comment moved
onto the mapping, and the now-orphaned `type CreateRunContextOptions` import
dropped. Net −19 LOC (14 insertions / 33 deletions).

Why this one was unattended-safe (unlike everything else below): it is a
**private** function (no exported-surface change), contained entirely to
`AgentLaunchContext.ts` (no `packages/**` edit), has **no dedicated test**
(grep-confirmed — the projection is only exercised transitively via
`withExecutionRunContext`), and is behavior-preserving (the object literal is
identical; `createRunContext` type-checks the inlined literal exactly as it
type-checked the helper's return). **Verified:** `npm run typecheck` clean
(exit 0, all four project configs), `eslint src/agent/runtime/AgentLaunchContext.ts`
clean, and the three path suites green — `AgentLaunchContext` + `RunContext`
(8 tests) and CLI `RunExecution` (25 tests).

No other cleanup was applied — every remaining candidate is reviewed-train
(signature/structure change, crosses `packages/**`, or deletes a tested seam)
or a verified false positive, and forcing one of those unattended would
violate the discipline.

### False positives caught this pass — record, do not re-flag

1. **`followUpResumeDetection.ts` is NOT safe to inline** (re-surfaced by the
   core reader as its top item — "single-caller one-line negation"). This is
   the **already-recorded 07-10 false positive**: its one production caller is
   `packages/extension/src/commands/agent/followUpCommand.ts:41`, it has a
   dedicated vitest (`src/test-kernel/agent/FollowUpResumeDetection.vitest.mts`,
   confirmed present at HEAD), and it is a named runtime-README module-map
   entry. A tested, documented, host-consumed domain predicate — inlining
   deletes a tested seam and edits `packages/**`. (`src/`-only grep misses the
   extension caller — the recurring methodology error.)

2. **`applyHelperModelPreference` is NOT safe to inline** (model reader
   finding F3, "single-caller extraction"). It has a **dedicated unit test**
   (`src/test-kernel/agent/runtime/helperModelPreference.vitest.ts`) that
   imports and exercises it directly. Same shape as (1): a tested named unit
   with meaningful logic (tool-use / function-calling guard + availability
   check). Inlining deletes the tested seam. Reviewed-train, not a sweep.

3. **`useRunContext` is NOT a dead export** (core reader finding #3, "exported
   but zero external callers"). Two test files import it directly —
   `RunContext.vitest.ts` (4 sites) and `AgentLaunchContext.vitest.ts` — so
   un-exporting breaks those suites. The "zero callers" grep missed the tests
   (the `src/`-only-grep error again, this time missing `test-kernel`). Keep
   exported.

## Genuinely-new / reviewed-train candidates — surfaced by this fan-out

Each is a signature/structure change, crosses `packages/**`, or is a
documented seam. **Reviewed-train, not unattended-safe** — record, don't sweep.
Several map onto already-tracked standing items (noted).

1. **`ModelHandler.ts` is a ~1,780-line base class tangling ~7 concerns**
   _(MEDIUM; strategic — maps to the standing `runTurn`/`streamTurn`-façade
   train)_. Auth/endpoint resolution, media attachments, compaction, token
   counting/limits, the prefill state machine, reasoning-effort, and pricing
   all live in the one base. Mitigating and important: the heavy machinery is
   **already** delegated to `support/` collaborators
   (`MediaAttachmentProcessor`, `ProxyConfigResolver`, `UsageNormalizer`,
   `AnthropicStreamHandler`, `reasoningEffort`, `contextUtilization`), the base
   imports **zero** provider-specific modules (no provider leakage), and the
   `#7101` in-source triage already removed no-value getters. So this is
   further **decomposition of the remaining orchestration** (compaction /
   prefill / token-limit / auth could each become an injected collaborator),
   not a rewrite — and it is the standing reviewed-train "`runTurn`/`streamTurn`
   façade over the ~40-member `IModelHandler`" item, not new debt. The provider
   abstraction itself is **justified** (13 concrete handlers over ~9 wire
   formats, 16 abstract methods every provider implements) — do not collapse it.

2. **`agentRegistry.ts` mixes the resolver with ~150 lines of one-time legacy
   migrations** _(MEDIUM; reviewed-train)_. `migrateLegacySourceKeys`,
   `migrateLegacyAgentNameKeys`, `migrateFilenameAgentNameKeys` (+ helpers) are
   upgrade concerns unrelated to lookup/resolution, and are pure legacy baggage
   an SDK consumer never needs. The resolution logic (`resolveAgentForLaunch`
   et al.) is genuinely intricate and earns its space — do not split that. The
   clean extraction is only the migration cluster; it edits the module every
   host imports, so reviewed-train. (Adjacent to north-star §4 Step 3's
   "curate the `index/` public surface at packaging".)

3. **Logger has two front doors onto the same `writeLine` sink** _(LOW;
   reviewed-train — the standing `createChannelTrace` → `ChannelLogger` item)_.
   The functional `debug/info/warn/error(channel, msg)` (156 importers) and
   `createChannelTrace(name).debug(...)` (64 importers) both funnel to
   `writeLine`; `createChannelTrace` exists only so module singletons can type
   a field as `AgentTrace`, and it honestly pre-justifies itself in its own
   doc-comment. Near-zero cost; one entry point (functional + a trivial
   `AgentTrace` adapter) is the SDK-cleaner shape. Already tracked
   (`2026-05-17-logger-simplification-feasibility.md`). `redaction.ts` (4 desktop call
   sites) and `channelTrace.ts` are otherwise **justified** — recorded so they
   are not re-flagged.

4. **`getRunContextAgentName` is a single-caller member of the six-accessor
   `RunContext` family** _(LOW; ride the F4 train)_. Its one production caller
   is `src/tools/memory/MemoryTool.ts:202`; the other five accessors are
   multi-caller and justified. This is a facet of the **already-tracked 07-10
   candidate** "`RunContext`'s `launch | bare` union forces six branch
   accessors" — handle the whole family with the F4 / `#7835`/`#7836`
   `RunScope`-hardening train, not one member in isolation.

5. **`IToolRegistry` is an interface over exactly one production
   implementation** _(LOW; re-confirmed from 07-10)_. `core/tools/ToolTypes.ts:42`
   — the only `implements` is `MapToolRegistry` in the same file; every
   construction is `new MapToolRegistry`. Ruling unchanged: a genuinely clean
   `get`/`has` surface an SDK tool-lookup wants; cost of keeping is ~4 lines.
   Keep.

6. **The layered run-options bags are the real `query({...})`-alignment gap**
   _(strategic; documented tension, not a bug)_. `RunAgentOptions extends
Pick<ExecuteAgentOptions>` → `SubagentRunOptions`, with `AgentLaunchInput`
   and `RunFlowLifecycleOptions` re-declaring overlapping subsets. The
   `Pick<>` forwarding is deliberate drift-prevention, and `SessionHandle`'s
   own doc explicitly declines the `query()`/send/stream/resume shape
   ("Anthropic shipped and then deleted exactly that shape"). This is the
   conscious divergence the north-star already records (no `runSession()`
   façade; shrink ceremony by deleting host bookkeeping into `SessionHandle`,
   not by wrapping). Strategic, gated — do not flatten unattended.

## Reviewed-train / strategic + adjudicated traps — held

No change from 07-10. The fan-out re-derived the standing set; rulings hold:
the `ResponseCycleNode`/`ToolUseCycleNode` `exec()→run inner flow→interpret`
wrapper (**keep** — the outer node owns real per-round orchestration);
`IModelHandler` as a "duplicate" of `ModelHandler` (**trap** — removal breaks a
real import cycle); folding the single-caller `createResponseCycleFlow` /
`createToolUseRoundFlow` into their nodes (**keep** — this _is_ the prescribed
`Node.exec() → createFlow() → run()` shape); `runAgent`/`executeAgent` dual
entry (**keep** — two documented responsibilities); collapsing the
OpenAI-compatible subclasses to a config table (**trap** — real per-provider
overrides + enum-mandated route table); `IToolUseSession` single-impl port
(**keep** — host-agnosticism seam keeping `core/flows` off the concrete
follow-up queue). The `Shared*` execution/subscription/status singletons →
session-only ownership, the helper-model / content-helper `runtime/` cluster
relocation, the four VS-Code-only `Platform` diagnostic ports, the
`SdkToolCall` union → generic `NormalizedToolCall`, packaging / barrels, and
the minimal-embedder `Platform` all remain **strategic/gated** exactly as the
north-star sequences them.

## Subagent split points — re-confirmed, gating observation unchanged

Delegation remains a **mature strategy-pattern subsystem**, not something to
build: `childRunLoop.ts` (one driver per child-run type) + `ChildRunStrategy`

- the `src/tools/delegation/` strategies + `executionRegistry` lineage +
  `detachSubagentsOnStop` are already the SDK spawn shape (prompt/config in →
  `AgentFlowResult` out, with progress/cost/resume/interrupt/lineage). Ranked
  split points unchanged from `-06-26` → `-07-10`:

1. Wire the existing `review` tool-use agent as a post-draft Verifier delegation.
2. Introduce a typed `delegateTo(subagent, input, {maxDepth, tools})` over
   `childRunLoop` + `ChildRunStrategy` + `executeAgent`.
3. Formalize workflow agents (`polish` / `correct` / `merge`) as SDK actors.
4. Relocate the remaining module-global registries onto the per-session handle.
5. Decompose in-agent multi-phase workflow agents into draft → Verifier →
   apply hand-offs — gated by #4.

**Gating observation (unchanged, re-verified):** delegation depth is tracked
but never gated — `delegationPolicy.ts` computes depth for observability /
`isSubagent` only, `agentToolResolution.ts` has no depth-based tool filtering,
and there is still no `maxDelegationDepth` runtime setting (grep: 0 hits). A
real depth cap remains a prerequisite before exposing recursive `delegateTo(...)`
as a public SDK surface (split point #2).

## Recommendation

**SDK-ready in shape; no structural refactoring warranted.** The tree is
cleaner than at 07-10 — the maintainers' PR train continues to pay down
single-caller wrappers and hand-rolled indirection (assertDesktopOutboundMessage,
exec poller, StreamSnapshotStore maps, yaml boundary, p-timeout, CliSecrets
JsonStore). **One cleanup was applied this pass:** the private, same-file,
single-caller `agentContextToRunContext` inlined into `withExecutionRunContext`
(−19 LOC), verified type-safe + lint-clean + 33 tests green. The pass otherwise
found no unattended-safe cleanup — three candidates were verified false
positives (`followUpResumeDetection`, `applyHelperModelPreference`,
`useRunContext`, all crossing `packages/**` or a tested seam via the recurring
`src/`-only-grep error), and every remaining item is reviewed-train
(`ModelHandler` decomposition, the `agentRegistry` migration cluster, the
logger dual front-door, the six-accessor `RunContext` family, the
`query()`-alignment options-bag tension) or an adjudicated trap (held). Do not
re-open the traps; do not re-flag `followUpResumeDetection`,
`applyHelperModelPreference`, or `useRunContext`; do not sweep the
reviewed-train items unattended.

## Verified (this checkpoint)

- Spine re-confirmed at HEAD `69f1b9f`: `createModelHandler` +
  `PROVIDER_HANDLER_ROUTES` (`ModelFactory.ts:51`,`:380`), `IModelHandler` =
  `Pick<ModelHandler>` (`src/agent/types/IModelHandler.ts:54-60`),
  `src/agent/core/index.ts` **absent** (no barrel regression),
  `emitRuntimeEvent` **retired** (sole grep hit is
  `sessionFactAmbientHelperRetirement.vitest.ts`), `RunScope.ts:13-20` carries
  `readonly` `streamId`/`executionId`/`agentName`, `Node.exec → createFlow().run`
  intact (`ResponseCycleNode.ts:101,115`; `ToolUseCycleNode.ts:91,138`), six
  `getRunContext*` accessors present (`RunContext.ts:182-227`).
- Applied cleanup verified: `agentContextToRunContext` inlined into
  `withExecutionRunContext` (`AgentLaunchContext.ts`), orphaned
  `CreateRunContextOptions` import removed; `npm run typecheck` exit 0 (all four
  tsconfig projects), `eslint` clean on the file, and `AgentLaunchContext` +
  `RunContext` (8 tests) and CLI `RunExecution` (25 tests) green.
- False positives verified in-tree: `followUpResumeDetection` imported at
  `followUpCommand.ts:41` with a dedicated `.vitest.mts`;
  `applyHelperModelPreference` imported/exercised by
  `helperModelPreference.vitest.ts`; `useRunContext` imported by
  `RunContext.vitest.ts` (4 sites) and `AgentLaunchContext.vitest.ts`.
- PR-train advances verified in-window (`685f9fb..69f1b9f`): `5961023`,
  `95f9126`, `d90ba57`, `4f12331`, `d38ed84`, `2c59187`, `64124eb`.
- Delegation depth verified still tracked-but-ungated (`delegationPolicy.ts`;
  no `maxDelegationDepth`, 0 grep hits).
- This checkpoint is added under `docs/proposals/`, an internal directory
excluded from the texra.ai publish allowlist — not a root-level doc.
</content>

</invoke>
