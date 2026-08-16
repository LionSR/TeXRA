# Cross-host consolidation: extension / desktop / CLI shared-substrate audit (2026-08-15)

> **Status:** Adjudicated audit (2026-08-15). Originally pinned to the wave1
> branch head `bc64b7cab4` (a branch commit not reachable from main — use
> **`3122ace2bc`**, post-campaign origin/main, as the reproduction pin; the
> stale-claims register in the contracts doc §5 re-verified every
> load-bearing claim there). Produced by four scoped sweeps — execution
> lifecycle, session/event projection, settings/auth/platform ports, and
> rendering/output — each instructed to separate _host-agnostic logic written
> twice_ from _legitimate host projection_. The re-verify-at-HEAD trap is
> live: re-open every cited site before acting.
>
> **Review round applied (2026-08-16):** corrections from the PR #10636
> reviews are folded in inline, marked _(Corrected/Narrowed after review)_ —
> notably V1a (not a missing host argument), V2 (partially initialized, not
> dead), V8 (shutdown sites are deliberate cascade), C2 (CLI has the bail),
> C3 (re-cited; needs a discriminated resolution first), C4 (read-vs-write
> failure split), C6 (no Electron race), C17 (transport, not ignored data),
> C19 (relocation withdrawn), §4i (webview fallback narrower than claimed),
> §4k (example replaced with the narrower true claim).

