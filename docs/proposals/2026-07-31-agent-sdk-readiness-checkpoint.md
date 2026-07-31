# Agent SDK Readiness — Verification Checkpoint (2026-07-31)

**Status:** Verification checkpoint. Read alongside the immediately prior
[`2026-07-30-agent-sdk-readiness-checkpoint.md`](./2026-07-30-agent-sdk-readiness-checkpoint.md)
(this pass reconciles against its §New-1…§New-11, [TRACKED] items, and the
"Follow-up: live-authorized safe-refactor diligence" census rather than
re-deriving them), the foundation-gap analysis
[`2026-07-26-agent-sdk-foundation-gap.md`](./2026-07-26-agent-sdk-foundation-gap.md)
(§6 absorption sequence, §7 acceptance criteria, §9 the real ceiling), the
plan of record [`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md),
and the `-06-25` → `-07-30` checkpoint chain.

This pass inspected the tree afresh at HEAD `4b3e8e6`
(`chore(deps): bump the production-dependencies group with 4 updates (#9450)`;
`CHANGELOG.md` heading `[Unreleased]`; package version `0.40.0`). The `-07-30`
checkpoint pin `8116ce9` **is** an ancestor
(`git merge-base --is-ancestor` succeeds); `git rev-list --count 8116ce9..HEAD`
reports **28 commits**. This pass re-inspected the tree at HEAD and reconciled
against the standing record; it did not perform a commit-by-commit audit of that
range.

**Run context (honesty note).** This was an **unattended scheduled run** with **no
external adversarial review available**. It therefore applies **no code change** —
see "No change lands." The discipline is the one every checkpoint since `-07-22`
has held, and which `-07-30`'s live-authorized census reconfirmed empirically: a
grep-justified "obviously safe" change can hide an incomplete caller census, and
only an out-of-pass reviewer reliably catches it. This pass produced its own
worked example of exactly that failure mode — see §New-12's honesty correction
(`computePrice` "zero production callers" was overstated on first reading and
corrected by direct verification before recording). Method mirrored `-07-30`:
four parallel read-only deep-dives (model handlers; agent core + flows + node;
runtime + logger + public surface; SDK-alignment + subagent boundaries), each
returning file:line-cited findings, reconciled here against the standing record
so already-tracked items are not re-filed as fresh, and each headline claim
independently re-verified by direct grep at HEAD before it was written down.

## Verdict — well-aligned; the absorption channel is doing the work

**The codebase remains well-aligned and SDK-ready in shape; no new structural
refactoring is warranted from an unattended pass.** The core-shape conclusion
every checkpoint since `-06-26` has reconverged on holds unchanged. The stronger
signal this pass is the **absorption velocity**: the 28 commits since `-07-30`
are dominated by exactly the maintainer-reviewed simplification the checkpoint
chain prescribes, landing in the tracked findings' own territory:

- `#9453 refactor: delete the dead prefill machinery in ModelHandler` — trimmed
  the base handler from 2025 → **1917 LOC** (verified at HEAD), directly the
  base-`ModelHandler` de-bloat theme (standing §9.3).
- `#9404 Retire the legacy stream-status trait table and dead group-end fold` —
  in §New-9's `StreamStatusService` territory (the emission fan-out itself is
  unchanged; see below).
- `#9466 refactor: fold the fresh and resume tool-use assemblies in executeAgent`,
  `#9465 bring the resume tool-use path to fresh-launch parity`,
  `#9463 extract shared persistTerminalExecution helper`,
  `#9455 delete FlexibleFS and xmlUtils pass-through wrappers`,
  `#9467 collapse SettingsMemoryController pass-through deps`,
  `#9468 make settlements the host-interaction result type`,
  `#9472 codebase-wide simplification sweep`,
  `#9456 Type ActiveChildInfo.status as StreamPhase`.

This is the healthy loop the process is designed to produce: findings recorded
here → absorbed through attended PRs. The verdict this pass adds nothing to
overturn; it re-verifies the spine, reconciles the deep-dives, and records two
genuinely new items plus one strategic clarification of the SDK-surface path.

## Spine invariants — re-verified at HEAD `4b3e8e6`

- `src/agent/core/index.ts` **absent** (no barrel regression).
- `IModelHandler = Pick<ModelHandler<…>>` (`src/agent/types/IModelHandler.ts:41`),
  **43** picked members — unchanged from `-07-30`. Still auto-derived from the
  class, so surface shape, not drift.
