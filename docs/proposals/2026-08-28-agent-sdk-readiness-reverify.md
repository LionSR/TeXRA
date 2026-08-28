# Agent-SDK readiness — re-verification pass (2026-08-28)

> **Status:** Written 2026-08-28 against branch HEAD `9acfdf6`
> (`refactor: simplify the multi-agent dispatch code`, #11526). The scheduled
> audit routine re-ran the standing question — "review the agent core, model
> handler, logger, and surface for unnecessary abstraction and unready surface;
> design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the most recent prior pass
> ([`-08-25`](./2026-08-25-agent-sdk-readiness-reverify.md), written at
> `51c04c6`, whose §4a/§4b removals landed at maintainer request in its §8). Like
> `-08-25`, this pass re-derived the verdict from **four fresh, independent area
> audits** (core, model handlers, logger, surface + subagents) rather than a diff
> of the prior entry. It reached the **same top-line verdict by an independent
> route — the alignment holds** — and this pass is **purer than `-08-25`**: it
> surfaced **no clean shovel-ready removal** of the `-08-25 §4a` (dead `export`)
> kind. Every marginal candidate the four audits raised is either a design-gated
> public-surface decision (a Tier-1 manifest choice, not a mechanical move) or a
> single-caller that an independent unit test or a cross-module export legitimately
> keeps. **Nothing was landed** — consistent with the routine's default and,
> unlike `-08-25 §8`, with **no maintainer request** on this scheduled run. Every
> claim below carries a `file:line`, config path, or count checked at `9acfdf6`.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, and no structural refactor is warranted.** The pass-through wrappers,
convenience barrels, and single-caller factories the standing question hunts for
are, save the design-gated and test-anchored exceptions in §4, not present. The
core audit's phrasing this pass is the honest summary: "there are **no
pass-through 'create state → run flow → return' wrappers** of the kind CLAUDE.md
bans — every candidate that looked like one does real work." The exemplary deep
modules the prior passes named — `ModelCell`, `SessionEventHub`, `PersistedFlow`,
`RoundPersistedFlow`, `childRunLoop`/`ChildRunStrategy`, `ModelInvocationNode` —
each re-verified as untouched-in-shape at HEAD and each still something you would
keep designing from scratch.

Two measured facts moved in the readiness-positive direction since `-08-25`: the
model-handler base class shrank a further 11 lines (§1), and the `-08-25 §8`
removals stayed removed. No frozen deep-import list widened; the SDK package's
7-specifier floor and the three entry files' exports are unchanged.

## 1. Every `-08-25` tracked fact re-verifies at `9acfdf6`

| Item                                | `-08-25` state (`51c04c6`)                             | `9acfdf6` state                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **§4a** (dead logger `export`)      | landed §8 — narrowed to local `interface`              | **still narrowed.** `OutputChannelFactoryOptions` is a bare `interface` (`src/logger/logUtils.ts:48`), used only as the internal param at `:198`. No `export`. |
| **§4b** (`SessionHandle` PT-2)      | landed §8 — method removed, callers re-routed          | **still gone.** `grep useHostInteractions src/ packages/` returns nothing; owners are addressed as `session.interactions.use(...)`.                            |
| **`-08-22 §8` removals**            | verified absent                                        | **still gone.** `createToolUseFollowUpMessages` / `createAssistantMessageForPrefillText` return no base definition in `modelHandlers/`.                        |
| **L-3** (dead redaction branch)     | closed; `redactSecrets` single-arg                     | **still closed.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:81`); no options branch.                                    |
| **§7 Tier-1 doors**                 | 4 of 8 landed (`export`/`review`/`templates`/`followUp`) | **present & stable.** `src/agent/{export,review,templates,followUp}/index.ts` all exist.                                                                       |
| **M-3** `ModelHandler.ts` god-base  | 2,043 LoC                                              | **2,032 LoC** (`wc -l`); −11 further. Genuinely shared behavior, no per-provider copy-paste (README's "shared, not duplicated").                               |
| **Provider-type-leak floor**        | `M`/`T` leak all four provider SDKs                    | **unchanged.** `src/agent/types/ProviderMessage.ts:4-8` still imports message types from `@anthropic-ai/sdk`, `@google/genai`, `openai`, `@openrouter/sdk`.   |
| **Node flow engine**                | 159 LoC, `BaseNode`/`Flow` only                        | **159 LoC** (`src/agent/node/index.ts`); still exactly `BaseNode` + `Flow` (single `export` at `:159`). Matches CLAUDE.md.                                     |
| **Version**                         | 0.40.5 (short of the v0.41 `runFact.` gate)            | **0.40.6.** Advanced one patch; still short of the v0.41 retirement gate. Retirement not yet due.                                                              |

## 2. Frozen host deep-import width — held on every host, floor intact

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*` deep-import
specifiers per package, past the `@agent` barrel):

