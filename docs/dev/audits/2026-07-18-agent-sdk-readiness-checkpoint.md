# Agent SDK Readiness — Verification Checkpoint (2026-07-18)

**Status:** Verification checkpoint. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the plan of record
[`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md), the detailed
[`./2026-05-29-agent-sdk-readiness-audit.md`](./2026-05-29-agent-sdk-readiness-audit.md), the
[`2026-06-24-agent-sdk-readiness-delta.md`](../../proposals/2026-06-24-agent-sdk-readiness-delta.md)
addendum, and the `-2026-06-25` → `-2026-07-12` checkpoints (most recently
[`-2026-07-12`](./2026-07-12-agent-sdk-readiness-checkpoint.md)).

This pass re-verified the standing audit against `main` at HEAD `1f7082f`
(v0.39.7). The `685f9fb`/`69f1b9f` audit-branch trees the 07-10/07-12
checkpoints pinned were squash-merged into `main`, so their individual working
commits are not in `main`'s history, but both checkpoint docs are present
in-tree and the spine anchors they recorded were re-confirmed at `1f7082f`
(see **Verified** below). As on every prior pass it ran a **fresh, uninformed
multi-way fan-out audit** — three separate readers for (1) `agent/core` +
`implementations/flows`, (2) `agent/modelHandlers` + `ModelFactory` +
`toolConversion`, and (3) `agent/runtime` + `logger` + `trace` + `index` /
the public host↔core run surface — then reconciled every finding against the
adjudicated rulings and re-checked the tracked candidates against the current
tree.

## Verdict — unchanged

**The codebase remains well-aligned and SDK-ready in shape. No structural
refactoring is warranted.** The three fresh readers independently re-reached
the standing conclusion: the SDK-aligned spine is unchanged in shape —
`createModelHandler` + `PROVIDER_HANDLER_ROUTES` (`ModelFactory.ts:427`,`:73`),
`IModelHandler` still a `Pick<ModelHandler>` (`src/agent/types/IModelHandler.ts:41`),
`src/agent/core/index.ts` still absent (no barrel regression),
`emitRuntimeEvent` still retired (sole grep hit is the retirement guard test),
`RunScope` still the single `readonly` identity carrier (`RunScope.ts:16-19`),
and the `Node.exec → createFlow().run` shape intact (`ResponseCycleNode.ts:103,117`;
`ToolUseCycleNode.ts:91,138`). Every substantive candidate the fan-out
surfaced maps onto an **already-adjudicated trap** (ruling held), an
**already-tracked reviewed-train / strategic** item, or a **verified false
positive** (the recurring `src/`-only-grep methodology error struck again — the
core and runtime readers both re-surfaced `followUpResumeDetection` /
`IToolRegistry`; see below).

## New signal this pass — the boundary erosion is no longer accelerating

The north-star's central "the boundary is eroding while unfenced" concern (§3:
extension 49 / CLI 35 / desktop 27 distinct `@agent/*` deep-import specifiers,
up 1.36×/1.94×/1.59× over 5.4 weeks) **is no longer trending up on the two
largest hosts**. Recounted at `1f7082f`:

| Host                 | North-star baseline | Now (`1f7082f`) | Δ    |
| -------------------- | ------------------- | --------------- | ---- |
| `packages/extension` | 49                  | **44**          | −5   |
| `packages/cli`       | 35                  | **34**          | −1   |
| `packages/desktop`   | 27                  | **29**          | +2\* |

\*_Census note (Codex review, P2)._ The complete distinct-`@agent/*`-specifier
count includes both static `from`-imports **and** dynamic `import('@agent/…')`.
Desktop is the only host with dynamic `@agent` imports: five distinct
specifiers occur dynamically, of which two (`@agent/runtime/runAgent` and
`@agent/runtime/helperModelName`) do not also occur in static imports. Those two
raise its complete count to **29**, rather than the 27 reported by a
static-`from`-only census; extension and CLI have **zero** dynamic `@agent`
imports, so their static and complete censuses coincide at 44/34. The
north-star's stated desktop `27` appears to be a static-`from` count, so the
desktop `+2` is largely this **census correction**, not confirmed new drift —
and it is a caution for the R-b baseline, which must count dynamic imports or
it will under-freeze desktop by exactly these two. The
headline rests on the two hosts whose drop is unambiguous under either census:
extension (−5) and CLI (−1).

Core→host alias violations remain **0** (R-a would install at a zero
baseline, unchanged). The maintainers' consolidation train (the 07-12 window's
`assertDesktopOutboundMessage` / exec-poller / `StreamSnapshotStore` /
`parseYamlWith` / `p-timeout` / `CliSecrets` merges, and the same discipline
since) is out-pacing new deep-import drift. This does **not** retire Step 0's
R-a/R-b ratchets — width is still ~100 union specifiers and unfenced, so the
freeze is still worth installing — but it removes the "erosion is
accelerating" urgency the north-star attached to it.

## Applied this pass — inline the single-use `TextConnectionService` interface

The one **unattended-safe** cleanup the fan-out produced was applied and
verified (core reader finding #6): `TextConnectionService`
(`src/agent/core/flows/CycleServices.ts`, formerly `:61-70`) was a
**private, non-exported, single-use** type-only interface whose only reference
was the `extends ... TextConnectionService` on `ResponseCycleServices` ten
lines below it — the repo's banned "single-caller extraction" (AGENTS.md
"abstraction-cost guardrails"). Its one member `bestConnectionMethod` is now
declared directly on `ResponseCycleServices` (its sole carrier), and the
private interface deleted. Net −2 LOC (11 insertions / 13 deletions).

Why this one was unattended-safe: it is a **non-exported type** (no
exported-surface change; nothing outside the file can name it — grep-confirmed
the only two `TextConnectionService` references are its definition and its one
`extends` site), the edit is contained entirely to `CycleServices.ts` (no
`packages/**` edit), it has **no dedicated test** (the
`TextConnectionHelperModel.vitest.ts` suite exercises the unrelated
`bestConnectionMethod` _function_ in `@agent/runtime/textConnection`, not the
interface type), and it is a **pure type merge** — `ResponseCycleServices`'s
structural shape is byte-identical before and after, so it cannot change
runtime behavior. **Verified:** `npm run typecheck` clean (exit 0, all six
project configs — root, test-kernel, extension, CLI, trace-viewer, desktop),
`eslint src/agent/core/flows/CycleServices.ts` clean (exit 0), and
`TextConnectionHelperModel.vitest.ts` green.

No other cleanup was applied — every remaining candidate is reviewed-train
(signature/structure change, crosses `packages/**`, or deletes a tested seam)
or a verified false positive, and forcing one of those unattended would
violate the discipline.

### False positives caught this pass — record, do not re-flag

1. **`followUpResumeDetection.ts` is NOT safe to inline** (re-surfaced by the
   runtime reader as its finding #8 — "single-caller one-line predicate"). This
   is the **already-recorded 07-10/07-12 false positive**: its one production
   caller is `packages/extension/src/commands/agent/followUpCommand.ts:13`
   (`shouldProbePersistedFlowForFollowUp`), it has a dedicated vitest
   (`src/test-kernel/agent/FollowUpResumeDetection.vitest.mts`, confirmed
   present at HEAD), and it is a named runtime-README module-map entry. A
   tested, documented, host-consumed domain predicate — inlining deletes a
   tested seam and edits `packages/**`. (`src/`-only grep misses the extension
   caller — the recurring methodology error.)

2. **`IToolRegistry` is NOT a removable single-impl interface** (core reader
   finding #4, "interface over exactly one implementation"). This is the
   **07-10/07-12 held ruling** (07-12 item 5): `core/tools/ToolTypes.ts:42` —
   the only `implements` is `MapToolRegistry` in the same file — but it is a
   genuinely clean `get`/`has` surface an SDK tool-lookup wants, cost of
   keeping is ~4 lines, and it sits on the `core/flows` → tools dependency edge
   (`CycleServices.ts:98`, `ToolUseRoundServices.toolRegistry`). Keep.

3. **`RetryableInvocationNode`'s abstract base earns its split via a test seam**
   (core reader finding #2, "template-method base with one production
   subclass"). Its one production subclass is `ModelInvocationNode`
   (`ModelInvocationNode.ts:67`), but a **test** subclass `ExposedRetryNode`
   (`RetryState.vitest.ts`) drives the base's retry machinery independently.
   Same shape as (1)/(2): inlining deletes a tested seam. Reviewed-train, not a
   sweep.

## Genuinely-new / reviewed-train candidates — surfaced by this fan-out

Each is a signature/structure change, crosses `packages/**`, or is a
documented seam. **Reviewed-train, not unattended-safe** — record, don't sweep.
Several map onto already-tracked standing items (noted).

1. **`ModelHandler.ts` is a ~1,860-line base class tangling ~7 concerns**
   _(MEDIUM; strategic — maps to the standing `runTurn`/`streamTurn`-façade
   train)_. Unchanged from 07-12 (measured 1,863 LOC now vs the ~1,780 the
   07-12 pin recorded on its branch tree — no material growth). Auth/endpoint
   resolution, media attachments, compaction, token counting/limits, the
   prefill state machine, reasoning-effort, and pricing all live in the one
   base — but the heavy machinery is **already** delegated to `support/`
   collaborators (`MediaAttachmentProcessor`, `AnthropicStreamHandler`,
   `UsageNormalizer`, `reasoningEffort`), the base imports **zero**
   provider-specific modules (no provider leakage), and the `#7101` in-source
   triage already removed the no-value getters. The provider abstraction itself
   is **justified** — 13 concrete handlers over ~9 wire formats, 16 abstract
   methods every provider implements — do not collapse it. Further
   decomposition of the remaining orchestration (compaction / prefill /
   token-limit / auth each an injected collaborator) is the standing
   reviewed-train item, not new debt.

2. **Message opacity is the real `query({...})`-alignment gap** _(strategic;
   documented tension, not a bug)_. The model reader's highest-leverage finding:
   because messages are provider-opaque (`M extends ProviderMessage`), the flow
   holds `shared.messages` as an untyped array it cannot inspect, so every
   transcript operation round-trips through a handler method — which is _why_
   `IModelHandler` has 31 members (~10 of them message-mutation methods:
   `initializeMessages`, `createRoundMessages`, `createUserFollowUpMessages`,
   `prependTextToUserMessage`, …). This is the same conscious divergence the
   north-star records (the layered `RunAgentOptions`/`SubagentRunOptions` bags,
   the `SessionHandle` doc's explicit rejection of the `query()`/send/stream
   shape, the `SdkToolCall` → generic `NormalizedToolCall` strategic item). A
   neutral internal transcript (role + content blocks, serialized at the
   send boundary inside each handler) would collapse both this and candidate 3
   — the biggest single lever, highest effort, gated. Do not flatten unattended.

3. **`ModelHandlerOpenRouterNative` re-implements the OpenAI chat message shape
   (~800 LOC)** _(MEDIUM; reviewed-train — a facet of candidate 2)_.
   `modelHandlerOpenRouterNative.ts:97` extends `ModelHandler` directly rather
   than `ModelHandlerOpenAI`, so it re-declares `initializeMessages` /
   `createRoundMessages` / `createUserFollowUpMessages` / `appendUserText` / …
   near-parallel to the OpenAI handler — the only real divergence is typing
   messages as `@openrouter/sdk`'s `ChatMessages` instead of `openai`'s
   `ChatCompletionMessageParam` (wire-equivalent shapes). Reparenting or
   sharing an `openAIMessageUtils` mixin would collapse most of it. Crosses
   multiple provider files with tests — reviewed-train. **Do not** confuse with
   the held trap "collapse the OpenAI-compatible subclasses to a config table"
   (that one stays — real per-provider overrides + enum-mandated route table);
   this is specifically the message-type divergence.

4. **`agentRegistry.ts` mixes the resolver with ~150 lines of one-time legacy
   migrations** _(MEDIUM; reviewed-train)_. Unchanged from 07-12:
   `migrateLegacySourceKeys` (`:72`), `migrateFilenameAgentNameKeys` (`:281`),
   `migrateLegacyAgentNameKeys` (`:223`) are upgrade concerns an SDK consumer
   never needs; the resolution logic itself earns its space. The clean
   extraction is only the migration cluster; it edits the module every host
   imports, so reviewed-train. (Adjacent to north-star §4 Step 3's "curate the
   `index/` public surface at packaging".)

5. **Logger has two front doors onto the same `writeLine` sink** _(LOW;
   reviewed-train — the standing `createChannelTrace` → `ChannelLogger` item)_.
   The functional `debug/info/warn/error(channel, msg)` and
   `createChannelTrace(name).debug(...)` both funnel to `writeLine`;
   `createChannelTrace` fabricates a full inert `AgentTrace` (`...noopTrace` +
   4 log methods) only so module singletons can type a field as `AgentTrace`.
   Corrected count this pass: **36** files import `createChannelTrace` (35 as
   the `const logger = createChannelTrace('X')` module-logger idiom) — _not_
   the "~210" the runtime reader estimated (that grep over-counted; the direct
   census is 36 importers / 71 total occurrences). `logUtils.ts` /
   `redaction.ts` themselves are a thin, justified `console`/OutputChannel
   wrapper — **keep**. The removable layer is only the `createChannelTrace`
   -as-logger idiom (add a `createChannelLogger(name)` over the existing
   `createChannelWriter`). Already tracked (`2026-05-17-logger-simplification-feasibility.md`).

6. **The core cycle flows reach into the ambient runtime + auth singletons**
   _(strategic; partly documented, not a defect — but the coverage gap is real)_.
   The core reader's central SDK-readiness finding: `createResponseCycleFlow()` /
   `createToolUseRoundFlow()` cannot be imported and driven in isolation
   because `CommonCycleTypes.ts:103,121`, `ResponseCycleFlow.ts:215`, and
   `RetryState.ts:275,126` reach `useLaunchRunContext()` and
   `@auth/SupabaseClient` directly. **Accuracy correction (Codex review, P2):**
   `core/README.md:29-41` blesses a _narrower_ set than an earlier draft of this
   entry implied — only the **`type`-only** `AgentRuntimeHost`/`StreamStatusMachine`
   imports in `BaseFlowServices.ts`/`RetryState.ts` and `RetryState.ts`'s
   `@auth/SupabaseClient` auth-refresh call. The **value** `useLaunchRunContext()`
   edges in `CommonCycleTypes.ts` / `ResponseCycleFlow.ts` (and
   `RetryState.ts:275`'s `runScope` read) are **not** documented there, so they
   are a genuinely _undocumented_ ambient-runtime coupling — treat them as a real
   boundary gap to close, not a waived one. All of it stays host-agnostic (no
   `vscode` / `packages/*`), but it is the load-bearing obstacle to an
   importable-and-runnable cycle. The fix, _if/when_ the SDK boundary hardens, is
   to thread `runScope` + a `refreshCredential` port through the services object
   (and to extend the `core/README.md` note to cover — or forbid — the
   `useLaunchRunContext()` value edges); strategic, gated.

7. **Minor structural / correctness notes** _(LOW; record only)_.
   (a) `support/AnthropicStreamHandler.ts` (Anthropic-only) and
   `support/moonshotRequestParameters.ts` (Kimi-only) are misfiled under the
   README's "cross-provider" `support/` invariant — a low-cost file move to
   `anthropic/` / `openai/`. (b) The Anthropic empty-response heuristic keys on
   the magic number `responseObject.usage.output_tokens === 3`
   (`modelHandlerAnthropic.ts:963`) — an undocumented constant that would
   silently misfire if Anthropic's accounting shifts; worth a content-based
   check. Both are behavioral/relocation changes to a provider handler — not
   unattended-safe, but cheap when a maintainer picks them up.

## Reviewed-train / strategic + adjudicated traps — held

No change from 07-12. The fan-out re-derived the standing set; rulings hold:
the `ResponseCycleNode`/`ToolUseCycleNode` `exec()→run inner flow→interpret`
wrapper (**keep** — the outer node owns real per-round orchestration; the core
reader's finding #1 "collapse the inner node graph to a turn-loop" is the
_strategic_ largest-single-structure-change item the readiness doc already
records, gated, not a blind sweep); `IModelHandler` as a "duplicate" of
`ModelHandler` (**trap** — removal breaks a real import cycle); folding the
single-caller `createResponseCycleFlow` / `createToolUseRoundFlow` into their
nodes (**keep** — this _is_ the prescribed `Node.exec() → createFlow() →
run()` shape); `runAgent`/`executeAgent` dual entry (**keep** — two documented
responsibilities); collapsing the OpenAI-compatible subclasses to a config
table (**trap** — real per-provider overrides + enum-mandated route table);
`IToolUseSession` single-impl port (**keep** — host-agnosticism seam keeping
`core/flows` off the concrete follow-up queue); `withModelClient` (**keep** —
two callers, load-bearing live-`client` getter for relay-401 rebinding). The
`Shared*` execution/subscription/status singletons → session-only ownership,
the helper-model / content-helper `runtime/` cluster relocation, the four
VS-Code-only `Platform` diagnostic ports, the `SdkToolCall` union → generic
`NormalizedToolCall`, packaging / barrels, and the minimal-embedder `Platform`
all remain **strategic/gated** exactly as the north-star sequences them.

## Minimal public surface for an external SDK consumer — re-measured

The runtime reader re-derived the irreducible symbol set to **start a run and
observe events**: a writable `StreamLogStore` (hard precondition —
`SessionHandle.ts` throws without it), `initializeDefaultSession` /
`SessionHandle`, `validateExecutionRequest` (`@agent/core/state/executionRequests`),
`runAgent`, `noopAgentRuntimeHost` (or a custom `AgentRuntimeHost`), and
`session.events.subscribe` / `session.onResult` — **~six symbols**. This is
consistent with the north-star's "15-module intersection" seed and its
measured "run API is already SDK-shaped". The residual friction is exactly what
the north-star's Step 2 targets: the run is coupled to a transcript-backed
session the consumer must construct and own (no "just call `runAgent` and get
an event stream back" facade), and full observation still spans three payload
vocabularies (`AgentEvent`, `SessionFact`, `AgentRuntimeEventPayloads`). The
north-star's ruling stands — shrink the ceremony by deleting host bookkeeping
into `SessionHandle`, **not** by adding a `createAgentRun()`/`runSession()`
wrapper (the readiness doc's Step-6 rejection: the `AgentConfigPayload`-vs-
`AgentConfig` type wall).

## Subagent split points — re-confirmed, gating observation unchanged

Delegation remains a **mature strategy-pattern subsystem**, not something to
build: `childRunLoop.ts` (one driver per child-run type) + the
`src/tools/delegation/` strategies (`nativeToolUseStrategy`,
`nativeWorkflowStrategy`, `workflowScriptStrategy`) + `executionRegistry`
lineage are already the SDK spawn shape (prompt/config in → `AgentFlowResult`
out, with progress/cost/resume/interrupt/lineage). Ranked split points
unchanged from `-06-26` → `-07-12`:

1. Wire the existing `review` tool-use agent as a post-draft Verifier delegation.
2. Introduce a typed `delegateTo(subagent, input, {maxDepth, tools})` over
   `childRunLoop` + `ChildRunStrategy` + `executeAgent`.
3. Formalize workflow agents (`polish` / `correct` / `merge`) as SDK actors.
4. Relocate the remaining module-global registries onto the per-session handle.
5. Decompose in-agent multi-phase workflow agents into draft → Verifier →
   apply hand-offs — gated by #4.

**Gating observation (unchanged, re-verified):** delegation depth is tracked
but never gated — there is still no `maxDelegationDepth` runtime setting
(grep: **0 hits** across `src/` and `packages/`). A real depth cap remains a
prerequisite before exposing recursive `delegateTo(...)` as a public SDK
surface (split point #2).

## Recommendation

**SDK-ready in shape; no structural refactoring warranted.** The tree is
healthy: the spine anchors hold at `1f7082f`, and — notably this pass — the
host deep-import width the north-star flagged as accelerating has **stopped
rising on the two largest hosts** (extension 49→44, CLI 35→34; desktop 27→29,
the +2 largely a census correction — desktop is the only host with dynamic
`@agent` imports, see the boundary table) with core→host violations still 0, so
the erosion the north-star flagged is no longer accelerating under the
maintainers' consolidation train. **One cleanup was applied this pass:** the private, non-exported,
single-use `TextConnectionService` interface inlined into
`ResponseCycleServices` (−2 LOC), verified type-safe (all six configs) +
lint-clean + the one relevant suite green. The pass otherwise found no
unattended-safe cleanup — three candidates were verified false positives
(`followUpResumeDetection`, `IToolRegistry`, `RetryableInvocationNode`, all
crossing `packages/**` or a tested seam via the recurring `src/`-only-grep
error), and every remaining item is reviewed-train (`ModelHandler`
decomposition, the `OpenRouterNative` message-shape re-implementation, the
`agentRegistry` migration cluster, the logger dual front-door, the `support/`
misfiling) or strategic/gated (message opacity → neutral transcript, the
core→ambient edges, the `query()`-alignment options-bag tension). Do not
re-open the traps; do not re-flag `followUpResumeDetection`, `IToolRegistry`,
or `RetryableInvocationNode`; do not sweep the reviewed-train items unattended.

## Verified (this checkpoint)

- Spine re-confirmed at HEAD `1f7082f`: `createModelHandler` +
  `PROVIDER_HANDLER_ROUTES` (`ModelFactory.ts:427`,`:73`), `IModelHandler` =
  `Pick<ModelHandler>` (`src/agent/types/IModelHandler.ts:41`),
  `src/agent/core/index.ts` **absent** (no barrel regression),
  `emitRuntimeEvent` **retired** (sole grep hit is
  `sessionFactAmbientHelperRetirement.vitest.ts`), `RunScope.ts:16-19` carries
  `readonly` `streamId`/`executionId`/`agentName`, `Node.exec → createFlow().run`
  intact (`ResponseCycleNode.ts:103,117`; `ToolUseCycleNode.ts:91,138`), six
  `getRunContext*` accessors present (`RunContext.ts:176-227`).
- Applied cleanup verified: `TextConnectionService` inlined into
  `ResponseCycleServices` (`CycleServices.ts`); `npm run typecheck` exit 0 (all
  six project configs), `eslint` clean on the file, and
  `TextConnectionHelperModel.vitest.ts` green.
- False positives verified in-tree: `followUpResumeDetection` imported at
  `followUpCommand.ts:13` with a dedicated `.vitest.mts`; `IToolRegistry` sole
  `implements` is `MapToolRegistry` (`ToolTypes.ts:42`), on the `core/flows` →
  tools edge; `RetryableInvocationNode` driven by a test subclass in
  `RetryState.vitest.ts`.
- Boundary metric recounted at `1f7082f`: distinct `@agent/*` deep-import
  specifiers (static `from` + dynamic `import()`) — extension **44**, CLI
  **34**, desktop **29** (north-star baseline 49/35/27). Desktop has 5 distinct
  dynamic `import('@agent/…')` specifiers, 2 of which (`runAgent`,
  `helperModelName`) are not among its 27 static `from`-imports; extension/CLI
  have 0 dynamic `@agent` imports (static == complete). `src/**` →
  extension-homed / `@cli` / `@desktop` alias imports: **0**.
- Logger census corrected: `createChannelTrace` importers **36** (35 as the
  module-logger idiom), 71 total occurrences — not ~210.
- Delegation depth verified still tracked-but-ungated (no `maxDelegationDepth`,
  0 grep hits across `src/` + `packages/`).
- This checkpoint is added under `docs/proposals/`, an internal directory
  excluded from the texra.ai publish allowlist — not a root-level doc.
