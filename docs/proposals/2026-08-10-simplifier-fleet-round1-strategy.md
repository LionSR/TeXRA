# Round-2 Strategy — Code-Simplification Fleet (sweep of 2026-08-10)

Synthesis of 47 worker reports (46 areas; the two `area-10-transcript` entries are one
area's observations, deduped throughout). Input: 187 structuralIssues + 168 crossFile
leads → **28 deduped clusters** across 8 themes. Corroboration counts below count
distinct _areas_ that independently reported evidence for the cluster.

Checked against: do-not-do ledgers `#8758` and `#8974`, and the taxonomy in
`.claude/agents/our-code-simplifier.md`. No cluster re-proposes a ledger-banned item;
two candidates carry explicit gates (noted inline): the settings-dispatch convergence
must be cleared against the `#8744` "settings one composition path" maintainer hold,
and all copy-level unifications respect the #7622 per-host-vocabulary isolation rule
(share logic, never grammar).

Classification key:

- **fleet-editable** — safe for a behavior-preserving fleet worker with a scoped assignment
- **needs-own-PR** — behavior-visible (perf, I/O, wire, ownership) or cross-cutting; one named owner + review
- **defer / do-not-do** — conflicts with adjudicated rulings, mid-migration churn, or below payoff threshold

---

## Theme A — Test-only production surface (the single biggest cluster)

### A1. Prod classes/modules carry public surface that exists only for test-kernel

**Corroboration: 11 areas** (02, 03, 04, 05, 10, 11, 14, 18, 24, 34, 44) — the most
widely corroborated finding of the round, and it maps 1:1 onto the planned round-2
test-kernel sweep.

Evidence (union):

- `src/transcript/StreamSnapshotStore.ts` `deleteStream` (~20 test call sites only), `src/transcript/StreamLogStore.ts` `clear()` — both counted in `config/ratchets/store-public-surface-baseline.json`, so the pinned budget overstates the real surface (area-10)
- `src/tools/agentCliSessionRegistry.ts` `release()` — test-only method on a concurrency-sensitive registry (area-02)
- `src/tools/TextEditorTool.ts` `ExecutionFileHistory.filesFor`, `src/tools/setup/platform.ts` `TerminalRunResult` alias re-export (canonical home `@hosts/uiHosts`) (area-04)
- `src/tools/github/PRPollingSource.ts` private `fetchAnnotations` delegator kept for `PRPollingSourceAnnotationPages.vitest.ts`; retarget at `checkRunsClient.fetchAnnotations` then inline (area-05)
- `src/common/errors/sdkErrorUtils.ts` — ~10 prod-orphan barrel re-exports alive only via test-kernel imports (area-11)
- `src/agent/modelHandlers/ModelHandler.ts` `getApiKey` + `ModelHandlerCodex` override — sole consumer `ModelHandlerApiKey.vitest.ts`; also a duplicate credential-routing decision path vs `resolveClientCredential` (area-18)
- `src/controllers/onboarding/setupLaunch.ts` `selectDesktopSetupModel` (area-24)
- `packages/extension/src/progressView/frontend/streamTree.ts` `getStreamBranchActivity` (area-34)
- `packages/cli/src/runtime/workflowInputs.ts` `expandWorkflowInputSpecs` (zero prod callers) + ~13 more export-only-for-tests symbols in `packages/cli/src/runtime/` (area-44)
- `src/tools/fileEditFlow.ts` literal-replace exports consumed only by `FileEditFlow.vitest.ts` (area-03)
- `src/agent/runtime/ModelFactory.ts` `shouldUseResponsesAPI` — test-only export, keep off the Tier-1 manifest (area-14)

**Strategy** (reconciled — every reporter converged on the same shape): in the
test-kernel round, retarget each test at the real production entry point
(`stageDeleteStream().commit()`, `resolveClientCredential`, `expandRunInputs`,
`computeStreamTreeProjection`, `checkRunsClient.fetchAnnotations`, …), then delete the
prod surface and lower `store-public-surface-baseline.json` / regen knip baseline in
the same PR (the ratchets' own semantics notes prescribe exactly this). Leave
explicitly-named `...ForTests` seams alone.
**Classification: fleet-editable — but only inside the test-kernel round**, where the
worker owns both the test file and the prod surface in one assignment. Sequencing:
tests first, deletion same change (build-implies-delete).

---

## Theme B — Dead carrier chains (mechanical, tsc-driven, high yield)

### B1. Dead `agentCategory` carrier chain through the model layer (left by #9489)

**Corroboration: 1 area (08), but ~14 files of hard evidence across 4 packages** —
the single largest verified element-count deletion of the round.

`resolveCodexSubscriptionCapabilitiesForAgentCategory` (`src/model/providerCapabilities.ts:165`)
ignores its parameter since #9489 (verified via `git log -L`). Dead plumbing feeding it:
`isCodexSubscriptionActive`'s 2nd param, the `agentCategory` fields on
`ModelOptionsAccess`/`ModelOptionsComputationOptions`/`ModelAvailabilityContext`
(`src/model/computeModelOptions.ts:88,92,333`), `applyModelOptionsComputationOptions`,
the `:category:` cache-key suffix (`computeModelOptions.ts:740-742` — currently splits
the TTL cache into slots producing identical results), `ModelFactory` threading
(`src/agent/runtime/ModelFactory.ts:426-516`), and ~14 external call sites constructing
`AgentCategory` values solely to pass them (setupLaunch, sessionCommands,
credentialStatus, modelAccess, proposalFlow, agentToolResolution, helperModelPreference,
agentProposalTransport, optionsLoader, 3 desktop controllers). The xAI twin never took
the param but copied the now-false `ForAgentCategory` name.

**Strategy**: one dedicated convergence PR, single owner: delete params → rename both
resolvers → delete interface fields/helper/cache-suffix → collapse call-site argument
construction (many `computeModelOptionsData(undefined, undefined, {agentCategory})`
become `computeModelOptionsData()`). Verify ModelFactory threading terminates only at
the ignored param; check whether sessionCommands' `hasCategory` plumbing dies too.
**Classification: needs-own-PR** (crosses model/runtime/CLI/desktop/extension, cache-key
change is technically behavior-visible even if results are identical).

### B2. Compatibility-key inference: dead `_messages` plumbing + three backfill owners

**Corroboration: 2 areas (15, 20) — same subsystem seen from both sides.**

`inferPersistedModelHandlerCompatibilityKey` (`src/agent/runtime/modelHandlerCompatibilityInference.ts:30`)
ignores `_messages`, yet 5 call sites assemble message arrays for it — including a
redundant `ProviderMessageArraySchema` parse on the resume path
(`SessionResumeRetrieval.ts:206/270`, `executeAgent.ts:526`, `runToolUseFlow.ts:505`,
`runReflectionFlow.ts:208`). Separately (area-20), the "record missing
modelHandlerCompatibilityKey → infer, else take active handler's key" backfill policy
has three owners: `SessionResumeRetrieval.ts` (the declared single boundary),
`runToolUseFlow.ts:488-534` ("defensive fallback"), `runReflectionFlow.ts:207-212` —
meaning the boundary is not actually single.

**Strategy**: one PR: drop the dead parameter (tsc drives it; verify the
`messages.success` gate isn't load-bearing before removing the parse), then move the
backfill into one owner at the persisted-record read and delete the two in-flow arms.
**Classification: needs-own-PR** (resume-path semantics; one owner). The parameter-drop
half alone would be fleet-editable, but doing both together is strictly better.

### B3. Smaller dead/vestigial chains (fleet fodder)

- `ResolvedAgent.definitionPath/.resolvedName` duplicate `entry.path/.name` — collapse to `{entry, inlineDefinition?}` (area-12)
- `ConfigInspection.effectiveValue` computed by all 3 providers, read only by one test (`src/platform/interfaces.ts`, area-01)
- `ANTHROPIC_TOOL_TYPE_MAP` `'str_replace_based_edit_tool'` alias now producer-less — modelHandlers owner to confirm no resume/replay path feeds it (areas 04)
- Google Interactions `requiresInteractionsAPI` guard reads a field that does not exist on ModelConfig — confirm the llm-zoo plan or delete both functions (area-15)
- `SubscriptionUsageService` grok arm: declared-but-unsupported; product-intent ruling then compiler-driven deletion (area-24)

**Classification: fleet-editable** (each is a scoped, tsc-provable assignment), except
the grok arm and Interactions guard which need a one-line intent ruling first.

---

## Theme C — Perf / O(all) scans (behavior-visible, needs owners)

### C1. Every completed-run archive read scans the whole streamLogs directory

**Corroboration: 1 area (10, reported by both canary runs) + 6 named consumer files.**

`StreamLogStore.openReadOnly()` (`src/transcript/StreamLogStore.ts:366-370`) runs
`readPersistentSummaries()` — `listKeys()` on the entire streamLogs dir plus a read +
Zod parse + 2 mtime stats per persisted stream — then the caller uses exactly one
stream. Paid per call by `traceAssembler.assembleTrace`,
`completedRunArchive.readCompletedRunConversation`, and their consumers:
`src/tools/ExecutionsTool.ts`, `packages/cli/src/runtime/history.ts`,
`src/agent/export/loadChatExportInput.ts`,
`src/controllers/settingsView/ChatExportController.ts`,
`packages/extension/src/settingsView/handlers/historyHandlers.ts`. Callers needing both
conversation and todos pay the scan twice. Companion finding: the
execution→stream FK resolution (`readMeta() → meta.streamId`) is re-derived at 3+ sites
— one `resolveStreamForExecution(executionId)` returning a typed absence reason
satisfies rule-of-three.

**Strategy**: add `StreamLogStore.openReadOnlyForStream(streamId)` seeding one summary
(or relax `ensureLoaded`'s summaries gate to a `kv.exists` check in read-only mode);
bundle the FK resolver since call sites overlap.
**Classification: needs-own-PR** — I/O-cost behavior change; the reporter explicitly
ruled it out of fleet scope.

### C2. CLI TUI render-path recomputation

**Corroboration: 1 area (42), 2 distinct sites + 1 in area-12.**

- `subscribeStreamLog.ts` `syncStreamLog` walks every entry per 16ms tick (full `getRange(0)`, two `findLast` scans, sortedness check) while sibling projections in the same file already use an incremental `appliedHead` cursor — extend the proven pattern (area-42)
- `streamViews.ts` recomputes `visibleSubagentRows` per child per render, O(children²)-ish (area-42)
- `reviewDiff.ts` `isPathInChangeSet` re-normalizes the whole changed-file list per issue, O(issues×files) (area-12)

**Classification: needs-own-PR each** (perf-visible; `TuiStateAndFocus` tests as
harness for the first). Small, well-scoped, good sonnet-wave candidates.

---

## Theme D — Dual-writes and wire-shape collapses (mainView family)

### D1. `modelOptions` is a vestigial projection of `modelOptionsByCategory.workflow`

**Corroboration: 2 areas (27, 29) — same root cause seen from contract and wire sides.**

All four `SET_MODEL_OPTIONS` senders derive `optionsData` from the by-category shape
and send both (`mainViewCommands.ts` `postModelOptions`, `MainViewProvider.ts:242`,
`desktopCredentialSettingsController.ts`, `MainViewStartupController.ts` — the one
sender whose by-category is conditional); the receiver keeps a 3-way fallback chain
(`catalogSlice.ts`) and a dual signal pair (`mainViewState.ts`). The startup contract
(`MainViewStartupOptions`) mirrors the same dual: `modelOptions` required,
`modelOptionsByCategory` optional (area-27).

**Strategy**: confirm `loadOptions` can always produce the by-category shape, then make
`optionsDataByCategory` required, delete `optionsData` from schema + 4 senders +
receiver fallback + `modelOptions$` signal in one change.
**Classification: needs-own-PR** (cross-host wire contract; one owner touching
src/controllers + both hosts).

### D2. Dead inbound `SET_*_FILES` arm + `UPDATE→SET` echo round trip

**Corroboration: 1 area (29), two issues in one command family.**
No code posts `SET_INPUT/CONTEXT/MEDIA_FILES` webview→host
(`src/shared/schemas/mainView/inbound.ts:138-140`), yet the union forces 3 registry
rows + `handleSetMultipleFiles` + its type. Separately `FileManager.handleUpdateFiles`
does nothing but log and echo the identical list back as `SET_*_FILES`, which the
webview re-applies as a no-op (2 wire hops per user edit). Verify desktop's
renderer→main dispatch and the persisted-state path don't observe the echo
(`ElectronFileSelection.vitest.ts` asserts SET pushes — test fallout is known).
**Classification: needs-own-PR** (wire schema; pairs naturally with D1 — could be one
mainView-wire owner for both).

### D3. Desktop renderer path-keyed RPC correlation

**Corroboration: 1 area (35).** Renderer correlates file I/O by PATH across
`window.postMessage` (3 pending maps, dual-queue FILE_ERROR rejection hack,
`main.ts:409-479`) while the same package already correlates prompts by
`requestId` (`desktopPromptMessages.ts`, `z.uuid()`). Add requestId to the workspace
file schemas, collapse to one `Map<requestId, {resolve,reject}>`.
**Classification: needs-own-PR** (wire change, but mechanically follows an in-package
precedent). Also from area-35: `hostBridge.ts` desktop-only pushes bypass
`assertKnownOutboundMessage` — closing that dev-assertion gap is **fleet-editable**
(compose existing schemas, no runtime change).

---

## Theme E — Cross-host duplication (extension ⇄ desktop ⇄ CLI)

### E1. Settings-view dispatch + credential-refresh cascade duplicated per host

**Corroboration: 4 areas (24, 25, 30, 36).**

- Command→controller routing hand-duplicated between `SettingsViewMessageHandler.ts` and `desktopSettingsIpc.ts` (pinMemory rows character-for-character parallel; past drift bug documented in `HistoryActionOutcomes`/`ProfileMessageBuilder` module docs) — `SettingsViewHost` already covers memory + model-selection; continue surface-by-surface (area-25)
- The ordered credential-refresh cascade ("invalidate api-key/model caches → repost model selection → repost options → maybe repost usage → onCredentialChanged") exists in `desktopCredentialSettingsController.ts` AND `SettingsViewMessageHandler.ts` (area-36); a third partial copy in extension/desktop invalidate-then-refresh sequencing was flagged by area-04
- `desktopAgentExecution.ts` (~400 lines of wiring lambdas doc-commented "Mirrors the extension's …") vs `ProgressViewMessageHandler.ts` (areas 36, 24)
- Webview-owned monthly profile-refresh timer proxying "quota reset" via WEBVIEW_READY belongs backend-side (area-30)

**Strategy**: continue the established SettingsViewHost migration surface-by-surface
(agents, profile, history, latex, github, tools), each surface deleting its two host
copies in the same PR. Hoist the credential-refresh cascade into
`src/controllers/settingsView/` as a mechanical dedup of the genuinely identical
sequence — NOT a new abstraction layer. For the progress-wiring mirror, diff the two
bodies first and proceed only on mechanical identity (Refactor-LOC lesson: three prior
"extract shared X" attempts net-added).
**Classification: needs-own-PR, GATED** — check against ledger `#8744` ("settings one
composition path" reverses part of #8482 and is held pending maintainer sanction).
SettingsViewHost surface-migration continues an _existing_ adjudicated direction, which
is likely fine, but the owner must confirm the boundary between "continue #SettingsViewHost"
and "re-file #8744" with the maintainer before starting.

### E2. CLI subscription-provider policy scattered across five surfaces

**Corroboration: 5 areas (39, 40, 42, 43, 44) — the widest CLI cluster.**

One domain (subscription providers: ChatGPT/Codex, Grok/xAI, Kimi Code, GLM) has its
policy fragmented:

- Kimi-Code↔OpenRouter mutual exclusion implemented twice (`CliConfigForm.tsx` writeValue + `modelAccessSelection.ts` `updateCliModelAccess`) (area-39)
- Retry "exhaustion → which subscription flag to disable" ladder lives in the modal (`RetryRequest.tsx`) with drifted naming (`isGlmCodingPlanLimit` gating the KIMI branch), while classify helpers live in `approvalPrompts.ts` (area-40)
- The whole commit/rollback auto-switch quintuple is host-embedded in `subscribeApprovals.ts` (area-42)
- `chatgptLogin.ts` / `grokLogin.ts` are 57-line mirror modules with byte-identical device-code pass-throughs over `subscriptionLogin.ts` (area-43)
- `updateCliModelAccess` has 4 near-clone provider arms + byte-identical formatter pairs; a 5th provider copies a 30-line arm (area-44)
- Launcher account actions re-implement auth-command sign-out policy inline and already dropped the relay-token notice (area-45)

**Strategy** (staged):

1. **fleet-editable now**: delete the two `shouldUse*DeviceCode` pass-throughs (callers import `shouldUseSubscriptionDeviceCode` directly); give the Kimi/OpenRouter exclusivity one owner (`setKimiCodePreference` in `@cli/runtime`); hoist sign-out outcome text into the runtime login modules.
2. **needs-own-PR**: move the exhaustionReason→decision mapping next to the classifiers (one owner for classify+decide), audit extension/desktop retry surfaces for the same ladder before hoisting into shared core (area-42's explicit warning: do NOT extract the rollback ladder as a generic table first — historically the net-adding shape).
3. **defer**: full provider-descriptor tableization of `updateCliModelAccess` until the GLM/Kimi surface stops churning (GLM landed this week; divergences are load-bearing).

### E3. Git probe / recent-commits policy duplicated per host

**Corroboration: 2 areas (36, 11).**
`desktopGitHost.ts` hand-parses `log`/`status --short`/`diff --numstat`/`rev-list`
while `packages/extension/src/commands/git/gitCommands.ts` implements the same
recent-commits surface separately; only `commitLogFormat.ts` is shared (area-36).
Area-11 separately catalogued three divergent branch/dirty probes in `src/utils/`
(worktreeInfo/workspaceInfo/isGitRepository) and ruled the deltas load-bearing — hoist
only on a fourth probe. **Strategy**: hoist one host-neutral recent-commits +
environment-summary module into `src/utils/git/`, evaluate simple-git (the blessed
track: 25 ad-hoc→library PRs, zero rejections), delete both host copies same change.
Leave the three utils probes alone. **Classification: needs-own-PR.**

### E4. Edit-like tool classification & exit-code scavenging (CLI renderer compensations)

**Corroboration: 1 area (41), two issues, both "fix the upstream data".**
`toolRenderers.tsx` extends the shared `toolKind` edit classification with private
name heuristics, and regex-scans output prose for exit codes that
`src/shared/toolUse.ts` should normalize structurally. Hoist names into
`src/shared/tools/toolKind.ts`; move the text fallback into `normalizedExitCode` (or
fix the emitting tool boundary). **Classification: needs-own-PR** (per-host render
behavior converges = user-visible in edge cases; small).

---

## Theme F — Retirement ledger + compat-arm consolidation

### F1. Dated and undated compat readers scattered with no central tracking

**Corroboration: 9 areas (08, 11, 13, 15, 16, 20, 23, 26, 29).**

Dated (maintainer ruling 2026-08-10: can retire now — do not wait for the original
November dates; original retire dates retained only as provenance):

- `modelHandlerCompatibilityInference.ts` COPILOT_MODEL_PREFIX arm — was 2026-11-03 (#9635) (area-15)
- `streamTab.ts` `isBackgroundShellStream` — was 2026-11-04 (#9705) (area-15)
- `agentPresets.ts` `AgentModePresetLegacySchema` + `mainView/state.ts` `liftLegacyMainViewFlatFields` — was 2026-11-04 (#9705) (area-23)
- `compileCheck.ts` three legacy compile-log filename spellings — was 2026-11-09 (area-16)
- `vscodeMainViewPersistedState.ts` `copilot:<baseModel>` preprocess — was 2026-11-03; file then collapses to a re-export (area-29)

Undated (need a #9590-style ruling to get a date, or a documented-permanent verdict):

- `PersistedFlow` legacy no-cursor replay + vestigial `params` field — and once retired, cap/drop the O(n²) `nodes[]` audit log whose only consumer is that replay arm (area-13; the perf half is a real win gated on the ruling)
- `useCustomRefresh` custom session-refresh arm — **persisted-credential resume compat, the #8091 reversal class**; deleting signs out stale users; maintainer ruling required (area-08)
- `fillLegacyTokensFreedFields` / `normalizeLegacyProviderErrorFields` — undated parse-side readers over unversioned stream logs (area-23)
- `normalizeRunId` `__default__` sentinel for pre-per-run-scoping sessions (area-11)
- runReflectionFlow `.tex` output-file resume fallback (area-20)
- pack/clean legacy beside-source workspace sweep + `mergeRunDirAndWorkspaceResult` (area-26)

**Strategy**: one human-owned ledger issue collecting all of the above; immediate
deletion PR for the five dated arms + their tests (no November wait); per-arm
maintainer rulings for the undated set (the memory note "intermediate migration
data is disposable — delete early, loud" is the governing precedent, but each arm's
blast radius differs). **Classification: needs-own-PR / human-owned issue.** Explicitly NOT
fleet-editable — every arm touches persisted data.

---

## Theme G — SSOT regressions: hand-synced lists, restated constants, duplicate vocabularies

### G1. Constants/prose restated at 2+ sites (mechanical hoists)

**Corroboration: 5 areas (05, 21, 30, 31, 10).**

- GitHub subscription caps (10 issues / 3 repos) as magic numbers in two pollers AND restated as prose in two tool descriptions — move into `prSubscriptionConstants.ts` and interpolate (area-05)
- LaTeX replacement field→config-key map duplicated on both sides of the settings wire (`LaTeXTab.ts` vs `LatexConfigPersistenceController.ts`) directly under a shared-map doc comment claiming SSOT; plus the two same-named `LatexConfigField` types whose gap is papered over by a cast (area-31)
- Pre-hydration defaults restated as literals in settings leaf components instead of importing schema constants (area-30)
- Install-guide copy: structured→prose→`split('\n\n')[0]` re-parse round trip + a second structured command table that can drift (area-21; golden-diff outputs — they ship in prompts)
- `StreamSnapshotStore` overlay→sidecar-key mapping enumerated in 3 hand-synced lists in one file — one `satisfies Record<keyof OverlayPatches, string>` table (area-10)
- `SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES` stringly-typed; type as `readonly RegisteredToolName[]` (area-04); `SetupCommandAdapter.invoke` narrow to `CommandId` (area-04)

**Classification: fleet-editable** (each single-assignment, compile-checked;
prompt-visible strings must be byte-identical). Exception: the tool-description prose
interpolation changes prompt-visible text → small own PR.

### G2. Vocabulary duplicates needing a ruling doc before code

**Corroboration: 4 areas (10, 21, 23, 41).**

- `SessionType` = exact value set of `AgentCategory`, manually converted at host boundaries — vocabulary-alias adjudication per the taxonomy (#9816 canon-per-surface: derive `SessionTypeSchema = AgentCategorySchema` or retire) (area-23)
- `'openRouter'` vs `'openrouter'` as two lookup keys in `src/shared/constants/providers.ts` — likely persisted/wire-pinned; migration not rename; grep consumers first (area-21)
- Stored stream status compared as bare string literals against enum-writing producers over `z.unknown()` data — a STREAM_PHASE rename silently disables orphan recovery; type the status at the one load boundary (area-10; **fleet-editable** type-tightening once scoped)
- WorkflowCallProgress vs WorkflowExecutionSnapshot dual status vocabulary — **defer**: #9918/#9916 landed days ago, mid-migration; adjudicate once it settles (area-23)
- Per-status glyph/color tables across TUI panes — adjudicated KEEP as typed contracts; document the palette convention only (area-41)

### G3. Display-vocabulary drift inside the extension progress view

**Corroboration: 2 areas (32, 33).**
Compaction facts render from two independent icon/label tables (`CompactionActivity.ts`
ACTIVITY_ICON vs `contextManagementFormatters.ts` ACTION_CONFIG — #9913 is days old, so
first ask whether the banner path is scheduled for retirement); token-usage stats wear
three different icon/label sets across `dataFormatters.ts` STAT_FIELDS,
`UsagePanel.ts`, and `contextManagementFormatters.ts`. **Strategy**: one shared
icon+label map keyed by stat/status name — share the vocabulary only, not field lists
or layout (the full "shared stats table" is the known net-add trap). Same-host, so
#7622 does not block it. **Classification: small needs-own-PR** (user-visible glyphs).

### G4. CLI status bar paraphrases the nestedRuns copy canon

**Corroboration: 1 area (22).** `statusBarDisplay.ts` hardcodes `'agent'`/`'active'`
while the canon fields (`SUBAGENT.countNoun`, `RUNNING_SESSION.countNoun`) sit unread.
User-visible copy → deliberate ruling: adopt canon or delete the never-adopted fields.
**Classification: small needs-own-PR under the texra-cli skill.** (Respects #7622: this
is adopting the CLI's own canon module, not cross-host unification.)

---

## Theme H — Duplicated engine/lifecycle machinery (single-owner convergences)

### H1. Google Interactions hand-rolls the OpenAI BackgroundRunLifecycle (~250 lines)

**Corroboration: 1 area (17).** `modelHandlerGoogleInteractions.ts` re-implements
pending-id/deadline/cancel/stale-id bookkeeping that
`openai/BackgroundRunLifecycle.ts` owns (which is itself misfiled under `openai/`
despite being provider-neutral). Both already share `BackgroundPoller` and
`ServerChainState` as hoist precedents. **Strategy**: move BackgroundRunLifecycle to
`support/`, have Google adopt it, delete the hand-rolled equivalents same change; keep
the stale-id predicate injectable (SMOKE-TEST notes say it is deliberately
provider-specific). **Classification: needs-own-PR** (behavior-risky provider
lifecycle; one named owner).

### H2. Three event-fold state machines over one WorkflowScriptEvent stream

**Corroboration: 1 area (07).** Delivery-summary collector, run-log collector, and
trace projection each keep their own phase/task maps
(`workflowScriptDeliverySummary.ts`, `workflowScriptStrategy.ts`,
`workflowScriptRun.ts`). One fold owner in `workflowScriptRun.ts` exposing terminal
per-call facts; derive the other two; preserve the documented taskDone-vs-done/total
semantic split as two derived counts. **Classification: needs-own-PR.**

### H3. Detached-launch lease choreography copy-pasted at three launch sites

**Corroboration: 1 area (07).** register→captureLease→startChildRunLoop→release-on-failure
repeated in `subagentExecution.ts`, `WorkflowScriptTool.ts`,
`inBandSubagentExecution.ts`. Reporter's own reconciliation is right: do NOT extract a
shared launcher (divergent call sites net-add); move only the
register+lease+release-on-failure triple into one owner next to
`captureOwnedExecutionLease` in `@agent/storage`. **Classification: needs-own-PR**
(failure-path ownership).

### H4. Registry import cycle patched by lazy imports; childRunLoop layering inversion

**Corroboration: 1 area (07), but matches the known Step-3 SDK blocker (cyclic
registry, memory: PR #9307 audit).** Two `await import('./nativeSubagentStrategy.js')`
sites exist solely to dodge the registry→DelegationTools→…→registry cycle; and
`src/agent/runtime/childRunLoop.ts` imports persistence/formatting from
`@tools/delegation` (inverted layering; helpers are thin wrappers over
`@agent/storage` writes — mind the vi.mock path-string hazard in ChildRunLoop.vitest).
**Classification: needs-own-PR, coordinate with SDK packaging work** — this is already
a named Step-3 blocker; breaking the cycle at the root retires both lazy edges.

### H5. SDK `MemoryConfigProvider` duplicates JsonConfigProvider with a policy drift

**Corroboration: 2 areas (01, 46) — independent, complementary.**
`packages/agent/src/node.ts:37-86` hand-rolls canonical-key normalization, watcher
wiring, precedence, and `inspect()` — AND skips `getCoreSettingDefault()`, so SDK
embedders resolve different effective settings than every host for the same key,
undocumented (area-46). **Strategy**: rule first whether the SDK should honor
core-schema defaults; then extract one memory-backed provider default under
`src/platform/defaults/` consumed by `nodePlatform()`, deleting the duplicate
(build-implies-delete). Also from area-46: `packages/agent/package.json` hand-lists
~70 dep ranges mirroring the workspace — add a sync gate analogous to
`sync-package-contributes.mjs` (**fleet-editable** as a script+CI addition).
**Classification: needs-own-PR** (SDK-observable behavior once defaults are honored).
Note: this shares logic, it does not collapse a Platform port — taxonomy-compliant.

### H6. Twin provider-block recognizers (export vs storage formatting)

**Corroboration: 1 area (16).** `normalizeConversation.ts` and
`conversationFormat.ts` must recognize the same provider block vocabulary, synced by
comments. Reporter's cheaper alternative is the right call: an exhaustiveness test
asserting both switches cover the same `CONVERSATION_BLOCK_TYPES` members — not a
shared classifier (intentional behavioral deltas; Refactor-LOC lesson).
**Classification: fleet-editable** (add the ratchet test only).

---

## Theme I — Barrel discipline and import-surface cleanups

### I1. Convenience barrels contradicting the no-convenience-barrels rule

**Corroboration: 5 areas (11, 16, 22, 34, 26-adjacent).**

- `src/utils/files/index.ts` `export *` twice, self-described "(re-exported for convenience)"; `taskRunStorage.ts` is a second mini-barrel; wildcard blinds the dead-export ratchet (area-11)
- `src/common/errors/`: stacked dual barrel (`index.ts` + `sdkErrorUtils.ts`) with ~10 prod-orphan re-export lines (area-11; overlaps A1)
- `src/shared/styles/`: curated barrel with ~77 importers PLUS 17 deep-import bypasses and 2 deliberately-excluded modules — pick one surface, codemod the loser (area-22)
- `packages/extension/src/progressView/frontend/store.ts` re-exports `@shared/schemas` symbols to ~10 files (area-34)
- `src/agent/storage/index.ts` re-exports foreign `@shared/schemas` symbols + test-only symbols (area-16)

**Strategy**: one mechanical codemod-style pass per barrel, coordinated with the
knip-baseline regen path; the styles one needs a direction decision first (bless vs
retire) but either direction is find-replace scale.
**Classification: fleet-editable** as dedicated codemod assignments (NOT side edits —
importers span hosts; each barrel is one assignment with the baseline regen included).

### I2. Hand-written structural interfaces where `Pick<>`/named exports exist

**Corroboration: 3 areas (10, 26, 38).**

- `WebviewBridge.ts:21-34` hand-writes StreamLog/StreamLogStore signatures; the `Pick<>` form used by `subscribeStreamArtifacts.ts` and `StatusBarUsageTracker.ts` is the blessed shape (area-10)
- `optionsLoader.ts` / `computeAgentOptionsData` export no named return types → consumers build `Awaited<ReturnType<…>>` chains (area-26); same for `runOutcomeExitCode`'s anonymous union → export `TurnOutcome` (area-38)
- `FollowUpQueueInput` not host-reachable → CLI hand-writes `InterruptedFollowUp` subset; re-export from `ToolUseFollowUpQueueManager` (already ratchet-baselined, no widening) and derive via `Pick<>` (area-38)

**Classification: fleet-editable** — this is the taxonomy's highest-hit-rate
type-tightening species.

---

## Theme J — Silent degradation & latent bugs (correctness queue — NOT simplification)

**Corroboration: 12 areas** (03, 06, 09, 10, 25, 30, 34, 38, 39, 41, 45, 26-adjacent).
These are behavior changes and must be filed as issues for reviewed PRs, never fleet
edits. Ranked by severity:

1. **Replacement-rule JS escape bugs — real latent text corruption** (area-09): `'\!'`/`'\,'` in single-quoted strings match bare punctuation; `'\Ra\,'` rewrites `'\Ra,'` → `'\Ra~'` on plausible prose; the end-of-line `\!` rule deletes a literal `!`. Dedicated PR with characterization tests in `ReplacementRules.vitest.ts`. **The standout bug find of the sweep.**
2. **StreamLogStore eviction asymmetry** (area-10): `drainPendingReleases` drops a resident log without bumping `stateRevision` — the sole reload-race guard; latent reload race or undocumented invariant. Decide the owner before merging the twin bodies.
3. **`startRootRun` silently discards superseded interrupted follow-ups** while `resume()` replays them — silent drop of user input (area-38).
4. **ToolsListForm toggle promise has no `.catch`** → unhandled rejection, potentially fatal; sibling form has the exact fix (area-39). One-line.
5. **Lean LSP error conventions**: direct adapter warn-logs the real cause, tool fabricates VS Code-centric guesses on CLI/desktop; plus three stale "Requires VS Code" tool descriptions steering agents wrong (area-06; description text is prompt-visible → deliberate).
6. **`ProfileMessageBuilder` 3× bare `catch {}`**, **`canLaunchWithDefaultModel` catch→false**, **`estimateEntryRows` silent 1-row fallback** — add rate-limited warns per the loud-degradation rule (areas 25, 45, 41).
7. **Zod `.catch([])` on persisted webview toggle state** feeding a whole-state rewrite — the CLAUDE.md permanent-data-loss shape, cosmetic data; annotate as §15 exception or warn (area-30).
8. **DELETE_ALL/DELETE_STREAM leave `inquiries` behind; `resetProgressState` doc/behavior drift** (area-34) — intent rulings then one-liners.
9. **audio.ts SIGTERM + `delay(500)`** instead of awaiting the held subprocess completion promise; needs real-mic smoke test (area-03).
10. **MemoryTool blurs `displayToStoragePath` errors** — traversal case reports the wrong reason (area-03).

---

## Theme K — Adjudicated-KEEP / rulings to record (so sweeps stop re-proposing)

Add these verdicts to the do-not-do ledger (#8974) or a directory README — zero code:

- **Two auth session-refresh state machines (SupabaseSession vs SubscriptionOAuthCoordinator): KEEP separate** — Refactor-LOC lesson applies squarely; revisit only after the useCustomRefresh arm dies (area-08)
- **StagedDeletionCoordinator: load-bearing port, do NOT refactor opportunistically**; if ever revisited → typed transition table + p-queue, own PR, existing vitest as gate (area-10)
- **finalizeRunTerminal vs executionRegistry waiting-termination path**: adjudicate parameterize-vs-KEEP once; the ordering invariant already drifted observably (usage on result events) (area-14)
- **Chat-side vs Responses-side compaction trigger ownership is deliberate** — one README paragraph so "unify compaction triggers" is recognized as a trap (area-19)
- **Two terminal renderers in progress view (hand-rolled buffer vs xterm)**: KEEP-with-rationale ruling (fidelity vs weight) (area-33)
- **controlStyles ⇄ desktop styles.css class-name dual-write**: documented; optionally a cheap existence-parity architecture test (area-22)
- **Twin follow-up prompt builders, ProbeEnvironment/VerifySetup dual prose, OAuth-handler pattern below rule-of-three**: recorded-fine / wait-for-third-consumer (areas 24, 04, 19)
- **`isCompactRows` wrapper-per-widget**: bless in texra-cli skill docs or collapse once globally — decide once, not per-area (area-37)
- **`commands/` micro-module layout**: one centralized fold-or-bless decision for the whole tree (area-26)
- **SettingsApp props-in/events-out vs SignalWatcher tabs**: maintainer ruling; either delete the ~130-binding plumbing layer or bless it in a README (area-30)
- **citty workaround aggregate (~750 lines)**: file a one-time evaluation issue (upstream gaps vs replace vs freeze with contract tests) — human-owned (area-45)
- **Hand-written Claude Agent SDK message types**: one-time ruling on type-only SDK imports in VS Code-free zones (precedent exists in the same file pair via `EffortLevel`); either deletes ~40 lines or blesses permanently (area-02)
- **Modal row-budget dual maintenance** (area-40): worst-failure-mode territory (pinned input pushed off-screen); a dedicated worker converts ONE modal to a declarative row-spec as a template — never a fleet side edit

---

# Ranked round-2 candidates (top 10)

Ranked by (corroboration, expected element reduction, risk-adjusted):

| #   | Candidate                                               | Corrob.      | Class                                          | Proposed scope                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------- | ------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Test-kernel sweep + test-only-surface deletion** (A1) | 11           | fleet (test round)                             | The already-planned test-kernel round (~190k LOC), with a standing rider: each worker retargets tests at prod entry points, then deletes the paired prod surface + lowers `store-public-surface-baseline.json`/knip in the same assignment. Seed each worker with this report's per-area list. Central typecheck gate + fix wave (vitest green ≠ typecheck green). |
| 2   | **Retirement-ledger consolidation** (F1)                | 9            | human-owned issue + immediate deletion PR      | File one ledger issue enumerating 5 dated + 6 undated arms; per-arm maintainer rulings for undated (useCustomRefresh explicitly flagged #8091-class); delete the dated five now (maintainer ruling 2026-08-10 — no November wait). Unlocks the PersistedFlow `nodes[]` O(n²) write fix.                                                                            |
| 3   | **Silent-degradation / latent-bug queue** (J)           | 12           | issues → reviewed PRs                          | File ~10 issues; the replacement-rules escape bug (J1) gets its own characterization-tested PR immediately — it corrupts user text today. J4 (missing `.catch`) is a one-liner.                                                                                                                                                                                    |
| 4   | **Dead `agentCategory` carrier chain** (B1)             | 1 (14 files) | needs-own-PR                                   | One convergence PR: params, renames, 3 interface fields, cache-key suffix, ~14 call sites. Largest single element-count deletion available. tsc-driven, low risk despite breadth.                                                                                                                                                                                  |
| 5   | **CLI subscription-provider policy** (E2)               | 5            | split                                          | Stage 1 fleet-editable now (device-code pass-throughs, exclusivity single-owner, sign-out hoist); Stage 2 own PR (retry decision mapping + cross-host audit); Stage 3 defer (descriptor tableization until GLM churn settles).                                                                                                                                     |
| 6   | **Cross-host settings/progress wiring** (E1)            | 4            | needs-own-PR, **gated on #8744 clarification** | Continue SettingsViewHost surface-by-surface (agents → profile → history → …), each PR deleting both host copies; credential-refresh cascade hoist as mechanical dedup; progress-wiring mirror only after a mechanical-identity diff.                                                                                                                              |
| 7   | **Single-stream transcript read path** (C1)             | 1 (7 files)  | needs-own-PR                                   | `openReadOnlyForStream(streamId)` + `resolveStreamForExecution` FK helper; update 6 named consumers. Every chat export / CLI history read stops paying O(all-streams) I/O.                                                                                                                                                                                         |
| 8   | **mainView wire-shape collapse** (D1+D2)                | 2            | needs-own-PR                                   | One owner for the command family: make `optionsDataByCategory` required and delete `optionsData` (4 senders, receiver fallback chain, dual signal); delete the 3 dead inbound `SET_*_FILES` members + the UPDATE→SET echo. Known test fallout enumerated.                                                                                                          |
| 9   | **Barrel-discipline codemods** (I1)                     | 5            | fleet (dedicated assignments)                  | One assignment per barrel: utils/files `export *`, errors dual barrel (pairs with #1's test repoints), progressView store.ts, storage foreign re-exports; styles barrel after a bless-or-retire decision. Each includes knip-baseline regen.                                                                                                                       |
| 10  | **Compatibility-key inference single owner** (B2)       | 2            | needs-own-PR                                   | Drop dead `_messages` param (5 call sites + redundant resume-path parse), then move the 3-owner backfill into the persisted-record read boundary.                                                                                                                                                                                                                  |

Near-misses (own PRs, run as a second wave): Google background-lifecycle convergence
(H1), workflow-script event-fold single owner (H2), detached-launch lease owner (H3),
SDK MemoryConfigProvider + config-defaults ruling (H5), git recent-commits hoist (E3),
desktop requestId RPC (D3), TUI hint-cascade primitive `firstFittingHintRow` (area-40 —
rule-of-three met ×4, fleet-editable), theme triple-owner (area-21, timing-sensitive),
CLI TUI perf trio (C2).

---

# Proposed round-2 plan

## (a) Test-kernel sweep (src/test-kernel/**, ~190k LOC)

Run it as planned, with three changes earned by this round's findings:

1. **Pair every test edit with its prod-surface deletion** (candidate #1). Seed workers with the per-area test-only-surface list from Theme A1 and the ~20 named fix-wave items the workers already queued (e.g. `WorkflowScriptCost.vitest.ts` sumCompletedWorkflowJournalCost inline, `ApiStatusLoad.vitest.ts` statusAssembly retarget, `EditApproval.vitest.ts` formatEditApprovalHunkCount, `SkillsListForm`/`RuntimeSkills` frontmatter fixtures, `codexImport.vitest.ts` describe block, `TuiStateAndFocus` `drain()`→`drainItems()`, `SetupLaunch.vitest.ts` retarget, SubscriptionUsageService import retarget, ProgressViewOnboardingRefresh vestigial `webviewBridge` key).
2. **Convert DesktopControlSystem.vitest.ts source-text assertions to DOM-render assertions** (area-35) — it currently pins raw source strings of production files, breaking behavior-preserving refactors.
3. **Ratchet hygiene in the same PRs**: lower `store-public-surface-baseline.json` (deleteAll already gone; deleteStream/clear next), knip regen via the documented path, and add the cheap parity tests recorded above (provider-block recognizer exhaustiveness H6, optional controlStyles existence parity).
   Central gates: `FORCE_COLOR=0` for vitest subsets, one repo-wide `npm run typecheck` fix wave at the end — no per-worker repo gates.

## (b) Targeted cross-cutting fixes (from the top-10)

Sequenced waves, one named owner each, worktrees off origin/main, claim-check before
starting (several areas flagged concurrent ownership — e.g. SessionResumeRetrieval,
#9918 workflow-observability territory):

- **Wave 1 (mechanical, low risk)**: #4 agentCategory chain; #10 compatibility-key; E2 stage-1 CLI provider cleanups; the fleet-editable G1 const hoists and I2 type-tightenings can ride a small round-2 fleet batch (~25 scoped assignments harvested from Theme B3/G1/I2/N-list: runPack inline, subscriptionBindings facade, attachmentMarkerVocabulary, preflightCliTeamAvailability, cliAgentRosterController, apiStatus dual surface, MainViewTypes fold, notify(kind), TurnOutcome, FollowUpQueueInput re-export, named return types, agentOptionsBuilder fold, ResolvedAgent field collapse, compileFailureRoundContext gate, trackActiveView axis, base-class push-downs, remoteCatalogRefreshAttempted rename, usage-route third copy, AgentCategory re-export repoint, ToolUseStatus alias hoist, hostBridge outbound assertion, hint-cascade primitive, owner-session resolver, overlay sidecar table, dead-inbound-arm prep).
- **Wave 2 (behavior-visible)**: #7 single-stream read path; #8 mainView wire collapse; H1 Google background lifecycle; C2 perf trio; E3 git hoist; D3 requestId RPC.
- **Wave 3 (gated)**: #6 settings/progress wiring — only after the #8744 gate is clarified with the maintainer; H4 registry cycle — coordinate with SDK Step-3 packaging; H5 SDK config-defaults — after the policy ruling.

## (c) Filed issues for human-owned PRs (not fleet, not waves)

1. **Retirement-ledger issue** (candidate #2) — all dated/undated compat arms, with the useCustomRefresh #8091-class warning front and center.
2. **Latent-bug queue** (candidate #3) — ~10 issues; replacement-rules escape bug flagged priority (user-text corruption today).
3. **Rulings batch** (Theme K) — one issue proposing the ~13 KEEP/bless verdicts for the #8974 ledger, so round-3 sweeps stop re-deriving them. Includes the citty evaluation, the SDK type-import ruling, the SessionType/AgentCategory alias adjudication, and the modal row-spec template conversion.
4. **`packages/agent/package.json` dependency sync gate** (H5 rider) — CI script issue.

## Explicit defer / do-not-do (checked against ledgers + taxonomy)

- Workflow-call status vocabulary unification — mid-migration (#9918, days old); revisit next round.
- Provider-descriptor tableization of `updateCliModelAccess` — GLM/Kimi churn; load-bearing divergences.
- Auth state-machine merge, StagedDeletionCoordinator refactor, cross-host progress-vocabulary or copy unification (#7622/#8758), any Platform-port collapse, OAuth-handler extraction below rule-of-three, "extract shared prompt builder", full shared-stats-table extraction, generic retry-rollback table in the CLI — all recorded as KEEP/wait in Theme K or banned by the taxonomy.
- Nothing in this strategy touches the ledger-banned items: ApprovalRequestHandler, PreToolUse/PostToolUse hook engine, Google GenAI handler deletion, D3 dual-writer retirement, settings-one-composition-path (explicitly gated, not re-filed).