| Package             | `-08-25` | `9acfdf6` |
| ------------------- | -------- | --------- |
| cli                 | 8        | **8**     |
| desktop             | 5        | **5**     |
| extension           | 9        | **9**     |
| agent (SDK package) | 7        | **7**     |

No host widened; none shrank this window either. The set-based ratchet still
forbids any new edge and fails on stale headroom, so the lists can only shrink or
hold; the "never widen a baseline" invariant remains structurally enforced.
`agent`'s 7 remains at its realistic floor, bounded by the provider-type-leak
constraint (§5.2). The window's commits (§6) are dominated by refactor,
deduplication, bug-fix-by-reading, and test-consolidation — none add a wrapper
layer or widen a baseline.

## 3. Subagent boundaries — still drawn, still mature (re-confirmed by two audits)

The subagent boundary is a **shipped, multi-implementor SPI, not a design task** —
re-confirmed independently by both the core and surface+subagent audits at HEAD.
The isolation primitive is the **`executionId` + lease + `ChildRunStrategy`**, not
the flow:

- **Contract:** `ChildRunStrategy<TTurn>` over the generic driver
  `startChildRunLoop` (`src/agent/runtime/childRunLoop.ts:759`) — the single owner
  of the follow-up queue, one interrupt target per child lifetime, per-turn
  delivery choreography, cost retention, and the terminal finalizer.
- **Recursion-closing seam:** the `AgentEngine` runtime slot, filled at
  `src/tools/delegation/nativeSubagentStrategy.ts`, breaking the
  `registry → DelegationTools → executeAgent → registry` cycle.
- **Independent implementors** driving the one loop: in-process TeXRA agent
  (`nativeSubagentStrategy.ts`, `inBandSubagentExecution.ts`), workflow-script
  children (`src/agent/workflowScript/` + `delegation/workflowScriptStrategy.ts`,
  the multi-agent dispatch #11526 simplified), external agent CLIs (Claude / Codex,
  behind per-session registries `src/tools/agentCliSessionStores.ts`), and
  background bash.

The honest six-candidate mapping is unchanged. **`reflection` and `tooluse` are the
`agentCategory` dispatch axis inside one run** (`executeAgent.ts` branches on
`setting.agentCategory`), not separate agents — they are the *body* of an
execution, sharing its lease, `TaskState`, follow-up queue, and interrupt handler;
splitting one out would duplicate the lifecycle `childRunLoop` already owns.
**`followUp` and `goal` are substrate**; **`review` is a support library behind a
tool-use YAML agent**; **`roster` (`AgentRosterController`) is the
which-agents-are-visible selection policy**, not a run agent; **`remote`
(`RemoteAgentLoader`) is an auth+network config loader** the SDK deliberately
excludes (`includeRemote: false`).

