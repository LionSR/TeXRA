# Tech-debt audit: largest debts not previously uncovered (2026-07)

> **Status:** Open tracking audit (2026-07-03; status refreshed 2026-07-04,
> Part D follow-up scan appended 2026-07-04).
> This is the evidence base for the #6950/#6951/#6952/#6953 tech-debt program.
> Items are implemented by the tracking issues; re-verify every cited file before
> acting because this area changes quickly.

Full-repo sweep (repo-root `src/` ~245k LoC non-test, `packages/extension` 57k,
`packages/cli`, `packages/desktop` 10.9k) cross-referenced against the existing
debt corpus (`docs/proposals/*`, `docs/dev/audits/2026-05-31-tui-performance-audit.md`,
`docs/dev/audits/2026-05-08-standalone-trajectory-audit.md`, coupling/SDK-readiness audits and the
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
  independent booleans. **Fix:** one declarative `ProviderCapabilities` source
  per handler, with entries allowed to be runtime resolvers over config/auth
  mode rather than only static constants. `ModelHandlerCodex` is the concrete
  warning: subscription and API-key routes do not advertise the same
  capabilities.
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
  duplicates most of the abstract class surface by hand. **Fix:** derive the
  common surface from one source, while preserving interface-only extension
  ports such as `createBatchedToolUseFollowUpMessages?`, which
  `ToolUseDispatchNode` feature-detects for providers requiring batched
  parallel tool-result messages.

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
a thin host-capability interface. Scope it to repeated controller/command
wiring, not to deliberate host-specific flows already called out in
`2026-07-03-agent-runtime-ui-coupling-audit.md` (GitHub subscriptions, crash reporting,
history export/rerun, provider-key differences, and similar platform seams).

### A3. `MainApp.ts`: 1,887-line god component running three state mechanisms at once

`packages/extension/src/webview/frontend/MainApp.ts` mixes 31 ad-hoc
`signal(...)` fields in the class state block, 4 `@state()` fields (2 also
`@provide()` context fields), and a `PersistedState`/`createWebviewStorage`
manager, with restore logic sprawled over three methods. The repo already
contains the correct pattern —
`progressView/frontend/` uses a store + 10 slice files with `mutative` — and
MainApp simply predates it. Same story in miniature for
`settingsView/frontend/SettingsApp.ts` (1,140) +
`settingsView/frontend/tabs/LaTeXTab.ts` (848).
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

- `scripts/` holds ~30 `.mjs` files, ~5,000 lines, including a hand-rolled
  JSON-comment stripper in `aliasUtils.mjs` (reimplements `strip-json-comments`)
  whose own header admits the extension tsconfig "will silently follow the
  root" on divergence.
- Root `tsconfig.json` has **46 path aliases**; `@/*` and `~/*` are exact
  duplicates, and several "shared" aliases (`@webview/*`, `@commands/*`,
  `@settingsView/*`, …) point into `packages/extension/`, coupling core to one
  host. `packages/desktop/tsconfig.paths.json` is a second hand-maintained copy.
- Desktop carries 5 tsconfigs; `scripts/extension-package-invariants.snapshot.json`
  is a 70 KB committed generated artifact (see B4 for the better end-state).
- The patch audited as `patches/ink@7.1.0.patch`, now carried unchanged as
  `patches/ink@7.1.1.patch`, has no documented exit plan (upstream issue or
  re-evaluation trigger on ink bumps).

**Fixes:** use `tsconfck`/`strip-json-comments`; drop `~/*`; move host aliases
into host tsconfigs only after the root typecheck is split or taught to read
the host project configs (today `tsc --noEmit` still includes extension files
that import `@commands/*`, `@frontend/*`, `@progressView/*`, etc.); generate
the desktop table from root; consolidate desktop tsconfigs via project
references; document the ink-patch exit plan.

### A6. Transcript persistence: four overlapping stores (2,856 LoC)

`src/transcript/` — `StreamSnapshotStore.ts` (1,046), `StreamLogStore.ts`
(814), `streamSnapshotRead.ts` (218), `StreamLog.ts` (185) — carries two durable
per-run stores plus a separate read path. They are not interchangeable:
`StreamSnapshotStore` owns sidecars under `streamData/{id}/*` (output files,
usage, todos/plan, task state), while `StreamLogStore` is the append-only
transcript under `streamLogs`. The coupling audit's #6889 (vestigial pub-sub,
headless sidecar gap) touches this area but not the narrower duplicated
read/write paths. **Fix:** one facade over both formats, with explicit
ownership of sidecars vs transcript entries; do not force sidecar-only restore
data into the append-only log. Also fixes the CLI's synthetic-entry dedup at
the source (see B2).

