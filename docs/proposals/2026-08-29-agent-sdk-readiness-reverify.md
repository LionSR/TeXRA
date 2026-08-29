# Agent-SDK readiness — re-verification pass (2026-08-29)

> **Status:** Written 2026-08-29 against branch HEAD `e7f535c`
> (`chore: bump version to 0.40.7`, #11556). The scheduled audit routine re-ran
> the standing question — "review the agent core, model handler, logger, and
> surface for unnecessary abstraction and unready surface; simplify the API
> surface and design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the most recent prior pass
> ([`-08-25`](./2026-08-25-agent-sdk-readiness-reverify.md), written at pre-land
> `51c04c6`, whose §4a/§4b removals landed in that pass's §8 follow-up). Like the
> prior passes, this one re-derived the verdict from **four fresh, independent
> area audits** (agent core + runtime, model handlers, logger, SDK surface +
> subagents) rather than a diff of the prior entry. It reached the **same
> top-line verdict by an independent route — the alignment holds** — and, unlike
> `-08-25`, surfaced **no new removable public member**: the two `-08-25`
> removals are confirmed still gone, the model-handler base shrank a further 18
> lines, and every banned-species hunt in the runtime came back empty of
> untriaged candidates. Every claim below carries a `file:line`, config path, or
> count checked at `e7f535c`. Consistent with the routine's default absent a
> maintainer request, this pass **records** its findings and lands **no** code.

## 0. Verdict

**The standing verdict holds, for the sixth consecutive pass: the codebase is
well-aligned with an Agent-SDK shape, and no structural refactor is warranted.**
The pass-through wrappers, convenience barrels, and single-caller factories the
standing question hunts for are not present in the agent core, runtime, model
handlers, or logger. The exemplary deep modules the prior passes named —
`ModelCell`, `SessionEventHub`, `childRunLoop`, `AgentRunLifecycle`,
`ModelInvocationNode`, the two flow drivers — all re-verified as
untouched-in-shape at HEAD, and each remains something you would design the same
way from scratch. What is different this pass from `-08-25` is that there is
**nothing new even to record as shovel-ready**: `-08-25`'s two removals
(`OutputChannelFactoryOptions` export, `SessionHandle.useHostInteractions`)
stayed landed (§1), and a fresh sweep of the ~50-file runtime, the core domain
model, the flow engine, and the implementations found **zero** untriaged
instances of the banned species (§4). The measured motions since `-08-25` are
all readiness-neutral-or-positive: the model-handler base shrank 18 lines, the
frozen deep-import lists held at their floor, and the SDK entry surface is
unchanged.

## 1. Every carried-forward fact re-verifies at `e7f535c`

| Item                               | prior state                                                   | `e7f535c` state                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **`-08-25` §4a** (logger export)   | landed §8a — `OutputChannelFactoryOptions` narrowed to local | **still landed.** `interface OutputChannelFactoryOptions` (no `export`) at `src/logger/logUtils.ts:48`; sole use is its own param at `:198`. |
| **`-08-25` §4b** (PT-2 pass-through)| landed §8b — `useHostInteractions` removed                   | **still gone.** `grep useHostInteractions src/ packages/` returns nothing; callers address `session.interactions.use(...)` directly.       |
| **`-08-22` §8** handler removals   | removed                                                       | **still absent.** `grep createToolUseFollowUpMessages\|createAssistantMessageForPrefillText src/agent/modelHandlers/` returns nothing.      |
| **M-3** `ModelHandler.ts` god-base | 2,043 LoC (`-08-25`)                                          | **2,025 LoC** (`wc -l`); −18. Genuinely shared behavior, no per-provider copy-paste; every hook carries its own `#7101`/`#7465` triage note. |
| **Node flow engine**               | 159 LoC, `BaseNode`/`Flow` only                              | **159 LoC** (`src/agent/node/index.ts`); unchanged. Matches CLAUDE.md's "local, not upstream PocketFlow" note.                             |
| **Provider-type-leak floor**       | `M`/`T` leak all four provider SDKs                          | **unchanged.** `src/agent/types/ProviderMessage.ts:4-9` still imports message types from `@anthropic-ai/sdk`, `@google/genai`, `openai`, `@openrouter/sdk`. |
| **`IModelHandler` port shape**     | hand-maintained derived `Pick<ModelHandler<…>>`              | **unchanged in kind.** `src/agent/types/IModelHandler.ts:33` is still `= Pick<…>`; the anti-drift derivation, not an intrinsic port.        |
| **Version**                        | 0.40.5 (`-08-25`)                                            | **0.40.7.** Advanced two patches; still short of the v0.41 `runFact.` retirement gate. Retirement not yet due.                             |

## 2. Frozen host deep-import width — held at the floor

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*`
deep-import specifiers per package, past the `@agent` barrel):

| Package             | `-08-25` | `e7f535c` |
| ------------------- | -------- | --------- |
| cli                 | 8        | **8**     |
| desktop             | 5        | **5**     |
| extension           | 9        | **9**     |
| agent (SDK package) | 7        | **7**     |

All four held. The two-host shrink recorded at `-08-25` (desktop 6→5, extension
10→9) stuck; no host widened. `agent`'s 7 (`@agent/core/definition/AgentConfig`,
`AgentDataclass`, `core/tools/ToolTypes`, `index`, `runtime`,
`runtime/AgentFlowResult`, `trace`) remains at its realistic floor, bounded by
the provider-type-leak constraint (§5.2). The `shared-schemas` deep-import
baseline stays at its documented minimum — **1 surface entry, 1 floor**
(`src/logger/logUtils.ts` → `@shared/schemas/log`), 0 forced, 0 gratuitous — so
coupling past the `@shared/schemas` barrel is effectively eliminated. The
set-based ratchets forbid both new edges and stale headroom, so these lists can
only shrink or hold; "never widen a baseline" is structurally enforced, not a
convention.

## 3. Subagent boundaries — still drawn, still mature; one unit still open

The subagent boundary is a **shipped, multi-implementor SPI, not a design task**
— re-confirmed independently again this pass:

- **Contract:** `ChildRunStrategy<TTurn>` + a narrow turn-based interface
  (`src/agent/runtime/childRunLoop.ts` — "the single owner of everything a
  driver does NOT vary"), with the upward channel limited to `notify(progress)`
  + `recordCost(usd)`.
- **Dispatch surface:** the three approval-gated delegation tools —
  `delegate_agent` / `delegate_workflow` / `delegate_multi_agents`
  (`src/tools/delegation/DelegationTools.ts`, `WorkflowScriptTool.ts`) — the
  equivalent of the Agent-SDK Task/dispatch tool, with the model picking an
  agent by description.
- **Recursion-closing seam:** the runtime slot
  `provideAgentEngine({ executeAgent, resumeToolUseTurn })`
  (`src/agent/runtime/executeAgent.ts`), a deliberate load-time slot (not a
  static import) filled at `nativeSubagentStrategy.ts`, breaking the
  `registry → DelegationTools → executeAgent → registry` cycle.
- **Isolation, budget, lifecycle, durable resume** are all already implemented
  (per-execution stream/lease/tools, one PQueue slot per turn via
  `childRunBudgetFor`, `ChildRunInterruptible` for the WAITING gap,
  `detachSubagentsOnStop` policy, exactly-once cost commit, WAITING resume
  across process restart). TeXRA's subagent model is *heavier* than the Agent
  SDK's (durable, interactive multi-turn children, two `agentCategory` execution
  shapes), not lighter.

The honest mapping is unchanged from `-08-25`: `reflection`/`tooluse` are the
`agentCategory` dispatch axis inside one run, not separate agents;
`followUp`/`goal` are substrate; `review` is a support library behind a tool-use
YAML agent (`@agent/review` door landed); `roster` is visibility policy;
`remote` is an auth+network loader the SDK deliberately excludes
(`includeRemote: false`). **`agentCreator` remains the one genuine "logical
agent not yet running as one"** — `runAgentCreator`
(`src/agent/implementations/agentCreator/agentCreatorFlow.ts`), single
production caller
`packages/extension/src/commands/agent/agentCreatorCommands.ts:11`, runs inline
in the extension host through the `AgentCreatorUI` port rather than through
`runAgent`/`ChildRunStrategy`. That boundary stays open **correctly**: closing
it is interactive-UI design work (the `AgentCreatorUI`/approval channel the
public `HostInteractions` deliberately lacks), not a mechanical move, and it is
gated on the same open contract as §5.5.

## 4. Runtime / core / implementations sweep — no untriaged abstraction

A fresh sweep of `src/agent/{runtime,core,implementations}` and
`src/agent/node/index.ts` for the banned species (single-caller helper
extraction, pass-through method, thin create-run-interpret flow wrapper,
re-export shim, gratuitous single-impl interface) found **no clean untriaged
candidate**. Concrete negative evidence for the things that looked like
candidates:

- `runReflectionFlow` / `runToolUseFlow` are **deep** drivers (~370 / ~710
  lines) owning tool resolution, persistence recovery, teardown ordering, and
  outcome classification — not the "create state + run flow + interpret result"
  wrapper the anti-pattern targets.
- `IToolUseSession` has a single implementor but exists to invert a
  `core → implementations` dependency edge — a dependency-direction justification,
  not a gratuitous interface.
- `helperModel*`, `mediaVisionWarning`, `normalizeAgentSettingTools`, the
  stream-tab and flow-result builders, `emitRunFact`, and the presentation-event
  dispatchers were each verified multi-caller (2–3+ production callers, several
  with dedicated tests) — not single-caller extractions.
- `ModelCell`, `RunContext`, `ExecutionInteractionOwnership`, and the
  `runAgent → executeAgent` split are deep modules with documented non-trivial
  invariants (handler/client aliasing, ALS context, ownership generations, lease
  lifecycle) — no pass-through.
- `runtime/index.ts` is the one barrel in scope; its docstring and the R-b
  import-width ratchet document it as a curated host surface, not a convenience
  barrel. No other re-export files exist in the scope.

The only structural smell surfaced was
`inferPersistedModelHandlerCompatibilityKey`
(`src/agent/runtime/modelHandlerCompatibilityInference.ts:10`) — a Google-resume
guard wearing an "inference" name and a `ModelHandlerCompatibilityKey |
undefined` return type it never populates (every non-Google path returns
`undefined`, Google throws). It is **not** single-caller (2 production callers in
`SessionResumeRetrieval.ts` + 1 internal), so removal is not mechanical; a
behavior-preserving fold would rename it to an `assertGoogleResumeSupported(model)`
guard and inline the parse into its flow variant. This is a naming/return-type
cleanup, not a defect, and sits alongside the already-catalogued low-risk runtime
items in
[`2026-08-27-simplification-survey-round5-deep-read.md`](./2026-08-27-simplification-survey-round5-deep-read.md)
slice b21 (`ModelRetryGate.isUnobservedFailure` relay orphan −42;
`childRunBudgetFor`'s test-only `concurrency`/`callerPinned` −25;
`ModelInvocationNode`'s dead constructor/param paths; the `childRunLoop` terminal
outcome-derivation). Those remain the standing backlog of low-risk runtime tidy
work; none is an SDK-readiness blocker and none warrants an unbidden edit.

## 5. Remaining open items (carried forward, none a defect)

Unchanged in substance from `-08-25 §5`; re-confirmed present at HEAD.

1. **`IModelHandler` port shape (forward-looking).** Still a hand-maintained
   derived `Pick<ModelHandler<…>>` (`src/agent/types/IModelHandler.ts:33`). The
   derivation is the correct anti-drift choice internally; a *public* SDK would
   want the port defined intrinsically. A manifest-design note, not mechanical.
2. **Provider-SDK type leak (`M`/`T`) is the floor on `agent`'s 7 specifiers.**
   `ProviderMessage.ts:4-9` still imports message types from all four provider
   SDKs. `U`/usage is already quarantined to `unknown`; `M` has an in-tree fix
   template but `T` is load-bearing at `ToolUseDispatchNode` display-fallback
   sites and must route through a handler method first. Whether `IModelHandler`
   can ever be a public export is the governing manifest decision;
   `scripts/validate-artifacts.mjs` already guards the built package against the
   leak (it walks the reachable `.d.ts` graph and throws on any provider SDK).
3. **Logger + telemetry are process-global singletons with no public plug
   point.** The SDK-correct unlock is injectable owners (a `Platform.log` port +
   a `UsageSink` port) behind Tier-1 `configureLogging` / `configureUsage` doors,
   specified in `docs/prds/2026-05-06-prd-logger-v2.md` and deliberately deferred
   behind singleton-retirement. This pass adds no new logger sub-item — the
   surface is clean (schema-driven redaction; the `createLog` vs free
   `debug/info/warn/error` duality is the deliberate `loggerSelf` test-spy seam,
   not a removable duplication).
4. **Two open Tier-1 doors remain** (four of eight landed —
   `src/agent/{export,review,templates,followUp}/index.ts` present and stable):
   fronting `agentCreatorFlow` (blocked on the interactive `AgentCreatorUI`
   design, §3), and a `core/state` door (blocked because a dynamic `import()` the
   ratchet counts would leave the leaf live for zero ratchet gain).
5. **`HostInteractions` required/optional (north-star TD-2a).** Open maintainer
   contract decision. The public shape stays deliberately minimal (`cancel()`
   only; approval-requiring tools throw at launch,
   `packages/agent/src/index.ts:233`) until the approval channel has a stable
   contract — the single biggest capability gap vs. Agent-SDK conventions.
6. **Result-taxonomy documentation.** An external consumer meets three result
   shapes (`AgentFlowResult`, `AgentFinalResult`, the non-terminal `WAITING`)
   with no doc explaining which they get. The transforms are real, not delete
   candidates; documenting *why* `WAITING` exists and *why* `cost`/`diffs` land
   only on the final is the single largest "which result do I get?" clarification
   the surface needs.
7. **Publication** remains gated on the named-external-consumer hold; the legal
   side (Apache-2.0 relicense, PocketFlow NOTICE, ToS scoping) cleared in a prior
   window, so the gate is now consumer-driven, not legal-driven.

## 6. Bottom line

Six consecutive passes (`-08-19` through `-08-29`) now find a green top-line
verdict, this one re-derived from four fresh independent area audits. It is the
cleanest pass in the series: the two `-08-25` removals stayed removed, the
model-handler base shrank a further 18 lines, the frozen deep-import lists held
at their floor, and the fresh runtime/core/implementations sweep found **no new
removable member** — only the already-catalogued low-risk backlog (§4). The
honest answer remains "almost nothing to remove," and this pass recorded
nothing new to land. The remaining structural work is unchanged and
design-gated: the two open Tier-1 doors, the injectable logger/usage ports, the
manifest decision on `IModelHandler` (its `M`/`T` leak and public-export
question), the `HostInteractions` approval contract, and result-taxonomy
documentation. Nothing found is a defect; nothing warrants a speculative edit
into the green tree absent a maintainer request, so — consistent with the
routine's cadence — this scheduled run records the verdict and lands no code.
</content>
