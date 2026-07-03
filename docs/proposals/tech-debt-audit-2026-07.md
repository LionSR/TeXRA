# Tech-debt audit: largest debts not previously uncovered (2026-07)

Full-repo sweep (repo-root `src/` ~245k LoC non-test, `packages/extension` 57k,
`packages/cli`, `packages/desktop` 10.9k) cross-referenced against the existing
debt corpus (`docs/proposals/*`, `docs/tui-performance-audit.md`,
`docs/dev/standalone-trajectory-audit.md`, coupling/SDK-readiness audits and the
2026-07-03 checkpoint). Two buckets:

- **Part A — debts not documented anywhere** in the proposal/audit corpus.
- **Part B — debts already documented, but where a materially better solution
  exists** than the one on file.

Ruled out up front (checked, healthy — don't spend time here): type-safety is
clean (27 `as any`/`as unknown as` in all non-test code, zero
`@ts-ignore`/`@ts-expect-error`); the VS Code-free zones really are free of
`vscode` imports; webview IPC is typed (Zod schemas + `createDispatcher`, no
stringly `postMessage` switches); the three webviews share Lit components and
`@controllers` cores across extension and desktop; the tool registry, usage
normalization (`UsageNormalizer`), and tool→provider conversion
(`toolConversion.ts`) are already unified; `Platform` is 17 small ports behind
one `createFakePlatform`, not a service-locator god object.

---

## Part A — largest debts not previously uncovered

### A1. The model-handler layer: one pipeline implemented four-to-five times (~20.7k LoC)

`src/agent/modelHandlers/` is 20,660 LoC. `ModelHandler.ts` (1,349) declares
**19 abstract methods**, and each provider re-implements the same conceptual
pipeline — message assembly, media attachment, tool-result blocks, streaming,
continuation — against its SDK types:

| File                                         |   LoC |
| -------------------------------------------- | ----: |
| `openai/modelHandlerOpenAIResponse.ts`       | 2,871 |
| `google/modelHandlerGoogleInteractions.ts`   | 2,154 |
| `anthropic/modelHandlerAnthropic.ts`         | 1,692 |
| `openai/modelHandlerOpenAI.ts`               | 1,513 |
| `google/modelHandlerGoogleGenAI.ts`          | 1,204 |
| `openrouter/modelHandlerOpenRouterNative.ts` |   957 |

Concrete sub-debts, each independently fixable:

- **Prefill/continuation re-implemented 5×.** Six abstract methods
  (`initializeOutputAndPrefill`, `updateMessageContentWith/WithoutPrefill`,
  `addContinueMessageWith/WithoutPrefill`, `shouldContinue`,
  `ModelHandler.ts:842-1033`) form a mini-subsystem every provider writes from
  scratch ("prefill" occurs 30× in the Anthropic handler, 19×/18× OpenAI,
  17× each Google). `support/openAiCompatiblePrefill.ts` exists but only
  OpenAI-shaped providers use it. **Fix:** hoist prefill/continuation into the
  base as a template method; providers supply only the "append text to last
  assistant message" primitive.
- **87 scattered capability booleans.** `supports*/should*/is*/use*` predicates
  (28 in the base alone: `supportsToolResultFileUpload`,
  `supportsResponseChaining`, `shouldIncludeReasoningInToolCalls`, …) are
  individually overridable toggles. A new provider means auditing dozens of
  independent booleans. **Fix:** one declarative `ProviderCapabilities` record
  per handler.
- **`modelHandlerOpenAIResponse.ts` god class.** 94 methods; header comment
  admits non-thread-safe instance state (`previousResponseId`,
  `pendingBackgroundResponseId`, `conversationState`); juggles streaming vs
  non-streaming, background polling, WebSocket transport, store:true chaining
  vs encrypted-reasoning replay, and OpenRouter routing — and `ModelHandlerCodex`
  extends it. **Fix:** extract the response-chaining state machine and the
  background-poll lifecycle into collaborators (the WebSocket transport was
  already split out; follow that precedent).
- **Two Google handlers** (`GoogleInteractions` 2,154 + `GoogleGenAI` 1,204)
  with overlapping-but-divergent chain/stateless logic for one vendor, plus a
  hand-rolled chain-invalidation state machine expressed as scattered boolean
  predicates. **Fix:** unify behind one handler with an explicit
  `InteractionChain` collaborator, or record a sunset date for the GenAI path.
- **Dual contract.** `types/IModelHandler.ts` (475 LoC, 33 signatures)
  duplicates the abstract class surface by hand. **Fix:** derive one from the
  other or delete the interface.

Caveat, honoring this repo's documented "rejected traps" discipline: the fix is
**not** a grand unified handler framework (call sites genuinely diverge per
SDK). It's the three targeted hoists above — prefill template method,
capabilities struct, chain-state collaborators — which shrink all handlers
simultaneously without inventing a leaky abstraction. The usage layer
(`UsageNormalizer` + thin adapters) already proves the pattern works here.

### A2. Host-adapter wiring duplicated between extension and desktop (~4.5k LoC of drift-prone glue)

The hard part was done right — controllers are shared — but each host
hand-writes a 1,000+ LoC wiring layer around them:

- Settings: `packages/extension/src/settingsView/SettingsViewMessageHandler.ts`
  (1,012) and `packages/desktop/src/main/desktopSettingsIpc.ts` (1,286) **both**
  call `createSettingsViewCommandHandlers(...)` (extension `:236`, desktop
  `:1081`) and both instantiate the same controller factories, then each adds
  ~500 LoC of bespoke `sendXData`/`postMessage` glue.
- Execution/progress: `desktopAgentExecution.ts` (1,279) mirrors what the
  extension spreads across `ProgressViewMessageHandler.ts` (889) +
  `MainViewProvider.ts` + `agentEventListeners.ts`.
- `src/shared/ipc/settingsViewCommands.ts` defines ~126 commands whose
  command→handler mapping is authored twice, once per host.

This seam is the single largest source of "works in extension, broken in
desktop" bugs (the coupling audit's #6887 crash-repair gap was exactly this
class of drift). **Fix:** a shared
`createSettingsViewHost({ postMessage, secrets, state })` /
`createAgentExecutionHost(...)` factory in `src/controllers/`, parameterized by
a thin host-capability interface; each host shrinks to a ~100-line adapter.