> **Follow-up:** the maintainer subsequently ruled for maximal consolidation
> ("same data structure, UI rendered differently, collapse
> projectors/adapters/bridges, single source of truth"). The target
> architecture and staged plan for that directive live in the companion doc
> `2026-08-15-single-substrate-hosts-as-renderers.md`, which deepens §2's
> C1/C13/C16/C20/C22 and the §4 register into a layer census, a transcript
> row-model study, a session-state field study, and a prior-rulings
> compliance map. Where the two docs disagree on an estimate, the companion
> doc's per-field accounting supersedes this doc's sweep-level estimate.

The question this audit answers, as the maintainer posed it: after the
substrate campaign, **is there tech debt that can actually be consolidated
between desktop/CLI/extension — rather than doing different layering or
projections — and where are the hosts diverging?**

Verdict in one line: the extension↔desktop pair is already consolidated by
construction (one Lit renderer, one `ProgressBackend`, one
`StreamSnapshotStore`); the remaining cross-host debt concentrates in **(a)
duplicate composition-root wiring between extension and desktop**, and **(b)
the CLI as a parallel civilization** — re-implementing or silently dropping
what shared code already computes. Some divergence is user-visible incorrect
behavior, not style.

Verdict vocabulary follows `2026-07-09-host-parity-audit.md`: **parity** /
**deserved** / **drift** / **false-simplification** / **copy-parity-risk**.
Rows that doc already adjudicated are cited (DR*/CP*/FS*), not re-registered.

---

## 1. Baseline: already one owner — do not re-flag

Confirmed load-bearing at HEAD; re-unifying any of these is wasted motion:

- **One webview stack for three surfaces.** Desktop maps `@progressView/*`,
  `@webview/*`, `@settingsView/*`, `@common/webview` straight into
  `packages/extension/src/` (`packages/desktop/tsconfig.paths.json:20-116`);
  `packages/desktop/src/renderer/main.ts:22,54` imports them wholesale, and
  the trace-viewer mounts the same `<stream-conversation>` element and drives
  it through the real `dispatchMessage` wire
  (`packages/trace-viewer/src/replayTrace.ts:1,209,218,259`). `archived=true`
  only disables interaction — every `archived` check is a `disabled=` or an
  action-handler early return; no content-rendering branch. Replay and live
  rendering **cannot** drift at the renderer layer (they can at the bootstrap,
  §2 C18).
- **`StreamSnapshotStore` landed in all three hosts.** Single writer of
  `streamData/{id}/*` (`src/transcript/StreamSnapshotStore.ts:1-19`),
  auto-attached per session (`SessionHandle.ts:221,226`), exhaustive-switch on
  facts (`:622-628` — `const unhandled: never`), consumed by
  `LitSessionRenderer` (ext+desktop), the CLI TUI via `StreamArtifactReader`,
  and the extension status bar. No host hand-rolls sidecar history anymore.
  The one deliberate gap: liveness is not persisted, each host clamps on
  hydrate — fence-worthy, not drift.
- **`SessionFactApplier` is the shared session-fact reducer** for all three
  hosts (`src/controllers/session/SessionFactApplier.ts:70`, reached via
  `ProgressBackend.ts:181` and the CLI's `sessionSignalsAdapter.ts:325`).
- Single-source with genuine ≥2-host use, re-confirmed: `detachSubagentsOnStop`
  (`src/agent/runtime/detachSubagentsOnStop.ts:17`),
  `prepareMainViewExecutionLaunch`, `HistoryActions`,
  `resolveAndResumeStream` + `resumeQueuedToolUseFromResumeData` +
  `retrieveSessionResumeData`, `selectAutoOpenFinalOutput`,
  `createHostAuthCoordinator` (3 callers), `installTexraModelAccess`,
  `setSetupPlatform`, `normalizeToolUseData`, `applyCompactionActivityEntries`
  / `settleCompactionActivities` / `upsertTaskGroupFromStreamLog`,
  `createMarkdownProcessor` / `createMarkdownRenderer`, `formatChatAsMarkdown`
  (CLI `history` + `ChatExportController` — the best-consolidated of the CLI's
  five output paths), and the `src/shared/copy/workflowCall.ts` fold — the
  exemplar shape for §2 C16 (one metadata fold + one detail rule, two thin
  host projections).
- Crash recovery is fully core-owned (`src/agent/runtime/restartRepair.ts` +
  `SessionHandle`); all three hosts touch it only via `waitUntilReady()`.
  Desktop's `restartRepair:'deferred'` opt-out is justified in-comment.
- The lease API is **not** duplicated per host: only the CLI imports
  `@agent/storage` lease verbs directly; ext/desktop go through
  `runAgent`/`executeAgent`. The real asymmetry is shutdown behavior (§3 V5),
  not lease choreography.

---

## 2. Band 1 — mechanical consolidations (drift / copy-parity-risk)

Format: mechanism → single-owner convergence → net elements. All are ≥2-host
duplications (the single-caller-extraction ban is respected); none adds a
layer — each replaces N copies with the strongest existing copy relocated to
core.

**Maintainer ruling (2026-08-16): recomputation and re-derivation are the
named defect class.** A fact computed by its owner and then re-derived
downstream (C17's second diff algorithm, C22's re-derived elapsed time, the
CLI's re-derived context window, every `resolve*`/`derive*` helper that
recomputes an upstream fact) is a defect regardless of whether the copies
currently agree — compute once at the owner, carry as data, render at the
edge. This is checklist §15's decide-once-carry-as-data rule promoted to a
standing review criterion for the whole program.

### 2a. Projection plane

- **C1. The delta-feed driver is written twice.** Ext/desktop
  (`src/controllers/progressView/backend/WebviewBridge.ts`, 189 L) and the CLI
  TUI (`packages/cli/src/chat/tui/state/subscribeStreamLog.ts`, 500 L)
  implement the identical algorithm over `StreamLogStore.onChange`: buffer
  into `StreamLogDeltaBuffer`, debounce at 16 ms (`WebviewBridge.ts:11` /
  `subscribeStreamLog.ts:72`), detect `resyncRequired`/gap, replay
  `getRange(0)` from scratch, per-stream registration + clear. Only the buffer
  class is shared. The CLI copy is strictly richer (mode-flip invalidation
  `:284-287`, generation guards `:166,175`) — the ext/desktop copy is the
  weaker fork. → One `StreamLogFeed` in `src/transcript/` owning
  subscribe+buffer+coalesce+resync, calling back
  `(streamId, batch | 'resync')`; both sites become sinks. **Net:** ~−120 L
  and one class of resync bug. Highest-value item in this audit.
- **C20. CLI display metadata bypasses `buildStreamTabInfo`.**
  `src/controllers/session/streamTabInfo.ts:32` +
  `streamInfoUtils.ts:19,48` serve ext+desktop; **zero CLI callers**. The CLI
  re-derives identity/agent/model by hand
  (`sessionSignalsAdapter.ts:135-155`) — no `getCleanAgentName`, no
  `modelLabel`, no `worktree`, no registry-derived `isRemote` — and re-runs
  `getRuntimeModelLabel` ad hoc across the TUI
  (`StaticConversationTranscript.tsx:126,140`, `SubagentList.tsx:148,255`,
  `sessionStatus.ts:93`, `statusBarDisplay.ts`,
  `runtime/workflowCallText.ts:9`). → Route the CLI through the
  shared builder. **Net:** ~−40 L; CLI gains worktree/isRemote/label parity
  for free.
- **C13. Small drifted predicates, one owner each.**
  - _Usage-worth-showing_: canonical `isEmptyUsage`
    (`src/shared/schemas/usage.ts:111`, checks 7 fields incl. cost/cacheMiss/
    reasoning) vs CLI `usageHasTokens` (`resumeHint.ts:86`, no cost) vs
    webview `hasUsage` (`UsagePanel.ts:184-194`, no cacheMiss/reasoning).
    Observable drift: a reasoning-only run shows in the CLI hint and hides in
    the webview; cost-only is the inverse. Both host copies are pure
    duplication of an already-exported symbol. **Net:** ~−20 L. (Adjacent to
    DR8, which covers the _totals_ fold; this row is only the predicate.)
  - _ACTIVE_SKILLS last-entry-wins_: three sites, two hosts
    (`logSlice.ts:100-112`, `subscribeStreamLog.ts:388-393`,
    `transcriptFold.ts:1057-1066`). → shared `latestActiveSkills(entries)`.
    **Net:** ~−25 L.
  - _Transcript-row membership_: the extension's drop rule
    (`logSlice.ts:149` + suppression list) and the CLI's
    `TRANSCRIPT_MESSAGE_TYPES` sets (`transcriptFold.ts:96-134,846-877`)
    encode one editorial decision in two vocabularies and have already
    drifted. Consolidating the _vocabulary_ (one exported set with
    per-host subsets) is mechanical; the _membership deltas_ are §4. Companion
    to CP5 (run-fact filter arrays), which remains open.
- **C17. Diff line-count stats, two algorithms for one edit.** Core computes
  `addedLines/removedLines` via diff-match-patch and puts them on the wire
  (`src/tools/approval/toolEditApproval.ts:159-188`,
  `src/shared/schemas/prompts.ts:34-35`; consumed by
  `ToolEditRequestPanel.ts:124-125`). The CLI recomputes from
  `structuredPatch` hunks (`DiffView.tsx:52-63`). _(Transport corrected
  after review: the CLI's zero-hit grep reflects a different transport, not
  ignored data — its approval path receives `ToolEditApprovalRequest` via
  `SessionHandle.interactions`, which does not carry
  `addedLines`/`removedLines`; those live only on the webview
  `ToolEditPermission` payload.)_ → Either add the counts to the
  host-interaction contract (pairs with the contracts doc §2.2 aliasing) or
  have the CLI call the canonical counting helper; keep `buildHunks` only
  for the visual diff. Same disease as C22.
- **C22. `elapsed`: wire-stamped vs locally recomputed.**
  `executionRegistry.ts:323` stamps `formatDuration(...)`; the webview renders
  it verbatim (`BackgroundTasksPanel.ts:478-480`); the CLI recomputes with a
  _different_ formatter and live ticking (`childControls.ts:24-34`). → One
  derivation + one formatter; if live ticking is wanted, ship `startedAt` on
  the wire and derive in one shared helper. **Net:** ~−15 L.
- **C18. `replayTrace` bootstrap re-implements two live builders.**
  `packages/trace-viewer/src/replayTrace.ts:228-254` hand-builds the
  `SyncStreamContentPayload` category branch that
  `ProgressStreamProjectionBuilder.ts:104-135` owns for the live path, and
  `:169-208` constructs `StreamTabInfo`/`streamStates` literals bypassing
  `buildStreamInfo` + `buildStreamMetadata` (the schema-parsing SSOT). A field
  added to `StreamMetadataSchema` with a prefault reaches live but not replay.
  → Feed replay through the same builders. (The renderer itself is already
  shared — §1; this is the last replay-drift surface, together with the
  fenced `legacyTraceIdentity` parser at `:140-156`.)

### 2b. Lifecycle plane

- **C2. Resume recovery claim/release triad — byte-identical, 2 hosts.**
  `packages/extension/src/commands/agent/resumeFromResumeData.ts:46-50,106-108`
  and `packages/desktop/src/main/desktopAgentResume.ts:50-58` are the same
  three statements (`useRecovery`/`claimRecovery` → bail on failure →
  `.finally(release('recoverable'))`) — pure `SessionHandle.followUps`
  choreography, nothing host-specific. _(Corrected after review: the CLI is
  NOT missing the guard — when no preclaimed recovery is supplied,
  `resumeQueuedToolUseFromResumeData` performs the same
  `claimRecovery(streamId, true)` internally and returns `false` if the
  queue is already owned or terminal (`resumeQueuedToolUse.ts:88-91`). The
  bail happens later in the call, not never.)_ → Core
  `resumeStreamWithRecovery(streamId, ports, recovery)` beside
  `resolveAndResumeStream` as a **dedup of the two GUI wrappers only**; the
  CLI keeps its in-function claim. **Net:** −2 copies.
- **C10. `validateExecutionRequest` → report → bail: 6 sites, 3 sinks, one
  silent.** CLI (`runExecution.ts:146-150`, stderr + exit code), desktop
  (`desktopAgentExecution.ts:1282-1289` + `desktopProgressFileActions.ts:82`,
  toast), shared controllers (`HistoryActions.ts:101-105`,
  `MainViewExecutionController.ts:99`), and the extension's
  `ProgressViewMessageHandler.ts:811-816,828-833` — which logs and **returns
  silently** behind a comment claiming "both callers own their own user-facing
  failure reporting" (neither does; that is the silent-degradation defect
  class). → `validateOrReport(request, report)` in the shared controller
  layer; the extension's silent branch must then declare itself. **Net:** −6
  skeleton copies + 1 silence made loud.
- **C11. Unhandled-failure de-dup guard: 2 hosts have it, the extension
  regresses without it.** Desktop resume
  (`desktopAgentResume.ts:68-71,89`), desktop launch
  (`desktopAgentExecution.ts:412-424`), and CLI
  (`runExecution.ts:288-291,556-560`) all wrap runs in
  `trackTerminalResultPresentation` → only surface if `!isHandled()` →
  dispose. The extension's resume path has no guard and passes an
  unconditional `onError: showResumeError`
  (`resumeFromResumeData.ts:33-40,83-87`) even though
  `resumeToolUseFromResumeData` sets `suppressErrorNotification: true`
  _because_ "host resume callers surface their own warning toast"
  (`executeAgent.ts:570`) — so a failure that already produced a
  terminal-result toast toasts twice. → Core
  `withUnhandledFailureReporting(session, filter, run, report)`; 3 existing
  sites become callers, the extension becomes the 4th and loses the double
  toast. **Net:** −3 copies + 1 bug.
- **C3. Resume-state resolution reporting: both GUI hosts mishandle
  `read-failed`, differently.** _(Re-cited after review — the original
  citations were wrong: the data|null|throw contract lives in
  `retrieveSessionResumeData` (`SessionResumeRetrieval.ts`), the cited
  desktop comment does not exist, and the port today resolves to
  `ResolvedResumeState | undefined` — the extension collapses a preload
  **failure** into the same `undefined` as missing state.)_ Corrected
  finding: on read failure the extension is log-only/silent
  (`resumeFromResumeData.ts:63-80`) and desktop shows the generic "No
  persisted run state was found" message (`desktopAgentResume.ts:141-149`)
  — **neither** host distinguishes "storage failed" from "nothing to
  resume", the false-diagnosis defect. The fix is therefore a small
  **contract change first**: propagate a discriminated resolution
  (`read-failed | incomplete | resolved`) through the port and its callers,
  then one shared `describeResumeStateResolution(resolution)` supplies the
  message; hosts keep only the render verb. Fixes §3 V4(a).
- **C21. `ExecutionLeaseActiveError` classification: 3 hosts, 3 phrasings,
  zero shared code.** CLI pre-checks via `inspectExecutionLease`
  (`resumeExecution.ts:96-105`, "Execution X is active in TeXRA."); desktop
  and extension hit the error deep inside `resumeToolUseFromResumeData` and
  render "Resume failed: …" / "Failed to resume tool-use session: …". The
  _pre-check_ is CLI-only (1 host — leave it); the **error classification and
  message** are shared by all three and exist nowhere. → One
  `describeResumeFailure(error)` in core distinguishing lease-active from
  generic failure; three call sites.
- **C12. Main-view launch ladder: identical 5-step sequence, 2 hosts.**
  `executionHandlers.ts:59-109` (ext) and
  `desktopAgentExecution.ts:1293-1312` (desktop): prepare → cancelled-return →
  error-show → infoMessage-show → invalid-show → run, same order, same
  predicates. Deliberate deltas layered on top: the extension's
  workspace-folder guard (deserved, multi-root) and its `docsCommand`
  affordance — which desktop **discards** (`:1307-1310`), giving desktop
  users a dead-end error where extension users get "Open file management
  guide" (gap, fix with the extraction). → `runMainViewLaunch(message,
hostPorts)` on the existing `MainViewExecutionController`. **Net:** −1 copy
  - 1 restored affordance.

### 2c. Composition-root / platform plane

- **C4. Project-config store selection + `canCreateOrWrite` — verbatim, 2
  hosts; 3rd host throws instead.**
  `packages/extension/src/frontend/vscode/texraConfig.ts:36-73` and
  `packages/desktop/src/main/platform/index.ts:54-72,103-123` are the same
  walk-up loop (`constants.W_OK | X_OK`, `isFileNotFoundError`,
  `parent === dir` termination), same
  `hasProjectConfig || canCreateOrWrite(path)` rule, same internal-store
  fallback, near-identical warning text; only the log sink differs. The CLI
  has **neither** — `initPlatform.ts:237-239` opens
  `workspaceTexraConfigPath(cwd)` unguarded. _(Narrowed after review:
  `JsonStore.open()` only reads — `ENOENT` is an empty store and no write
  happens until `set()`/`flush()` — so the failure cases split: a
  **malformed or unreadable** config file fails CLI initialization, while
  an **unwritable** one fails only when a command persists configuration.
  The GUI hosts degrade both cases to the internal store; the CLI degrades
  neither.)_ (§3 V10.) Adjacent: the global-store open is
  3-host with one drifted constant (desktop hard-codes `'config.json'`,
  `platform/index.ts:99-101`, instead of `TEXRA_CONFIG_FILE_NAME`). →
  `openTexraConfigStores(storage, workspaceRoot, warn) → {workspace, global}`
  in `src/platform/defaults/`; 3 call sites. **Net:** −1 verbatim copy, +1
  missing degradation path, −1 drifted literal.
- **C5. Config-provider logic duplicated inside core itself.**
  `src/platform/defaults/memoryConfigProvider.ts:26-71` vs
  `jsonConfigProvider.ts:35-91`: byte-equivalent `get` (workspace → global →
  `getCoreSettingDefault` → caller default), `inspect`, `isExplicitlySet`,
  `watch`; only the store accessor differs. → One provider over a 3-method
  source interface; 2 implementers (JSON: 3 hosts; memory: agent package).
  **Net:** ~−45 L.
- **C6. Secrets: one skeleton, two implementers, four env-first copies.**
  `cliSecrets.ts:34-78` and `electronSecrets.ts:59-168` share the whole
  `JsonStore`-backed shape (env-first get, `set/delete` = `store.set`,
  `listStoredKeys` = snapshot keys); real deltas are the value codec
  (identity vs `safeStorage` envelope) and the CLI's outer `PQueue`.
  _(Corrected after review: Electron's missing queue is NOT a race —
  `JsonStore.set()` synchronously enqueues flushes into a module-wide
  per-path `PQueue` and the flush takes a cross-process file lock; the CLI
  needs its outer queue only because it asynchronously re-opens a fresh
  store per mutation. Do not add a redundant queue to Electron.)_ The
  env-first `get()` appears in all four impls (`vscodeSecrets.ts:19-23`,
  `electronSecrets.ts:69-74`, `cliSecrets.ts:39-41`,
  `packages/agent/src/node.ts:29-30`). → `JsonStoreSecrets` base with
  injected codec (2 implementers) + `withEnvOverride(store)` (4 callers) —
  a FLAGGED-class extraction that lands only if net-≤0. `VscodeSecrets` and
  the Electron `safeStorage` mode machine stay host-specific (deserved).
- **C7. The extension re-implements two shared bootstrap helpers — by
  admission.** (a) `copyDefaultAgents`
  (`packages/extension/src/frontend/setup.ts:26-55`) duplicates
  `bootstrapNodeAgentDirectories` (`nodeHost.ts:163-184`, used by desktop +
  CLI), minus the re-entry guard. (b) The runtime-skills block
  (`extension.ts:274-286`) carries a comment: "Mirrors the CLI/desktop
  Node-host wiring … inlined … so the extension bundle doesn't also pull in
  that module's Lean direct-adapter import." The blocker is a module-boundary
  artifact: `nodeHost.ts:25` imports the Lean LSP adapter. → Split the skill
  helper out of `nodeHost.ts`; the extension imports both helpers; delete
  both inline copies. **Rider (review-caught):** `copyDefaultAgents` catches
  reconciliation errors so VS Code activation survives an unreadable agent
  directory, while `bootstrapNodeAgentDirectories` propagates — the shared
  helper must gain a catch-and-warn (or injected reporter) before the
  extension copy deletes, or a broken agent dir starts rejecting activation.
  **Net:** −2 admitted duplicates; real 3-host consolidation unlocked by a
  file split, not a new layer.
- **C8. Three near-identical `Platform` literals.** `createNodePlatform`
  (`nodeHost.ts:93-114`), `nodePlatform` (`packages/agent/src/node.ts:58-78`
  — reimplements rather than calls it), and the extension's hand-assembled
  literal (`extension.ts:209-235`). _(Mechanism corrected after review:
  widening `configStores`' declared type is NOT sufficient —
  `createNodePlatform` unconditionally constructs `new JsonConfigProvider`
  from the stores, while the SDK deliberately supplies a
  `MemoryConfigProvider`. The consolidation needs the factory to accept an
  already-constructed `ConfigProvider` (stores-or-provider input), so the
  SDK's semantics survive; and the SDK surface is frozen, so its exported
  signature must not change.)_ Extension passes overrides (`globalState`,
  `workspaceState`, `secrets`, `languageModel`, `toolMissingHandler`).
  **Net:** −2 restatements.
- **C15. Workspace-state path derived twice, same physical file.** Desktop
  (`platform/index.ts:84-98`) re-derives
  `join(storage.getStoragePath(), 'state.json')` that
  `createCliStateStores` (`cliStateStores.ts:22-46`) already owns — and in
  production both hosts write the **same**
  `~/.texra/workspace-storage/<id>/state.json`. Fold into one helper; the
  _global_-state path divergence is §3 V1 (a ruling, not a refactor).
- **C14. `registerCoreShutdownHandlers` — desktop and CLI leak at exit.**
  _(Scope note from review: the recorder backstop belongs only to
  recording-capable hosts — the CLI has no audio path, so its wiring would
  be dead; the lifecycle doc's self-registration form scopes this
  naturally.)_ Only the extension disposes the shared polling sources
  (`SharedPR/Repo/IssuePollingSource.disposeAll`), `killActiveRecording`, and
  `clearStoreCache` at shutdown (`extension.ts:289-308`); desktop
  (`index.ts:1231-1252`) and CLI (`initPlatform.ts:353-377`) dispose none of
  them, leaking core-owned timers and recording child processes. These are
  core resources reachable from every host. → A
  `registerCoreShutdownHandlers(lifecycle)` beside the existing (already
  3-host) `registerAgentShutdownHandlers`; three callers. **Net:** −1 leak
  class ×2 hosts.

### 2d. Auth plane

- **C9. Subscription sign-in descriptors: 3 hosts × 2 providers = 6
  restatements.** Ext (`codexSubscriptionSignIn.ts:12-28`,
  `xaiSubscriptionSignIn.ts:12-28`), CLI (`chatgptLogin.ts:18-57`,
  `grokLogin.ts:18-57`), desktop inline
  (`desktopCredentialSettingsController.ts:312-338`) each restate
  `{coordinator, loginWithDeviceCode, loginWithLoopback, accountLabel,
setPreferSubscription, displayName}` per provider, and the three generic
  runners share one device-code-vs-loopback shape with only presentation
  differing. → One `SUBSCRIPTION_PROVIDERS` registry in `src/auth/` + a
  host-supplied `{presentDeviceCode, presentSignInUrl}` port; 6 descriptor
  sites → 2. Rider: desktop currently imports **only** `loginWithLoopback`
  (§3 V11a) — the registry gives it the device-code fallback for free.
- **C-minor (auth).** `getServerSideKeyService().clearAllCaches({
resetQuotaFlip: true })` is repeated unconditionally at 6 sites across the
  three hosts (`SupabaseAuthProvider.ts:83,388`,
  `desktopSupabaseAuth.ts:414`, `cli/supabaseAuth.ts:158,209,221`).
  `authFlowEffects.ts:1-21` argues the _surrounding_ refresh sequence is a
  permanent host boundary — this single call is not part of that argument and
  belongs inside the shared coordinator. Also: `getCliSecrets` memoizes on
  first `storageRoot` and ignores later arguments (`cliSecrets.ts:86-91`)
  while `initializeCliSupabaseAuth` re-derives secrets independently
  (`supabaseAuth.ts:108`) — two sources for one store; and the extension's
  `secretManager.ts:31-72` is a pass-through over `platform().secrets` (4 of
  6 members one-line delegations) — a deletion candidate, not an extraction.

### 2e. Rendering plane (needs one editorial ruling first)

- **C16. Tool-row assembly: two folds over one `NormalizedToolUse`.** The
  normalizer is shared (`src/shared/toolUse.ts:81`, 2 callers); every display
  decision on top is forked with divergent policy — header-preview source,
  truncation (width-budgeted vs fixed 60/120), which tools show output (CLI:
  bash+MCP only, `toolRenderers.tsx:318-329`; webview: everything _except_
  MCP/read/delegate/…, `toolFormatters.ts:155-162` — a direct inversion on
  MCP), output truncation (CLI head-6/tail-3/2000-chars vs webview none),
  error text (240-char collapse vs full `<pre>`). → The workflowCall.ts shape
  (§1): a core `toolRowModel(normalized, {widthBudget}) → {headerLabel,
headerPreview, sections[], errorPreview, elision}`; CLI paints spans,
  webview paints Lit. **Blocked on an editorial ruling** — which policy wins
  per axis — so this is Band 1 mechanics _after_ a Band 2 decision (§4).
  Related: `buildDelegationSections` / `buildWorkflowScriptSections` etc.
  (`toolSections.ts:408,455`) have no CLI counterpart at all (§4d).
- **C19. (Withdrawn half + surviving half.)** _(Review-adjudicated:)_ the
  `htmlMarkdownNormalize.ts` relocation is **withdrawn** — the Lit webview
  renders HTML directly and no second consumer for the terminal conversion
  exists, so moving it to shared code would mint a single-caller shared API
  (the banned species). It stays in the CLI until a second host needs it.
  The surviving half: `summarizeEmbeddedSubagentFollowups`
  (`src/shared/subagentFollowup.ts:391`) sits in shared code with a header
  claiming "Both hosts render them" while having exactly one CLI caller —
  the header is wrong or the webview is missing the feature (§4f decides
  which).

---

## 3. Band 2 — divergence register (correctness; each needs a ruling or is a plain bug)

Format: mechanism → consequence → convergence/ruling needed.

- **V1. Same setting key, three physical stores.**
  - Git-author keys (`texra.git.*`, catalog says
    `hosts: ['vscode','cli','desktop']`, `stateSettings.ts:351-407`): ext →
    `WorktreeMemento`; desktop → workspace `state.json`; CLI →
    `.texra/config.json`. _(Corrected after review: this is NOT a missing
    host argument — `applyStateSettingUpdate` has no host parameter by
    design, `SettingsHostKind` is deliberately `'extension' | 'cli'`, and
    `settingsAccess.ts:23-25` documents that desktop shares `entry.store`
    with the extension while `cliStore` is CLI-only. Desktop writing these
    keys to workspace `state.json` follows the catalog contract.)_ The
    defect is the **three-store divergence itself**: the same catalog row
    resolves to three different physical stores, so a value set in one host
    is invisible in the others. Where the value _should_ live is the
    ruling — and the 2026-08-15 policy-toggle precedent (extension moves to
    the shared store) is the recorded direction.
  - Global state is not shared at all — desktop
    `<userData>/state/global.json` (`platform/index.ts:84-86`) vs CLI
    `~/.texra/global-storage/state.json` (`cliStateStores.ts:22-28`) vs VS
    Code `globalState` — affecting `USE_OPENROUTER`, `HELPER_MODEL`,
    `DISABLED_TOOLS`, `KIMI_CODE_PREFER`, provider endpoints, enabled-model
    list, onboarding flags. CLI comments assert the opposite
    (`initPlatform.ts:394-401`: "the setting lives in shared `~/.texra`
    state … would clobber a choice the user made in another host"). Either
    unify on `~/.texra` (a data migration, needs its own design note) or fix
    the comments and the catalog to tell the truth.
  - Secrets are not shared and differ in confidentiality tier:
    `~/.texra/secrets.json` plaintext 0o600 (CLI) vs `safeStorage`-encrypted
    `<userData>/secrets.json` (desktop) vs VS Code SecretStorage. `texra