### A7. Smaller, contained items

- **Command-surface dual bookkeeping:** `extensionCommandSurface.ts` (538 LoC,
  40 aliased imports, 111 command-id strings) hand-mirrors
  `src/shared/commands/catalog.ts`, which desktop already consumes cleanly.
  Drive extension registration from the catalog plus explicit hidden-alias
  metadata/table, so compatibility ids such as `texra.showSettingsView` remain
  registered even when they are intentionally absent from the public catalog.
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
full map.)_ Documented state: `2026-06-10-error-pipeline-and-ownership.md` ruled that new
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
   `docs/dev/audits/2026-05-29-agent-sdk-readiness-audit.md:226`.
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

Note the logger itself is **no longer debt**: `src/logger/` is 381 lines, 4
files after the redaction helper expansion, with one channel-sink boundary and
`AgentLogger`/`structuredLogger` genuinely deleted. The remaining cost is fact
duplication across pipelines, not stacked modules.

### B2. CLI↔extension sharing: the documented rung-ladder targets approvals; the real duplication is the projection layer

`2026-05-31-tui-extension-sharing.md` (rungs 3–4 open) shares approval/proposal
orchestration. But both frontends independently re-project the **entire**
`ProgressEventPayloads` stream into view state: CLI
`chat/tui/state/` (4,352 LoC: `subscribeApprovals` 534, `subscribeStreamLog`
443, `subscribeRuntimeHost` 298, …) + `toolRenderers.tsx` (623 ANSI) versus the
extension's `progressView/frontend/` (**18,788 LoC**: 10 slices + 3,196 LoC of
formatters). `cliState.ts:1-6` still claims it "mirrors the webview's shape …
so feature parity is a port, not a rewrite" — the shapes have already forked
(one 25-field map-of-structs vs 10 slices). Only `normalizeToolUseData` is
genuinely shared.

**Better solution:** not the broad "single reducer for CLI and webview" rejected
in `2026-07-03-agent-runtime-ui-coupling-audit.md:76` (that rejection is still correct for
async disk I/O, race handling, host-specific derived fields, and persistence
ownership). The viable target is narrower: one shared projection/display-model
layer for common run facts and per-tool presentation facts (title, sections,
status, elided output), while each host keeps its own persistence and derived
UI state. This also dissolves the CLI's fragile synthetic-entry machinery
(`state/transcript.ts:35` dedup-by-normalized-text,
`syntheticAfterSeq` splicing in `subscribeStreamLog.ts:385-411`) — the correct
fix is upstream: emit the finalized assistant message into `StreamLogStore`
with a stable id so synthetics/dedup disappear entirely.

### B3. `@texra/core` "SDK boundary": declared done, but nothing enforces it

`2026-05-30-agent-sdk-readiness.md` marks Steps 1–7 landed and the checkpoint concludes
"SDK-ready in shape." As of the audit, the artifact was a single 134-line
re-export barrel — `"private": true`, `main`/`exports` pointing at raw
`./src/index.ts`, no emit build, excluded from root tsconfig — and its own
header conceded deep `@agent/*` imports "are not being migrated in bulk." An
unenforced boundary drifts by default.

**Better solution:** pick one honestly. Either (a) enforce: an ESLint
`no-restricted-imports` rule banning deep `@agent/*`/`@platform` imports from
`packages/{cli,desktop,extension}` (allowlist the current offenders, ratchet
down) plus a real build so the package is publishable; or (b) demote. #7099
selects path (b): remove the unused package/dependencies and describe the SDK
package as a future enforced surface rather than a current artifact. The costly
state was the middle: SDK claims without SDK guarantees.

### B4. Config catalog: extend the documented plan to code-generate the manifest and delete the snapshot machinery