- `Node.exec → createFlow().run` shape intact: the inner cycle flows are still
  created and run inline by their owning nodes, no wrapper.
- **0** `vscode` imports across all declared VS Code-free zones (`src/agent`,
  `model`, `latex`, `tools`, `controllers`, `shared`, `replacement`, `eventBus`,
  `hosts`, `logger`).
- `MapToolRegistry` still `Map<string, ITool> | Record<string, ITool>` with the
  `instanceof Map` branch (`ToolTypes.ts:50-51`) — the reverted `-07-22`/`-07-23`
  state, correctly not re-attempted. **Do not re-narrow without a deliberate
  compatibility boundary for `Map` inputs.**
- `agentCreator/` still contains **0** `Node`/`Flow`/`@agent/node` references — a
  linear async function with a single production caller
  (`agentCreatorCommands.ts:220`); CLAUDE.md's "not a flow" note is accurate.
- `node/index.ts` flow engine carries **no** upstream-PocketFlow dead surface —
  `grep` for `BatchNode|ParallelBatch|setParams|\.params` over `node/` +
  `core/flows/` + `implementations/` returns **0**.
- §New-1 inner-cycle snapshot schemas (`CycleFieldsSchema` /
  `BaseCycleFieldsSchema` / `ToolUseRoundFieldsSchema`) still **never**
  `.parse`/`.safeParse`'d (**0** hits at HEAD) — the collapse-to-while-loop
  simplification remains available and remains a test-restructuring, not a
  deletion.

## Remaining gaps — the real ceiling (§9), re-verified present at HEAD

Unchanged in substance from `-07-30`; all still present. Tool registry still
closed (`IToolRegistry = { get, has }`, no public `register`); product types
still leak into the runtime launch path (`toolConfig` LaTeX booleans,
`AgentFlowResult.compileFailures`, `RunAgentOptions.preferHelperModel`, TeXRA-domain
`AgentEvent` arms); `IModelHandler` port width (43) is the standing strategic
port-shape item where the lever is **reducing what the flow layer demands of the
handler**, not trimming the `Pick`; NS-1 host→core public surface has no Tier-1
manifest yet (this pass sharpens that item — see "SDK surface" below);
`stateOwnership` retirement still proceeding through the attended channel.

## Deep-dive findings — reconciled against the standing record

Each finding is tagged **[TRACKED]** (already on the record) or **[NEW]** (not
previously named in the checkpoint chain). Effort S/M/L. All are recorded for an
attended maintainer pass; none are applied here.

### Already-tracked — re-affirmed present at HEAD

- **[TRACKED] Model-handler base → credential/route collaborator (standing §9.3).**
  Re-affirmed with fresh precision. The credential/route concern on the base
  (`ModelHandler.ts` ~lines 206-211 state + `resolveClientCredential`,
  `rememberClientCredentialRoute`, `buildProxyConfig`, `getCredentialRouteForClient`,
  `getWireRouteKey`, `getModelRetryRouteKey`, `getBaseUrl`, `getRetryEndpoint`,
  `shouldUseServerSideKeys`, …) is ~230 lines with its own private `WeakMap` state,
  consumed by every provider `getClient()` through exactly one seam —
  `resolveClientCredential(selection)` then `rememberClientCredentialRoute(…)`
  (**13** provider call sites verified this pass). Extracting a
  `support/ClientCredentialRouter` the handler _holds_ (the same collaborator shape
  as `mediaProcessor: MediaAttachmentProcessor`) is idiomatic and touches no
  convention. Caveat unchanged from `-07-30`: the credential state is threaded into
  the `createResponse` template, so the collaborator must expose an active-route
  setter back to the template. This is the clearest genuine extraction on the base;
  the ~10 single-override capability getters are **settled #7101 work — do not
  re-litigate** (a representative sample was re-checked this pass; each carries its
  triage doc comment proving genuine per-family behavior).
- **[TRACKED] `IModelHandler` port width — 4 picks are pure credential/retry
  routing.** `getWireRouteKey`, `getModelRetryRouteKey`, `getCredentialRouteForClient`,
  `getLastCredentialUsageRoute` are transport concerns riding a message/response
  port, each with one external consumer. If the §9.3 `ClientCredentialRouter`
  extraction lands, these move to that collaborator's interface and shrink the
  port — the "narrow the demand, not the derived `Pick`" lever, concretized.