### A3. `MainApp.ts`: 1,915-line god component running three state mechanisms at once

`packages/extension/src/webview/frontend/MainApp.ts` mixes 18 ad-hoc
`signal(...)` fields (`:162-227`), 5 `@state`/`@provide` context fields, and a
`PersistedState`/`createWebviewStorage` manager, with restore logic sprawled
over three methods. The repo already contains the correct pattern —
`progressView/frontend/` uses a store + 10 slice files with `mutative` — and
MainApp simply predates it. Same story in miniature for
`settingsView/frontend/SettingsApp.ts` (1,140) + `LaTeXTab.ts` (848).
**Fix:** migrate MainApp/SettingsApp to the in-repo slice-store pattern; no new
architecture needed.

### A4. Test infrastructure: hand-rolled in-memory filesystem + 75 per-suite platform bootstraps

- `src/test-kernel/support/FakePlatform.ts` is 788 lines, ~377 of which
  (`:282-659`) are a bespoke in-memory filesystem (posix path math, error
  codes, dir trees) that all **359** vitest suites (~62k LoC) trust and that can
  silently diverge from `nodeFilesystem.ts` semantics. **Fix:** back
  `FakeFileSystemProvider` with `memfs`.
- `vitest.config.mjs` has no `setupFiles`, so platform bootstrap is repeated at
  **75** `beforeEach`/`initPlatform` sites. **Fix:** a global setup installing a
  default fake platform; suites override rather than re-init.

### A5. Build/script/alias sprawl

- `scripts/` holds ~30 `.mjs` files, ~7,850 lines, including a hand-rolled
  JSON-comment stripper in `aliasUtils.mjs` (reimplements `strip-json-comments`)
  whose own header admits the extension tsconfig "will silently follow the
  root" on divergence.
