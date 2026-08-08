---
created: 2026-08-08
---

# Agent-SDK readiness re-check (agent core · model handler · logger · surface)

> **Status:** Audit note. Written 2026-08-08 from four parallel evidence passes
> (agent core, model handlers, logger/trace, package surface), every claim
> backed by `file:line`. This is a _current-state_ re-measurement, not a new
> plan. It continues the daily/near-daily checkpoint series — read alongside the
> immediately prior
> [`2026-08-03-agent-sdk-readiness-checkpoint.md`](./2026-08-03-agent-sdk-readiness-checkpoint.md)
> and the base audit
> [`2026-07-25-agent-sdk-readiness-audit.md`](./2026-07-25-agent-sdk-readiness-audit.md),
> under the plan of record
> [`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md).
> Its job is to confirm whether the standing conclusions still hold and to flag
> what is new. Nothing here overrides a maintainer ruling, reopens the retired
> package-fence / `RunDescriptor` / `ModelCell` / `RetryGate` proposals, or
> proposes splitting the deliberately-flat `runtime/` directory.

## Verdict

**Well-aligned. No large structural refactor is warranted.** The four named
areas remain converged on the Claude-Agent-SDK shape, and the `config/ratchets/`
guardrails plus the free-zone import fence are holding. This re-check reproduces
the standing conclusion of the `-05-29 → -08-03` chain with fresh citations and
adds **four small, concrete, non-urgent deltas** the prior checkpoints had not
yet named — two of them net-negative cleanups, since landed in this PR (§3-A,
§3-C); one deferred to a focused follow-up (§3-B); one narrowed down to a stale
comment plus a genuine pre-publish decision (§3-D). None is a removable
"wrapper layer"; the abstractions this task asked us to hunt for are, once
again, mostly justified boundaries.

The one genuinely structural obstacle to a package cut is unchanged and remains
the intra-`agent` dependency web documented as finding #1 of the
[2026-07-25 audit](./2026-07-25-agent-sdk-readiness-audit.md) — not addressed
here because it is only worth inverting _if and when_ a real `@texra/core`
extraction is pursued.

## 1. Area confirmations (fresh evidence)

- **Agent core.** Launch is single-entry: `runAgent`
  (`src/agent/runtime/runAgent.ts`) mints the `executionId` and registers;
  `executeAgent` is the lower-level path for callers that already own the id,
  and `runAgent`'s options are `Pick`ed from `ExecuteAgentOptions` so they
  cannot drift. The flow engine (`src/agent/node/index.ts`, ~250 LoC) is the
  sole local `BaseNode`/`Node`/`Flow` definition — no upstream layer to
  collapse. `agentCreator/` is correctly one linear `runAgentCreator` function,
  importing none of `BaseNode`/`Flow`. No wrapper-only forwarder found **except**
  the `SessionHandle.useHostInteractions` pass-through in §4 below (already
  tracked as PT-2).
- **Model handlers.** Unusually well-consolidated. `toolConversion.ts` owns every
  provider shape-map (providers call in, none re-implement); usage normalization
  is config-driven through `support/UsageNormalizer`; SDK-error tagging is a thin
  per-provider adapter over one shared matcher; the OpenAI-compatible inheritance
  ladder is thin and each concrete handler carries real provider quirks, not
  base-URL stubs. `ModelFactory`'s `PROVIDER_HANDLER_ROUTES` is an exhaustive
  `Record<ModelProvider,…>` that fails typecheck on a missing arm. One removable
  leak found (§3-C).
- **Logger / trace.** The run-vs-session split is respected: run facts live only
  on `AgentEvent`, `SessionFact` explicitly excludes them, and all five
  `appSignals.emit` sites are within AppSignals' documented app-lifecycle scope —
  **no stray `bus.emit` from a VS Code-free zone.** No `default: return` event
  drops; the `catch {}`-shaped blocks in scope are the sanctioned
  diagnostic-guard exception (each wraps only a `logger.warn` with an explanatory
  comment), not the silent-degradation defect. `platform().log` has 0 call sites
  under `src/agent` — agent logging flows through trace/channel as intended.
- **Surface.** The `@texra-ai/agent` run surface still mirrors the Anthropic
  `Query` pattern one-for-one (`runAgent(input): AgentRun`, `AgentRun extends
AsyncIterable<AgentEvent>` + `result`/`interrupt`, six-field `RunAgentInput`:
  `platform`, `agent`, `instruction`, `interactions`, optional `model`/`tools`).
  The host-layer import ban is airtight (`eslint.config.mjs`), composition-root
  discipline holds (single guarded `initPlatform`), and approval-requiring tools
  are refused at the boundary. Every ratchet's `semantics` field states the
  never-widen invariant explicitly.

## 2. Subagent boundaries (task step 4) — already designed and shipped

Unchanged from the July/August findings: the "logical units that could run as
independent agents" already exist as first-class runtime concepts, so there is
nothing to newly carve out. `childRunLoop`'s `ChildRunStrategy<TTurn>`
(`src/agent/runtime/childRunLoop.ts`) unifies all four child-run types
(agent-CLI codex, agent-CLI claude, native subagents, workflow-script) behind one
driver; its `launch` / `runTurn` / `resolveDeliveryTarget` / `buildResultMeta`
seams _are_ the independent-agent units. Lineage lives on the handle
(`ExecutionHandle`), detach policy is single-sourced (`detachSubagentsOnStop`),
and `AgentRosterController` (`src/agent/roster/`) is the multi-agent roster. The
one tangle is that subagent _delivery formatting_ lives in `@tools/delegation/*`
but is driven from `runtime` and `core/flows` — the same intra-`agent` edge as
the structural obstacle above, not a new boundary to invent.

## 3. New deltas since 2026-08-03 (small, concrete, non-urgent)

### A. Ratchet blind spot: `packages/agent/src` is not scanned for `@agent/*` deep-import width — NEW

> **Update (landed this PR):** the `agent` package is now a scanned member of
> `host-agent-import-baseline`, snapshotted at its current 10 distinct `@agent/*`
> specifiers, so the SDK barrel's internal-coupling width can only shrink.

`host-agent-import-baseline` is the ratchet that freezes each host's distinct
`@agent/*` deep-import specifier count (cli 31 / desktop 25 / extension 34). Its
enforcement test scans only the three host packages —
`hostAgentDeepImportRatchet.vitest.ts:35-39` lists `cli`, `desktop`, `extension`
and **omits `packages/agent/src`**. That is the one package destined to _become_
the published SDK, and its public barrel reaches 10 distinct `@agent/*` deep
specifiers (`packages/agent/src/index.ts:2-13`: `@agent/trace`,
`@agent/runtime/{ExecutionHandle,AgentFlowResult,HostInteractions,SessionHandle,runAgent}`,
`@agent/core/tools/ToolTypes`, `@agent/core/definition/{AgentConfig,AgentDataclass}`,
`@agent/index/agentRegistry`) plus `@platform/*`, `@tools/*`, `@transcript/*`
leaves — all currently un-ratcheted and unmeasured. **Recommendation (low-risk):**
add `'agent'` to the `HOSTS` tuple (not just `HOST_DIRS` — `collectCurrentHosts()`
and every `it.each` case iterate `HOSTS`, so `HOST_DIRS` alone leaves the new
entry unscanned), extend `HostBaseline.hosts`, and snapshot the current count, so
the SDK barrel's internal-coupling width can only shrink. This is the surface a
Tier-1 manifest must eventually re-export or seal; freezing it now costs nothing
and prevents silent widening.

### B. `@shared/schemas` `forced` bucket — highest-leverage barrel shrink — NEW (actionable)

> **Deferred to a focused follow-up PR.** Widening the barrel with `export *`
> across 10 layered modules (incl. the 87-symbol `toolResult`) needs
> collision-checking and correct layer placement, and the `gratuitous` bucket
> recomputes against the live barrel at test time so the ratchet baseline must
> be regenerated in the same PR. That is its own reviewable change, kept out of
> this structural PR.

`shared-schemas-deep-import-baseline.json` records **10 `forced` specifiers /
~182 statements** — production code forced past the `@shared/schemas` barrel only
because the barrel does not re-export those leaves:
`agentPresets(14)`, `agentSkills(4)`, `codex(4)`, `coreSettings(14)`,
`historyViewMessages(3)`, `opResults(11)`, `profileViewMessages(24)`,
`stateSettings(15)`, `toolResult(87)`, `workflowScriptFiles(6)`.
Re-exporting these ten wholesale would reclassify all ~182 statements at
ratchet-measure time — `toolResult` alone (87) is nearly half the bucket — but
is **not** simply mechanical: `index.ts:49-53` deliberately keeps
`historyViewMessages` and `profileViewMessages` off the barrel, re-exporting
only selected consumer-facing symbols through the canonical
`settingsViewMessages` entry point, so a blanket `export *` for those two would
undo that curated boundary. `forced` proves a name is absent from the barrel,
not that every export in the leaf belongs there. The real follow-up is
per-leaf: `export *` for the eight leaves with no existing curation, and a
deliberate symbol-selection (or caller migration) for the two that are
intentionally narrowed.

### C. `isOReasoningModel` sits on the host-agnostic base but is OpenAI-only — NEW (net-negative cleanup)

> **Update (landed this PR):** relocated from `ModelHandler` to
> `OpenAICompatibleModelHandler` (the common ancestor of all four callers),
> removing one provider-identity concept from the host-agnostic base with no
> behavior change (724 model-handler tests green).

`ModelHandler.isOReasoningModel` (`src/agent/modelHandlers/ModelHandler.ts:924`)
hard-codes `config.provider === ModelProvider.OPENAI` and has **zero non-OpenAI
readers** — every caller is inside `openai/`
(`modelHandlerOpenAI.ts:291,306,637`, `modelHandlerOpenAIResponse.ts:1550`).
Moving it into `OpenAICompatibleModelHandler` — the only class common to all four
readers; `ModelHandlerOpenAIResponse` extends `OpenAICompatibleModelHandler`
directly and is a sibling of `ModelHandlerOpenAI`, not its subclass, so
`ModelHandlerOpenAI` alone would leave `modelHandlerOpenAIResponse.ts:1550`
without access — removes one provider-identity concept from the core base
class. This exact layering angle was raised but left open in the
[2026-07-02 checkpoint](./2026-07-02-agent-sdk-readiness-checkpoint.md); it is a
clean net-delete from core, not a behavior change. (The other base-class provider
comparisons are _not_ silently removable, though the paper trail differs per
site: `ModelHandler.ts:778` (`supportsReasoningLevelOverride`) carries its own
`#7101` combinator note; `:295` (`isOpenAIProvider`) and `:913`
(`getStreamingConfig`'s `ModelProvider.OTHERS` check) have no comment of their
own but fall under the general `#7101` triage-complete note at `:723-728`,
which states every remaining predicate was reviewed and kept. They remain the
layer's residual core-leak surface for a future interface-first provider port,
listed here only for the record.)

### D. Public `AgentEvent` union carries TeXRA-specific arms, and one doc comment is stale — NEW (pre-publish decision)

`events.ts:258-263` documents the `domain` escape hatch as the mechanism that
keeps host-specific events "out of the agent-general union… Keeps the union clean
for SDK consumers," and its own example list still names `missingOutputs`. But
that comment predates a later, deliberate decision: `runFactEvents.ts:15-19`
states plainly that "durable run facts ride the run trace as explicit
`AgentEvent` arms… producers no longer encode them through the `domain` escape
hatch." `RunFactEvent` (`events.ts:177-201`) is that decision implemented —
`updateTodos`, `updatePlan`, `addOutputFiles`, `updateMissingOutputs`,
`updateCompileFailures`, `goalPaused` are first-class discriminated arms on
purpose, because `RUN_FACT_EVENT_TYPES` and `SessionFactApplier.handleRunFact`
depend on those exact discriminants to drive CLI and progress-view state — not
residue to route through `domain`. So the actionable item is narrower than
"decide where these arms live": it's that the `DomainEvent` comment's
`missingOutputs` example is stale against the later invariant and should be
corrected (drop the example or note the carve-out), not a live either/or.
What remains a genuine pre-publish decision: several public arms tie their
shape to internal `@shared/schemas` host types (`RunConfigEvent.config:
AgentConfig`, `StatusEvent`), which a published `.d.ts` would drag along — that
part is real and unresolved. Flagging, not executing — a public-contract call
for the maintainer.

## 4. Already tracked — confirmed, not re-litigated

These reproduce with fresh citations but are known and owned; recorded so this
checkpoint is not mistaken for discovering them:

- **`SessionHandle.useHostInteractions` per-concern pass-through**
  (`SessionHandle.ts:656-658`) contradicts the class's own "address each owner
  directly" contract — already tracked as **PT-2** in the tech-debt and
  SSOT-consolidation proposals. Sanctioned net-delete; the package itself
  (`index.ts:241`) uses the wrapper, so worth clearing before freezing the SDK
  surface. ~90 call sites, mostly tests.
- **Package-boundary type twins** — public `HostInteractions` /
  `HostInteractionCancelSelector` (`packages/agent/src/index.ts:36-50`) are
  hand-narrowed copies of the runtime types (`HostInteractions.ts:237-243,275-322`)
  rather than `Pick`/`Omit` derivations, so they can silently drift; `AgentFlowResult`
  is re-exported from both `index.ts:29-33` and `schemas.ts:29-33`;
  `PendingInteractionKind` is aliased in two independent spots. All are minor
  pre-publish surface tidy-ups, valid to defer until the Tier-1 manifest is drawn.
- **`AgentRunStream` (114 LoC) lives in the public `index.ts`** — internal
  event-pump glue that could move behind `@agent/runtime`, leaving `index.ts` a
  thin manifest. Cosmetic; no contract impact.
- **`IModelHandler` is `Pick<ModelHandler<…>>`, not an independent port**
  (`IModelHandler.ts:35-86`) — structurally, any object or unrelated class that
  satisfies the resulting member shape works; TypeScript does not require
  literal inheritance. What's coupled is the _type declaration_: the port's
  signatures are pinned to the base class's, so a base-class member rename or
  retype ripples into the port, and building a truly independent provider means
  reproducing ~40 picked signatures by hand rather than inheriting them for
  free. Deliberate drift-proofing per the docstring; the standing decision
  (2026-07-25) is _not_ to demote base-default members to an optional
  sub-interface. Recorded as the structural fact an interface-first provider
  SDK would eventually confront, not an action item.
- **TD-2(a)** (making `HostInteractions` request methods required) — retired with
  evidence in the [2026-08-03 checkpoint §7](./2026-08-03-agent-sdk-readiness-checkpoint.md);
  the optional-with-graceful-decline shape is the shipped minimal-host contract
  the npm package depends on. Not reopened.

## 5. Bottom line

Agent core, model handlers, logger/trace, and the package surface remain aligned
with the Agent-SDK direction; the guardrails are holding and, where measured,
still tightening. There is no unnecessary abstraction to remove beyond the
already-tracked PT-2 pass-through, and no subagent boundary to newly design — the
`ChildRunStrategy` seams already are the boundaries. Of the four fresh items this
checkpoint named: **§3-A (SDK-package ratchet coverage) and §3-C
(`isOReasoningModel` relocation) have landed** in this PR; **§3-B (barrel
re-exports) is deferred** to a follow-up that also needs to preserve the two
curated `settingsViewMessages` leaves rather than blanket-re-exporting; **§3-D**
is narrower than originally scoped — the `domain`-routing "decision" was a false
choice (the stale `DomainEvent` comment needs a fix, not a migration) and the
one real open item is whether public event arms may keep depending on internal
`@shared/schemas` host types before publication. The remaining work continues to
belong to the packaging/legal track and the one-time intra-`agent` dependency
inversion — both already captured elsewhere — not to abstraction cleanup.

---

_Method: four parallel evidence-gathering passes (agent core, model handlers,
logger/trace, package surface), each required to back every claim with
`file:line` and grep'd caller counts and to state clean areas explicitly rather
than invent problems. Findings cross-checked against the ratchet baselines and
the prior checkpoint series; the four §3 deltas were independently re-verified
against source before recording._