- **[TRACKED] §New-8 — compatibility-key space encoded three times.** Re-verified
  present: the `MODEL_HANDLER_COMPATIBILITY_KEYS` enum, the `PROVIDER_HANDLER_ROUTES`
  loader table, and the `switch (compatibilityKey)` (`ModelFactory.ts:581`) all still
  coexist. Unchanged M-effort dispatch-table tidiness.
- **[TRACKED] §New-9 — one stream-status transition emitted four ways.** Re-verified:
  `emitStatus` still fans to the run-trace `status` event (`StreamStatusService.ts:316`),
  the `updateStreamStatus` `SessionFact` (`:319-322`), and the direct
  `statusListeners` set (`:326`); the `attachRunTrace` bridge re-broadcast is the
  fourth. `#9404` retired the _legacy trait table_ but did not collapse this
  emission fan-out. Still a **considered** duplication — flag and confirm intent,
  do not assume a bug.
- **[TRACKED] `createChannelTrace` module-logger redundancy (standing
  `-07-08`/`-07-18`/logger-surface-cleanup PRD).** Re-verified **29** non-test
  module singletons (up from 27 at `-07-30`) do `const logger = createChannelTrace('X')`
  and only call `debug/info/warn/error`, paying for an object whose structured
  methods are silent no-ops. Behavior-preserving conversion to the functional
  `logger.*(channel, …)` API is a standing PRD item wanting deliberate sequencing,
  not a drive-by (23+ core files each rewriting every call to add a channel arg).
- **[TRACKED] §New-6 — flow↔final result field divergence.** Re-affirmed as the
  runtime deep-dive's highest-leverage cleanup: `AgentFinalResult` renames
  `lastResponse→response` / `touchedFiles→files` (`AgentFinalResult.ts:44-56`),
  forcing `projectToolUseFinalTextFields` (`:81-97`) to exist _and_ be shared with
  `resultMeta.ts`'s legacy builder behind a drift-guard comment. Because
  `AgentFinalResult` is persisted, this is a "pick canonical names once at the
  public boundary" cleanup bridging legacy snapshots — not a free deletion.
- **[TRACKED] §New-7 — redaction path-stripping still not on the primary log sink.**
  Re-verified: the main output-channel sink still calls `redactSecrets(message)`
  with no `homeDir`/`workspacePath` options (`logUtils.ts:77`). Security-sensitive;
  stays recorded, not touched. (Otherwise the logger surface is **verified clean**
  this pass — no factory-of-factory, single memoized redaction wrap, single
  `writeLine` emission point; `logUtils` staying off the `Platform` object remains
  the correct call.)

### New this pass — recorded for maintainer re-derivation

- **[NEW] §New-12 — `computePrice` is a redundant public contract member for 4 of
  the 5 provider families (inconsistency, not dead code). (S; honesty-corrected.)**
  `abstract computePrice(U): number` (`ModelHandler.ts:1498`) is a required member
  of all provider families, but for `anthropic`/`openai`/`google`/`openrouter` the
  actual cost math wired into `normalizeUsage` runs through **standalone module
  functions** (`computeAnthropicPrice`/`computeOpenAIPrice`/`computeOpenRouterPrice`
  in `anthropicUsage.ts:144`, `openAIUsage.ts:122`, `openRouterUsage.ts:59`, etc.,
  passed as the `UsageNormalizer` `computePrice` callback) — **not** through the
  public `computePrice` method, which sits parallel to them. **Honesty correction
  to the first-pass reading:** the deep-dive initially reported "`computePrice` has
  zero production callers." That is **wrong** — `modelHandlerOpenAIResponse.ts:2508`
  wires `(usage) => this.computePrice(usage)` into its normalizer, so OpenAIResponse
  _does_ route pricing through the public method. The accurate finding is a
  **partial redundancy / wiring inconsistency**: 4 families duplicate price math
  between the public method and the module function; 1 (OpenAIResponse) relies on
  the method. The cleanup is to make the wiring uniform (all via the module
  functions, or all via the method) before considering whether the abstract member
  earns its place — _not_ to remove it. Filed precisely because it is the exact
  incomplete-census trap the process guards against.