login` does not sign in the GUI hosts and vice-versa. Ruling: is
    cross-host single sign-on a goal? If yes, this is a keychain-backed
    shared-store design note; if no, fence it and say so in `texra login`
    help.
- **V2. Desktop telemetry is partially initialized.** _(Narrowed twice on
  review/verification — "dead" overstated it.)_ The catalog row declares
  `hosts: ['vscode','desktop']` (`stateSettings.ts:881-890`), the desktop
  renders + persists the toggle (`desktopSettingsIpc.ts:248`), and the
  toggle DOES gate collection (`log()` checks the setting per entry).
  What the missing `UsageLogService.initialize` costs: no 30 s flush
  cadence ever starts (batch-of-10 and immediate relay-round flushes still
  fire), `editorType`/`extensionVersion` stay undefined on every desktop
  entry, and low-volume **non-relay** entries (BYOK telemetry,
  subscription-route plan accounting) queue until exit and are lost —
  relay spend-cap accounting is safe (flushed per round by
  `UsageMonitor`). Same class:
  desktop never calls `refreshModelListStateIfNeeded` at startup (ext
  `extension.ts:385`, CLI `initPlatform.ts:298`), so retired-model sweeps and
  stale Copilot-route clears never run there. Both are FS-class
  (advertised-toggle-no-ops); both are plain wiring fixes.
- **V3. Two contradicting SSOTs for "which host honors setting X".**
  `CLI_CORE_SETTING_PATHS` (`coreSettings.ts:508-562`) vs
  `STATE_SETTINGS[].hosts`: `toolUse.requireEditApproval` /
  `requireBashApproval` and the `latex.*Replacements` /
  `wrapCritiqueInAlign` rows are in the CLI list while the catalog says
  `hosts: ['vscode','desktop']`. One catalog must own the answer; the other
  derives. Adjacent asymmetries to settle in the same pass: settings surfaced
  in only one host's UI over a key core reads everywhere
  (`WEBSOCKET_OPENAI`, `USE_OPENROUTER`, `KIMI_CODE_PREFER`, provider
  endpoints — `hosts: ['cli']` with the Models tab as a parallel UI), and
  ext/desktop-only rows the CLI reports as _unknown keys_ when they appear in
  `.texra/config.json` (`ALLOW_ORCHESTRATOR_KILL`,
  `DETACH_SUBAGENTS_ON_STOP` — which is also the CP2 gap,
  `WORKFLOW_AUTO_OPEN_PDF`, `LATEXDIFF_*`, `LATEX_FORMATTER`,
  `telemetry.enabled`).
- **V4. Extension resume was the weak sibling — V4b/c ruled + landed.** (a)
  silent `read-failed` (fixed by C3); (b) the extension passed no
  `canAcquireResumeLease`, so `acquireResumedExecutionLease(id, undefined)`
  skipped the atomic re-admission check inside the lease lock
  (`executionLease.ts:674-678,642`) — a stream deleted or relaunched during
  the async retrieval window could still have its lease acquired; (c) its
  cancellation was non-monotone — recomputed live from
  `!session.transcripts.has(streamId)`, so a stream re-created under the
  same id _un-cancelled_ a resume; (d) double-toast (fixed by C11).
  **Ruling + landed shape:** each attempt owns one monotone host-cancellation
  latch. The proposed shared default was rejected because cancellation is a
  host-owned lifecycle fact assembled from different signals; a core default
  would either duplicate host policy or silently weaken it, so the monotone
  `isCancellationRequested` port remains optional. The extension latches observed transcript absence
  (`resumeFromResumeData.ts:35-46`) and forwards the same latch/guard to both
  resume branches (`:82-102`); desktop latches host detach + transcript
  absence + authoritative-stream absence (`desktopAgentResume.ts:72-94`); the
  CLI already latched the same (`chatSessionController.ts:657-660,739`). The
  same latch reaches `resolveAndResumeStream` and queued tool-use;
  `canAcquireResumeLease` rechecks it under the lease lock. Desktop alone
  also checks the durable authoritative stream identity
  (`desktopAgentResume.ts:84-94`), fenced as desktop-only — extension/CLI
  must not copy it.
- **V5. Only the CLI settles executions at exit.** CLI shutdown
  (`runExecution.ts:344-399`) kills, persists `CANCELLED` with `'preserve'`,
  releases the lease, derives resumability, then advertises recovery.
  Desktop (`index.ts:1231-1253`) and extension (`extension.ts:289-303`)
  register only `flushArtifacts()` + disposal — no terminal outcome, no lease
  release — relying entirely on next-launch `repairRestartedStreams` and the
  120 s stale horizon (`executionLease.ts:19`). Consequence: quitting the
  desktop/VS Code mid-run leaves a live lease blocking `texra resume` of that
  execution for up to 2 minutes, and nothing documents it. _(Widened after
  review + lifecycle verification: the CLI is not fully settled either —
  the TUI completes leases only when `isResumableIdle()`, and headless
  settlement can lose its bounded grace race — so this is a **four-host gap
  of varying width**.)_ Resolution: lease settlement becomes a
  session-level obligation for all hosts (an awaited session-owned shutdown
  drain, since lease completion is async under file locking — the lifecycle
  doc §3 fix 2 owns the design).
- **V6. `enforceCategory` + mismatch finalization are CLI-only.** Core
  supports it (`runAgent.ts:39`, `executeAgent.ts:354`, enforced at
  `AgentLaunchContext.ts:321`); passed by 4 CLI sites + core's
  `nativeSubagentStrategy.ts:281`; never by `runExecuteCommand` (ext) or
  `launchDesktopAgent` (desktop). The CLI additionally finalizes mismatched
  runs (`runExecution.ts:162-175`); GUI hosts leave a live registered
  execution + flow record. A config whose `agentCategory` disagrees with the
  resolved agent silently runs in the GUIs and is rejected in the CLI.
  Ruling: by design or gap? (Nothing in the code claims design.)
- **V7. AppSignals is extension-only in practice.** Of 13 declared signals
  (`AppSignals.ts:10-57`), core emits `toolAvailabilityChanged`,
  `githubTokenInvalid`, `includedModelAccessChanged`, `workspaceFilesWritten`
  and six subscription signals — and `appSignals` has **zero references** in
  `packages/desktop` and `packages/cli`. Concrete consequences: the desktop
  tool dashboard repaints only on explicit user re-check (and desktop has no
  secret-change re-probe at all, vs `extension.ts:571-591`); desktop GitHub
  subscription panels are refresh-on-request where the extension's are live;
  a rejected GitHub token keeps polling silently outside VS Code
  (`PollingSourceBase.ts:449` emit, `extension.ts:594` sole subscriber); a
  core-side quota flip (`serverKeys/index.ts:71`) drives nothing in desktop
  or CLI. Overlaps DR10 for the subscriptions half; the
  tool-availability/token/model-access half is **new**. → Wire desktop (and
  where sensible CLI TUI) subscriptions; where a host deliberately won't
  react, fence it at the signal declaration.
- **V8. `detachActiveChildren` "SSOT bypass" — ruled deliberate divergence;
  2 shutdown sites documented.** `detachSubagentsOnStop.ts:17` documents
  itself as "shared by every host" and is honored at 4 sites;
  `chatSessionController.ts:856-858` (`stopStream`) hardcodes `true`.
  _(Corrected after re-audit against #9009:)_ the hardcode is deliberate
  action-semantic divergence, not a bypass — bare Escape is the
  focus-scoped gesture ("Stop only the focused stream", `App.tsx:149-150`)
  and always detaches descendants, while the configured stop surfaces
  (root stop, extension/desktop stop, orchestrator kill) consult the
  setting. The `runExecution.ts:409,505` `kill(id)` sites are on the
  **process-shutdown path**, where cascade-kill is correct — a detached
  child cannot outlive the exiting CLI process, and applying the toggle
  there would strand children without finalization. Landed: the shutdown
  sites pass an explicit `{detachActiveChildren: false}` with a comment
  declaring the deliberate cascade (per the lifecycle doc §4); `stopStream`
  keeps its #9009 contract. (CP2's "CLI has no setter" half remains a
  separate decision.)
- **V9. "Resumable" has two truth sources.** GUI hosts:
  `deriveResumability(id)` with typed causes
  (`HistoryMessageBuilder.ts:36-42`, `resumability.ts:82`). CLI:
  `resumeData !== null` where `readCliResumeDataForListing` additionally
  requires a stamped `meta.streamId`, a successful state-schema parse, and
  swallows read errors to null (`history.ts:198-213,504-508`,
  `toolUseResumeData.ts:24-57`). The same run can display resumable in one
  host and not the other, invisible at the type level because both feed
  `resolveHistoryRunStatus`. This is **DR13, still open at HEAD** — cite,
  decide once at the shared owner.
- **V10. CLI config open throws where GUI hosts degrade.** Covered by C4;
  listed here because until C4 lands, every `texra` command hard-fails on a
  corrupt project config — the one host where the user has no settings UI to
  fix it.
- **V11. Auth drift.** (a) Desktop has no device-code path — only
  `loginWithLoopback` imported (`desktopCredentialSettingsController.ts:3,6`);
  ext falls back under `remoteName`, CLI under remote/non-TTY/`--no-input`; a
  desktop without a reachable loopback browser has no fallback (fixed by C9).
  (b) Login-CSRF binding is per-host: desktop persisted nonce + match; CLI
  per-attempt nonce on the loopback POST; the extension's
  `SupabaseUriHandler.handleUri` fires on path match alone with **no
  nonce/state binding** (`UriHandler.ts:22-26`) — mitigated by PKCE
  (`SupabaseSession.ts:224-241`), but the defense-in-depth tier differs
  silently. Ruling: minimum bar for callback binding, then converge.
- **V12. Approval-policy default differs by entry path, undocumented.** CLI
  under `--no-input` defaults to `'never'`
  (`cliContext.ts:411-413`), ext and desktop to `'ask'` via the shared
  `TEXRA_APPROVAL_POLICY_DEFAULT` constant (`src/shared/approvalPolicy.ts:9`;
  ext through `settingsState.ts:199`, desktop through
  `readPersistedTexraApprovalPolicy` imported at
  `desktop/main/index.ts:48` — anchors refreshed on review). Plausibly
  deserved (headless discipline) — but the catalog doesn't record it; fence
  or unify.

---

## 4. The #9021 register: data on the wire, dropped by the CLI

The live instances of the class issue #9021 named (subagent file data on the
wire, discarded by the CLI adapter). Each is _data already computed by shared
code_; the CLI either filters it out or re-derives a weaker version. These
need one editorial ruling — "does the CLI transcript aim for webview parity
or a deliberately terser editorial line?" — after which each row is
mechanical. Today the answer is undeclared, which is how the drift
accumulated.

- **(a) Retained finished subagent rows.**
  `sessionSignalsAdapter.ts:206-209` filters
  `badges.subagents.filter((c) => c.finishedAt === undefined)` — one line
  after `SessionFactApplier.updateChildRoster` (`:333-405`) computed
  retention, phase-merge, and the 200-cap. The webview keeps every non-process
  retained row. The CLI then runs its own 585-line relationship model
  (`childExecutions.ts`) whose tombstone cap mirrors the shared constant "as
  a value, not an import" (`:66-76`). Consuming the shared roster likely
  retires much of that file.
- **(b) Error detail fields.** Webview renders 11 typed fields + relay
  labeling (`messageFormatters.ts:91-138`); the CLI renders `message` only,
  truncated to 240 (`transcriptFold.ts:229-252`). `statusCode`, `requestId`,
  `provider`, `rawErrorBody`, `userRetryable` etc. are on the wire and
  unreachable in a terminal — where users debug provider failures.
- **(c) `CONTEXT_STATE`.** Recorder emits the model-handler-authoritative
  context window + utilization (`TexraTranscriptRecorder.ts:506`); the
  extension folds it (`logSlice.ts:134-146` → UsagePanel); `packages/cli` has
  zero references and re-derives the window from `MODEL_CONFIGS` /
  subscription profiles (`statusBarDisplay.ts:214-226,312-320`). One gauge,
  two sources; the CLI's can disagree with what the handler actually used.
- **(d) Delegation/workflow tool sections.** The webview builds structured
  sections incl. file groups via shared `getProposalFileGroups`
  (`toolSections.ts:408,455`); the CLI transcript falls through to
  `JSON.stringify(input)` because `deriveToolInputPreview` has no
  `delegate_agent` row (`toolInputPreview.ts:30-33`), and uses
  `getProposalFileGroups` only in approval modals, never the transcript. The
  original #9021 surface, still open in transcript rows.
- **(e) User-feedback tool rows.** `normalizeToolUseData` produces
  `isUserFeedback`/`userInstructionText` (`toolUse.ts:99,119`); the webview
  renders the instruction (`toolFormatters.ts:181-188`); `packages/cli` never
  reads either field — a user's rejection instruction is invisible in the
  terminal transcript.
- **(f) Embedded subagent follow-up summaries.** Shared
  `summarizeEmbeddedSubagentFollowups` claims both hosts render them; only
  the CLI does (§2 C19). Inverse-direction instance of the same class.
- **(g) File attachments.** CLI keeps only `ok && image` entries and drops
  the whole row when zero survive (`transcriptFold.ts:68-92`,
  `renderLogEntryFresh:288`); the webview renders every entry with a
  "Files (n/m loaded, k not found)" summary (`dataFormatters.ts:66-88`). A
  run with 3 of 4 attachments failed shows a partial-load warning in the
  webview and a single happy image line in the CLI — a
  silent-degradation instance, not just a style delta.
- **(h) Message types with no CLI row.** Webview renders 15 types; the CLI
  admits 5 (+2 for child streams) (`transcriptFold.ts:95-106` vs
  `formatters/index.ts:90-135`). No scrollback row for `webSearch`,
  `webFetch`, `missingOutputs`, `latexdiff`, `statistics`,
  `contextManagement`, `scratchpad`; `thinking` is live-activity-only.
  Some rows are surely deserved (terminal economy) — the point is to rule
  per-type and fence, not leave it to accretion.
- **(i) Malformed rows are silently dropped — on both hosts, differently.**
  _(Corrected after review:)_ the webview's visible "Failed to render X"
  fallback (`formatters/index.ts:56-79`) covers only **thrown** formatter
  errors; for malformed tool payloads `normalizeToolUseData` `safeParse`s to
  `null` and the entry falls through to the default formatter — so the CLI
  comment claiming parity (`transcriptFold.ts:299-302`) is closer to true
  than first audited. The real defect is that neither host has a declared
  malformed-payload policy: choose one (visible failure row or structured
  normalization error) and apply it to both, rather than prescribing "CLI
  adopts webview behavior" that doesn't exist.
- **(j) MCP tool output inversion.** Shown in CLI
  (`toolRenderers.tsx:327-328`), suppressed in webview
  (`toolFormatters.ts:159`). Someone decided each side once; nobody decided
  both.
- **(k) LaTeX math environment coverage gap — CLI-only exposure.**
  The shared `MATH_SPAN_PATTERNS` (`createMarkdownProcessor.ts:123-128`)
  protect `$…$`/`$$…$$`/`\(...\)`/`\[...\]` but **not**
  `\begin{env}…\end{env}`; the webview's texmath enables `beg_end`
  (`texmathPlugin.ts:54`). _(Corrected after review — the original
  `a_{i} b_{j}` example does not reproduce: those `_` runs are not
  left-flanking under CommonMark rules, so they survive verbatim.)_ The
  narrower true claim: environment bodies pass through markdown-it
  **unprotected** in the CLI, so any genuinely markdown-sensitive content
  inside them corrupts — `\\` row breaks are eaten as escapes, `*…*`
  spans become emphasis, `` ` `` opens code — where the webview's `beg_end`
  consumes the whole environment first. Test coverage exists for the four
  protected delimiters (`AnsiMarkdown.vitest.ts:985-1002`); a
  `\begin…\end`-specific test is the missing piece. Inverse false-positive
  verified as stated: the CLI's inline `$…$` pattern lacks texmath's
  adjacency rule, so `Cost $5 then *ten* $10` suppresses emphasis in the
  CLI only, and the currency masking that would compensate runs only when
  an HTML tag is present (`htmlMarkdownNormalize.ts:247-318`). Both are
  pattern fixes in the shared processor + tests, no ruling needed.

