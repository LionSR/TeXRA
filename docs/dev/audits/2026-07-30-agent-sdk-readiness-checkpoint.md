# Agent SDK Readiness — Verification Checkpoint (2026-07-30)

**Status:** Verification checkpoint. Read alongside the immediately prior
[`2026-07-29-agent-sdk-readiness-checkpoint.md`](./2026-07-29-agent-sdk-readiness-checkpoint.md)
(this pass reconciles against its §New-1…§New-7 and [TRACKED] items rather than
re-deriving them), the foundation-gap analysis
[`2026-07-26-agent-sdk-foundation-gap.md`](../../proposals/2026-07-26-agent-sdk-foundation-gap.md)
(§6 absorption sequence, §7 acceptance criteria, §9 the real ceiling), the audit
of record [`../dev/audits/2026-07-25-agent-sdk-readiness-audit.md`](./2026-07-25-agent-sdk-readiness-audit.md),
the plan of record [`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md),
and the `-06-25` → `-07-29` checkpoint chain.

This pass inspected the tree afresh at HEAD `8116ce9`
(`Stop bundling the Codex and Claude Code CLIs in the desktop app (#9396)`;
`CHANGELOG.md` heading `[Unreleased]`; package version bumped to `0.40.0` at
`f7c3958`). The `-07-29` checkpoint pin `25c0cb1` **is** an ancestor
(`git merge-base --is-ancestor` succeeds); `git rev-list --count 25c0cb1..HEAD`
reports **15 commits**. This pass re-inspected the tree at HEAD and reconciled
against the standing record; it did not perform a commit-by-commit audit of that
range.

**Run context (honesty note).** This was an **unattended scheduled run** with **no
external adversarial review available**. It therefore applies **no code change** —
see "No change lands." The discipline is the one every checkpoint since `-07-22`
has held: this class of refactor needs a reviewer outside the pass's own
analysis (the `-07-22` applied-then-reverted `MapToolRegistry` mistake is the
worked example), which an unattended run lacks. Method this pass mirrored `-07-29`:
four parallel read-only deep-dives (model handlers, agent core + flows +
subagent boundaries, runtime + public surface, logging + trace), each returning
file:line-cited findings, reconciled here against the standing record so
already-tracked items are not re-filed as fresh.

## Verdict — well-aligned; two genuinely new structural observations

**The codebase remains well-aligned and SDK-ready in shape; no new structural
refactoring is warranted from an unattended pass.** The core-shape conclusion
every checkpoint since `-06-26` has reconverged on holds unchanged. The
`packages/agent` public surface — `runAgent(input): AgentRun` where
`AgentRun extends AsyncIterable<AgentEvent>` + `{ result, interrupt() }`
(`packages/agent/src/index.ts:71-74,201`) — **is** the north-star
`run(agent, input) -> stream/result` shape, still implemented and still honest
about what it cannot yet do (approval tools rejected `:207`; interactive retry
denied `:231`).

**Movement is happening through the correct (attended) channel.** The 15 commits
since `-07-29` include the `-07-29` checkpoint's own two safe base-`ModelHandler`
trims landing as `#9378`, a silent-validation-fallback fix + two data-shape
simplifications (`#9379`, directionally §New-2/§New-6 territory), and several
dedup refactors (`#9377`, `#9380`, `#9381`, `#9382`, `#9388`). This is exactly
the maintainer-reviewed absorption the checkpoint chain prescribes.

**The two items worth surfacing that the `-07-29` chain did not name:** the
**triple-encoded compatibility-key dispatch** in `ModelFactory` (§New-8), and the
**four-way status-transition emission** in `StreamStatusService` (§New-9). Both
are structural simplification opportunities, not defects, and — like everything
else here — are recorded, not applied.

## Spine invariants — re-verified at HEAD `8116ce9`

- `src/agent/core/index.ts` **absent** (no barrel regression).
- `IModelHandler = Pick<ModelHandler<…>>` (`src/agent/types/IModelHandler.ts:41`),
  **43** picked members — unchanged from `-07-29`. The model-handler deep-dive
  independently verified **all 43 are called through a port-typed value** (held as
  `AgentCore.modelHandler` in `BaseFlowServices.ts` and threaded through the cycle
  services); no picked-but-unused member, no consumer reaching around the port to
  the concrete class for a picked member. The port width is real flow-layer
  coupling, not over-abstraction.
- `Node.exec → createFlow().run` shape intact: `ResponseCycleNode.exec()` /
  `ToolUseCycleNode.exec()` create and run the inner cycle flow inline, no wrapper.
- **0** `vscode` imports across all declared VS Code-free zones (`src/agent`,
  `model`, `latex`, `tools`, `controllers`, `shared`, `replacement`, `eventBus`,
  `hosts`, `logger`).
- `MapToolRegistry` still `Map<string, ITool> | Record<string, ITool>` with the
  `instanceof Map` branch (`ToolTypes.ts:50-51`) — the reverted `-07-22`/`-07-23`
  state, correctly not re-attempted.
- `agentCreator/` still contains **0** `Node`/`Flow`/`@agent/node` references — a
  linear async function with a single production caller
  (`agentCreatorCommands.ts:224`), independently re-confirmed; CLAUDE.md's "not a
  flow" note is accurate.
- `node/index.ts` flow engine carries **no** upstream-PocketFlow dead surface —
  `grep` for `BatchNode|ParallelBatch|setParams|\.params` over `node/` +
  `core/flows/` + `implementations/` returns **0**. The `params`/`setParams`
  channel genuinely does not exist; deps flow through the typed `Svc` services
  generic instead.

## Remaining gaps — the real ceiling (§9), re-verified present at HEAD

Unchanged in substance from `-07-29`; all still present:

1. **Tool registry still closed.** `IToolRegistry = { get, has }`
   (`ToolTypes.ts:41-44`), no public `register`; tools hard-coded in
   `createDefaultTools()`. An embedder cannot add a tool. Correctly last on LoC,
   first on foundation.
2. **Product types still leak into the runtime launch path.** `toolConfig`
   LaTeX booleans; `AgentFlowResult.compileFailures`;
   `RunAgentOptions.preferHelperModel` (`runAgent.ts:54,82`); TeXRA-domain
   `AgentEvent` arms (`updateCompileFailures`, `updateMissingOutputs`,
   `goalPaused`) riding the generic union rather than the `domain` escape hatch.
3. **`IModelHandler` port width (43) and `SdkToolCall` vendor-type embedding**
   remain the standing strategic port-shape item. Still auto-derived
   `Pick<ModelHandler>`, so surface shape, not drift. The real lever is
   **reducing what the flow layer demands of the handler**, not trimming the
   `Pick` (which would only force concrete-class reach-arounds) — see §New-8's
   sibling note.
4. **NS-1 host→core public surface.** Hosts still reach `@agent/*` deep
   specifiers frozen by the enforcing ratchet; no Tier-1 manifest yet.
5. **Partial: `stateOwnership` not fully retired** — carried forward from
   `-07-29`'s "Movement" section; absorption proceeding through the attended
   channel.

## Deep-dive findings — reconciled against the standing record

Each finding is tagged **[TRACKED]** (already on the record; do not re-file as
new) or **[NEW]** (not previously named in the checkpoint chain, to the best of
this pass's reading). Effort S/M/L. All are recorded for an attended maintainer
pass; none are applied here.

### Already-tracked — re-affirmed present, cited for completeness

- **[TRACKED] Model-handler base → collaborator extractions (standing §9.3).**
  Re-verified. **Honesty correction to the "2068-LOC god class" framing:** the
  file is 2025 LOC at HEAD, but **~39% (~785 lines) is comment/blank** — chiefly
  the `#7101`-triage doc blocks that record _why_ each capability getter stays
  overridable. The _logical_ class is ~1200 lines. The clearest genuine
  extraction remains the **credential/route cluster** (`ModelHandler.ts:208-702`:
  a `WeakMap` + two route fields + ~13 methods operating only on those fields and
  `this.config`) into a `ClientCredentialRouter` collaborator the handler _holds_.
  Caveat that keeps it off the mechanical-lift list: the credential state is
  threaded into the `createResponse` template (`:1130-1136`, `getBaseUrl` reads
  the active route at `:687`), so the collaborator must expose an active-route
  setter back to the template. The ~10 single-override predicate getters are
  **settled work (#7101)** — do not re-litigate.
- **[TRACKED] `createChannelTrace` fabricates an inert `AgentTrace` to serve as a
  module logger.** Re-verified: **27** non-test module singletons at HEAD do
  `const logger = createChannelTrace('X')` and only ever call
  `debug/info/warn/error`, paying for an object whose structured methods
  (`emit`/`openStage`/`openStream`) are silently no-ops — a mild
  silent-degradation smell on top of the redundancy. Keep `createChannelTrace`
  only where a value is passed to an `AgentTrace`-typed parameter (e.g.
  `ExecutionSubscriptionBinder`'s `BinderLogger`, `logCompactionEvent`); convert
  the pure module-logger singletons to the functional `logger.*(channel, …)` API.
  One caller must stay exempt: `ModelHandler.ts:291-292` needs the full
  `TraceEmitter` for `openStream` before the per-run trace is swapped in. Standing
  `-07-08`/`-07-12`/`-07-18` + logger-surface-cleanup item.
- **[TRACKED] `@agent/index` barrel conflates run vs manage (NS-1, §9.4).**
  Unchanged; splitting "run" (load/resolve) from "manage" (roster/directory) is
  the surface question seen from the registry side.
- **[TRACKED] §New-1 (`-07-29`) — inner non-persisted cycle flows are ceremony
  over a while-loop.** Re-verified the load-bearing factual claim: `grep` for
  `.parse`/`.safeParse` on `CycleFieldsSchema` / `BaseCycleFieldsSchema` /
  `ToolUseRoundFieldsSchema` returns **0** at HEAD — the inner-cycle snapshot
  schemas are still never validated. Collapsing each inner flow into its owning
  node's body remains the standout structural simplification; the boundary
  (outer persisted flows earn their node graph — the per-node cursor is the
  crash/resume granularity) and the caveat (these flows are the main vitest seam,
  so it is a test-restructuring, not a deletion) both still hold.
- **[TRACKED] §New-2/§New-4/§New-5 (`-07-29`) — re-verified still present.**
  Canonical-vs-legacy snapshot twins: ~20 non-test `*CanonicalSchema` /
  `fromCanonicalSnapshot` references remain. `createRunScope` is still a one-line
  `Object.freeze` with a single production caller (`AgentLaunchContext.ts:393`).
  Both `createModelHandler` and `createModelHandlerForCompatibilityKey`
  (`ModelFactory.ts:427,457`) still delegate to the same impl. `#9379` moved in
  the §New-2/§New-6 direction but these specific twins/entrypoints are not yet
  retired.
- **[TRACKED] §New-7 (`-07-29`) — redaction path-stripping still not on the
  primary log sink.** Re-verified: the main output-channel sink still calls
  `redactSecrets(message)` with **no** `homeDir`/`workspacePath` options
  (`logUtils.ts:77`), so secret-token patterns are stripped everywhere but path
  redaction runs only in the desktop app-log export. Security-sensitive; stays
  recorded, not touched.

### New this pass — recorded for maintainer re-derivation

- **[NEW] §New-8 — the model-handler compatibility-key space is encoded three
  times. (M; the model-handler standout.)** The set of compatibility keys — and
  the key→handler mapping — lives in three parallel structures:
  (1) the `MODEL_HANDLER_COMPATIBILITY_KEYS` enum
  (`modelHandlerCompatibilityKey.ts:3-19`); (2) the `PROVIDER_HANDLER_ROUTES`
  record's `compatibilityKey` fields + lazy `load` loaders
  (`ModelFactory.ts:73-147`), which also encode routing _precedence_ at `:328`;
  and (3) the `switch (compatibilityKey)` at `ModelFactory.ts:595-663`, which
  special-cases `ModelHandlerOpenAIResponse` / `ModelHandlerGoogleInteractions` /
  `ModelHandlerOpenRouterNative` / `ModelHandlerValidation` outside the record and
  falls through (`:652`) to the record for the rest. Two structures over one key
  space, with instantiation split from routing. Concrete simplification: promote
  the four currently-special-cased keys into the same `{ load, compatibilityKey }`
  loader-table shape with per-key config-prep hooks (the OpenRouter
  `{ …config, openrouterFullName }` massaging and the
  `assertGoogleInteractionsRoutable` guard become hooks), collapsing the switch to
  "run the async Codex/Kimi/vscodelm-availability overrides, then
  `new (await ROUTES_BY_KEY[key].load())(…)`". Payoff is moderate (the switch is
  ~70 lines) — SDK-surface tidiness, not urgent. Distinct from §New-5, which is
  about the two _entrypoints_; this is about the _dispatch table_ behind them.
  Sibling note under standing §9.3: this is the same "the handler surface is wide
  because the runtime asks a lot of it" theme as the port width — the SDK lever is
  narrowing the demand, not the derived surfaces.
- **[NEW] §New-9 — one stream-status transition is emitted four ways. (M;
  considered duplication — confirm intent before cutting.)** `emitStatus`
  (`StreamStatusService.ts:306-328`) fans a single transition to: (1) a `status`
  `AgentEvent` on the run trace (`:316`); (2) an `updateStreamStatus` `SessionFact`
  on the session hub (`:319-325`); (3) the direct `statusListeners` callback set
  (`:326-328`). Because the `attachRunTrace` bridge re-broadcasts every run
  `AgentEvent` onto the hub, the `status` event _also_ reaches the hub — where the
  progress projectors filter it out (`status` is deliberately excluded from
  `RUN_FACT_EVENT_TYPES`) — while the semantically identical `updateStreamStatus`
  fact is separately published. So one transition has four representations. It
  exists because `TexraTranscriptRecorder` is trace-only (consumes the `status`
  arm) and the progress projectors are hub-only (consume the fact). The cleaner
  shape is one status rail: keep `status` on the trace and let the hub bridge
  project it (deleting the separate `updateStreamStatus` publish), the smaller of
  the two options and one that keeps the recorder trace-only. This is a
  **considered** duplication (documented at `events.ts:364-387`), not an
  accidental one — flag and confirm intent, do not assume a bug. It is the
  highest-value dedup in the observability surface, and `conversation.progress`
  (already single-rail via a session projector, `helpers.ts:200-215`) is the
  pattern to follow.
- **[NEW → RETRACTED] §New-10 — `polishModel.ts` is _not_ a naked single-caller
  extraction; do not merge it. (Corrected 2026-07-30 by a live-authorized census
  — see "Follow-up" below.)** The `-07-29` framing and the runtime deep-dive both
  read this as "`renderPolishPrompt` has one consumer (`textEnhancement`), so
  inline it and delete the file." A full census (including `.mts` tests, which a
  `*.ts` grep misses) shows `renderPolishPrompt`/`initializePolishModel` have a
  **dedicated unit suite** — `src/test-kernel/agent/PolishPromptLoader.vitest.mts`
  — that exercises the loader in isolation (real-YAML happy path + malformed-YAML
  error-wrapping), and `TextEnhancementSession.vitest.ts` additionally uses
  `polishModel` as a **mock seam** to keep the filesystem out of the session test.
  `polishModel` is therefore a cohesive, independently-tested prompt-loader unit,
  not a naked extraction; merging it either drops a real test seam or keeps
  `renderPolishPrompt` exported anyway (no surface gain) while scattering a
  separately-tested concern into its consumer. **Net-neutral-to-negative churn —
  leave `polishModel.ts` as its own file.** The broader placement observation (the
  runtime "content helpers" cluster is one-shot content generation that an SDK
  boundary would lift out of the launch layer) still stands as a _directional_
  note, but it is a deliberate relocation, not a file merge.
- **[NEW] §New-11 — `setLogger` mutable injection could be ambient trace via
  `RunScope`. (M; pairs with §New-4.)** The run trace is pushed into the model
  handler through `setLogger` at two production sites (`AgentLaunchContext.ts:329`
  at launch; `runToolUseFlow.ts:332` on mid-run model switch), which mutates two
  objects (`this.logger` **and** `mediaProcessor.setLogger`) and requires a
  placeholder `TraceEmitter` in the constructor because emit sites can be reached
  before the swap (the handler's own comment at `ModelHandler.ts:285-291` admits
  this). The run already executes inside a `withExecutionRunContext`
  `AsyncLocalStorage` scope whose `RunScope` carries `session` but not `trace`.
  Adding the trace to `RunScope` and resolving `this.logger ?? ambientTrace() ??
noopTrace` per emit deletes `setLogger`, the `MediaAttachmentProcessor.setLogger`
  re-wrap, the constructor placeholder, and the model-switch re-wire — **and**
  fixes the standing gap (audit `-05-29`) where `createHelperModelKit()` handlers
  never get a logger at all. Cost: emit-site reads must be per-call (the handler
  is reused across ALS scopes), so this rides on §New-4's `RunScope` reshape and
  should sequence with it.

The runtime deep-dive's result-shape observation is reconciled **under standing
§New-6**, not filed new: renaming the tool-use result fields
(`lastResponse`/`touchedFiles` → `response`/`files`) at the `AgentFlowResult`
tier collapses the 2→3 result transform and deletes the
`projectToolUseFinalTextFields` + `firstDefinedArray` SSOT helper
(`AgentFinalResult.ts:74-102`) plus the legacy-alias branches — the concrete
"unify results before freezing a public result type" step §New-6 named.

## Subagent boundaries (task item 4) — the seams already exist, re-affirmed

The subagent architecture remains the **strongest-factored part of the runtime**;
the flows/subagent deep-dive independently re-derived the `-07-29` conclusion:
SDK-readiness here is an **exposure** problem, not a build problem. The seams, at
HEAD:

1. **`ChildRunStrategy<TTurn>` is THE subagent seam (split point #1).** One
   host-agnostic driver `startChildRunLoop` (`childRunLoop.ts:499`) runs four
   concrete strategies: native subagent, codex CLI, claude CLI, workflow-script.
   A future external-agent SDK is exactly a new `ChildRunStrategy` passed to the
   same loop — publish `ChildRunStrategy` + `startChildRunLoop` + `ChildRunPorts`.
2. **`nativeSubagentStrategy` is the "run a TeXRA agent as a subagent" adapter
   (split point #2)** — `launch` wraps `executeAgent`, `runTurn` wraps
   `resumeToolUseFromResumeData`. This is why `executeAgent`'s low production-caller
   count is **not** an inline signal: folding it into `runAgent` would break the
   subagent engine's ability to reuse the run engine without re-registering.
3. **Lineage/detach seam (split point #3):** `registerExecution(…, parentExecutionId)`
   (persisted, `executionLifecycle.ts:127`) + `executionRegistry` child-activation
   tracking + `detachActiveChildren`/`interruptActiveChildren`, with
   `detachSubagentsOnStop()` one clean policy read. "Promote a subagent to a
   top-level run" is already a first-class operation.
4. **Core-level boundary:** `runToolUseFlow({ isSubagent })` + `ToolUseWaitNode`
   suspends the persisted flow at `FlowTransition.WAITING`; delegation tools
   (`delegate_workflow`, `delegate_agent`) dispatch through
   `tools/delegation/subagentExecution.ts` → `runToolUseFlow`. The tool call is the
   right SDK granularity for a nested agent.
5. **Cleanest micro-subagent candidates: the helper-model one-shots.** Five
   callers share `createHelperModelKit` + `runHelperModelCompletion`
   (`helperModel.ts`), each an already-`try/catch`-guarded, non-streaming,
   single-shot call that is a near-pure function of config: session-description
   generation (`sessionDescription.ts`), text polish (`textEnhancement.ts`),
   LaTeX text-connection (`textConnection.ts`), agent-YAML generation
   (`agentCreatorFlow.ts`). Almost no coupling to break — the lowest-risk first
   "SDK sub-task" surface.
6. **`agentCreator` (`runAgentCreator`) — isolated linear function, host-UI
   coupled.** Already VS Code-free behind an injected `AgentCreatorUI` port; the
   AI core (`generateAgentYaml`) is already pure. Coupling to break for headless
   use: a non-interactive `AgentCreatorUI` implementation (params-in, no prompts).
7. **The load-bearing non-abstractable coupling:** parent-delivery via
   `deliverTurn` → `submitPendingDelivery` (`childRunLoop.ts`) routes results back
   through the parent's follow-up queue with careful ordering (#8093). A
   distributed-subagent SDK must replace this in-process handoff with IPC/RPC; the
   current design does not (and need not yet) abstract it. Flag it so the seam is
   not assumed free.

Recommended sequencing (unchanged from `-07-29`): stabilize `ChildRunStrategy` as
the public subagent contract → expose the helper-model one-shots as a headless
sub-task API → give `agentCreator` a non-interactive UI port → leave the intra-run
flow seams (tool-use round vs turn, reflection round) in-process.

## Notable strengths (unchanged, re-affirmed)

- The SDK target shape is implemented and honest (`packages/agent`).
- `createResponse`/`extractResponse` template method (`ModelHandler.ts`) is
  textbook — the one clean provider contract to keep as the SDK core; the
  `createResponse` → `withCreateResponseGuard` → `createResponseImpl` +
  `sdkErrorTagger` chain is real shared logic (credential-route tracking, SDK-error
  tagging, pending-compaction cleanup), not indirection.
- `IModelHandler = Pick<ModelHandler>` prevents port drift by construction; all 43
  members are called through it. The problem is width (flow-layer demand), not
  derivation.
- The OpenAI-compatible subclasses (DeepSeek/Kimi/GLM/MiniMax/XAI) carry **real
  per-provider behavior**, not config; the `ReasoningModelHandlerOpenAI` and
  `GoogleModelHandlerBase` intermediate bases are correct multi-subclass
  factorings; DashScope (14 lines, one flag) is the lone config-only shell and is
  harmless. Do not data-drive these away.
- `node/index.ts` is SDK-grade minimal — no dead PocketFlow surface; the local
  engine is faster to read than upstream docs, as CLAUDE.md promises.
- The three buses (`AgentEvent` run-scoped / `SessionFact` session-scoped /
  `AppSignals` process-scoped) are genuinely distinct by lifetime — **none should
  collapse.** AppSignals' scope guard is honored with no run/session leakage. The
  `attachRunTrace` trace→hub bridge is justified layering (the hub adds per-`streamId`
  / per-`type` subscription filtering the trace lacks), not double-emission.
- `logUtils` staying **off** the `Platform` object is the correct call — channel
  output is a host-injected redacting text sink, a different concern from the
  structured `Platform` ports.
- `SessionHandle` deliberately is _not_ a conversation API and says so, citing the
  shipped-then-deleted Anthropic shape; its forced-dependency-order constructor
  prevents the silent state-split bug — do not collapse it.

## No change lands (by design this pass)

Consistent with every unattended checkpoint since `-07-22`. Even the lowest-risk
candidates this pass could see — §New-10 (`polishModel` merge, 2 import sites),
§New-5 (two `createModelHandler` entrypoints) — were **not applied.** The `-07-22`
revert is the worked example: a grep-justified "obviously safe" change can hide an
incomplete caller census, and only an out-of-pass reviewer reliably catches it.
§New-7 (redaction) and §New-9 (status rail) are respectively security-sensitive
and a considered-duplication requiring intent confirmation, and stay recorded.
(A subsequent live-authorized attempt to apply the two smallest candidates was
made and reverted on census — see "Follow-up: live-authorized safe-refactor
diligence" below.)
`MapToolRegistry` re-checked and still `Map | Record` with the `instanceof Map`
branch — **do not re-attempt the narrowing without a deliberate compatibility
boundary for `Map` inputs.**

## Follow-up: live-authorized safe-refactor diligence (2026-07-30)

After this checkpoint was first written, a maintainer authorized applying "the
things we can already do" and opening a PR — the out-of-pass review the unattended
pass lacked. Under that authorization, the two smallest candidates were taken to
a full caller/test census and a working branch, then **both were reverted** as
not-yet-clean. The census is the deliverable:

- **§New-10 (`polishModel` → `textEnhancement` merge) — reverted.** The merge was
  implemented and the targeted session test passed, but `typecheck` surfaced a
  second, dedicated test suite (`PolishPromptLoader.vitest.mts`, a `.mts` file the
  original `*.ts` grep missed) that imports `renderPolishPrompt`/`initializePolishModel`
  from `@agent/runtime/polishModel` and tests the loader in isolation. That makes
  `polishModel` an independently-tested unit, not a single-caller extraction — see
  the retraction under §New-10 above. Reverted to a clean tree.
- **§New-5 (collapse the two `createModelHandler` entrypoints) — not attempted,
  declined on census.** The two functions differ semantically (`useOpenRouter`
  derivation: `getUseOpenRouter()` vs `key === 'ModelHandlerOpenRouterNative'`;
  `allowCodexSubscriptionOverride`: always vs only for `ModelHandlerOpenAIResponse`;
  `withCompatibilityRoutingMode` applied only on the key path), and
  `ModelFactoryRouting.vitest.ts` locks a **drift invariant** between the key
  predicate and the dispatch (the "routing precedence" describe block) plus tests
  `createModelHandlerForCompatibilityKey` directly at five sites. Collapsing them
  is a lateral move (the caller's ternary becomes an internal branch) that removes
  one export at the cost of resume-path routing-test churn and non-trivial
  behavior-preservation risk — a judgment refactor, not a mechanical one.
- **`createChannelTrace` → functional-logger conversion — out of scope for a
  drive-by.** Behavior-preserving but 23 core files, each rewriting every
  `logger.x(msg)` call to add a channel argument, and it is a standing PRD item
  (`logger-surface-cleanup`) that wants deliberate sequencing, not a piecemeal grab.

**Outcome:** no code refactor lands from this pass either — not by the unattended
"no change" rule this time, but because a live-authorized census found the "already
do" subset empty of clean mechanical wins. This is the strongest available
confirmation of the standing verdict: the remaining items are design-judgment or
deliberate-sequencing work, not drive-by simplifications. The genuinely safe next
steps are the _additive_ SDK-surface exposures the subagent-boundaries section names
(publish `ChildRunStrategy`; expose the helper-model one-shots as a headless
sub-task API), which add capability without touching the tested invariants above —
those are the right candidates for the next attended change.

## Coverage gaps (honest scope of this pass)

- Alignment against the live `code.claude.com/docs/en/agent-sdk` docs was **not**
  re-fetched; the standing verification is carried forward.
- No commit-by-commit audit of the 15-commit `25c0cb1..HEAD` range — a fresh state
  inspection at HEAD reconciled against the standing record instead.
- Findings tagged [NEW] were produced by focused read-only deep-dives and are cited
  to file:line; the two headline claims (§New-8's triple encoding, §New-9's
  four-way status emission) plus the §New-1 never-parsed schemas and §New-7
  un-optioned redact call were independently re-verified this pass by direct grep
  at HEAD. The four-way _count_ in §New-9 relies on the deep-dive's reading of the
  `attachRunTrace` bridge's re-broadcast; the three primary emit sites
  (`StreamStatusService.ts:316,319,326`) were verified directly. Re-derive before
  any edit, per the standing rule.
- This checkpoint lives under `docs/proposals/` (internal, excluded from the
  texra.ai publish allowlist) — not a root-level doc, so it does not touch the
  `docs-root-boundary` gate.
