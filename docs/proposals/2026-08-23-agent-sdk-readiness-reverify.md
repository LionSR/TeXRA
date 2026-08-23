# Agent-SDK readiness — re-verification pass (2026-08-23)

> **Status:** Written 2026-08-23 against branch HEAD `3c35ffc`
> (`3c35ffcd207db77f98d820e17ad33e4c24bc2e85`). The scheduled audit routine
> re-ran the standing question — "review the agent core, model handler, logger,
> and surface for unnecessary abstraction and unready surface; design subagent
> boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the four immediately-prior passes
> ([`-08-19`](./2026-08-19-agent-sdk-readiness-reverify.md),
> [`-08-20`](./2026-08-20-agent-sdk-readiness-reverify.md),
> [`-08-21`](./2026-08-21-agent-sdk-readiness-reverify.md),
> [`-08-22`](./2026-08-22-agent-sdk-readiness-reverify.md) at `d455149`). Like
> the prior pass, this one re-derived the verdict from **four fresh, independent
> area audits** (core+runtime, model handlers, logger, surface + subagents)
> rather than a diff of the last entry. It reached the **same top-line verdict —
> the alignment holds — for the fifth consecutive pass.** Every `-08-22` tracked
> fact re-verifies (§1), including the two behavior-preserving removals landed at
> the maintainer's request that pass (§1, §4). Two new low-confidence
> observations surfaced (§4a, §4b) — both boundary-hygiene, neither a defect and
> neither consensus-mechanical — and are **recorded, not landed**: this pass ran
> unattended with no maintainer request, so no speculative edit was made into the
> green tree (the discipline `-08-22 §7` set). Every claim below carries a
> `file:line`, config path, or count checked at `3c35ffc`.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, and no structural refactor is warranted.** The pass-through wrappers,
convenience barrels, and single-caller factories the standing question hunts for
are not present in `core/` or `runtime/` (the core+runtime audit found `core/`
clean with zero unnecessary abstractions), and the model-handler layer's
apparent breadth is disciplined (§3). Yesterday's two removals (`-08-22 §4a`
inlining `createToolUseFollowUpMessages` off the public port, and `-08-22 §4b`
inlining `createAssistantMessageForPrefillText`) are **present and stable at
HEAD** — both symbols are gone from the tree and `ModelHandler.ts` sits at 2,043
LoC, down from the 2,069 the `-08-22` pass measured pre-landing. What is new this
pass is two honest, low-value boundary-hygiene observations (§4a, §4b) plus one
measured improvement in the frozen surface — the host deep-import width **shrank
again** (§2). Nothing found is a defect.

## 1. Every `-08-22` tracked fact re-verifies at `3c35ffc`

| Item                                    | `-08-22` state                                       | `3c35ffc` state                                                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **§4a removal** (`createToolUseFollowUpMessages`) | landed; off port + base                    | **still gone.** No match in `ModelHandler.ts`, `IModelHandler.ts`, or anywhere in `src/`/`packages/`. The port lost the member permanently.                                  |
| **§4b removal** (`createAssistantMessageForPrefillText`) | landed; inlined                     | **still gone.** No match anywhere in `src/`.                                                                                                                                |
| **M-3** `ModelHandler.ts` god-base      | 2,069 LoC (pre-`-08-22` landing)                     | **2,043 LoC** (`wc -l`); −26 from the two removals. Genuinely shared behavior, no per-provider copy-paste (model-handler audit re-confirmed `support/`+`utils/` cross-family). |
| **L-3** (dead redaction branch)         | closed; `redactSecrets` single-arg                   | **still closed.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:81`); no options branch.                                                   |
| **L-2** (process-global log sink)       | module-singleton, deliberate; no platform port       | **unchanged, re-confirmed deliberate.** `platform.ts:32-35` documents logging as "its own subsystem" and states "the platform abstraction doesn't carry a log backend." No `platform().log` port; `logUtils.ts` 256 LoC. |
| **§7 Tier-1 doors**                     | 4 of 8 barrels seeded                                | **present & stable.** `src/agent/{export,review,templates}/index.ts` all exist; `@agent/index` widened.                                                                      |
| **Provider-type-leak floor**            | 4 provider SDKs on `ModelHandlerContracts`           | **unchanged.** `openai`, `@google/genai`, `@anthropic-ai/sdk`, `@openrouter/sdk` still imported (`ModelHandlerContracts.ts:14-19`, 5 import statements across 4 SDKs).       |
| **Node flow engine**                    | 159 LoC, `BaseNode`/`Flow` only                      | **159 LoC** (`src/agent/node/index.ts`); unchanged, matches CLAUDE.md.                                                                                                       |
| **`shared-schemas-deep-import` floor**  | one entry (`@shared/schemas/log`), forced/gratuitous empty | **unchanged.** `floors: {"@shared/schemas/log": ["src/logger/logUtils.ts"]}`, `forced: {}`, `gratuitous: {}` (`shared-schemas-deep-import-baseline.json`). Effectively sealed. |
| **Version**                             | 0.40.4 (short of the v0.41 `runFact.` gate)          | **0.40.4.** Unchanged; retirement not yet due.                                                                                                                              |

## 2. Frozen host deep-import width — shrank again, one host edge each retired

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*`
deep-import specifiers per package, past the `@agent` barrel):