- Root `tsconfig.json` has **45 path aliases**; `@/*` and `~/*` are exact
  duplicates, and several "shared" aliases (`@webview/*`, `@commands/*`,
  `@settingsView/*`, …) point into `packages/extension/`, coupling core to one
  host. `packages/desktop/tsconfig.paths.json` is a second hand-maintained copy.
- Desktop carries 5 tsconfigs; `scripts/extension-package-invariants.snapshot.json`
  is a 70 KB committed generated artifact (see B4 for the better end-state).
- `patches/ink@7.1.0.patch` has no documented exit plan (upstream issue or
  re-evaluation trigger on ink bumps).

**Fixes:** use `tsconfck`/`strip-json-comments`; drop `~/*`; move host aliases
into host tsconfigs and generate the desktop table from root; consolidate
desktop tsconfigs via project references; document the ink-patch exit plan.

### A6. Transcript persistence: four overlapping stores (2,856 LoC)

`src/transcript/` — `StreamSnapshotStore.ts` (1,046), `StreamLogStore.ts`
(814), `streamSnapshotRead.ts` (218), `StreamLog.ts` (185) — two big stores
persisting the same conceptual per-run stream data plus a separate read path.
The coupling audit's #6889 (vestigial pub-sub, headless sidecar gap) touches
this area but not the structural overlap. **Fix:** one store interface with a
single serialization format; the snapshot becomes a view over the log (or vice
versa). Also fixes the CLI's synthetic-entry dedup at the source (see B2).

### A7. Smaller, contained items

- **Command-surface dual bookkeeping:** `extensionCommandSurface.ts` (538 LoC,
  40 aliased imports, 111 command-id strings) hand-mirrors
  `src/shared/commands/catalog.ts`, which desktop already consumes cleanly.
  Drive extension registration fully from the catalog.
- **CSS-in-TS sprawl:** ~6,000 LoC across 25+ `*Styles.ts` files;
  `src/shared/styles/requestPanelStyles.ts` alone is 1,058. Split per-panel,
  colocate, finish `designTokens` adoption.
- **CLI god files:** `cliState.ts` (510) is a monolithic ~25-field
  `StreamSlice` store where the extension deliberately uses 10 slices;
  `App.tsx` (1,056) holds 11 signals **and** 15 props plus local `useState` for
  view toggles (violates the CLAUDE.md signal-state rule);
  `ChildControlPicker.tsx` (1,198) contains a third bespoke scroll/tail state
  machine paralleling `useScrollableOffset.ts` and `transcriptScroll.ts`.
- **Stray per-component interval:** `StatusBar.tsx:865` codex-subscription
  poll bypasses the shared `useLiveNowMs` ticker (which otherwise landed —
  the CLAUDE.md "shared Clock" item is ~done; ref-counted raw mode is not:
  `runChatTui.tsx:900,:909` and `terminalCapabilities.ts:102,:132` still
  toggle `setRawMode` directly).
- **`ExecutionsTool.ts`** (951) and `extension.ts` `activate()` (814) /
  desktop `main/index.ts` (978) are accretion files worth phase-splitting.

---

## Part B — documented debts where a much better solution exists

### B1. Dual run-event taxonomy: a full collapse is NOT feasible — target the three duplicated facts instead

_(Revised after the mechanism-level deep dive; see the appendix below for the
full map.)_ Documented state: `error-pipeline-and-ownership.md` ruled that new
facts extend `AgentEvent` **or** `ProgressEventPayloads`, and SDK-readiness F-1
deferred host-path re-routes. The deep dive shows the naive "make the bus a
trace projection" idea is wrong: of the bus's **54** keys, **22** are
bidirectional approval/host RPC (`show*`/`resolve*` pairs with promise
coordinators) and **10** are app-lifecycle signals emitted outside any run —
neither can ever be append-only trace facts. The bus also provides
pre-subscription buffering (`ProgressEventBus.ts:329-351`, 1000-event replay)
that `TraceEmitter` lacks. And the discipline already holds: zero raw
`bus.emit` in VS Code-free zones; everything routes via
`runtimeHost`/`emitRuntimeEvent`.

The _actual_ debt is **the same fact emitted in two vocabularies at three
spots**:

