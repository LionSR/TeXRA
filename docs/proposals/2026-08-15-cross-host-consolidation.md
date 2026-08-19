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

> **Reconciled against origin/main `e00b9317f7` (2026-08-19).** The lifecycle
> plane largely executed — C2/C3/C21 landed in one resume-hardening PR
> (#10699), V4b/c were ruled and landed (#10739), C10's silent branch is loud
> (#10924), and §4a landed over-delivered (#10693 then the Wave A collapse).
> §4i landed (#10713) and §4k's code landed by a better mechanism than
> prescribed (#10704, a texmath-mirroring block probe rather than a
> `MATH_SPAN_PATTERNS` addition) — though the `\begin…\end` test this doc
> named as the missing piece is still missing. V3 is **fixed** by #10925, and
> V9/DR13 is substantially resolved (see the row — the doc's "two truth
> sources" framing was wrong at HEAD). **The composition-root plane
> (§2c) is untouched: not one of C4/C5/C6/C7/C8/C15 has a landing PR**, and
> C4/V10 is the live user-facing defect in the set — a malformed project
> config still hard-fails every `texra` command on the one host with no
> settings UI. Also genuinely open: C1 (whose framing is superseded — see the
> row), C12, C13a/c, C16, C17, C9/V11a, V2 (worse than written), V5 (real
> harm changed), V6, V7, V11b, and eight of the eleven #9021 rows.
> Three rows landed by a _better_ mechanism than proposed (C14, §4k, V9) and
> should be read down to their actual residue rather than whole; two rows
> evaporated with the relay retirement (#10894 attic + recovery record, #10896
> client plane) rather than being consolidated — C-minor(a)'s
> `clearAllCaches` repetition and V2's relay-spend mitigation — and with them
> the separately-tracked included-access spend consolidation, whose subject no
> longer exists: `relayUsage.ts` is deleted and `apiStatus.ts` carries no
> included-access line. (What survives is deliberate: one dated legacy copy
> string at `src/shared/copy/modelAccess.ts:59-68`, marked "delete after
> 2026-11" and backed by live tests — not leftover debt.) Three claims were
> already stale at this
> doc's own pin (C-minor(c), V12's "undocumented", and the `src/hosts/nodeHost.ts`
> path in C7/C8/C14 — the file has been at `src/platform/defaults/nodeHost.ts`
> since `3122ace2bc`). One regression to triage separately: C13b was resolved
> by **deleting** the CLI's ACTIVE_SKILLS handling, so the CLI can no longer
> observe active skills at all.

> **Reconciled again (2026-08-19, origin/main `82cc8b089d`).** **V2 LANDED** —
> `initializeElectronPlatform` now calls `UsageLogService.initialize({},
app.getVersion(), 'desktop')` with a BEFORE-phase `dispose()`, and
> `refreshModelListStateIfNeeded` against the desktop `globalState`. **The
> "no production caller on any host" escalation below is REFUTED**: at HEAD
> `refreshModelListStateIfNeeded` had two live production callers
> (`packages/extension/src/extension.ts`, `packages/cli/src/runtime/initPlatform.ts`)
> and no commit in available history removed either. The entry's original
> desktop-only framing was correct; read the escalation as an error of method
> (a `src/`-only grep). **C13b RESOLVED, and the premise it rested on was
> half-wrong**: the extension folded ACTIVE_SKILLS into
> `StreamState.activeSkills`, but _nothing rendered that field either_ — three
> hosts, zero renderers. Rather than restoring a shared derivation between one
> live and one dead consumer, the fact now has one owner and one surface: the
> CLI's `/status` reads the newest ACTIVE_SKILLS entry straight from the stream
> log and prints a `skills:` line, and the extension's reader-less fold plus
> the `activeSkills` field on `ToolUseStreamStateSchema` are deleted.

> **Follow-up:** the maintainer subsequently ruled for maximal consolidation
> ("same data structure, UI rendered differently, collapse
> projectors/adapters/bridges, single source of truth"). The target
> architecture and staged plan for that directive live in the companion doc
> `2026-08-15-single-substrate-hosts-as-renderers.md`, which deepens §2's
> C1/C13/C16/C20/C22 and the §4 register into a layer census, a transcript
> row-model study, a session-state field study, and a prior-rulings
> compliance map. Where the two docs disagree on an estimate, the companion
> doc's per-field accounting supersedes this doc's sweep-level estimate.

> **Composition-root plane executed (2026-08-19, #10991, merge `df86f1989f`).**
> The "§2c is untouched" claim in the `e00b9317f7` reconciliation above is
> superseded: C4/V10, C5, C7, C8 and C15 landed in one PR (one composition
> root for all three hosts — see §2c's status note), and C6 is struck as
> refuted rather than re-queued. C9/V11a remains open on this plane.

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

**Row status at `e00b9317f7` (2026-08-19).** C1 **superseded — the extraction
is withdrawn** (see the row). C20 **LANDED #10932** (the "zero CLI callers"
claim is now false: `streamViews.ts:124` calls `buildStreamTabInfo`; residual
ad-hoc `getRuntimeModelLabel` calls survive in four CLI files). C13a **OPEN**
— three live copies, `isEmptyUsage` still with zero host importers. C13b
**RESOLVED 2026-08-19** — the CLI's two ACTIVE_SKILLS sites went with the Wave
A slice retype (#10895) rather than converging on a shared
`latestActiveSkills`, leaving the CLI unable to observe active skills at all.
Triaged as the capability regression it was, and fixed by giving the fact one
owner and one surface (CLI `/status` reads the log directly; the extension's
reader-less fold and `StreamState.activeSkills` are deleted) — see the row.
C13c **OPEN**. C17
**OPEN** — the counts still are not on `ToolEditApprovalRequest` and
`DiffView.statsFromHunks` still recomputes. C22 **PARTIAL #10892 — and now
three representations, not two**: `startedAt` shipped and the CLI ticks from
it, but the redundant `formatDuration` stamp survives on the wire and the
webview still renders it. C18 **PARTIAL #10889** — the SYNC branch and
`streamStates` go through the shared builders; the `StreamTabInfo` literal is
still hand-built. Doc correction: `ProgressStreamProjectionBuilder.ts` no
longer exists; the live owner is `src/shared/streams/streamContentSync.ts`.

- **C1. The delta-feed driver is written twice.**
  **SUPERSEDED 2026-08-19 — the `StreamLogFeed` extraction is withdrawn**
  (issue #10673, closed NOT_PLANNED; substrate doc §7). The premise did not
  survive re-audit: the buffer/gap-detect/resync half was already one
  implementation (`StreamLogDeltaBuffer`, `src/transcript/StreamLog.ts:64`) and
  the coalescing half already had a shared owner (`createFlushableDebounce`,
  ten consumers) — both imported by both sites. What is left is divergent
  host policy, and it has diverged _further_ since this row was written: the
  CLI copy gained `logInstanceId`, `hasUndrainedChanges`, and mode-flip
  invalidation the webview has no use for. A single feed with two overriding
  consumers is the shape the repo's own LOC lesson says net-adds. Read the
  paragraph below as a description of a real duplication that was priced and
  declined, not as pending work.

  Ext/desktop
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
    **Net:** ~−25 L. **RESOLVED 2026-08-19, not as written.** The shared
    helper was not built: after #10895 deleted the CLI's two sites, the only
    remaining fold (the extension's) wrote a field with no renderer, so a
    "shared derivation consumed by both hosts" would have had one live
    consumer and one dead one — a single-caller extraction. Instead the fact
    got one owner and one surface: the CLI's `/status` reads the newest
    ACTIVE_SKILLS entry from the stream log directly, and the extension's fold
    and `StreamState.activeSkills` are deleted.
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

**Row status at `e00b9317f7` (2026-08-19).** C2 **LANDED #10699**
(`resumeStreamWithRecovery` in `resolveAndResumeStream.ts:75`, both GUI
wrappers converted; the CLI kept its in-function claim as adjudicated). C3
**LANDED #10699** — the discriminated `resolved | read-failed | incomplete`
resolution goes through the port and one shared
`describeResumeStateResolution`, closing V4a; the contract-change-first
sequencing this row insisted on is what made it work. C21 **LANDED #10699**
(`describeResumeFailure`, four call sites — one more than this row counted;
the CLI pre-check stayed CLI-only as designed). C10 **PARTIAL #10924** — the
_defect_ is fixed and is the more valuable half: the extension's silent branch
now logs **and** surfaces, and the false "both callers own their own reporting"
comment is replaced; the six-site `validateOrReport` dedup did not happen. C11
**PARTIAL #10699** — the double-toast bug is dead, but it was fixed by making
the extension a **fourth** `trackTerminalResultPresentation` caller, so the
duplication this row wanted removed grew by 33% and the row is now pure dedup
with no bug attached. C12 **OPEN** — the ladder is still duplicated and desktop
still discards `docsCommand`, so desktop users still get the dead-end error.

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

**LANDED #10991 (2026-08-19), one composition root for all three hosts.**
C4/V10 (the lead fix), C5, C7, C8 and C15 landed together:
`openTexraConfigStores` / `openNodeWorkspaceStateStore`
(`src/platform/defaults/nodeStores.ts`) own project-config selection and the
workspace-state path once each — the CLI now degrades a malformed or
unreadable `.texra/config.json` with a stderr warning instead of
hard-failing every `texra` command, and desktop's hard-coded `'config.json'`
became `TEXRA_CONFIG_FILE_NAME`. `JsonConfigProvider` reads through a
three-method `ConfigStore` surface, and `MemoryConfigProvider` _is_ that
provider over in-memory stores. `createNodePlatform`
(`src/platform/defaults/nodeHost.ts`) assembles the `Platform` skeleton for
all three hosts, and the shared agent-directory bootstrap catches
reconciliation failures the way the deleted extension copy did. **C6 is
struck — refuted, not deferred**: the genuinely shared code between
`CliSecrets` and `ElectronSecrets` is four trivial lines, and both candidate
extractions come out net-positive. C14's "remains open on this plane" in the
#10991 body names the proposed `registerCoreShutdownHandlers` extraction
only — #10716's self-registration already closed the leak class (residue:
`clearStoreCache` is still extension-only), so the extraction is moot, not
re-queued. The pinned paragraph below is the pre-#10991 record.

**This plane is where the program did not go.** At `e00b9317f7` (2026-08-19)
**none of C4, C5, C6, C7, C8 or C15 has a landing PR**, and two of them moved
the wrong way: C8's extension literal grew a member, and the factory still
constructs `new JsonConfigProvider` unconditionally so the SDK's
`MemoryConfigProvider` still cannot route through it. C5's scope shrank by one
member for an unrelated reason — #10865 deleted `watch` from both providers —
leaving `get`/`inspect`/`isExplicitlySet` still byte-equivalent. C4 is the
**highest-priority live defect in this doc**: the CLI still opens the project
config unguarded (`initPlatform.ts:229-231` over a `JsonStore.open` that
rethrows non-ENOENT), so a malformed `.texra/config.json` hard-fails every
`texra` command on the one host with no settings UI to fix it — and desktop
hard-codes `'config.json'` at two sites, not one. C14 **LANDED by a better
mechanism (#10716)**: rather than a three-caller `registerCoreShutdownHandlers`,
`PollingSourceBase` self-registers its own `disposeAll` on `platform().lifecycle`,
which fixes every host at once and matches the lifecycle doc's scoping note;
desktop separately gained `killActiveRecording`. The residue is one line —
`clearStoreCache` is still extension-only.

**Path correction:** C7, C8 and C14 cite `src/hosts/nodeHost.ts`. The file has
been at `src/platform/defaults/nodeHost.ts` since before this doc's own
reproduction pin.

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

**Row status at `e00b9317f7` (2026-08-19).** C9 **OPEN** — all six descriptors
live, and rider V11a is confirmed: desktop still imports only
`loginWithLoopback`. C-minor(a) is **MOOT by deletion, not consolidation** —
`getServerSideKeyService`/`clearAllCaches` went with the relay client plane
(#10896), so the argument that the call belonged inside the shared coordinator
was never tested. C-minor(b) **PARTIAL** — the harm is fixed (auth now reads
`platform().secrets`, one derivation), but `getCliSecrets`' storageRoot
memoization survives and is now pinned by a test. C-minor(c) **stale as
written** — `secretManager.ts` was never a `platform().secrets` pass-through at
this doc's own pin; it is presentation-only helpers, so "deletion candidate" is
the wrong verdict.

### 2e. Rendering plane (needs one editorial ruling first)

**Row status at `e00b9317f7` (2026-08-19).** C16 **OPEN**, unchanged — all four
divergences intact (MCP inversion, truncation budgets, error-text collapse,
output-suppression rulesets), and `buildDelegationSections` /
`buildWorkflowScriptSections` still have no CLI counterpart. The editorial
ruling this row was blocked on has since been granted (the 2026-08-19 parity
directive), so C16 is now unblocked mechanics, and the shared
`src/shared/transcript/toolRowModel.ts` in flight on `track/transcript-parity`
is its execution. One correction: the shared normalizer this row builds on is
`normalizeToolUseForRender` (`src/shared/toolUse.ts:205`) — the raw
`normalizeToolUseData` has zero direct production callers now. C19 **OPEN** —
the withdrawal of the `htmlMarkdownNormalize.ts` relocation was honored (it is
still CLI-local), and the surviving half is unfixed: the header still claims
both hosts render follow-up summaries while exactly one CLI caller exists.

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

**Register status at `e00b9317f7` (2026-08-19).** **V3 FIXED #10925** — the two
contradicting SSOTs are one row shape; `CLI_CORE_SETTING_PATHS` and the
overloaded `hosts:` field are both gone, and the specific rows this entry
flagged are now consistent. **V4 confirmed ruled + landed** (#10699/#10739),
exactly as the entry describes, desktop fence included. **V8 LANDED #10694**
with two corrections: only one explicit-cascade kill site survives (#10800
removed the second), and `detachSubagentsOnStop`'s own JSDoc still asserts an
unqualified "shared by every host" without the quit-asymmetry paragraph the
lifecycle doc owed it. **V9/DR13 substantially resolved** — see below. **V12
PARTIAL**, and this entry was stale when written: `'never'` was already a
named shared constant at the reproduction pin; what is still true is that the
settings catalog records only the `'ask'` prefault, so the fence exists in code
and not in the catalog. **V7 LANDED #10997** — 4 signals wired on desktop
(tool availability, GitHub subscriptions, invalid-token notice, workspace-file
writes), 2 fenced extension-only (`languageModelsChanged`,
`approvalPolicyChanged`), 6/6 annotated with per-host consumption at the
declaration; CLI fenced on all six. Two of the entry's claims were refuted at
landing: the declaration list was down to **6** signals, not 13
(`includedModelAccessChanged`, the six subscription signals, and
`extensionDeactivating` (#10924) were already gone), and the
`refreshModelListStateIfNeeded` "no production caller on any host" escalation
was false (two live callers, extension + CLI — the gap was desktop-only
bootstrap, V2's row). Everything else — V1, V2, V5, V6, V10, V11 — is
**still true at HEAD**, three of them with the harm restated below.

**V2 is worse than written.** `UsageLogService` has zero references in
`packages/desktop` — not just no `initialize`, but no `dispose()` either — and
the relay retirement removed the mitigation this entry relied on: `UsageMonitor`
no longer force-flushes per relay round, so on desktop any queue under ten
entries is now silently dropped at quit, including plan accounting.
~~`refreshModelListStateIfNeeded` is a stronger finding than the entry claims:
it has **no production caller on any host**.~~ **REFUTED 2026-08-19** — two
live production callers (`extension.ts`, CLI `initPlatform.ts`); the gap was
desktop-only, as the entry originally said, and is now closed.

**V5's harm changed, and the entry's framing with it.** The 120 s stale horizon
this entry cites is gone — #10778 replaced heartbeat liveness with
socket-presence proof (`executionLease.ts` version 2, verdicts
`alive | dead | unprovable`), so quitting mid-run no longer blocks `texra
resume` for two minutes. What survives is the real residue: no host except the
CLI persists a terminal outcome at exit, and an `unprovable` verdict still
fails closed. **RESOLVED 2026-08-19** — the lifecycle doc's §3 fix 2 landed as
`settleLiveSessionExecutions`, registered as each host's first ON-phase
shutdown handler: every still-owned execution gets `CANCELLED` with its flow
record preserved and its lease released, bounded by the phase deadline. The
CLI-UI copy is deleted. The `unprovable` fail-closed verdict is unchanged and
deliberate.

**V9/DR13 — REFUTED as written; one owner exists.** The entry's "two truth
sources" framing does not hold at HEAD. `deriveResumability`
(`src/agent/storage/resumability.ts:95`) is the single durable-state authority,
reached by `SessionHandle`, `ToolUseFollowUp`, `restartRepair`,
`SessionResumeRetrieval`, `ExecutionsTool`, and three CLI call sites. What
#10927 added (with #10940's follow-ups) is **not** a second derivation but a
display-side wrapper, `deriveOfferableResumability`, which gates the shared
decision on execution-lease liveness and fails closed loudly on an
unclassifiable lease — because a run executing _right now_ has exactly the
resumable durable shape, so every listing was advertising live work as
resumable. **Admission semantics are deliberately unchanged**: `texra resume`
and the in-process resume paths still call `deriveResumability` directly, and
the rationale is written at the function's declaration. Both display surfaces
are gated — the CLI listing (`toolUseResumeData.ts:56`) and the GUI WAITING
badges (`detectWaitingStreams.ts:26`). The CLI's extra strictness — a stamped
`meta.streamId` and a successful resume-state read — is a deliberate strict
superset of _requirements_ over the one owner, not a rival derivation:
deleting it would have `/resume` offer rows it then refuses. Two honest
residues: a run with a valid flow record but no stamped `streamId` still shows
WAITING in the GUI and non-resumable in the CLI, and the lease-gating behavior
is **thinly pinned** — no test names `deriveOfferableResumability`, and
`History.vitest.ts` mocks `readCliResumeDataForListing` wholesale.

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
- **V2. Desktop telemetry is partially initialized.** **LANDED 2026-08-19** —
  both calls now sit in `initializeElectronPlatform`, in the CLI's ordering.
  _(Narrowed twice on review/verification — "dead" overstated it.)_ The catalog row declares
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
  (advertised-toggle-no-ops); both are plain wiring fixes. This paragraph — the
  desktop-only framing — is the one that held up; the later escalation to
  "no production caller on any host" did not.
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
  must not copy it. The rejected shared-default admission port would wrongly
  centralize host-owned cancellation; the optional port instead documents the
  monotone contract while each host retains its own lifecycle authority.
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
  react, fence it at the signal declaration. **LANDED #10997 (2026-08-19)** —
  every declared signal now has one recorded answer at its declaration in
  `AppSignals.ts`: 4 wired on desktop (the tools dashboard, the Git tab
  subscription list, a previously nonexistent invalid-token notice, and the
  files tree after a run writes into the workspace), 2 fenced extension-only
  (`languageModelsChanged` by construction, `approvalPolicyChanged` as a
  duplicate repaint), 6/6 annotated; the CLI is fenced on all six with
  per-signal reasons. Two of this entry's premises were **refuted at
  landing**: the declaration list was down to **6** signals, not 13 —
  `includedModelAccessChanged`, the six subscription signals, and
  `extensionDeactivating` (#10924) were already gone — and the
  `refreshModelListStateIfNeeded` "no production caller on any host"
  escalation was false (two live callers, `extension.ts` and CLI
  `initPlatform.ts`); the real gap was desktop-only bootstrap, tracked under
  V2 (contracts doc §7.4 row 5).
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

**Register status at `e00b9317f7` (2026-08-19): 2 landed, 1 partial, 8 open —
and the editorial ruling has been granted.** The maintainer's 2026-08-19
directive — _"the TUI should render the same state extension/desktop have"_ —
is the answer this section said was undeclared, and it settles the register in
favour of parity. The shared `src/shared/transcript/` row model executing it is
in flight on `track/transcript-parity`; rows (b), (d), (e), (g), (h) and (j)
are its scope. **(a) LANDED** (#10693, then the Wave A collapse:
`childExecutions.ts` 585 → 241 L, the duplicated cap gone, the shared roster
the sole owner). **(i) LANDED #10713** — and by the route this row prescribed:
a declared shared policy, `normalizeToolUseForRender`, keeping the row live
with a bounded diagnostic, called by both hosts, so the CLI's parity comment is
now true. **(k) PARTIAL #10704** — the code landed by a better mechanism than
prescribed (a container/fence-aware markdown-it block probe mirroring texmath's
`beg_end`, plus adjacency guards that fix the inverse false positive), but the
`\begin…\end` test this row named as "the missing piece" is **still missing**,
now guarding considerably more machinery. **(e) may be worse**: routing the CLI
through the shared normalizer means a feedback row with no summary now renders
blank rather than merely omitting the instruction. **(b)** shrank to 10 webview
fields, not 11 — relay labeling went with the relay plane.

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

Re-checked at this HEAD during the sweep, and again on 2026-08-19 — the
changes since: **DR13's resumability facet is closed** (one owner plus a
display-side lease gate; see V9 above), so the row below is stale in that half;
its history-projection half stands. **CP2's stream-stop half stayed ruled**,
and the CLI-setter half is now the settings-catalog's business (#10925 gave
every row a `slots` map, so "the CLI reports these as unknown keys" needs
re-checking against the new catalog before it is re-filed). **CP4/CP5** are
unchanged. DR2, DR3, DR6 and DR8 are all still open exactly as written.

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

1. **Plain bugs, no ruling** — V2 **LANDED 2026-08-19** (desktop
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

**Execution status at `e00b9317f7` (2026-08-19).** Step 1's plain bugs mostly
landed (V2 is the exception, and it got worse); §4i and §4k's code shipped;
V1a's "missing host argument" was corrected away on review rather than fixed,
since no host argument was missing. Step 2 landed C2+C3+C11+C21 as the single
resume-hardening PR this step proposed (#10699) and closed V4a/d with it, but
C1 is withdrawn, C4 never started, C10 landed only its bug half, C14 landed by
self-registration instead, and C12 is untouched. **Step 3 did not happen** —
C5, C6, C7, C8, C15 and C9 are all open, which makes the composition-root plane
the single largest untouched block in this doc. Step 4's rulings: the
CLI-transcript parity charter was **granted** (2026-08-19) and is executing;
V3 was settled by the catalog collapse; V9/DR13 resolved to one owner plus a
display-side gate. Still awaiting a ruling: settings-store unification (V1),
lease-at-quit (V5, whose design the lifecycle doc owns), `enforceCategory`
(V6), AppSignals wiring scope (V7), and the callback-binding bar (V11b).
**Updated 2026-08-19 (#10991, #10997):** step 2's C4 landed (closing V10)
and step 3's core landed — C5, C7, C8 and C15 in one composition-root PR,
with C6 struck as refuted; C9, C13, C17, C18, C20 and C22 remain open on
that plane. Step 4's V7 is also off the ruling list: the AppSignals wiring
landed as #10997 (4 signals wired on desktop, 2 fenced extension-only, the
CLI fenced on all six).

Everything here was found by scoped sweeps, not adjudicated line-by-line the
way the 2026-07-09 audit was; treat each row as _verified-at-citation_ but
re-open sites before acting — the verifier-wrong-on-specifics rate in past
campaigns was nonzero, and eight campaign PRs are landing around these files.