| Package             | `-08-21` (post-§7) | `-08-22` (`d455149`) | `3c35ffc`            |
| ------------------- | ------------------ | -------------------- | -------------------- |
| cli                 | 8                  | 8                    | **8**                |
| desktop             | 6                  | 6                    | **5** (−1)           |
| extension           | 10                 | 10                   | **9** (−1)           |
| agent (SDK package) | 7                  | 7                    | **7**                |

Both host reductions come from a single window commit: `5d30ce6`
(`fix(follow-up): resolve at admission …`) pruned the `@agent/followUp`
specifier from **both** desktop and extension, which no longer import it
(verified: no `@agent/followUp` reference survives in `packages/desktop/src` or
`packages/extension/src`). The set-based ratchet forbids any new edge and fails
on stale headroom, so the "never widen a baseline" invariant remains
structurally enforced — and this window it did more than hold: the lists shrank.
`agent`'s 7 remains near the realistic floor bounded by the provider-type-leak
constraint (§4c).

## 3. Subagent boundaries — still drawn, still mature (independently re-mapped)

The surface + subagent audit re-derived the boundary map from scratch this pass
and reached the same conclusion the prior passes did: **the subagent boundary is
a shipped, multi-implementor SPI, not a design task.**

- **One driver.** `startChildRunLoop` (`src/agent/runtime/childRunLoop.ts:765`)
  drives *every* child-run type — native subagents (both categories), agent-CLI
  (codex/claude) sessions, workflow-script grandchildren, background shells —
  through the turn-based `ChildRunStrategy<TTurn>` interface (`launch` /
  `runTurn?` / `isTerminal` / `formatDelivery`; upward channel just
  `notify(progress)` + `recordCost(usd)`).
- **Recursion-closing seam.** The `AgentEngine` runtime slot —
  `provideAgentEngine({ executeAgent, resumeToolUseFromResumeData })`
  (`executeAgent.ts:703`), filled at
  `src/tools/delegation/nativeSubagentStrategy.ts` — a deliberate load-time slot,
  not a static import, to break the `registry → DelegationTools → executeAgent →
  registry` cycle.
- **Two spawn modes, one loop.** Detached (`detachedChildRun.ts` →
  `startChildRunLoop`) and in-band (`inBandSubagentExecution.ts`, a durable
  synchronous call awaiting a typed `AgentFinalResult`) both drive
  `nativeSubagentStrategy`.
- **Budget & lineage.** `childRunBudgetFor` (`childRunBudget.ts:65`) — one
  `PQueue` per `SessionHandle` capping concurrently-live native child model
  conversations; only budgeted (detached/workflow) turns acquire a slot.
  `ExecutionRegistry` tracks handles + a `childActivations` map;
  `detachSubagentsOnStop()` decides cascade-kill vs. `detachActiveChildren`
  (promote to top-level, clear the delivery target).

The honest six-candidate mapping is **unchanged**: reflection and tooluse are the
`agentCategory` dispatch axis inside one run (`executeAgent` branches on
`setting.agentCategory`); followUp and goal are substrate; review is a support
library behind a tool-use YAML agent; and **only `agentCreator` is a genuine
"logical agent not yet running as one"** — `runAgentCreator`
(`src/agent/implementations/agentCreator/agentCreatorFlow.ts:437`), a single
linear async fn with one production caller, still run inline in the extension
host (reached from `packages/extension/src/commands/agent/agentCreatorCommands.ts`)
via the `AgentCreatorUI` port rather than through `runAgent`/`ChildRunStrategy`.
It remains the one open boundary, correctly, because fronting it carries
interactive-UI design work, not a mechanical move.