1. **Terminal outcome dual-emit** — `AgentRunLifecycle.ts:83` emits the trace
   `ResultEvent` while `StreamStatusService.set → runtimeHost.emit('updateStreamStatus')`
   (`StreamStatusService.ts:76`) publishes the same fact as
   `StreamStatus`+`terminalStatus`. Two shapes, two channels, guard-coordinated.
2. **Usage triple-emit** — `UsageMonitor.ts:170` (bus `updateStreamUsage`) +
   `UsageMonitor.ts:182` (trace `usage`) + `ResultEvent.usage`
   (`events.ts:183`), already flagged "genuine duplication" in
   `docs/agent-sdk-readiness-audit.md:226`.
3. **Every `trace.info()` on a run writes two sinks** — output channel (via
   `attachChannelSubscriber`) and transcript (`TexraTranscriptRecorder` →
   `StreamLogStore`). Intentional, but a per-call double write.

**Better solution:** keep the bus, but (a) make the remaining overlapping
run-facts _projections_ of trace events, following the in-repo reference
implementation `conversationProgressHub.ts:36-45` (one trace domain emit →
hub republishes onto the bus); (b) collapse usage to a single trace emit
projected to the bus; (c) split `ProgressEventPayloads` into three explicit
interfaces — `RunFactEvents` (22), `ApprovalRpcEvents` (22),
`AppSignalEvents` (10) — so the taxonomy is in the types and nobody proposes
the wrong collapse again. Non-terminal stream status (INITIALIZING/RUNNING/
WAITING) has no trace representation and its handler performs memory-eviction
side effects (`ProgressEventHandler.ts:580-584`), so it stays bus-native
unless a `status` trace variant is added deliberately.

Note the logger itself is **no longer debt**: `src/logger/` is 308 lines, 4
files, one sink boundary (`writeLine`), with `AgentLogger`/`structuredLogger`
genuinely deleted. The remaining cost is fact duplication across pipelines,
not stacked modules.

### B2. CLI↔extension sharing: the documented rung-ladder targets approvals; the real duplication is the projection layer

`tui-extension-sharing.md` (rungs 3–4 open) shares approval/proposal
orchestration. But both frontends independently re-project the **entire**
`ProgressEventPayloads` stream into view state: CLI
`chat/tui/state/` (4,352 LoC: `subscribeApprovals` 534, `subscribeStreamLog`
443, `subscribeRuntimeHost` 298, …) + `toolRenderers.tsx` (623 ANSI) versus the
extension's `progressView/frontend/` (**18,788 LoC**: 10 slices + 3,196 LoC of
formatters). `cliState.ts:1-6` still claims it "mirrors the webview's shape …
so feature parity is a port, not a rewrite" — the shapes have already forked
(one 25-field map-of-structs vs 10 slices). Only `normalizeToolUseData` is
genuinely shared.

**Better solution:** one host-neutral reducer in `src/shared` that folds
`ProgressEventPayloads` (or, post-B1, `AgentEvent`) into a normalized
per-stream view model, plus a shared per-tool **display model** (title,
sections, status, elided output); the CLI and webview become thin ANSI/Lit
paint layers. This also dissolves the CLI's fragile synthetic-entry machinery
(`state/transcript.ts:35` dedup-by-normalized-text,
`syntheticAfterSeq` splicing in `subscribeStreamLog.ts:385-411`) — the correct
fix is upstream: emit the finalized assistant message into `StreamLogStore`
with a stable id so synthetics/dedup disappear entirely.

### B3. `@texra/core` "SDK boundary": declared done, but nothing enforces it

`agent-sdk-readiness.md` marks Steps 1–7 landed and the checkpoint concludes
"SDK-ready in shape." The artifact, though, is a single 134-line re-export
barrel — `"private": true`, `main`/`exports` pointing at raw `./src/index.ts`,
no emit build, excluded from root tsconfig — and its own header concedes deep
`@agent/*` imports "are not being migrated in bulk." An unenforced boundary
drifts by default.