Headless CLI is deliberately **out** of this register: the NDJSON rail is a
frozen wire (fenced), and the status-line renderer's hand-rolled folds are
CP4/CP5 + §2 territory (the projection sweep confirmed
`runProgressRenderer.ts:60-68,331-390` duplicates roster tracking that
`SessionState` owns — fold it onto the shared state when touching that file,
~−80 L).

---

## 5. Overlap with the 2026-07-09 drift register

Re-checked at this HEAD during the sweep:

- **DR2 (prompt replay):** half-converged since adjudication — both hosts now
  call `replayApprovalRequestHandlers` (`ProgressViewProvider.ts:334-340`,
  `desktopAgentExecution.ts:1073`). The userQuestion gap and DR3
  (inquiry rehydration extension-private; desktop ignores
  `inquiryThreadUpdated` — re-confirmed at `sessionSignalsAdapter.ts:292`
  no-op) remain open.
- **DR6 (goalPaused):** still open exactly as written; each host keys off a
  different fact (`LitSessionRenderer.ts:236-244` vs
  `sessionSignalsAdapter.ts:294-303`).
- **DR13 (history projections):** still open; §3 V9 adds the resumability
  truth-source facet with current line numbers.
- **DR8 (usage totals):** still open; §2 C13's predicate row is a smaller,
  independent slice.