**Window note (subagent area):** `41982da` **reverted** "fix(delegation): guard
recursive lead delegation (#11290)" — the recursive-lead-delegation guard and
its `userVars`/`AgentLaunchContext`/`RunScope` scope-threading were rolled back
(11 files, −349 lines). This restores the pre-guard delegation-scope behavior;
it is a behavior revert, not a structural change to the boundary, and does not
alter the map above.

The cleanest still-embedded split candidates (surface audit) remain the
helper-model one-shots that **already thread `session` explicitly and so carry no
`RunContext` ALS coupling**: `generateSessionDescription`
(`sessionDescription.ts:101`) and `polishTextWithAI` (`textEnhancement.ts:49`).
Neither is a defect; both are noted only as the lowest-friction future
extractions if the SPI ever needs more first-class members.

## 4. New this pass — two low-confidence boundary-hygiene observations (recorded, not landed)

The `-08-22` pass surfaced two consensus-mechanical removals and landed them at
the maintainer's request. This pass's fresh audits surfaced no comparably
clear-cut removal. The two items below are **honest but low-value** — one is a
naming/placement nit, one a boundary bleed already partly resolved upstream —
and neither is consensus-mechanical. Consistent with the discipline `-08-22 §7`
set (and this run being unattended, with no maintainer request), **both are
recorded here and neither was edited into the green tree.**

### 4a. `textConnection.ts` — a LaTeX-domain connector living in the generic runtime layer

`src/agent/runtime/textConnection.ts` (`agentResponseTextConnector` /
`bestConnectionMethod`) implements a **LaTeX-grammar decision** — a helper-model
prompt asking which candidate string is "more english and latex grammatically
correct" — and imports `@latex/latexLogging` and a type from
`@latex/texraResponseTextProcessing`. It sits in the layer being groomed into a
generic Agent SDK, while the neutral seam it should sit behind already exists:
`createNeutralResponseTextProcessing` (`responseTextProcessing.ts:28`) is the
domain-free default. The connector is wired by all three hosts through the
`@agent/runtime` barrel (`packages/desktop/src/main/index.ts`,
`packages/cli/src/runtime/transcriptSession.ts`,
`packages/extension/src/extension.ts`).

**Severity: low, and milder than when first noted.** The deeper coupling the
`2026-07-27-agent-npm-package-step3.md` analysis flagged — core's
`ResponseCycleFlow` importing `bestConnectionMethod` directly — is **already
resolved**: no reflection-flow file under
`src/agent/implementations/flows/reflection/` imports `textConnection` or
`bestConnectionMethod` at HEAD. What remains is a host-wired connector
implementation carrying LaTeX domain code on the runtime side of an existing
neutral port. The SDK-clean shape (per the north-star "hosts as reference
examples" direction) is to relocate the concrete connector beside the LaTeX/host
layer and keep only the neutral `ResponseTextProcessing` port + defaults in
runtime. Low risk (3 host call sites, all through the barrel), but it touches the
LaTeX boundary rather than being a pure inline, so it is design-adjacent, not
consensus-mechanical.

### 4b. `ModelHandlerValidation` — a 335-line validation stub at the shared model-handler root

`src/agent/modelHandlers/modelHandlerValidation.ts:128`
(`class ModelHandlerValidation extends ModelHandler<…>`) is a full handler
implementation returning canned output (`VALIDATION_OUTPUT`,
`WORKFLOW_SCRIPT_VALIDATION_SOURCE`), selected only behind the CI-only env gate
`shouldUseInternalValidationModelHandler()` (`ModelFactory.ts:240`,
`internalValidationOverride.ts`). It is dead in every real run and sits at the
shared `modelHandlers/` root rather than behind a provider folder or a dev-only
path.

**Severity: low; not a leak.** It is **not** referenced by `packages/agent/src`
and does not reach the published SDK `.d.ts`, so it is not a provider-type-leak
contributor — the observation is placement/hygiene, not correctness. If the
model-handler tree is ever curated for a published Tier-1 surface, moving this
stub behind a `__internal`/dev-only path (excluded from the published graph)
would keep the shared root free of a validation double. Until then it is
harmless and the single factory caller keeps the risk of moving it low.

### 4c. Provider-SDK type leak — unchanged; still the floor on `agent`'s specifier count

Re-confirmed exactly as `-08-22 §4c` recorded. The `IModelHandler` port is
`Pick<ModelHandler<M, U, T, C, Resp>>` with `M extends ProviderMessage`,
`T extends SdkToolCall = SdkToolCall`. **`U` (usage) stays quarantined** (defaults
to `unknown`; `ModelCell` binds `U = unknown`; `extractNormalizedResponse`
returns `NormalizedUsage`). **`M` and `T` still leak:** `ProviderMessage`
imports message types from all four provider SDKs, and `SdkToolCall`'s `raw`
members import provider SDK types (`ModelHandlerContracts.ts:14-19`). The
model-handler audit independently reached the same conclusion and added the
precise reason the leak check does not already fail: `validate-artifacts.mjs`
scans only the **main entry** graph, and `packages/agent/src/index.ts:18-24`
deliberately routes `AgentFlowResult` around the `@agent/runtime` barrel to keep
the model-handler `.d.ts` graph out of the published surface. Closing the leak
(the `U → M/T` template) is the gating item for ever publishing `IModelHandler`
as Tier-1, and remains a **manifest-design decision**, not a mechanical move —
unlanded, correctly.

## 5. Remaining open items (carried forward from `-08-22 §5`, none a defect)

1. **`HostInteractions` required/optional (north-star TD-2a)** — open maintainer
   contract decision. Re-confirmed a real port (the core+runtime audit ruled it
   *not* a wrapper: one implementer but 17 typed use sites + barrel + test mocks).
2. **Logger + telemetry are process-global singletons with no public plug point.**
   The only log entry point is the frozen deep import `@logger/logUtils` (§1 L-2);
   the SDK-correct unlock is injectable owners behind Tier-1 `configureLogging` /
   `configureUsage` doors (specified in `docs/prds/2026-05-06-prd-logger-v2.md`,
   deferred behind singleton retirement). The **dual public entry surface** noted
   `-08-22` persists and is measurable: ~191 non-test files import
   `@logger/logUtils`, ~173 use `createLog` — narrowing the free
   `debug/info/warn/error` exports to internal (migrating their importers to
   `createLog`) would shrink the `@logger` surface before any freeze. Low value;
   not a defect.
3. **Two open Tier-1 doors remain** (four of eight landed): fronting
   `agentCreatorFlow` (its deepest specifier; blocked on the interactive
   `AgentCreatorUI` design, §3), and a `core/state` door — **re-confirmed still
   blocked**: `desktopProgressFileActions.ts:86` reaches `executionRequests` via a
   *dynamic* `import()` the ratchet counts (and `desktopAgentExecution.ts:26`
   statically), so a barrel would leave the leaf live for zero ratchet gain.
4. **The provider-SDK type leak is the floor on `agent`'s specifier count** (§4c) —
   a manifest-design decision; `scripts/validate-artifacts.mjs` already guards the
   leak on the built package.
5. **Result-taxonomy documentation.** An external SDK consumer still meets three
   result shapes — `AgentFlowResult` (discriminated `workflow | toolUse`),
   `AgentFinalResult` (the stable post-flow chaining artifact adding
   `diffs`/normalized `cost`), and the non-terminal `WAITING` state. The core
   audit re-confirmed the transform between them is real (`buildAgentFinalResult`,
   not a pass-through); documenting *why* `WAITING` exists and why `cost`/`diffs`
   land only on the final remains the single largest "which result do I get?"
   clarification the surface needs.
6. **Publication** remains gated on the named-external-consumer hold; the Apache-2.0
   relicense and NOTICE/ToS work from the prior window stand. Packaging/API shape
   unchanged.

## 6. Merges since the `-08-22` pass (`d455149..3c35ffc`, 50 commits)

None add a wrapper layer. The window is dominated by runtime durability work
(lease/pid-liveness, derived run status, checkpoint classification, follow-up
admission). Relevant to the audited areas:

- **Host deep-import shrink** (`5d30ce6`) — pruned `@agent/followUp` from desktop
  and extension (§2).
- **model-handler indirection removal** (`fb887c3` `refactor(google): inline
  interactions media round helper`) — collapses a helper in the Google handler;
  indirection-reducing, no wrapper added.
- **settings dedup** (`bbb5c51` `refactor(settings): share team roster
  orchestration`) — shares team-roster orchestration across hosts; consistent
  with the cross-host consolidation trend.
- **delegation behavior revert** (`41982da`, §3) — reverts the recursive-lead
  guard; behavior change, not structure.

All neutral or indirection-reducing, consistent with the standing trend.

## 7. Bottom line

Five consecutive passes (`-08-19` through `-08-23`) now find a green top-line
verdict, this one re-derived from four fresh independent area audits. Yesterday's
two behavior-preserving removals are present and stable, and the frozen host
deep-import surface **shrank further** this window (desktop and extension each
retired an `@agent/followUp` edge) — the invariant is not merely holding, the
lists are still tightening. This pass's honest additions are two low-confidence
boundary-hygiene observations (the `textConnection` LaTeX bleed, already milder
than first flagged; the `ModelHandlerValidation` stub's root placement) and a
re-confirmation of the one true structural blocker (the provider-type leak,
§4c). Neither new observation is a defect, and — this run being unattended with
no maintainer request — **neither was edited into the tree**, following the
discipline the prior passes set: verify first, land only consensus-mechanical
items and only on request, record the rest. The remaining structural work is
unchanged and design-gated: the two open Tier-1 doors, the injectable
logger/usage ports, the result-taxonomy doc, and the manifest decision on
`IModelHandler`. Nothing else found warrants a speculative edit into the green
tree.

## 8. Correction — §4a/§4b do not survive a refactor attempt; withdrawn

At the maintainer's request, this session attempted to execute §4a and §4b as
refactors, plus a third item the core+runtime audit surfaced but this doc did
not carry forward at the time (a naming nit on
`inferPersistedModelHandlerCompatibilityKey`, below). Closer investigation
before editing showed **none of the three survive**; all three are
correctly-placed, deliberate design once read in full context. **No code was
changed.** This section documents why, so tomorrow's pass does not re-flag
the same non-issues.

- **§4a `textConnection.ts`:** relocating the connector beside the latex layer
  would create a `latex → agent` dependency edge.
  `config/ratchets/architecture-edges-baseline.json:6` enforces exactly the
  opposite direction — `{ "from": "agent", "to": "latex", "kind": "value" }` is
  the only edge between the two; no `latex → agent` edge exists anywhere in the
  baseline, and `src/latex/` has zero real imports from `@agent/*` (the one
  `grep` hit, `latexdiff/executionDiscovery.ts:6`, is a comment, not an
  import). The file's own doc comment already states the reasoning this audit
  had missed: "Hosts inject this through the latex-owned factory; it keeps the
  helper-model call out of the latex layer" — `agent/runtime` depending on
  `@latex/texraResponseTextProcessing`'s *type* (the established, ratchet-backed
  direction) is the correct shape; moving the connector's *implementation* to
  latex would need to reverse it. Withdrawn — not a defect.

- **§4b `ModelHandlerValidation`:** its root-level placement in
  `src/agent/modelHandlers/` is explicitly documented, not accidental —
  the modelHandlers `README.md`'s module table lists it alongside `ModelHandler`
  itself as a root file "shared across all providers." It is CI-only (gated
  behind `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL=1` plus an absolute
  CI flag-file check in `internalValidationOverride.ts`), dynamically imported
  only inside the `ModelFactory` provider switch (the same pattern every real
  provider handler uses), and — as this pass's §4c already noted — not
  referenced by `packages/agent/src`, so it never reaches the published `.d.ts`.
  There is no reachable production or published-surface cost to its current
  location. Withdrawn — not a defect.

- **`inferPersistedModelHandlerCompatibilityKey` naming (core+runtime audit
  finding #2, this pass):** re-reading both call sites
  (`SessionResumeRetrieval.ts:190-192`, `:245-247`) shows the pattern
  `persistedKey ?? inferPersistedModelHandlerCompatibilityKey(model)` — the
  function's job is precisely to infer a compatibility key from the model alone
  when none was persisted, returning `undefined` where no key is needed to
  resume safely and throwing only for Google, the one provider where an absent
  key makes resumption unsafe. That is inference (including the correct decision
  *not* to infer a value), not merely a guard; the name is accurate for what the
  function does in context. Withdrawn — not a defect.

All three were flagged by this pass's own fresh audits without the follow-up
context above; the audits' "recorded, not landed" framing (chosen precisely
because they were low-confidence) held up. This is the discipline working as
intended: an unattended pass records observations rather than acting on them,
and a maintainer-requested follow-up gets the deeper read before any edit — in
this case revealing there was nothing to land.