- **[NEW] §New-13 — `helperModelPreference.ts` is a single-production-caller file.
  (S.)** `applyHelperModelPreference` is imported only by `runAgent.ts` in
  production (verified: the only non-test importers are the file itself and
  `runAgent.ts`). The repo bans single-caller extractions. It is ~50 lines of real
  selection logic (tool-use capability + availability checks), so it is not pure
  indirection; folding it into `helperModelName.ts` collapses the advertised 3-file
  helper cluster to 2 cohesive files without a shim. Low value; genuinely tracked
  as a candidate, not a defect. (The rest of the helper-model cluster is **not**
  over-split — `helperModel` has 8 importers, `helperModelName`'s
  `resolveEffectiveHelperModel` is shared with `SettingsModelSelectionController`.)

### Minor / recorded-but-below-the-line

- **`extractAssistantText` base default is dead in production (all 7 provider
  families override).** Base returns `undefined` (`ModelHandler.ts:1683`); only
  `ModelHandlerValidation` reaches it. Making it `abstract` removes a silent no-op
  default at the cost of a one-liner in the validation stub. Minor; `createMediaContent`
  (base _throws_ with a clear message) is the correctly-done version of the same
  pattern.
- **`resumeAdmission.ts` — a 9-line error-class-only file.** Exports only
  `ResumeAdmissionCancelledError`, imported by 3 runtime files; a standalone file
  avoids an import cycle, so it is defensible — the clearest "file names one symbol"
  case, not worth churning unless those files are touched anyway.
- **`executeAgent`'s `allowWaitingResult` overloads** (`executeAgent.ts` WAITING-result
  path) are exported complexity used by a single internal caller
  (`nativeSubagentStrategy`) — worth narrowing when an SDK surface is drawn, not now.
- **Media-attachment _bookkeeping_ on the base** (`insertedAttachmentKinds` map +
  `consumeInsertedAttachmentKinds`/`createMediaForRound`) is a second cohesive chunk
  `MediaAttachmentProcessor` could own — same collaborator pattern as §9.3, lower
  value, one external consumer.
- **Usage modeled twice in the contracts** (`ExtractResponseResult.usage:
ProviderUsage` vs the raw generic `U` through `normalizeUsage`) — genuinely
  different lifecycle stages (normalized vs raw), so a flag, not a defect.

## SDK surface — the path is additive and does not fight the no-barrel rule

The strongest strategic clarification this pass adds to NS-1. **The no-barrel rule
does not block SDK packaging** — the convention already carves out documented
public surfaces (AGENTS.md:544), and **three such barrels already exist and are the
de-facto SDK surface**:

- `src/agent/trace/index.ts` — self-describes as "**AgentTrace — agent-general SDK
  surface for agent runs**" (verified at HEAD); the reference model for how a
  surface is declared in-docstring.
- `src/agent/index/index.ts` — the agent-registry public API.
- `src/agent/storage/index.ts` — the execution-storage public surface.

A future SDK entry point is therefore _consistent with_, not a violation of, the
convention: one more documented barrel (or a small set — `launch`, `platform`,
`trace`, `registry`, `model`) declaring its members in-docstring, **plus an
import-boundary lint gate** forbidding host packages from deep-importing any
`@agent/runtime/<File>` not re-exported by it.