**Only `agentCreator` remains the one genuine "logical agent not yet running as
one"** — a single linear `runAgentCreator`
(`src/agent/implementations/agentCreator/agentCreatorFlow.ts:437`, single
production caller `agentCreatorCommands.ts:184`) that runs inline in the extension
host through the `AgentCreatorUI` port, not through `runAgent`/`ChildRunStrategy`,
and is the deepest surviving host deep-import specifier. That boundary stays open
**correctly**: closing it is interactive-UI design work (modelling the
`AgentCreatorUI` name/description/add-to-config prompts as structured tool I/O),
not a mechanical move. The surface audit adds one smaller observation: the
**helper-model one-shots** (`src/agent/runtime/helperModel.ts` — session
description, text enhancement/connection, agent-creator generation) are
clean input→text micro-boundaries coupled only through `currentSession()` model
resolution. They are a legitimate future "utility LLM sub-session," but not a
defect and not the SDK-readiness bottleneck — recorded, not actioned.

## 4. New this pass — no clean removal; four design-gated / test-anchored notes

Unlike `-08-25 §4a/§4b`, this pass surfaced **no behavior-preserving removal that
is both mechanical and surface-neutral**. Each candidate the four audits raised is
recorded here with the reason it is *not* a shovel-ready land:

### 4a. `schemas.ts` is the widest internal-shaped public surface (manifest-gated)

`packages/agent/src/schemas.ts` re-exports the entire on-disk agent-definition Zod
graph — `AgentDefinitionSchema`, `AgentPromptSchema`, `AgentSettingSchema`,
`AgentToolUseSettingSchema`, `AgentWorkflowSettingSchema` and their inferred types
(`schemas.ts:11-24`) — plus branded id schemas from `@shared/schemas`
(`StreamTabId`, `ExecutionId`, `AgentName`, `AgentSource`; `schemas.ts:34-49`).
These mirror the persisted YAML/dataclass format an embedder calling
`runAgent({ agent: 'name', … })` never needs. **This is the single largest Tier-1
narrowing target**, and narrowing it would let `@agent/core/definition/AgentDataclass`
(and possibly `@agent/core/tools/ToolTypes`) drop off the frozen `agent`
deep-import list (§2). Note an inconsistency worth resolving in the manifest
design: `index.ts` deliberately re-declares `streamId` as plain `string` to keep
the `StreamTabId` brand out of the emitted `.d.ts`, yet `schemas.ts` publishes
`StreamTabId`/`StreamTabIdSchema` directly — the two entry points disagree on
whether the brand is public. **Not mechanical**: choosing what an external
consumer may import is a manifest decision, not a scheduled-run edit.

### 4b. Tool-registry export trio is internal-shaped (surface decision)

`index.ts:41-46` exports `IToolRegistry`, `ToolHost`, and the concrete
`MapToolRegistry`, but the public run path only accepts
`tools?: readonly ITool[]` (`index.ts:80`) and `runAgent` builds the registry
itself — a custom-tool author needs only `ITool` + `defineTool` + `DefinedToolClass`
(`index.ts:47-48`). The trio are drop candidates for a Tier-1 manifest, but that is
a public-surface change (a manifest decision), not a mechanical removal.

### 4c. `AgentRunStream`'s reader queue is over-general (judgment-call collapse)

`AgentRunStream` (`packages/agent/src/index.ts:106-219`) is a hand-rolled
push-based async-iterator. The stream is documented single-consumer and
`[Symbol.asyncIterator].next` cannot be re-entered until its promise settles, so
`readers: Array<…>` + `shift()`/`splice(0)` models a queue that is always length
≤ 1; a single `p-defer` deferred (already a dependency) expresses it directly. This
is behavior-preserving and internal (the class is not exported, only the `AgentRun`
interface is), but it is a judgment-call rewrite of intricate iterator
concurrency, not a delete — recorded for a maintainer's ruling, not landed
unbidden into the green tree.

### 4d. Marginal single-callers that legitimately stay

The audits enumerated several single-production-caller symbols; each has a reason
to keep that a scheduled run must respect:

- `utils/toolCallAccumulator.ts` — single production caller
  (`utils/channelStreamAggregator.ts`) **but carries its own unit test**
  (`ToolCallAccumulator.vitest.ts`), a legitimate module boundary.
- `runReflectionAgent` (`executeAgent.ts:238`) — single caller (`:487`), but its
  symmetry with the two-caller `launchToolUseRun` is a real readability reason;
  low-value to inline.
- `disposeAgentChannel` / `createChannelWriter` (`src/logger/logUtils.ts`) —
  single- and two-caller respectively, but both are **cross-module exports** to
  `src/agent/trace/channelTrace.ts`, so neither is dead or removable; their
  "protocol-neutral" docstring framing is stale but harmless.
- `ModelHandlerDashScope` (`openai/modelHandlerDashScope.ts:11`) — a near-empty
  subclass (one `convertContentToString = true` flag override), but its class name
  is the **compatibility key** `ModelFactory` uses to persist conversation format
  (`ModelFactory.ts:116-121`); data-driving it off `config.provider` requires
  preserving that key by other means first — not a free collapse.

## 5. Remaining open items (carried forward, none a defect)

1. **Model-handler port shape (forward-looking).** The public `IModelHandler` port
   is a derived `Pick<ModelHandler<…>>` (`src/agent/types/IModelHandler.ts:27-77`) —
   the correct anti-drift choice internally (it cannot diverge from the base), but
   a _public_ SDK would want the port defined **intrinsically**. The port is also
   parameterized over provider SDK message/usage/client types, which surface in
   method signatures and are safe **only** because consumers instantiate the
   generics as `ProviderMessage`/`unknown` (`ModelCell.ts`) and `ModelFactory`
   lazy-`import()`s the concrete handlers — the safety rests on lazy-import
   discipline, not the type system. A manifest-design note, not a defect.
2. **Provider-SDK type leak (`M`/`T`) is the floor on `agent`'s 7 specifiers.**
   `T` is load-bearing (`call.raw` read at `ToolUseDispatchNode.ts` display-fallback
   sites) and must route through a handler method before it can be quarantined.
   `scripts/validate-artifacts.mjs` (the main-entry `.d.ts` graph guard for
   `@anthropic-ai/sdk`, `@google/genai`, `@openrouter/sdk`, `openai`) already keeps
   the built package clean; the constraint is on whether `IModelHandler` can ever
   be a public export.
3. **Logger + telemetry are process-global singletons with no public plug point.**
   The SDK-correct unlock is injectable owners (a `Platform.log` port + a `UsageSink`
   port) behind Tier-1 `configureLogging` / `configureUsage` doors — specified in
   `docs/prds/2026-05-06-prd-logger-v2.md`, deliberately deferred behind
   singleton-retirement. The logger surface is otherwise browser-safe and minimal;
   the dual public entry (`createLog` vs the free `debug/info/warn/error`) is a
   confirmed style-only duplication with **no** surface reduction available (the
   free functions are the `loggerSelf` test-spy seam and are re-typed by extension
   ports), so it is not a simplification target.
4. **Two open Tier-1 doors remain** (four of eight landed): fronting
   `agentCreatorFlow` (its deepest specifier; blocked on the interactive
   `AgentCreatorUI` design, §3), and a `core/state` door (blocked because a
   _dynamic_ `import()` the ratchet counts would leave the leaf live for zero
   ratchet gain).
5. **`HostInteractions` required/optional (north-star TD-2a).** Open maintainer
   contract decision, not a mechanical cleanup. The public shape stays deliberately
   minimal (`cancel()` only) until the approval channel has a stable contract. Both
   `index.ts`'s reduced `HostInteractions` (`:69-71`) and its plain-`string`
   `HostInteractionCancelSelector` (`:57-61`) are deliberate hand-narrowings that
   keep the full interaction graph and the `StreamTabId` brand out of the emitted
   declarations — intentional, and part of this same manifest decision, not
   drift to collapse.
