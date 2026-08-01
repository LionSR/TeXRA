# Agent SDK Readiness — Verification Checkpoint (2026-08-01)

**Status:** Verification checkpoint. Read alongside the immediately prior
[`2026-07-30-agent-sdk-readiness-checkpoint.md`](./2026-07-30-agent-sdk-readiness-checkpoint.md)
(this pass reconciles against its §New-8…§New-11 and [TRACKED] items rather than
re-deriving them), the foundation-gap analysis
[`2026-07-26-agent-sdk-foundation-gap.md`](./2026-07-26-agent-sdk-foundation-gap.md)
(§9 the real ceiling), the audit of record
[`../dev/audits/2026-07-25-agent-sdk-readiness-audit.md`](../dev/audits/2026-07-25-agent-sdk-readiness-audit.md),
the plan of record [`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md)
(§4 sequenced path, §5 verified traps), and the `-06-25` → `-07-30` checkpoint chain.

This pass inspected the tree afresh at HEAD `6ab67ce`
(`Merge pull request #9503 from LionSR/fix/9409-windows-ci`; `CHANGELOG.md`
heading `[Unreleased]`; package version `0.40.0`). The `-07-30` checkpoint pin
`8116ce9` is **not** in HEAD's ancestry (`git merge-base --is-ancestor` fails —
consistent with the repo's squash-merge history), but `git rev-list --count
8116ce9..HEAD` reports **71 commits** reachable from HEAD and not from it. This
pass re-inspected the tree at HEAD and reconciled against the standing record; it
did not perform a commit-by-commit audit of that range.

**Run context (honesty note).** This was an **unattended scheduled run** with **no
external adversarial review available**. It therefore applies **no code change** —
see "No change lands." The discipline is the one every checkpoint since `-07-22`
has held: this class of refactor needs a reviewer outside the pass's own analysis
(the `-07-22` applied-then-reverted `MapToolRegistry` mistake, and the `-07-30`
live-authorized-but-reverted `polishModel`/`createModelHandler` census, are the
worked examples), which an unattended run lacks. Method mirrored `-07-29`/`-07-30`:
four parallel read-only deep-dives (model handlers, agent core + flows + subagent
boundaries, runtime + public surface, logging + trace), each returning
file:line-cited findings, reconciled here against the standing record so
already-tracked items are not re-filed as fresh. The orchestrating pass then
re-verified every headline claim by direct grep/read at HEAD before recording it.

## Verdict — well-aligned; one genuinely new latent defect, several new small structural items

**The codebase remains well-aligned and SDK-ready in shape; no new structural
refactoring is warranted from an unattended pass.** The core-shape conclusion
every checkpoint since `-06-26` has reconverged on holds unchanged across the
71-commit delta. The `packages/agent` public surface — `runAgent(input): AgentRun`
where `AgentRun extends AsyncIterable<AgentEvent>` + `{ result, interrupt() }`
(`packages/agent/src/index.ts:70-72,207`) — **is** the north-star
`run(agent, input) -> stream/result` shape, still implemented and still honest
about what it cannot yet do (approval-requiring tools throw `:213-214`; the public
`HostInteractions` is deliberately the minimal `cancel()` shape `:49`).

**The one item this pass elevates above the standing record is a genuine (if
low-severity, latent) silent-degradation defect** — the `goalPaused`/`default:
return` fall-through in `StreamSnapshotStore` (§New-14) — which is the exact
CLAUDE.md §"Silent degradation is a defect" `default: return` pattern and is **not**
previously recorded. It is a maintainability/latent-drop defect, not a live
incident (current behavior is correct), and — like everything here — is recorded,
not applied.

## Spine invariants — re-verified at HEAD `6ab67ce` (direct grep this pass)

- `src/agent/core/index.ts` **absent** (no barrel regression).
- `IModelHandler = Pick<ModelHandler<…>>` (`src/agent/types/IModelHandler.ts:41`),
  **43** picked members — unchanged from `-07-29`/`-07-30`. (The model-handler
  deep-dive's "44" counts the one hand-authored `&{ createBatchedToolUseFollowUp…? }`
  extension `:103` alongside the 43 `Pick` members; the `Pick` list is 43.)
- `Node.exec → createFlow().run` shape intact: `ResponseCycleNode.exec()` /
  `ToolUseCycleNode.exec()` create and run the inner cycle flow inline, no wrapper.
- **0** `vscode` imports across all declared VS Code-free zones (`src/agent`,
  `model`, `latex`, `tools`, `controllers`, `shared`, `replacement`, `eventBus`,
  `hosts`), and — independently re-confirmed by the runtime deep-dive — **0**
  `packages/*` imports anywhere in `src/agent/runtime/`.
- `MapToolRegistry` still `Map<string, ITool> | Record<string, ITool>` with the
  `instanceof Map` branch (`ToolTypes.ts:50-51`) — the reverted `-07-22`/`-07-23`
  state, correctly not re-attempted. It is exported through the package surface
  (`packages/agent/src/index.ts`), so the `Map` branch is a real compatibility
  boundary, not dead code.
- `agentCreator/` still contains **0** `Node`/`Flow`/`@agent/node` references — a
  linear async function with a single production caller
  (`agentCreatorCommands.ts:220`); CLAUDE.md's "not a flow" note is accurate.
- `node/index.ts` flow engine carries **no** upstream-PocketFlow dead surface —
  `grep` for `BatchNode|ParallelBatch|setParams|\.params` over `node/` +
  `core/flows/` + `implementations/` returns **0**.
- Inner-cycle snapshot schemas still **never validated**: `grep` for `.parse` /
  `.safeParse` on `CycleFieldsSchema` / `BaseCycleFieldsSchema` /
  `ToolUseRoundFieldsSchema` returns **0** (re-verifies standing §New-1).

## Remaining gaps — the real ceiling (§9), re-verified present at HEAD

Unchanged in substance from `-07-30`; all still present:

1. **Tool registry still closed.** `IToolRegistry = { get, has }`
   (`ToolTypes.ts:41-44`), no public `register`; tools hard-coded in
   `createDefaultTools()`. An embedder cannot add a tool. Correctly last on LoC,
   first on foundation.
2. **Product types still leak into the runtime launch path.** `RunAgentOptions.preferHelperModel`
   (`runAgent.ts:54,82`); `AgentFlowResult.compileFailures` (`AgentFlowResult.ts:34,139`);
   TeXRA-domain `AgentEvent` arms (`updateCompileFailures`, `updateMissingOutputs`,
   `goalPaused` — `events.ts:191-199,379-381`) riding the generic union rather than
   the `domain` escape hatch.
3. **`IModelHandler` port width (43) and `SdkToolCall` vendor-type embedding**
   remain the standing strategic port-shape item. Still auto-derived
   `Pick<ModelHandler>`, so surface shape, not drift; the model-handler deep-dive
   independently re-affirmed every picked member is called through a port-typed
   value. The real lever remains **reducing what the flow layer demands of the
   handler**, not trimming the `Pick`. See §New-13 for the model-handler deep-dive's
   port-inversion proposal and why it is design-judgment, not mechanical.
4. **NS-1 host→core public surface.** Hosts still reach `@agent/*` deep specifiers
   frozen by the #7684 **R-b freeze ratchet** (`config/ratchets/host-agent-import-baseline.json`);
   no Tier-1 manifest yet, and — see §New-12 — the north-star **R-a forbidding
   rule** is still not in place.

## Deep-dive findings — reconciled against the standing record

Each finding is tagged **[TRACKED]** (already on the record; do not re-file as new)
or **[NEW]** (not previously named in the checkpoint chain, to the best of this
pass's reading). All are recorded for an attended maintainer pass; none are applied
here.

### Already-tracked — re-affirmed present, cited for completeness

- **[TRACKED] Model-handler base → collaborator extractions (standing §9.3).**
  Re-verified. `ModelHandler.ts` is **1986 LOC** at HEAD; the file is a Template
  Method base (16 abstract members are the true "implement a new provider"
  contract), not a random god-object, and much of its length is load-bearing
  `#7101`-triage documentation — do not treat line count alone as bloat. The
  model-handler deep-dive **refines** `-07-30`'s single `ClientCredentialRouter`
  extraction into **three** cohesive sub-domains that the file itself already shows
  can be delegated (media is delegated to `support/MediaAttachmentProcessor`, held
  at `:222`): (1) credential/wire-route resolution (~230 lines, `:204-698`),
  (2) client-side compaction (~250 lines, `:821-1398`), (3) token-budget validation
  (~230 lines, `:1751-1975`). Extracting all three (matching the
  `MediaAttachmentProcessor` precedent) would shed ~700 lines and leave the base as
  the pure provider Template Method — the standout SDK-readiness lift, still gated
  on an attended reviewer. Context worth recording: the actual largest handlers are
  the **concrete** ones — `openai/modelHandlerOpenAIResponse.ts` (**2939**) and
  `google/modelHandlerGoogleInteractions.ts` (**1878**) both exceed the base — so if
  decomposition effort is spent, those two are more urgent than the base.
- **[TRACKED] §New-1 — inner non-persisted cycle flows are ceremony over a
  while-loop.** Re-verified the load-bearing factual claim (0 schema `.parse` calls,
  above). Collapsing each inner flow into its owning node's body remains the
  standout structural simplification; the caveat still holds and was independently
  re-derived by the core deep-dive — these two factories
  (`createResponseCycleFlow`/`createToolUseRoundFlow`) are the codebase's principal
  vitest seam (`FinalToolSynthesis`, `ResponseCycleContinuation`, `BashTool`,
  `ToolUseRoundFollowUpMedia`, `ToolUseDispatchInterruption`), so it is a
  test-restructuring, not a deletion.
- **[TRACKED] §New-4 — `createRunScope` single-caller freeze wrapper.** Re-verified:
  `RunScope.ts:24` has one production caller (`AgentLaunchContext.ts`); the two
  other hits are test utils. Textbook inline candidate per CLAUDE.md's own
  "single-caller extractions are banned" guardrail; the `RunScope` *interface*
  (10 importers) stays.
- **[TRACKED] §New-6 — `AgentFlowResult → AgentFinalResult` field rename +
  `projectToolUseFinalTextFields` SSOT bridge.** Re-verified present
  (`AgentFinalResult.ts:81`, consulted in two places incl. `storage/resultMeta.ts`).
  The envelope split itself is load-bearing (live flow result vs durable
  subagent-delivery/persistence envelope with `diffs`/`cost`, 11 delivery-side
  importers); only the `lastResponse→response` / `touchedFiles→files` rename and its
  bridge fn are the removable friction §New-6 named.
- **[TRACKED] §New-8 — model-handler compatibility-key space encoded three times.**
  Re-verified present: the enum (`modelHandlerCompatibilityKey.ts:3`), the
  `PROVIDER_HANDLER_ROUTES` record (`ModelFactory.ts:72,314`), and the
  `switch (compatibilityKey)` (now `ModelFactory.ts:581`). Unchanged; the routing
  precedence is still single-owner (predicate + switch keyed off the same value so
  they can't drift), which the model-handler deep-dive independently rated a good
  pattern to keep.
- **[TRACKED] §New-9 — one stream-status transition emitted four ways.** Re-verified:
  `StreamStatusService.emitStatus` still fans a single transition to the `status`
  `AgentEvent` trace, the `updateStreamStatus` `SessionFact` (`:308`), and the
  direct `statusListeners` set (`:312`). The logging deep-dive independently
  re-derived this as the one place the run/session channel separation is not clean.
  Considered duplication (documented `events.ts:369-373`) — flag and confirm intent,
  do not assume a bug; highest-value dedup in the observability surface.
- **[TRACKED] `createChannelTrace` fabricates an inert `AgentTrace` as a module
  logger.** Re-verified **27** non-test module singletons (28 total incl. one test)
  do `const logger = createChannelTrace('X')` and only call `debug/info/warn/error`.
  Standing `-07-08`/`-07-18`/`-07-30` + `logger-surface-cleanup` PRD item; `-07-30`'s
  live-authorized attempt confirmed this is a deliberate-sequencing job (23 core
  files each rewriting every call to add a channel arg), not a drive-by.
- **[TRACKED] §New-7 — redaction path-stripping still not on the primary log sink.**
  Re-verified: the main output-channel sink still calls `redactSecrets(message)`
  with **no** `homeDir`/`workspacePath` options (`src/logger/logUtils.ts:61`), so
  secret-token patterns are stripped everywhere but path redaction runs only in the
  desktop app-log export. Security-sensitive; stays recorded, not touched.
- **[TRACKED] core inward→outward edges (accepted per `core/README.md:29-38`).** The
  core deep-dive re-flagged three flow-layer edges that point outward:
  `responseCycleToolsForModel` calling `useLaunchRunContext()`
  (`ResponseCycleFlow.ts:24,223`), `IToolUseSession` importing `@agent/followUp`
  (`IToolUseSession.ts:4`), and `CommonCycleTypes` importing `@agent/index`
  (`:6`) and `@tools/subagentResults` (`:19`). All host-agnostic (no `vscode`,
  no `packages/*`) and **pre-acknowledged** by the core README as the
  canonical-collaborator pattern, not a defect — recorded as accepted debt that a
  future `@agent/core` package boundary would need to resolve, not a fresh finding.

### New this pass — recorded for maintainer re-derivation

- **[NEW] §New-12 — the "import-boundary lint gate" the docs promise is half-built;
  reconcile the claim.** CLAUDE.md/AGENTS.md (`AGENTS.md:91-92`) say hosts import
  core through path aliases "until a future SDK surface is enforced with a build and
  import-boundary lint gate." Two honest corrections at HEAD: (1) **the build
  already ships** — `packages/agent` is the published `@texra-ai/agent` v0.40.0
  ("Embeddable TeXRA agent runtime") with a real build pipeline
  (`packages/agent/scripts/{build,bundle,rewrite-declaration-aliases,validate-artifacts}.mjs`);
  the "no `@texra/core` yet" framing is stale for the *build*. (2) The **gate is
  partial**: the #7684 **R-b freeze ratchet** exists
  (`config/ratchets/host-agent-import-baseline.json` — pins each host's distinct
  `@agent/*` deep-import specifier count, "freezes the surface a future SDK barrel
  would be seeded from"), but the north-star **R-a forbidding rule** (forbid
  `src/**` except `src/test-kernel/**` from importing the host ports — north-star
  `:108`) is **not** in place. So the accurate status is "R-b freeze landed, R-a
  fence not yet," which the runtime deep-dive's "the gate does not exist" overstated.
  This is the single highest-leverage *additive* piece for durable SDK readiness and
  is the north-star's own gated Step 0 — not a refactor, a new lint rule.
- **[NEW] §New-13 — `IModelHandler` port ownership is inverted for external
  authorship (strategic, design-judgment — do not treat as mechanical).** The model
  handler deep-dive's sharpest surface observation: the port is a `Pick` *projection*
  of the 1986-line concrete base (`IModelHandler.ts:35-42`), so the base is the
  source of truth and the interface derives from it. This is exactly what prevents
  drift (standing §9 item 3) and must not be "fixed" by trimming the `Pick`. But for
  a genuinely *external* provider author, the direction is backwards: they cannot
  implement a hand-authored contract; they must satisfy a slice of a large class. A
  true extractable provider SDK would invert ownership (author `IModelHandler` as the
  SoT, base `implements` it) — a strategic reshape with 3 consumer sites
  (`BaseFlowServices.ts:22`, `CycleServices.ts:65`, `followUpMessages.ts:17`), firmly
  in "design-judgment, reduce-the-demand" territory, **not** a mechanical lift.
  Recorded under standing §9 item 3, not as a drive-by.
- **[NEW] §New-14 — silent-degradation defect: `goalPaused`/`default: return`
  fall-through in `StreamSnapshotStore`. (S; the one genuine defect this pass.)**
  `StreamSnapshotStore.attachSessionEvents` subscribes `goalPaused` explicitly
  (`types` list, `:493`) but its run-fact switch folds `goalPaused` into the
  catch-all `default: return` with **no `never` exhaustiveness guard**
  (`StreamSnapshotStore.ts:477-479`). Current behavior is correct (`goalPaused` is an
  intended no-op for the snapshot store), but this is the exact CLAUDE.md
  §"Silent degradation is a defect" `default: return` pattern: adding a new run-fact
  type to the subscription `types` list will silently no-op here with no compile
  error. The sibling `TexraTranscriptRecorder.ts:644-648` does the same switch
  correctly with `const _exhaustive: never = event`. **Fix (recorded, not applied):**
  give `goalPaused` its own explicit `return` (documenting the intentional no-op) and
  make `default` a `never` assertion. Not previously on the record. (The session-fact
  switch at `:520` also uses bare `default: return`, but it filters an unfiltered
  `{scope:'session'}` subscription, so ignoring unsubscribed facts there is expected
  — lower severity, noted for completeness.)
- **[NEW] §New-15 — inconsistent "a subscriber threw" policy across the three buses.
  (S.)** `TraceEmitter.emit` logs a throwing subscriber at **`debug`**
  (`TraceEmitter.ts:88`); `SessionEventHub.emit` logs the same at **`warn`**
  (`SessionEventHub.ts:125`); `AppSignals.emit` **re-throws** (`AppSignals.ts:93`).
  The `debug` level in `TraceEmitter` is quiet degradation per the same guardrail
  ("log the cause at warn"). Recommend `warn` for the trace bus to align the two
  fan-out buses; the `AppSignals` re-throw is a deliberate different contract and
  stays. Small, recorded.
- **[NEW] §New-16 — `.catch('unknown')` on accounting-adjacent provider label.
  (S.)** `UsageMonitor.ts:273` does `UsageProviderSchema.catch('unknown').parse(...)`
  on a value that feeds `UsageLogService.log` (billing). Provider is a *label*, not
  the metered quantity, so risk is low — but it is a Zod `.catch` on data flowing to
  accounting, exactly the class the schema guardrail says to scrutinize. Flag and
  confirm intent; likely fine, but should be a loud `warn`-and-default rather than a
  silent `.catch` per the guardrail.
- **[NEW] §New-17 — small model-handler tidy-ups (S each, recorded).**
  (a) `withReasoningOverride` (`ModelFactory.ts:154`) is a genuine single-production-
  caller wrapper (one call at `:360`) — inline candidate per the "single-caller
  extractions are banned" guardrail; the *other* `ModelFactory` wrappers are
  multi-caller and stay. (b) `createBatchedToolUseFollowUpMessages` is implemented on
  **6** concrete handlers (openai, openrouter, google×3, vscodelm) and **0** on the
  base; promoting it to the base with a default (wrap the single-call
  `createToolUseFollowUpMessages`, exactly as `GoogleModelHandlerBase.ts:270-287`
  already does) would delete the port's one hand-authored `&{}` extension
  (`IModelHandler.ts:103`) and the `ToolUseDispatchNode.ts:664` feature-probe, keeping
  the `requiresBatchedParallelToolResults` gate. (c) `config`/`capabilities` are
  `public` mutable on the base (`ModelHandler.ts:212-213`) and picked into the port,
  with `ModelFactory.ts:168` mutating `capabilities.reasoningEffort` post-construction
  — an SDK boundary would expose these read-only and fold the reasoning override into
  construction (pairs with (a)).
- **[NEW] §New-18 — two projectors re-derive the same run facts. (M; consolidation
  candidate.)** `StreamSnapshotStore.attachSessionEvents` (durable sidecar) and
  `ProgressFactApplier` (live webview state) both consume the same
  `updateTodos/updatePlan/addOutputFiles/updateMissingOutputs/updateCompileFailures/usage`
  allowlist and accumulate near-identical state, each maintaining its own switch
  against the hand-maintained `RUN_FACT_EVENT_TYPES` array (`events.ts:374-387`). The
  persist-vs-live split is legitimate, but the dispatch logic is duplicated. A typed
  dispatch map keyed off the union (making an omitted arm a compile error) would fix
  both the duplication and the §New-14 class of silent-drop at once. Recorded as a
  consolidation target, not a drive-by.

## Subagent boundaries (task item 4) — the seams already exist, re-affirmed

Unchanged from `-07-30`; the flows/subagent deep-dive independently re-derived the
same conclusion: SDK-readiness here is an **exposure** problem, not a build problem.
The seams, at HEAD:

1. **`ChildRunStrategy<TTurn>` is THE subagent seam (split point #1).** One
   host-agnostic driver `startChildRunLoop` (`childRunLoop.ts`) runs four concrete
   strategies (native subagent, codex CLI, claude CLI, workflow-script). A future
   external-agent SDK is a new `ChildRunStrategy` passed to the same loop — publish
   `ChildRunStrategy` + `startChildRunLoop` + `ChildRunPorts`.
2. **`nativeSubagentStrategy` is the "run a TeXRA agent as a subagent" adapter
   (split point #2)** — `launch` wraps `executeAgent`, `runTurn` wraps
   `resumeToolUseFromResumeData`. This is why `executeAgent`'s low production-caller
   count (2) is **not** an inline signal — folding it into `runAgent` would break the
   subagent engine's ability to reuse the run engine without re-registering. The
   runtime deep-dive independently confirmed the two-production-caller count and the
   "not a second public door" reading.
3. **Lineage/detach seam (split point #3):** `registerExecution(…, parentExecutionId)`
   + `executionRegistry` child-activation tracking +
   `detachActiveChildren`/`interruptActiveChildren`, with `detachSubagentsOnStop()`
   one clean policy read.
4. **Core-level boundary:** `runToolUseFlow({ isSubagent })` + `ToolUseWaitNode`
   suspends the persisted flow at `FlowTransition.WAITING`; the tool call is the right
   SDK granularity for a nested agent.
5. **Cleanest micro-subagent candidates: the helper-model one-shots.** Callers share
   `createHelperModelKit` + `runHelperModelCompletion` (`helperModel.ts`), each an
   already-`try/catch`-guarded, non-streaming, single-shot near-pure function of
   config (session description, text polish, LaTeX text-connection, agent-YAML
   generation). Almost no coupling to break — the lowest-risk first "SDK sub-task"
   surface.
6. **`agentCreator` (`runAgentCreator`) — isolated linear function, host-UI coupled.**
   Already VS Code-free behind an injected `AgentCreatorUI` port; the AI core
   (`generateAgentYaml`) is already pure. Coupling to break for headless use: a
   non-interactive `AgentCreatorUI` implementation.
7. **The load-bearing non-abstractable coupling:** parent-delivery routes results back
   through the parent's follow-up queue in-process (#8093). A distributed-subagent SDK
   must replace this in-process handoff with IPC/RPC; the current design does not (and
   need not yet) abstract it. Flag it so the seam is not assumed free.

Recommended sequencing (unchanged): land the north-star **R-a fence** (§New-12) →
stabilize `ChildRunStrategy` as the public subagent contract → expose the
helper-model one-shots as a headless sub-task API → give `agentCreator` a
non-interactive UI port → leave the intra-run flow seams in-process.

## Notable strengths (unchanged, re-affirmed)

- The SDK target shape is implemented and honest (`packages/agent`).
- The `platform()` port is genuinely SDK-grade — runtime touches it in only 4
  files / 8 sites, `Platform` is a frozen composition root of ~14 typed ports each
  with a documented single-implementer fallback, and `nodePlatform()`
  (`packages/agent/src/node.ts`) is a complete working default. Strongest part of the
  readiness story.
- `createResponse`/`extractResponse` Template Method (`ModelHandler.ts`) is textbook
  — the one clean provider contract to keep as the SDK core; the 16 abstract members
  are a reasonable "implement a new provider" surface (documenting them as *the*
  provider contract is a cheap surface win).
- `IModelHandler = Pick<ModelHandler>` prevents port drift by construction; all 43
  members are called through it. The problem is width (flow-layer demand) and
  ownership direction (§New-13), not derivation.
- The OpenAI-compatible subclasses carry real per-provider behavior; the
  `ReasoningModelHandlerOpenAI` and `GoogleModelHandlerBase` intermediate bases are
  correct multi-subclass factorings. Do not data-drive these away.
- `node/index.ts` is SDK-grade minimal — no dead PocketFlow surface.
- The three buses (`AgentEvent` run-scoped / `SessionFact` session-scoped /
  `AppSignals` process-scoped) are genuinely distinct by lifetime and type-separated
  (`SessionEvent = {scope:'run', …} | {scope:'session', …}`) — none should collapse;
  `AppSignals` (11 emit sites, all auth/subscription/tool/workspace) shows no
  run/session leakage. The `attachRunTrace` trace→hub bridge is justified layering
  (per-`streamId`/per-`type` filtering the trace lacks), not double-emission.
- `logUtils` staying **off** the `Platform` object is defensible — channel output is
  a host-injected redacting text sink, a different concern from the structured
  `Platform` ports, and `log` facts already ride the `AgentEvent` stream (`type:'log'`).
  The runtime/logging deep-dives agree this is the sharpest SDK-shape *question*, not
  a redundancy to delete.

## No change lands (by design this pass)

Consistent with every unattended checkpoint since `-07-22`, and reinforced by
`-07-30`'s live-authorized census finding the "already-do" subset empty of clean
mechanical wins. Even the smallest candidates this pass could see —
§New-17(a) (`withReasoningOverride` inline), §New-15 (trace log-level), §New-14 (the
one defect) — are **not applied**: each wants an out-of-pass reviewer, and §New-14 in
particular is a `default:`-branch reshape that should sequence with §New-18's typed
dispatch map rather than be spot-patched. `MapToolRegistry` re-checked and still
`Map | Record` — **do not re-attempt the narrowing without a deliberate
compatibility boundary for `Map` inputs.** The genuinely safe next steps remain the
*additive* ones the subagent-boundaries and §New-12 sections name (land the R-a
fence; publish `ChildRunStrategy`; expose the helper-model one-shots) — capability
added without touching the tested invariants above.

## Coverage gaps (honest scope of this pass)

- Alignment against the live `code.claude.com/docs/en/agent-sdk` docs was **not**
  re-fetched; the standing verification is carried forward.
- No commit-by-commit audit of the 71-commit `8116ce9..HEAD` range — a fresh state
  inspection at HEAD reconciled against the standing record instead.
- The headline claims were independently re-verified this pass by direct grep/read at
  HEAD: the 43-member `Pick`, 0 vscode/packages imports, 0 cycle-schema parses,
  `MapToolRegistry` shape, the ceiling leaks, §New-8/§New-9 presence, the
  `createChannelTrace` 27-non-test count, the §New-14 `default: return` fall-through
  (read directly), the §New-17 single-caller/base-absence/mutable-field claims, and
  the §New-12 build-ships/R-b-ratchet-exists/R-a-absent status. §New-13/§New-18 are
  design-judgment framings, cited to file:line but not re-derived exhaustively.
- This checkpoint lives under `docs/proposals/` (internal, excluded from the
  texra.ai publish allowlist) — not a root-level doc, so it does not touch the
  `docs-root-boundary` gate.
</content>
</invoke>
