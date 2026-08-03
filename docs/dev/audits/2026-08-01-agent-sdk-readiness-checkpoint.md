# Agent SDK Readiness — Verification Checkpoint (2026-08-01)

**Status:** Verification checkpoint. Read alongside the immediately prior
[`2026-07-30-agent-sdk-readiness-checkpoint.md`](./2026-07-30-agent-sdk-readiness-checkpoint.md)
(this pass reconciles against its §New-8…§New-11 and [TRACKED] items rather than
re-deriving them), the foundation-gap analysis
[`2026-07-26-agent-sdk-foundation-gap.md`](../../proposals/2026-07-26-agent-sdk-foundation-gap.md)
(§9 the real ceiling), the audit of record
[`../dev/audits/2026-07-25-agent-sdk-readiness-audit.md`](./2026-07-25-agent-sdk-readiness-audit.md),
the plan of record [`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md)
(§4 sequenced path, §5 verified traps), and the `-06-25` → `-07-30` checkpoint chain.

This pass inspected the tree afresh at HEAD `6ab67ce`
(`Merge pull request #9503 from LionSR/fix/9409-windows-ci`; `CHANGELOG.md`
heading `[Unreleased]`; package version `0.40.0`). The `-07-30` checkpoint pin
`8116ce9` **is** in HEAD's ancestry (`git merge-base --is-ancestor` succeeds,
and `git merge-base` returns that checkpoint itself). `git rev-list --count
8116ce9..HEAD` reports **71 descendant commits**. This
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
return` fall-through in `StreamSnapshotStore` (§New-14) — a bare-default form of
CLAUDE.md's §"Silent degradation is a defect" pattern that is **not**
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
  (`packages/extension/src/commands/agent/agentCreatorCommands.ts:220`);
  CLAUDE.md's "not a flow" note is accurate.
- `node/index.ts` flow engine carries **no** upstream-PocketFlow dead surface —
  `grep` for `BatchNode|ParallelBatch|setParams|\.params` over `node/` +
  `core/flows/` + `implementations/` returns **0**.
- Inner-cycle snapshot schemas still **never validated**: `grep` for `.parse` /
  `.safeParse` on `CycleFieldsSchema` / `BaseCycleFieldsSchema` /
  `ToolUseRoundFieldsSchema` returns **0** (re-verifies standing §New-1).

## Remaining gaps — the real ceiling (§9), re-verified present at HEAD

Unchanged in substance from `-07-30`; all still present:

1. **Shared tool registry mutation is still closed, but per-run injection is public.**
   `IToolRegistry = { get, has }` (`ToolTypes.ts:41-44`) exposes no `register`, and
   built-ins remain hard-coded in `createDefaultTools()`. However, an embedder can
   add tools for a run through `RunAgentInput.tools` (`packages/agent/src/index.ts:60`),
   which `runAgent` forwards at `:275` and the tool-use flow overlays onto the
   registry. The remaining question is only whether a process-wide mutable registry
   is needed; it is not a missing foundation capability.
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
   frozen by the #7684 **R-b freeze ratchet**
   (`config/ratchets/host-agent-import-baseline.json`), and there is no Tier-1
   manifest yet. The north-star **R-a host-layer fence is already in place** in
   `eslint.config.mjs:532-549`; see the corrected status in §New-12.

## Deep-dive findings — reconciled against the standing record

Each finding is tagged **[TRACKED]** (already on the record; do not re-file as new)
or **[NEW]** (not previously named in the checkpoint chain, to the best of this
pass's reading). All are recorded for an attended maintainer pass; none are applied
here.

### Already-tracked — re-affirmed present, cited for completeness

- **[TRACKED] Model-handler base → collaborator extractions (standing §9.3).**
  Re-verified. `ModelHandler.ts` is **1986 LOC** at HEAD; the file is a Template
  Method base (15 abstract members are the true "implement a new provider"
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
  "single-caller extractions are banned" guardrail; the `RunScope` _interface_
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
- **[TRACKED] §New-9 — one stream-status transition has three delivery paths.** Re-verified:
  `StreamStatusService.publishStatus` still fans a single transition to the `status`
  `AgentEvent` trace, the `updateStreamStatus` `SessionFact` (`:308`), and the
  direct `statusListeners` set (`:312`). These paths serve distinct consumers:
  trace recording, session-fact observers, and synchronous status listeners used by
  the status bar, window title, TUI, and execution registry. No redundant consumer
  or effect was identified, so this checkpoint records the topology but does not
  recommend deduplication.
- **[TRACKED] `createChannelTrace` fabricates an inert `AgentTrace` as a module
  logger.** A defined census finds **24** non-test module-scope
  `const … = createChannelTrace(...)` declarations. A broader file-level search
  finds **35** non-test files invoking the factory; tests contain three local trace
  constructions rather than one module singleton. The narrower 24-declaration
  population is the relevant module-logger cleanup scope.
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
  (`IToolUseSession.ts:4`), and `CommonCycleTypes` importing
  `@agent/index/agentRegistry`
  (`:6`) and `@tools/delegation/subagentResults` (`:19`). All host-agnostic (no `vscode`,
  no `packages/*`) and **pre-acknowledged** by the core README as the
  canonical-collaborator pattern, not a defect — recorded as accepted debt that a
  future `@agent/core` package boundary would need to resolve, not a fresh finding.

### New this pass — recorded for maintainer re-derivation

- **[NEW] §New-12 — the build and both import-boundary fences exist; npm publication
  does not. Reconcile the claim.** CLAUDE.md/AGENTS.md (`AGENTS.md:91-92`) say hosts
  import core through path aliases "until a future SDK surface is enforced with a
  build and import-boundary lint gate." At HEAD, `packages/agent` is a locally
  build-ready `@texra-ai/agent` v0.40.0 package with build, bundle,
  declaration-rewrite, and artifact-validation scripts
  (`packages/agent/scripts/{build,bundle,rewrite-declaration-aliases,validate-artifacts}.mjs`).
  It is **not published to npm**: `.github/workflows/release.yml:153-158` explicitly
  marks the publish job "NOT PUBLISHED YET" and disables it with `false &&`. The
  lint gate is also more complete than the initial deep-dive reported: the #7684
  **R-b freeze ratchet** exists in
  `config/ratchets/host-agent-import-baseline.json`, and the north-star **R-a
  host-layer fence** exists in `eslint.config.mjs:532-549`, applying
  `no-restricted-imports` to production `src/**` and `packages/agent/src/**` while
  excluding `src/test-kernel/**`. The remaining boundary work is the Tier-1 public
  manifest and reduction of frozen host deep imports, not another R-a rule.
- **[NEW] §New-13 — `IModelHandler` port ownership is inverted for external
  authorship (strategic, design-judgment — do not treat as mechanical).** The model
  handler deep-dive's sharpest surface observation: the port is a `Pick` _projection_
  of the 1986-line concrete base (`IModelHandler.ts:35-42`), so the base is the
  source of truth and the interface derives from it. This is exactly what prevents
  drift (standing §9 item 3) and must not be "fixed" by trimming the `Pick`. But for
  a genuinely _external_ provider author, the direction is backwards: they cannot
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
  intended no-op for the snapshot store), but the bare default still permits a new
  subscribed run fact to disappear silently. This is the CLAUDE.md
  §"Silent degradation is a defect" `default: return` pattern: adding a new run-fact
  type to the subscription `types` list will silently no-op here with no compile
  error. The sibling `TexraTranscriptRecorder.ts:644-648` uses a narrowed event union
  and a `never` assertion. Here, `SessionEventHub.subscribe` still types the callback
  as the full `SessionEvent`; its runtime `types` filter does not narrow the callback
  type. **Fix direction (recorded, not applied):** give `goalPaused` an explicit no-op,
  then introduce either a selected-event callback type or an exhaustive handler map
  before adding a `never` assertion. Adding the assertion alone would not type-check.
  Not previously on the record. (The session-fact
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
- **[NEW] §New-16 — `.catch('unknown')` is an intentional telemetry vocabulary
  boundary.** `UsageMonitor.ts:273` applies
  `UsageProviderSchema.catch('unknown').parse(...)` to the internally resolved
  `ModelConfig.provider`. The telemetry schema is deliberately narrower than the
  model-provider vocabulary and includes an explicit `unknown` bucket. The fallback
  changes only the provider label, not tokens, cost, or route; warning on every round
  for a newly supported provider would create noise until telemetry catches up. No
  change is recommended.
- **[NEW] §New-17 — small model-handler tidy-ups (S each, recorded).**
  (a) `withReasoningOverride` (`ModelFactory.ts:154`) has one production caller at
  `:360`, but it is not a trivial wrapper: it checks capability, reads and translates
  configuration, logs the selected level, mutates the handler, and preserves chaining.
  It is a cohesive helper allowed by the single-caller guardrail and should remain.
  (b) `config`/`capabilities` are `public` mutable on the base
  (`ModelHandler.ts:212-213`) and picked into the port, with `ModelFactory.ts:168`
  mutating `capabilities.reasoningEffort` post-construction — an SDK boundary would
  expose these read-only and fold the reasoning override into construction (pairs
  with (a)). The optional `createBatchedToolUseFollowUpMessages` extension stays:
  its batched signature has no provider-client argument, whereas the base
  `createToolUseFollowUpMessages` requires one, and `GoogleModelHandlerBase` correctly
  delegates single-call handling to its provider-specific batched primitive rather
  than providing the reverse generic adapter.
- **[NEW] §New-18 — the progress path already shares one snapshot owner; narrow the
  finding to §New-14.** `ProgressViewState` receives `session.snapshots` directly
  (`ProgressViewState.ts:159-179`), and `ProgressFactApplier` reads from that same
  `StreamSnapshotStore`; the store remains the sole snapshot owner and updater, so
  the progress layer does not maintain a second accumulated copy. Its run-fact
  dispatch is already an exhaustive `RunFactHandlers` map
  (`ProgressFactApplier.ts:85-92,123-180`), not a duplicate switch. Therefore there
  is no projector-consolidation target here. The actionable exhaustiveness gap is
  only the remaining switch in `StreamSnapshotStore` described by §New-14.

## Subagent boundaries (task item 4) — the seams already exist, re-affirmed

Unchanged from `-07-30`; the flows/subagent deep-dive independently re-derived the
same conclusion: SDK-readiness here is an **exposure** problem, not a build problem.
The seams, at HEAD:

1. **`ChildRunStrategy<TTurn>` is the internal subagent reuse seam (split point
   #1), not yet a publishable external contract.** One driver `startChildRunLoop`
   (`childRunLoop.ts`) runs four concrete strategies (native subagent, codex CLI,
   claude CLI, workflow-script), but it also requires an owned execution lease and
   `currentSession()`, exposes internal child/execution/stream/result-metadata types,
   and directly invokes TeXRA persistence and parent-delivery helpers. An external
   SDK must first extract those dependencies behind public ports; exporting
   `ChildRunStrategy` + `startChildRunLoop` alone would not make the loop usable.
2. **`nativeSubagentStrategy` is the "run a TeXRA agent as a subagent" adapter
   (split point #2)** — `launch` wraps `executeAgent`, `runTurn` wraps
   `resumeToolUseFromResumeData`. This is why `executeAgent`'s low production-caller
   count (2) is **not** an inline signal — folding it into `runAgent` would break the
   subagent engine's ability to reuse the run engine without re-registering. The
   runtime deep-dive independently confirmed the two-production-caller count and the
   "not a second public door" reading.
3. **Lineage/detach seam (split point #3):** `registerExecution(…, parentExecutionId)`
   - `executionRegistry` child-activation tracking +
     `detachActiveChildren`/`interruptActiveChildren`, with `detachSubagentsOnStop()`
     one clean policy read.
4. **Core-level boundary:** `runToolUseFlow({ isSubagent })` + `ToolUseWaitNode`
   suspends the persisted flow at `FlowTransition.WAITING`; the tool call is the right
   SDK granularity for a nested agent.
5. **Helper-model one-shots are a candidate only after their ambient dependencies are
   made explicit.** Callers share
   `createHelperModelKit` + `runHelperModelCompletion` (`helperModel.ts`), each a
   non-streaming, single-shot operation used for session description, text polish,
   LaTeX text connection, and agent-YAML generation. They are not near-pure:
   `createHelperModelKit` defaults to ambient `currentSession()`, reads process-wide
   platform configuration and availability state, resolves the runtime model registry,
   and exposes an internal `ModelHandler`; `runHelperModelCompletion` performs the
   provider request and lets terminal failures escape after retry. A public sub-task
   needs a stable higher-level result plus explicit session, platform, and model ports.
6. **`agentCreator` (`runAgentCreator`) — isolated linear function, host-UI coupled.**
   Already VS Code-free behind an injected `AgentCreatorUI` port; the AI core
   (`generateAgentYaml`) is already pure. Coupling to break for headless use: a
   non-interactive `AgentCreatorUI` implementation.
7. **The load-bearing non-abstractable coupling:** parent-delivery routes results back
   through the parent's follow-up queue in-process (#8093). A distributed-subagent SDK
   must replace this in-process handoff with IPC/RPC; the current design does not (and
   need not yet) abstract it. Flag it so the seam is not assumed free.

Recommended sequencing: define the Tier-1 public manifest and reduce the frozen host
deep-import surface (§New-12) → extract the child-run loop's session, lease,
persistence, and parent-delivery dependencies behind public ports → stabilize the
resulting external subagent contract → expose the helper-model one-shots as a
headless sub-task API → give `agentCreator` a non-interactive UI port → leave the
intra-run flow seams in-process.

## Notable strengths (unchanged, re-affirmed)

- The SDK target shape is implemented and honest (`packages/agent`).
- The `platform()` port is structurally promising — runtime touches it in only 4
  files / 9 direct call sites (two in `SessionHandle`, one in `AgentRunLifecycle`,
  two in `helperModelName`, and four in `ModelFactory`). `Platform` is a frozen
  composition root of roughly 14 typed ports, and `nodePlatform()`
  (`packages/agent/src/node.ts`) supplies a complete working implementation. The
  interface documents a single-implementer fallback only for optional
  `toolMissingHandler`; it does not promise a fallback for every port.
- `createResponse`/`extractResponse` Template Method (`ModelHandler.ts`) is textbook
  — the one clean provider contract to keep as the SDK core; the 15 abstract members
  are a reasonable "implement a new provider" surface (documenting them as _the_
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
  The runtime/logging deep-dives agree this is the sharpest SDK-shape _question_, not
  a redundancy to delete.

## No change lands (by design this pass)

Consistent with every unattended checkpoint since `-07-22`, and reinforced by
`-07-30`'s live-authorized census finding the "already-do" subset empty of clean
mechanical wins. Even the smallest candidates this pass could see —
§New-15 (trace log-level) and §New-14 (the one defect) — are **not applied**:
each wants an out-of-pass reviewer. §New-14 is now deliberately narrow: make the
intentional `goalPaused` no-op explicit, then establish a selected-event type or
exhaustive handler map before adding a `never` assertion. `MapToolRegistry` remains
`Map | Record`; **do not re-attempt the narrowing without a deliberate compatibility
boundary for `Map` inputs.** The genuinely safe next steps remain additive or
boundary-first: define the Tier-1
manifest, extract the child-run loop's internal dependencies behind public ports,
and expose the helper-model one-shots without touching the tested invariants above.

## Coverage gaps (honest scope of this pass)

- Alignment against the live `code.claude.com/docs/en/agent-sdk` docs was **not**
  re-fetched; the standing verification is carried forward.
- No commit-by-commit audit of the 71-commit `8116ce9..HEAD` range — a fresh state
  inspection at HEAD reconciled against the standing record instead.
- The headline claims were independently re-verified this pass by direct grep/read at
  HEAD: the 43-member `Pick`, 0 vscode/packages imports, 0 cycle-schema parses,
  `MapToolRegistry` shape, the ceiling leaks, §New-8/§New-9 presence, the
  defined `createChannelTrace` census (24 non-test module-scope declarations; 35
  non-test invoking files), the §New-14 `default: return` fall-through (read directly),
  the §New-17 mutable-field claim and cohesive-helper assessment, the §New-12
  build-ready-but-unpublished/R-b-and-R-a-landed status, and the shared snapshot
  ownership correction in §New-18. §New-13 is a design-judgment framing, cited to
  file:line but not re-derived exhaustively.
- This checkpoint lives under `docs/proposals/` (internal, excluded from the
  texra.ai publish allowlist) — not a root-level doc, so it does not touch the
  `docs-root-boundary` gate.