6. **Result-taxonomy documentation.** An external consumer meets three result
   shapes — `AgentFlowResult` (discriminated `workflow | toolUse`),
   `AgentFinalResult` (adds `diffs`/normalized `cost`, the persisted journal shape
   consumed by `subagentResults.ts` / `storage/resultMeta.ts`), and the
   non-terminal `WAITING` state. The transforms are real (not delete candidates);
   documenting _why_ `WAITING` exists and _why_ `cost`/`diffs` land only on the
   final is the single largest "which result do I get?" clarification the surface
   needs. `AgentFlowResult`'s dual re-export from both `index.ts:50-54` and
   `schemas.ts:29-33` is a minor by-product to fold when the two entry points'
   manifests are settled.
7. **Publication** remains gated on the named-external-consumer hold; the legal
   side cleared in a prior window. The gate is consumer-driven, not legal-driven.

## 6. Merges since the `-08-25` pass (through `9acfdf6`)

The window (~50 commits dated on/after 2026-08-25; `51c04c6` is not in this
checkout, so the range is characterized by log inspection rather than a diff) adds
no wrapper layer. It is dominated by refactor-collapse, deduplication,
bug-fix-by-reading, and test-consolidation — consistent with the standing trend.
Relevant to the audited areas:

- **Multi-agent dispatch** — `9acfdf6` (#11526) simplify the multi-agent dispatch
  code, six defects fixed, recorded in
  [`2026-08-28-simplification-survey-multi-agent-dispatch.md`](./2026-08-28-simplification-survey-multi-agent-dispatch.md);
  the `workflow` series `42baa71`/`683cb58`/`605331f`/`f24078b` reshape
  plan-vs-issued-calls and phase legibility.
- **Bug-fix-by-reading** — `0d0eaca` ten runtime bugs in the flows/nodes;
  `f77a9c0` CLI; `ae14d2f` extension; `26d9e0d` shared; `d9c97e4` made four
  swallowed failures loud, including a Zod `.catch` on persisted data (the
  silent-degradation rule enforced).
- **Refactor-collapse** — `683990d` inline reflection support-file collection;
  `6fa2f8a` fold missing-output invalidation; `9784610` finish the
  storage-transition cleanup; `af31933` simplify complexity-audit data structures;
  `1fcffda` drop dotenv and duplicate stable-stringify; `49ae46e` swap four
  hand-rolled clamps for `@utils/core` clamp.
- **Test-consolidation** — `79635ec`/`5af964e`/`c8d1b28`/`d522fdf`/`f995c70` etc.,
  one-owner-per-component consolidation, no churning-seam pins added.

## 7. Bottom line

Six consecutive passes (`-08-19` through `-08-28`) now find a green top-line
verdict, this one re-derived from four fresh independent area audits. This pass is
**cleaner than `-08-25`**: where that pass had two genuine shovel-ready removals to
record (and later land at maintainer request), this one has **none of that kind**.
Every marginal candidate the audits raised is design-gated — the `schemas.ts` /
tool-registry public-surface narrowings are Tier-1 manifest decisions, and the
`IModelHandler` intrinsic-port and injectable-logger/usage-port items are the same
open decisions carried since `-07-09` — or is a single-caller an independent test
or a cross-module export legitimately keeps. The one internal, behavior-preserving
collapse (`AgentRunStream`'s length-≤1 reader queue → a `p-defer`, §4c) is a
judgment-call rewrite of intricate concurrency, recorded for a ruling rather than
pushed. The subagent boundary is unchanged and mature; `agentCreator` remains the
one genuinely inline agent-shaped unit, open for the right (UI-design) reason.
Nothing found is a defect; nothing warrants a speculative edit into the green tree
absent a maintainer request — and this scheduled run carries none, so, matching the
routine's default and the pure-green passes before `-08-22`, it records and stops.