`2026-06-26-config-catalog-unification.md` proposes a catalog SSOT feeding the extension
settings view and a CLI `/config`. The audit found the deeper cost sits in what
that plan doesn't yet subsume: `packages/extension/package.json` is a 72 KB
hand-maintained manifest (65 settings + 67 commands) synced by
`sync-settings-configuration.mjs` and guarded by a **70 KB committed snapshot**
(`extension-package-invariants.snapshot.json`) — and core still reads settings
by raw string key (`config.get('texra.files.exclude', …)`), with feature-flag
wrappers existing solely to hide that.

**Better solution:** make the catalog generate _both_ directions —
`contributes.configuration`/`contributes.commands` in package.json **and** a
typed `SettingKey` accessor map consumed via `platform().config` — then replace
the snapshot part of the invariant machinery with a codegen diff check while
preserving package-resource checks that are not catalog-derived (required
agents/docs/templates/webview assets and `.vscodeignore` allow-list lines).
Same SSOT the proposal wants, but it removes the 70 KB generated artifact and
the silent-rename failure mode without weakening VSIX resource validation.

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
  `ToolUseFollowUpQueue`. The DI doc's stale deleted-registry cite was corrected
  by the 2026-07 D2 proposal-status sweep.

### B6. The PocketFlow `shared` bag: DI-cleanup targets the AgentCore bag; the flow bag is the bigger untyped surface

`2026-06-07-dependency-injection-cleanup.md` attacks the fat `AgentCore` context. The
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

- **Ownership map:** `SessionHandle` composes per-session `InterruptRegistry`,
  `ExecutionRegistry`, `RunCoordinatorBridge`, `ExecutionSubscriptionBinder`,
  event hub, transcript store, and follow-up queue in forced dependency order;
  `defaultSession()` aliases the process singletons/default store/default queue
  so unmigrated call sites stay byte-identical. Deliberately NOT session-owned:
  `subagentDeliveryRegistry` (explicit rationale comment),
  `toolInjectionRegistry`.
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

## Part C — second sweep (2026-07-03): tools, LaTeX, model/auth, IPC performance, async correctness

Five areas not covered by Parts A/B, audited to the same evidence standard.
Each subsection ends with what is healthy, so fixes don't churn sound code.

### C1. Tools layer: the result contract never declares its status

`src/tools/` is 29,135 LoC, 56 tools behind one clean contract
(`defineTool` → `BaseTool`), with projection to model/transcript/headless
written once, centrally. The debts are in the contract's blind spots:

- **C1a (keystone). `ToolResult` has no `status` at the source.**
  `ToolResultSchema` is an all-optional `looseObject`
  (`toolResult.ts:127-149`); success-vs-error is reverse-engineered
  downstream by `NormalizedToolResultSchema`'s heuristic
  (`isError || (error && !output)`, `:179-198`) and then re-parsed into the
  _real_ discriminated `ToolResultPayloadSchema` that model/trace layers
  want (`toolAttachmentUtils.ts:78-101`). All 56 tools flow through the
  heuristic bridge, which papers over real bugs — `ExecutionsTool.handleKill`
  returns `isError: true` with the message in `output`, not `error`
  (`ExecutionsTool.ts:602-648`). **Fix:** tools return the discriminated
  union at the source; delete the normalizer and the fallback ladder. Then a
  single `toolError()` builder makes the throw-vs-return convention
  principled (throw = programmer error, return = expected failure).