**Better solution:** pick one honestly. Either (a) enforce: an ESLint
`no-restricted-imports` rule banning deep `@agent/*`/`@platform` imports from
`packages/{cli,desktop,extension}` (allowlist the current offenders, ratchet
down) plus a real build so the package is publishable; or (b) demote the
framing from "curated public SDK" to "internal convenience barrel" in docs and
CLAUDE.md. The costly state is the current middle: SDK claims without SDK
guarantees.

### B4. Config catalog: extend the documented plan to code-generate the manifest and delete the snapshot machinery

`config-catalog-unification.md` proposes a catalog SSOT feeding the extension
settings view and a CLI `/config`. The audit found the deeper cost sits in what
that plan doesn't yet subsume: `packages/extension/package.json` is a 72 KB
hand-maintained manifest (65 settings + 67 commands) synced by
`sync-settings-configuration.mjs` and guarded by a **70 KB committed snapshot**
(`extension-package-invariants.snapshot.json`) — and core still reads settings
by raw string key (`config.get('texra.files.exclude', …)`), with feature-flag
wrappers existing solely to hide that.

**Better solution:** make the catalog generate _both_ directions —
`contributes.configuration`/`contributes.commands` in package.json **and** a
typed `SettingKey` accessor map consumed via `platform().config` — then retire
the snapshot+invariants scripts entirely (a codegen diff check replaces them).
Same SSOT the proposal wants, but it deletes ~two scripts, a 70 KB artifact,
and the whole silent-rename failure mode instead of adding a third surface.

### B5. `ExecutionRegistry`: the SessionHandle work fixed _global-ness_; the remaining debt is narrower than "split the class"

_(Revised after the mechanism-level deep dive; see appendix.)_ Corrections to
the first pass: the class is ~33 methods over 7 fields (not 42), and it
contains **no follow-up queue** — `getToolUseFollowUpTarget` is a pure
read-only routing _decision_; the queue is the separate static
`ToolUseFollowUpQueue` (`src/agent/followUp/ToolUseFollowUpQueueManager.ts`).
The tracking + waiter-notification + stop/kill clusters are genuinely one
cohesive object (stop reads the handle map, every mutation notifies waiters,
`streamStatus.set` re-enters the registry synchronously via `onDidChange`) —
a full split would add abstraction without isolating anything.

What actually remains:

- **Two clean lift-outs**: `getToolUseFollowUpTarget` and
  `requestManualCompaction` are read-only, disjoint-caller methods; the repo
  already narrows the registry via `Pick<ExecutionRegistry, …>` in two places
  (`runCoordinators.ts:39`, `ExecutionSubscriptionBinder.ts:48`) — same
  pattern, copy-move.
- **Double bookkeeping of STOPPED**: both the registry stop path
  (`terminate` :740, `interruptRegisteredStream` :761, `stopAgentStream`
  :622) and the lifecycle arms (`AgentRunLifecycle.ts:157/215/280`) write the
  shared `StreamStatusService` for the same stream, coordinated only by
  STOPPED-wins guards. One writer (the lifecycle) with the stop path
  _requesting_ rather than writing would remove a whole class of guard code.
- **Two live-run indices that must stay coherent**: `handles`
  (executionId-keyed) and `InterruptRegistry.entries` (streamTabId-keyed). A
  stream present in only one is discoverable-but-uninterruptible
  (`terminate` returns false at :738). No test enforces the pairing.
- **Decision-then-act window**: `getToolUseFollowUpTarget` returns `active`,
  then `appendFollowUp` runs (`ToolUseFollowUp.ts:192,199`) with no liveness
  re-check between — a stop landing in that window appends to a terminating
  flow.
- **Unenforced session invariant**: `SessionHandle.ts:99-104` documents that
  the per-session `ExecutionSubscriptionBinder` reads the _process-static_,
  streamId-keyed follow-up queue as its release source — coherent only while
  the queue stays streamId-keyed, flagged in a comment but not by any test.
- **Bimodal tests**: registry unit tests construct fresh injected instances
  (`ExecutionRegistry.vitest.ts:24,46`), while follow-up/integration suites
  still mutate the exported singleton (`ToolUseFollowUp.vitest.ts:51,81`) —
  a migration-in-progress footprint worth finishing.