- **CP2 (detach policy):** the stream-stop half is now §3 V8 (ruled
  deliberate divergence, 2 shutdown sites documented); the CLI-setter half
  remains CP2's decision.
- **CP4/CP5 (headless vocabularies):** unchanged; reaffirmed by the
  projection sweep (three hand-maintained run-fact filter arrays,
  `RUN_PROGRESS_RUN_FACT_TYPES` at `runProgressRenderer.ts:43-48`).

---

## 6. Deserved-divergence fence additions

New rows for the fence register (different on purpose; stop re-flagging):

- **Math protection mechanisms differ correctly**: webview texmath consumes
  math before inline rules run (hazard structurally absent); CLI opts into
  `protectLatexMath` (`ansiMarkdown.ts:503-514`) because terminal markdown-it
  has no texmath. One _coverage_ gap is real (§4k); the mechanism split is
  deserved.
- **Ink `<Static>` settlement-ordering model**
  (`transcriptEntries.ts:117-179`, `finalizedFrontier`) vs the webview's
  append-only `logs[]` — deserved; do not merge the container models.
- **NDJSON boundary drops** (`sessionProgressSubscription.ts:24-37,70,105`)
  — frozen compatibility wire, documented and fenced.
- **Extension passes no `runtimeUnavailableTools`** — deserved; VS Code is
  the reference host owning the full tool surface
  (`DESKTOP_UNAVAILABLE_TOOLS` is literally the VS-Code-only set + more).