- **C1b. Two parallel child-agent run drivers.** Native subagents
  (`subagentExecution.ts`, 542 LoC) and external CLI agents
  (`agentCliSessionLoop.ts`, 351) hand-implement the same
  launch → deliver-to-parent-queue → persist-report → derive-outcome →
  terminal-status choreography twice, including twin delivery-envelope
  formatters (`subagentResults.ts` 469 vs `agentCliShared.ts:60-95`, both
  emitting the same `<…-result>` XML). The codex/claude pair already proves
  the fix: both are ~30-line strategies over one shared loop
  (`AgentCliSessionStrategy`). **Fix:** promote that loop to the single
  child-run driver (the architecture proposal's `session.runs` owns it);
  native delegation becomes a strategy.
- **C1c. Tool capabilities live as four external name-sets** —
  `APPROVAL_GATED` (20 names), `SLOW_TOOLS`, `DEFERRED_LOG_TOOLS`,
  `STREAMABLE_TOOLS` (`approvalGatedTools.ts:7-28`,
  `ToolUseDispatchNode.ts:38-50`) — because the contract has no capability
  axis. Adding a tool means editing up to four far-away sets. **Fix:**
  optional capability flags on `ToolDefinition`; the dispatcher reads
  `tool.definition.*`.
- **C1d.** `ExecutionsTool` (951 LoC, ~30 methods, 12 virtual routes) wants
  the same `executions/*` extraction already started for its formatters;
  its file-reader subsystem duplicates the `..` traversal guard
  **character-for-character** with `AcceptRunFilesTool.ts:154-155`, plus
  five more ad-hoc variants — one `assertNoParentTraversal()` helper is
  missing and each unshared copy is a potential path-escape bug.

Healthy: single contract shape, centralized projection, clean registry,
Zod v4 hygiene nearly complete (241 `.prefault/.catch/.nullish` uses; two
stragglers in `ExternalInquiryTool.ts:121,130`), and silent catches are
overwhelmingly disciplined best-effort-with-logging.

### C2. LaTeX subsystem: healthy core, fragility concentrated in two files

`src/latex/` (5,133 LoC, 30 files) passes the platform test perfectly: zero
`vscode` imports, filesystem via `platform().fs`, every binary invoked
through the shared `executeCommand` (execa, array-form args — no shell
quoting bugs — centralized tree-kill/timeout). The compile-failure pipeline
deliberately does **no** LaTeX-log parsing: binary exit code + raw 200-line
log tail for the LLM (`texTools.ts`, `compileCheck.ts`) — best-in-class
choice that sidesteps TeX-distro brittleness; protect it. The debts:

- **C2a. Diff machinery fragmentation:** four bare `new diff_match_patch()`
  instantiations with no shared wrapper (`diffComputation.ts:51`,
  `contentSimilarity.ts:90`, `subagentDiffs.ts:34`,
  `toolEditApproval.ts:135,203,328`), already drifting (some
  `diff_cleanupSemantic`, some not; line-mode vs char-mode). **Fix:** one
  `@utils/text/diff` module (line diff + stats + cleanup).
- **C2b. `diffFileProcessor.ts` regex patch-stack** over latexdiff output —
  six hardcoded repair regexes plus preamble skipping keyed on
  natural-language markers **including LLM phrasing** (`'Here is'`,
  `'以下是'`, `:34`). Silently corrupts when latexdiff or model phrasing
  shifts. **Fix:** structured preamble-boundary detection + fixture matrix.
- **C2c.** The bib-error retry requires **all four** hardcoded latexdiff
  message substrings (`diffCommandExecutor.ts:15-20,265-269`) — the
  `--flatten` fallback dies silently on a message change. **C2d.** TikZ
  extraction uses lazy `.*?` regexes (with `/gs`) that miss `figure*` and
  break on nested environments — lazy matching stops at the first closing
  delimiter, not the matching one (`TikzPictureManager.ts:76-78`).

### C3. Model registry + auth: capability variance by auth mode is the anchor

`src/model/` (953 LoC) is structurally sound: `llm-zoo` is the true single
source of model facts (no local table — even the Supabase relay consumes
it), handler routing is enum-keyed and exhaustiveness-checked, one model
catalog serves all three hosts, and secret hygiene is excellent (secrets
never cross IPC/webviews — status-only DTOs; no key material in errors or
logs). `src/auth/` is 4,181 LoC. The debts:

- **C3a (anchor — confirms the maintainer's Codex warning).**
  Subscription-vs-API-key is a **capability fork implemented as ~15
  `usingSubscription()` runtime overrides** in `modelHandlerCodex.ts:207-380`
  (context window clamped to a hardcoded 272k, token counting / compaction /
  uploads disabled, different pricing) — while the picker still advertises
  llm-zoo's API-key capabilities (`computeModelOptions.ts:180-189`). The
  routing _predicate_ is properly centralized (`codexSubscriptionRouting.ts`); the
  _consequences_ are scattered. **Fix:** the declarative
  `ProviderCapabilities` record from A1, **keyed by (model, auth-mode)**
  with runtime resolvers — subscription becomes a capability profile the
  picker reads, not 15 method forks.
- **C3b. Two (soon three) concurrent-refresh coordinators.**
  `SupabaseSessionCoordinator` (mutex + mutation-version + store-if-current)
  and `CodexSessionCoordinator` (in-flight flags + generation counter) solve
  the identical single-flight/supersede problem with different primitives
  (`SupabaseSession.ts:196-345` vs `CodexSessionCoordinator.ts:118-289`);
  the Copilot OAuth PRD implies a third. **Fix:** one generic
  `RefreshingTokenStore<Session>`; providers supply `refresh()`/`isExpired()`.
- **C3c. Capability split-brain:** llm-zoo's 20 per-model data flags vs
  **128** handler-level `is*/supports*/requires*` predicates with no unified
  resolver — the superset of Part A1's count; C3a is its worst symptom.
- **C3d. Security-adjacent: redaction coverage gaps.** `redaction.ts:6-7`
  recognizes only `sk-`/`sk-ant-`/`xai-` key shapes (plus `KEY=`/Bearer
  forms) — a raw Google `AIza…`/Moonshot/DeepSeek/GLM key logged outside
  those shapes reaches off-machine sinks unredacted. **Fix:** derive the
  pattern set from `PROVIDER_REGISTRY`; assert every off-machine sink is
  wrapped.
- **C3e.** Tier/spend policy manually mirrored client↔relay with "you MUST
  update both" comments (`sharedConfig.ts:97-129` ↔ `relay/models.ts:79-169`)
  — billing-adjacent silent drift; codegen or shared JSON. **C3f.** Stringly
  model-family routing (`startsWith('gpt-5')`, Anthropic name prefixes,
  hardcoded Codex eligible-model list) belongs as data flags on the model
  config.

### C4. Webview IPC performance: streaming is quadratic; everything else is per-event

A message-volume model of a streaming run found exactly one per-token-scale
cost, and it's quadratic twice over:

- **C4a (dominant). Full-buffer resend + full re-format per streaming
  tick.** Every 50ms the recorder writes the _entire accumulated text_ into
  the streaming row (`TexraTranscriptRecorder.ts:137`), the bridge ships the
  _whole entry_ in `LOG_DELTA.updates` (`StreamLog.ts:123`,
  `WebviewBridge.ts:139`), and the frontend re-parses the whole growing text
  through the formatter (new object ref defeats `guard()` memoization by
  design). Bytes and CPU are O(L²) in response length. **Fix:** a text-delta
  protocol (`{id, appendText}`) for live rows — one change removes both
  quadratic costs.
- **C4b.** `sendStreamMetadata` rebuilds and ships **all historical
  streams** (two O(N) loops, `WebviewUpdater.ts:392,428-442`; N unbounded =
  every stream ever persisted) and fires per run start _and per subagent
  spawn_ — O(N·S) during fan-out runs, O(N) at startup. **Fix:** per-stream
  add/patch messages + memoized per-stream metadata.
- **C4c.** `@lit-labs/virtualizer` is a declared dependency with **zero
  imports**; long transcripts rely on manual windowing (120 timeline / 400
  per-group rows with reveal buttons). Mount it on the timeline `repeat()`
  or drop the dependency. **C4d.** The 50ms recorder throttle + 16ms bridge
  frame are a redundant double buffer for single-row streaming (five ad-hoc
  timing constants total, no shared policy). **C4e.** The 300ms save
  debounce serializes the full stream log on the same hot path.

Healthy (explicitly fenced off): the frontend's incremental `MessageIndex`

- keyed `repeat()`/`guard()` pipeline, the trimmed 7-field `StreamMetadata`
  payload, cheap known-stream tab switches, per-window clone-free desktop
  relay, and the eviction/rehydration machinery.

### C5. Async correctness: four real defects in an otherwise disciplined codebase

The sweep (129 statement-position `void` calls, 220 `Promise.all*` sites,
9 AbortControllers, zero unguarded async bus handlers) found the store
write-chains, coordinator timeout handling, and `withEventErrorHandling`
wrapping genuinely careful. The defects:

- **C5a.** Two `void sendFollowUp(...).then(...)` sites with **no
  `.catch`** — `ExecutionSubscriptionBinder.ts:170` and
  `github/StreamSubscriptionRegistry.ts:131`. `appendFollowUp` or the
  `.then`'s `runtimeHost.emit` throwing during teardown ⇒ unhandled
  rejection. Both sites get _more_ reachable under session scoping.
- **C5b (data-loss window).** Desktop never awaits the transcript-store
  flush at quit: only `snapshotStore.flush()` is a registered shutdown
  handler (`desktop/platform/index.ts:210`); the per-window
  `StreamLogStore` flush is fire-and-forget on window `closed`
  (`desktopAgentExecution.ts:588`), racing the 300ms write debounce against
  process exit. The extension does this correctly
  (`extension.ts:275-277` awaits `flushState()` in a BEFORE phase).
- **C5c.** `goalStore.addToIndex` read-check-act across an await
  (`goalStore.ts:109-113`): concurrent goal creation on different streams
  last-writer-wins the index — silently dropped entries (the file's own
  comment acknowledges dangling entries). **C5d.**
  `executionLifecycle.ts:130` `Promise.all` over config/meta/parent-link
  writes — one rejection leaves a half-registered execution on disk.

The sweep also classified which known-safe patterns the session refactor
would destabilize (the deferred `untrackHandle` flush vs `dispose()`, the
process-global `wakeAttempts` map, the streamId-keyed queue) — these are
inputs to the architecture proposal's §5 risk list, not immediate bugs.

### Part C quick wins (small PRs, independent of the architecture program)

Add `.catch` to the two C5a sites; await the desktop stream-log flush in a
shutdown phase (C5b); serialize `addToIndex` through the existing
per-stream write pattern (C5c); extract `assertNoParentTraversal()` (C1d);
broaden the redaction pattern set (C3d); fix the two Zod stragglers (C1);
delete or mount the unused virtualizer dependency (C4c).

---

## Part D — follow-up scan (2026-07-04): gaps in the `github/` and edit-tool subtrees

A second independent sweep (four parallel readers over `modelHandlers/`,
`tools/`, `transcript/`, cross-cutting patterns, and the CLI/webview
frontends) re-derived Parts A–C from scratch and confirmed them (line counts
match: MainApp 1,887, `modelHandlerOpenAIResponse` 2,871, `StreamSnapshotStore`
1,046). It surfaced **four duplication debts not covered anywhere in this
document or the audit corpus** — the Part-C sweep audited `tools/` broadly but
never entered the `tools/github/` polling subtree or the edit-tool family, and
A1's model-handler decomposition names prefill/continuation but not the two
adjacent hoists below. Same evidence standard; line numbers below are pinned to
`main` at `73c358f` — re-verify (they drift quickly, especially in
`modelHandlers/`) before acting.

### D1. GitHub polling-source family: seed-branch cloned from diff-branch per resource (~150–220 LoC)

`src/tools/github/` carries three near-identical pollers over one
`PollingSourceBase` (370):

| File                    | LoC | `pollOne` |
| ----------------------- | --: | --------: |
| `PRPollingSource.ts`    | 884 |    `:308` |
| `RepoPollingSource.ts`  | 573 |    `:210` |
| `IssuePollingSource.ts` | 238 |    `:131` |

Every `pollOne` hand-copies the same skeleton per tracked resource: build
`?since=` URLs → `Promise.all` the GETs → per-endpoint `safeParse`-or-`warn`
(each preceded by the same "must not throw or the 24h detach trips" rationale,
copied verbatim across all three files) → **a seed branch
(`if (!state.initialized) { …; state.initialized = true; return }` —
`PRPollingSource.ts:459`, `RepoPollingSource.ts:272`,
`IssuePollingSource.ts:214`) that mirrors the diff branch's seen-id / cursor
bookkeeping with the `emit()` calls removed** → the dedup/trim unit
(`seen.has/add` + `shouldDropBotEvent` + `trimSet(…, MAX_SEEN_IDS)` +
`getNewestTimestamp`, `PRPollingSource.ts:535-574`) repeated once per resource
(4× PR, 3× Repo, 2× Issue, ~9 copies). The shared bookkeeping parity is
enforced only by copy-paste discipline: a fix landed in one branch (e.g. bot
filtering) can silently miss its seed twin, and each new event resource
re-derives the whole seed/diff/trim quartet by hand.

Note the seed branch is **not** pure diff-minus-`emit`: it also does
cursor-specific initialization the diff path doesn't — e.g.
`RepoPollingSource.ts:280` seeds `prUpdatedAtByNumber` (with a comment
explaining it prevents a next-tick merge-probe stampede) while the diff path
delegates mergeability to `probeMergeableStates`. Any consolidation must
preserve these seed-only init behaviors rather than assume strict parity.

**Fix:** a declarative `DedupedResource<T>` on `PollingSourceBase` owning
`{ seenIds, sinceCursor }` and exposing `seed(items)` / `diff(items, emit)`, so
`pollOne`'s shared bookkeeping reduces to `resource.seed(data)` (init) or
`resource.diff(data, c => emit(format(c)))` — with seed-only side effects
(cursor pre-seeding) kept as explicit per-resource init, not folded into the
generic `seed`; wrap the parse-or-skip block in one
`validateOrSkip(res, schema, label)` base helper; hoist the three identical
`backoffBaseMs`/`backoffMaxMs`/`maxFailureDurationMs` config literals
(`PollingSourceBase.ts:45-47`) into a shared default. Warrants its own tracked
issue — larger than a quick win, independent of the architecture program.

### D2. Edit/Write/TextEditor: the approve-and-write pipeline re-inlined 4× (~60–100 LoC)

The read-gate → approval → write → diff-note sequence
(`requireFileReadForEdit` → `requestApprovedEditContent` → reject-check →
`writeApprovedContent` → `recordToolFileRead` → assemble the
`{summary, output, userPatch, edits[]}` result) is re-inlined in four places:
`EditTool.ts` (`:72,:104,:116,:122`), `WriteTool.ts` (`:53,:64,:76,:82`), and
**twice inside** `TextEditorTool.ts` — `create` (`:302-328`) and `undoEdit`
(`:597-624`). TextEditorTool's `create` is essentially WriteTool re-inlined;
`undoEdit` re-inlines it again. Any change to the approval/return contract must
land in all four.

TextEditorTool's other two edit commands, `strReplace` (`:415`) and `insert`
(`:508`), have **already** factored the pipeline into the in-file helpers
`prepareEditContent` (`:356`) and `approveAndWriteEdit` (`:380`) — they are the
consolidated precedent, not additional copies. The real target is to promote
that in-file helper to a cross-tool one so `create`/`undoEdit`, EditTool, and
WriteTool all route through it.

This is **distinct from F5 (#6975)**, which fixes the `ToolResult` _status
contract_; F5 does not dedupe this execution pipeline. **Fix:** one shared
`applyApprovedEdit({path, originalContent, proposedContent, sourceTool})` helper
(generalizing TextEditorTool's existing `approveAndWriteEdit`); each command
computes only `proposedContent` and delegates. Best landed alongside F5 while
these files are open.

### D3. Extends A1/F3 — two model-handler hoists it does not name

A1's decomposition (F3 #6973 prefill/continuation template, F4 #6974
capabilities) leaves two adjacent copy-paste seams untouched:

- **Streaming-catch boilerplate across 5 handlers.** The mid-stream failure
  path — `thinking?.finalize(undefined)` + `output?.finalize()` + partial-tail
  extraction + `annotateStreamFailure(err, tail, …)` + rethrow — is copied in
  `anthropic:723`, `openai:433`, `openaiResponse:2011`, `googleGenAI:521`,
  `openRouterNative:281` (the "parity with the other streaming providers"
  comments admit it). A protected `runProgressStreaming()` template method on
  `ModelHandler` would own stream creation + the try/finally finalize + the
  catch block; providers pass only their per-chunk `consume`. **Carve-out:**
  `modelHandlerOpenAIResponse` is not pure catch-and-annotate — before the
  outer catch it can recover the Responses-API result via
  `retrieveAfterUnhandledStreamEvent` (`:1896,:1966,:1973`) and finalize
  normally. The template must expose an optional provider `recover(streamError)`
  hook (default: none) so a Responses stream interrupt still recovers rather
  than being forced straight to `annotateStreamFailure`.
- **Near-identical message construction, OpenAI ↔ OpenRouterNative.**
  `initializeMessages` / `createRoundMessages` / `createUserFollowUpMessages`
  run the same algorithm (`openai:674,:741,:777` vs
  `openRouterNative:362,:425,:457`); OpenRouter's message model has the OpenAI
  chat shape (~120–160 LoC). It is **not** byte-identical — the media-failure
  log call diverges (`openai:757` `logSdkError` vs `openRouterNative:441`
  `this.logger.error`) and a prior audit explicitly rejected treating the
  OpenRouter SDK surface as the OpenAI base over real type/shape differences.
  So the hoist is a shared helper over the **truly common algorithmic pieces**
  (role selection, media-append gating, "append to last user message vs new"),
  parameterized on the per-provider message/part types and the error-log call —
  not a merge that re-couples the two SDK surfaces. Extract into the existing
  `src/agent/modelHandlers/support/` collaborator directory (alongside
  `UsageNormalizer`, `MediaAttachmentProcessor`).

Fold both into F3's sub-debt list rather than tracking separately.

### D4. Smaller items

- **`externalToolDefs.ts` `detailCheck` duplication (~40–60 LoC).** The Codex
  (`:507`) and Claude-agent (`:572`) `detailCheck` callbacks run the same
  algorithm (import SDK → classify the `not found`/`MODULE_NOT_FOUND`/`Cannot
find package` triad → find native binary → append WSL hint) that
  `probeSdkBinaryAvailable` (`:205`) already shares for their `check`. Add a
  matching `describeSdkTool({importSdk, findBinary, pkgName, …})` helper.
- **Reasoning-gate: only the one-shot guard is duplicated, not the payload
  (~20–40 LoC).** The guard
  `if (workspaceState && !workspaceState.reasoning.thinkingAdded) { …; thinkingAdded = true }`
  is inlined in `anthropic:1234`, `googleGenAI:801`, `googleInteractions:1001`.
  But these are **not** foldable into the string-only base helper
  `ModelHandler.applyStringReasoningToWorkspaceState` (`:1241`), which stores a
  plain `{ type: 'thinking', thinking: string }` block (correct for
  OpenAI/OpenRouter). The structured providers legitimately store richer,
  continuation-critical payloads the string helper would discard —
  Anthropic keeps the full SDK `thinkingBlocks` (`:1241-1244`) and Gemini keeps
  per-part `thoughtSignature` (`googleGenAI:802-806`). The duplication is only
  the guard-and-set-once bookkeeping, so the fix is a typed
  `applyReasoningBlocks(blocks, workspaceState)` that takes already-constructed
  provider blocks and applies the one-shot guard — **not** routing these through
  the string helper. Fold into F4, scoped to the guard only.

---

## Suggested priority

1. **A2 host-adapter factories** — highest bug-yield per line deleted when
   limited to duplicated controller/command wiring; deliberate platform seams
   remain host-owned.
2. **A1 model-handler hoists** (prefill template method → capabilities struct →
   OpenAIResponse/Google collaborator splits) — largest raw mass; every
   provider feature currently pays 4–5×.
3. **B2 shared projection/display-model layer** — unblocks CLI feature parity
   without reviving the rejected full-reducer extraction, and deletes the
   synthetic-entry hacks; B1's taxonomy split
   (RunFacts/ApprovalRpc/AppSignals) is a natural prerequisite so the shared
   projection layer folds a well-typed event set.
   3a. **B1/B5 targeted fixes** (small, high-safety-value): usage single-emit +
   projection; terminal-status single-writer; a test enforcing the
   handles/interrupts pairing and the binder↔queue keying invariant; close
   the follow-up decision-then-act window; lift
   `getToolUseFollowUpTarget`/`requestManualCompaction` behind `Pick<>`
   interfaces; migrate the singleton-bound follow-up tests to fresh sessions.
4. **B4 config codegen** — deletes the snapshot artifact and silent-rename
   failure mode while preserving package-resource checks; small.
5. **A4 test-infra** (`memfs` + global setup) — cheap, pays on every suite.
6. **A3 MainApp slice migration, B3 boundary enforcement, A6 transcript facade,
   B5/B6 cohesion splits** — as-touched.
7. **D1 polling-source `DedupedResource<T>`** — new tracked issue; independent
   of the architecture program. D2 rides F5, D3 folds into F3, D4 into F4.