- **The remaining true cross-session singletons** are deliberate but
  undocumented as such in the DI plan: `StreamStatusService` (same instance
  injected into every `SessionHandle`, :92) and the static
  `ToolUseFollowUpQueue`. (Also: the DI doc still lists
  `idleContinuationRegistry` as a live singleton — that module has been
  deleted; the doc reference is stale.)

### B6. The PocketFlow `shared` bag: DI-cleanup targets the AgentCore bag; the flow bag is the bigger untyped surface

`dependency-injection-cleanup.md` attacks the fat `AgentCore` context. The
adjacent, undocumented instance: flow nodes make **184** `shared.X` accesses
across **41 distinct keys** while the canonical `ToolUseRunShared`
(`implementations/flows/tooluse/nodes/types.ts:38`) types only ~10 of them —
ordering bugs between a node's `post()` write and a later node's `prep()` read
surface only at runtime (guarded ad hoc by `assertPreparedShared`). The same
file still carries `migrateSharedState` handling **three** legacy on-disk
shapes. **Better solution:** typed per-flow context objects (or Zod-validated
slice accessors) instead of the loose bag, and an expiry date for
`migrateSharedState` once persisted runs age out.

---

## Appendix — deep dive (2026-07-03): event/logger pipelines and the execution cluster

Mechanism-level findings behind the B1/B5 revisions above.

### Event architecture as it actually runs

Two independent delivery systems, meeting only at two bridges:

- **Pipeline A (bus):** `ProgressEventBus` — synchronous Node `EventEmitter`,
  54 typed payloads, pre-subscription buffer (1000 events, replayed on first
  `on()`). Consumed by the host-agnostic `ProgressEventHandler` (~22 run-fact
  handlers via `registerHandlers.ts`, 18 approval callbacks via `UIEvents.ts`)
  plus host-specific subscribers (status bar, file decorations, desktop
  window bridge, CLI `subscribeRuntimeHost`).
- **Pipeline B (trace):** `TraceEmitter` implementing the 12-variant
  `AgentEvent` union (`log`, `stage.*`, `tool.*`, `usage`, `context.state`,
  `stream.*`, `domain`, `result`). Per-run subscribers: channel logger
  (`attachChannelSubscriber` → `writeLine` sink), transcript recorder
  (`TexraTranscriptRecorder` → `StreamLogStore`, which each host UI reads
  directly), `conversationProgressHub` (trace→bus projection), and
  `SessionHandle.attachRunTrace` (`result` → `session.onResult`).
- **Key structural fact:** the bus carries **no log lines and no model stream
  text** — all transcript content flows trace→`StreamLogStore`. So "merge the
  log pipeline into the bus" and "collapse the bus into the trace" are both
  non-problems; the systems partition cleanly except for the three duplicated
  facts listed in B1.
- **Emit discipline is fully enforced**: zero raw `bus.emit` under `src/`
  outside `emitRuntimeEvent.ts:31` (the sanctioned single-session fallback);
  `src/tools` (~30 sites) and `src/agent` (~28 sites) all route through
  `runtimeHost.emit`/`emitRuntimeEvent`. Raw bus access exists only in the
  three host packages, which bind the bus by design
  (`extensionAgentRuntimeHost.ts:5`, `desktopAgentExecution.ts:811`,
  `runExecution.ts:70`).
- Migration hazards for any future projection work: the bus's buffering and
  per-handler `withEventErrorHandling` wrapping must be reproduced;
  `ProgressEventHandler` handlers are not pure renderers (they drive
  `streamLogs.ensureLoaded/releaseEntries` eviction and
  `StreamStatusService.set(emit:false)`); `setActiveStream` is half fact,
  half UI command (tab switching, `suppressViewSwitch` gating) and is emitted
  from non-run contexts; `updateProcessOutput` is high-frequency process
  output with no trace analogue — folding it into `stream.chunk` would
  conflate model text with process output.

### Execution cluster as it actually runs