- **CLI chat refuses workflow auto-resume**
  (`chatSessionController.ts:733-737`) — deserved; `texra resume` is the
  workflow path; the throw is an internal invariant.
- **CLI relay-token management** (mint/list/revoke) is single-host by
  scope; note the consequence (tokens minted in CLI are unmanageable from
  GUIs) in `texra relay-tokens` help rather than porting.
- **Electron `safeStorage` mode machine + Linux `basic_text` refusal;
  VS Code SecretStorage `keys()` unsupported-host error** — deserved
  host-specific secret backends (the _skeleton_ consolidates, C6).
- **`childExecutions.ts` tombstones ≠ retained finished rows** — the copied
  cap constant is defensible, but convert the "as a value, not an import"
  comment into an import once §4a lands.
- **Render-time re-redaction in the CLI**
  (`transcriptFold.ts:239,383` etc. over already-redacted rows) — defensive
  double-apply, deserved; note it costs per-frame work.

---

## 7. Suggested execution

Band 1 items are independent, PR-sized, and net-negative; Band 2 items each
start with a one-paragraph ruling (several are recorded above as plain bugs
needing none). Suggested order:

1. **Plain bugs, no ruling** — V2 (desktop
   `UsageLogService.initialize` + `refreshModelListStateIfNeeded`), §4i
   (silent CLI render failures), §4k (math patterns + tests), V1a's missing
   host argument at `desktopSettingsIpc.ts:258`.
2. **Top mechanical consolidations** — C1 (delta-feed driver), C2+C3+C11+C21
   (one resume-hardening PR: triad + resolution reporting + failure guard +
   lease-active classification; also closes V4a/d), C4 (config-store open,
   closes V10), C10 (validate-and-report), C14 (core shutdown handlers),
   C12 (launch ladder + docsCommand).
3. **Composition-root cleanups** — C5, C6, C7, C8, C15, C9 (closes V11a),
   C13, C17, C18, C20, C22.
4. **Rulings, then mechanics** — the CLI-transcript parity charter (§4, one
   decision unlocking a–h and C16), settings-store unification (V1, needs a
   migration design note), catalog SSOT (V3), lease-at-quit (V5),
   `enforceCategory` (V6), AppSignals wiring scope (V7), resumable truth
   source (V9/DR13), callback-binding bar (V11b), approval-policy default
   fence (V12). Resume admission (V4b/c) is no longer pending: ruled + landed.

Everything here was found by scoped sweeps, not adjudicated line-by-line the
way the 2026-07-09 audit was; treat each row as _verified-at-citation_ but
re-open sites before acting — the verifier-wrong-on-specifics rate in past
campaigns was nonzero, and eight campaign PRs are landing around these files.