**The blocker is demotion breadth, not barrel creation.** The real leak is that
host packages reach straight into large runtime composition records: at HEAD,
**37** host files deep-import `@agent/runtime/SessionHandle` and **14** import
`@agent/runtime/HostInteractions` (plus content-helper internals like
`textEnhancement`/`polishModel` that would sit _behind_ an SDK). A launch/platform
barrel over the ~5–6 genuinely-public runtime symbols is additive and needs no file
moves (answering the runtime README's "why this stays flat" concern); the hard part
is that `SessionHandle`/`HostInteractions` are consumed as concrete classes, so a
clean surface must either expose them as public contracts or introduce narrower
host-facing ports (the idiomatic path, given the `Platform`-port precedent — but a
large per-consumer effort). The dead-export ratchet
(`config/ratchets/knip-baseline.json`) is the closest thing to enforcement today
but only catches _unused_ exports, not "internal export a host reaches around to."

## Subagent boundaries (task item 4) — one genuinely new candidate

The subagent architecture remains the **strongest-factored part of the runtime**;
the seams are unchanged and re-affirmed (they are an **exposure** problem, not a
build problem):

1. **`ChildRunStrategy<TTurn>` is THE subagent seam (split point #1)** — one driver
   `startChildRunLoop` runs native/codex-CLI/claude-CLI/workflow-script strategies;
   a future external-agent SDK is a new strategy passed to the same loop.
2. **`nativeSubagentStrategy`** wraps `executeAgent`/`resumeToolUseFromResumeData` —
   which is _why_ `executeAgent`'s low caller count is not an inline signal.
3. **Lineage/detach seam** — `registerExecution(…, parentExecutionId)` +
   `executionRegistry` child-activation + `detachSubagentsOnStop()` policy
   (cascade default; detach promotes children to top-level).
4. **Helper-model one-shot tier** (`sessionDescription`, `textEnhancement`/`polishModel`,
   `agentCreator`'s `generateAgentYaml`) — a distinct tier _below_ the subagent tier:
   no tools, no lineage, no persistence. Correctly **not** subagents; promoting them
   would add machinery for a single model call (re-confirms the `-07-30` §New-10
   retraction and the helper-model-one-shot verdict).

**Genuinely new candidate — an automated review/critique subagent.** No review
agent exists in `packages/extension/resources/agents/` (verified: `correct`, `merge`,
`ocr`, `polish`, `transcribe_audio`, `write` — no `review`). The only "criticism"
today is `manualCriticism`, a _user-driven_ `HostInteraction`, not an automated
pass. A review subagent has textbook-clean I/O — **in** = draft output + rubric;
**out** = structured critique — is stateless, tool-light, and parallelizable across
sections, and would ship as a YAML file under `resources/agents/` plus the existing
delegation machinery (no new abstraction, no convention touched). This is the
strongest _new_ subagent opportunity. Exposing **LaTeX fix-compilation** as a
delegatable agent is a secondary, mostly-plumbing opportunity (it already runs as a
full tracked `runAgent` execution today).

Recommended sequencing (unchanged): stabilize `ChildRunStrategy` as the public
subagent contract → expose the helper-model one-shots as a headless sub-task API →
add the review agent (additive, lowest-risk) → leave the intra-run flow seams
in-process. The load-bearing non-abstractable coupling is parent-delivery via
`deliverTurn`/`submitPendingDelivery` (#8093 ordering) — a distributed-subagent SDK
must replace this in-process handoff with IPC/RPC; flag so the seam is not assumed
free.

## No change lands (by design this pass)

Consistent with every unattended checkpoint since `-07-22`, and with `-07-30`'s
live-authorized census that found the "already-do" subset empty of clean
mechanical wins. Even the smallest candidates this pass surfaced — §New-13
(`helperModelPreference` fold, 1 import site), the `extractAssistantText`/`resumeAdmission`
micro-items — are **not applied**. §New-7 (redaction) is security-sensitive; §New-9
(status rail) is a considered duplication requiring intent confirmation; §New-12
(`computePrice`) is a wiring inconsistency whose first reading was wrong and must be
re-derived, not acted on. The genuinely safe next steps remain the **additive**
SDK-surface exposures the subagent section names (publish `ChildRunStrategy`; expose
the helper-model one-shots; add the review agent) — capability without touching the
tested invariants — and they are the right candidates for the next _attended_ change.

## Coverage gaps (honest scope of this pass)

- Alignment against the live `code.claude.com/docs/en/agent-sdk` docs was **not**
  re-fetched; the standing verification is carried forward.
- No commit-by-commit audit of the 28-commit `8116ce9..HEAD` range — a fresh state
  inspection at HEAD reconciled against the standing record instead.
- All [NEW] and headline [TRACKED] claims were independently re-verified by direct
  grep at HEAD before being written (base LOC 1917; §New-1 zero-parse; §New-8 three
  structures + switch; §New-9 three emit sites; §New-12 `computePrice` wiring across
  all five families; `extractAssistantText` 7 overrides; barrels present;
  `SessionHandle` 37× / `HostInteractions` 14× host imports; `resources/agents`
  contents). §New-12 is the worked example of why this re-verification step is
  mandatory: the deep-dive's original claim was overstated and was corrected here.
- This checkpoint lives under `docs/proposals/` (internal, excluded from the
  texra.ai publish allowlist) — not a root-level doc, so it does not touch the
  `docs-root-boundary` gate.