- **Ownership map:** `SessionHandle` (289 lines) composes per-session
  `InterruptRegistry`, `ExecutionRegistry`, `RunCoordinatorBridge`,
  `ExecutionSubscriptionBinder` in forced dependency order
  (`SessionHandle.ts:86-118`); `defaultSession()` aliases the process
  singletons so unmigrated call sites stay byte-identical. Deliberately NOT
  session-owned: `StreamStatusService` (shared instance injected into every
  session), static `ToolUseFollowUpQueue`, `subagentDeliveryRegistry`
  (explicit rationale comment), `toolInjectionRegistry`.
- **Lifecycle single-writer (landed):** `runFlowWithLifecycle` is the sole
  owner of RUNNING and of the terminal transition; `RunOutcome` is projected
  through the declarative `RUN_OUTCOME_PROJECTION` table to
  execution/group/stream statuses, with emit-before-untrack ordering and a
  `resultEmitted` double-publish guard. Terminal fan-out
  (`handle.settleResult`, `session.onResult`, `writeTerminalStatus`,
  `streamStatus.set`) stays consistent only because all four route through
  one projection — this is the invariant to protect in any refactor.
- **Stop propagation:** host → `stopAgentStream` → child sweep
  (cascade/detach sharing one `visited` set) → `terminate` → look up
  `interrupts.get(streamTabId)` → `interrupt()` → flow's
  `InterruptManager` closure sets `isInterrupted` + aborts the
  `AbortController` the model handler streams under.
- **Known safe-but-fragile spots (all currently guarded by synchronous
  single-tick execution):** `streamStatus.set → onDidChange → handles` walk
  re-enters the registry mid-cascade; `untrackHandle` defers the final
  process-output flush across an await (`executionRegistry.ts:273-280`);
  `ExecutionSubscriptionBinder.ts:116-124` re-checks the handle after
  `addListener` (TOCTOU); `wakeAttempts` serializes concurrent resume wakes
  (`ToolUseFollowUp.ts:52,78-90`).
- **AgentCore/RunContext split-brain, concretely:** flow nodes read the
  services bag while tools read the ALS `RunContext`; both are populated from
  the same `AgentLaunchContext` (`agentContextToRunContext`,
  `AgentLaunchContext.ts:153-172`). Same-fact-two-paths examples: `streamId`
  (`BaseFlowServices.ts:53` vs `tryUseRunContext()?.streamId` in
  `bashApproval.ts:72`, `PlanTool.ts:112`), `executionId`
  (`CommonCycleTypes.ts:98` vs `MemoryTool.ts:197`, `bash.ts:157`),
  `workingDirectory` (`AgentCore.workingDirectory` vs `bash.ts:134`,
  `DiagnosticsTool.ts:120`). Each duplicated field has exactly one write
  site, so per-field collapse is mechanical. The bag over-carry is wholesale
  spreads (`{...this.services}`) inflating declared ~13 fields to ~31-35 at
  runtime with 70-90% unread per node — also mechanical to narrow.

---

## Suggested priority

1. **A2 host-adapter factories** — highest bug-yield per line deleted; purely
   mechanical; no design debate.
2. **A1 model-handler hoists** (prefill template method → capabilities struct →
   OpenAIResponse/Google collaborator splits) — largest raw mass; every
   provider feature currently pays 4–5×.
3. **B2 shared projection/display-model layer** — unblocks CLI feature parity
   and deletes the synthetic-entry hacks; B1's taxonomy split
   (RunFacts/ApprovalRpc/AppSignals) is a natural prerequisite so the shared
   reducer folds a well-typed event set.
   3a. **B1/B5 targeted fixes** (small, high-safety-value): usage single-emit +
   projection; terminal-status single-writer; a test enforcing the
   handles/interrupts pairing and the binder↔queue keying invariant; close
   the follow-up decision-then-act window; lift
   `getToolUseFollowUpTarget`/`requestManualCompaction` behind `Pick<>`
   interfaces; migrate the singleton-bound follow-up tests to fresh sessions.
4. **B4 config codegen** — deletes tooling and a whole failure mode; small.
5. **A4 test-infra** (`memfs` + global setup) — cheap, pays on every suite.
6. **A3 MainApp slice migration, B3 boundary enforcement, A6 transcript store
   unification, B5/B6 cohesion splits** — as-touched.
