---
created: 2026-08-03
updated: 2026-08-03
---

# SSOT consolidation plan: projections, normalization, derived data, one host language

**Status:** Draft plan (v2 — grounded in seven parallel codebase audits, 2026-08-03)
**Branch:** `claude/texra-9597-design-review-5tyyls`
**Companion docs:**
[`2026-07-09-state-of-the-architecture.md`](./2026-07-09-state-of-the-architecture.md) (D1–D8, M/C/IF/FB items),
[`2026-08-01-architecture-rulings-ledger.md`](./2026-08-01-architecture-rulings-ledger.md) (closed questions),
[`2026-07-09-tech-debt-design-philosophy.md`](./2026-07-09-tech-debt-design-philosophy.md) (PT/SHALLOW/DI rulings),
[`2026-06-10-error-pipeline-and-ownership.md`](./2026-06-10-error-pipeline-and-ownership.md) (catch budget, rejected findings),
[`2026-06-10-lifecycle-status-ownership.md`](./2026-06-10-lifecycle-status-ownership.md) (trait-table rule),
[`../prds/2026-08-03-prd-approval-policy-unification.md`](../prds/2026-08-03-prd-approval-policy-unification.md) (approval policy; Stage references below)

## 0. Charter and method

Seven audits (three over the run-fact projection rails runtime→extension/
desktop/CLI, one over entry-point normalization, one over derived-data
recomputation, one over standing rulings, one over cross-host duplication
above the presentation layer) produced a consolidated inventory of: duplicate
channels for one fact, mid-layer format normalization, independent re-folds of
the same event stream, pass-through hops, and host-restated orchestration
sequences. This plan turns that inventory into ordered, bounded workstreams,
and §10 is the adversarial pass: how each change can go wrong and the clean
fix.

The goal stated plainly: **CLI, desktop, and extension speak one language.**
Vocabulary (schemas, facts, copy) is defined once in `src/`; orchestration
sequences ("after mutation X, repost Y and Z"; "probe, submit, emit, present")
are defined once in `src/controllers` or the owning domain; hosts contribute
presentation verbs and transports only. Where a standing ruling says a
per-host surface is the deliberate resting state (interaction registries,
per-host reducers), this plan does not fight it — the finding of the cross-host
audit is that the duplication worth removing sits *above* those sanctioned
seams, in the sequence layer.

Rules of accounting (salvaged from the retired gold-standard PRD, still good):

- **A relocation is never counted as a reduction.** Moved code goes in a
  "relocated" column, not a deletion count.
- **Every claimed deletion names the file/symbol that ceases to exist.**
- **Anti-mixed-state:** each item ships as one atomic PR — new path and legacy
  removal in the same commit; never both paths alive across PRs
  (per the 2026-02-20 PRD's binding style ruling).
- Every PR: `npm run typecheck` (builds do not type check), `npm test` for
  touched kernels, `npm run lint`, `npm run check:dead-code-ratchet`.

### 0.1 Hard constraints (closed questions — do not re-litigate)

From the rulings ledger and companion docs; a PR that violates one of these is
wrong even if it "simplifies":

1. No new bus, plane, event vocabulary, coordinator layer, or
   fact-router/auto-forwarding hub. Hosts ignoring facts is a feature; the
   explicit ignore arm stays.
2. No unifying the status enums or cycle-outcome unions — one *source* with
   projections, not one enum. Rail C (`onDidChange`) stays beside the fact rail.
3. The trace `'status'` arm **stays** (#9127 gave it a persistence consumer);
   do not cite the stale contrary line at state-of-the-architecture `:1112-1113`.
4. No facade over `SessionHandle`, no `runSession()`, no `RunScope`, no deep
   session injection, no deleting `defaultSession()`.
5. No single-caller extractions. No repo-wide `noImplicitReturns` flip; no
   forced full enumeration on `AgentEvent` switches.
6. Frozen wire stays frozen: CLI NDJSON names (deletions ride the D3
   deprecation clock, 0.40 deprecate / 0.41 delete), progress-view IPC
   literals, persisted `result.outcome`, `'approveSuperYolo'`,
   `'updateSuperYoloBypassState'`.
7. `SessionHostInteractions`' 9 one-line forwards are load-bearing
   (SHALLOW-2: defer); `requestToolEditApproval`'s optionality is load-bearing
   dispatch (IF-1) — do not make it required.
8. The snapshot+targeted dual path in the progress view is the intended end
   state; the transcript rail stays separate from the fact rail (trap #7).
   Per-host interaction registries are the deliberate resting state (HOST-2);
   the CLI `StreamSlice` vs extension slice fragmentation stays (no shared
   reducer, no merged host implementations).
9. Per-request `getConfig` reads in `src/tools/approval/*` are **correct**
   (in-memory map lookup; live mid-run toggles). Do not cache them.
10. The Zod `.catch()` budget: never on persisted/authoritative data; the
    sanctioned exceptions are display-only view state.
11. No `BootstrapConfig` parameter object threaded through hosts. Composition
    folds take the `nodeHost.ts` shape: additional *named helpers called in
    order by each composition root*.

## 1. Workstream A — normalize at the entry point (schemas)

The repo's rule: one `z.union().transform()` at deserialization; downstream
never branches on format. The audit found the rule mostly honored, with these
violations. All items here are host-independent and unblock nothing/depend on
nothing — they can land first and in any order.

### A1. `GROUP_END`/`GROUP_START` status: four normalizers → one

`StreamLogStore.ts:184-186` claims to be "The ONE app-side read boundary" for
legacy `data.status` wire values. It is one of four:

| # | Site | Today |
| --- | --- | --- |
| 1 | `src/transcript/StreamLogStore.ts:204-224` (applied `:1448`) | the claimed boundary |
| 2 | `src/shared/streams/taskGroupProjection.ts:27-36` | hand-rolled duplicate mapping at a consumer |
| 3 | `packages/trace-viewer/src/replayTrace.ts:105-133` | re-derivation + two extra fallbacks |
| 4 | `packages/cli/src/chat/tui/state/subscribeStreamLog.ts:309-329` | tolerant re-parse, comment admits duplication |

**Fix:** move the mapping into `GroupLogPayloadSchema`
(`src/shared/schemas/taskGroup.ts:56-66`) as a **read-side** `.transform()`,
so every parser of the payload inherits it (see §10.5 for the write-path
hazard). **Delete:** `taskGroupEndStatus`'s legacy branch
(`taskGroupProjection.ts:27-36`); the equivalent mapping inside
`StreamLogStore.ts:204-224`; the legacy fallback arm in `replayTrace.ts`.
Sites #3/#4 keep their parse call but lose their private mapping.
**Result:** the `StreamLogStore` comment becomes true. Keep #3's structural
heuristic for pre-`data.kind` traces — that is archaeology, not normalization.

### A2. `roundStage`/`phaseStage`: null↔undefined transform on the schema

Today: `undefined → null` at the producer (`ProgressFactApplier.ts:702-703`),
hand-unwrapped at two consumers (`streamStateMerge.ts:14-19`,
`syncSlice.ts:21-22`), while a third consumer (`streamMetaSlice.ts:149-155`)
rides a different message schema with a fourth nullability contract.

**Fix:** `.transform(v => v ?? undefined)` on `StreamMetadataSchema`'s two
stage fields (`streamState.ts:141-142`) and on `activeState`
(`outbound.ts:299-300`). The wire keeps `null` (explicit clear semantics);
consumers receive `undefined` uniformly. Transforms live on the inbound/parse
side only (§10.5). **Delete:** `metadataToStreamStatePartial`
(`streamStateMerge.ts:9-21`) and the `activeStateFields` unwraps
(`syncSlice.ts:19-25`).

### A3. `parentStreamId`: one nullability spelling

Three schema spellings (`.nullish()` / `.nullable()` / `.optional()`), a
tri-state consumer branch (`childExecutions.ts:173-181` branches on
`undefined` vs `null` vs value), and a `...(x !== undefined && { x })` idiom
copy-pasted in three hosts.

**Fix:** `.nullish()` at the wire with a `.transform()` to `undefined`; the
"explicit clear" case, if needed, becomes a dedicated flag rather than a
tri-state. **Delete:** the tri-state branch; `stateUtils.ts:106`; the duplicate
spread idioms converge only where a shared helper would have ≥2 callers
(single-caller-extraction ban).

### A4. `TokenUsageStats` legacy transform: two copies → one

The `viaChatGptSubscription → usageRoute` migration is written byte-identically
in `usage.ts:47-54` and `streamData.ts:100-106`, with an
`as z.ZodType<TokenUsageStats>` cast suppressing the error that would catch
divergence.

**Fix:** one exported transform function; both schemas `.transform(sameFn)`.
**Delete:** the second copy and the cast.

### A5. External-inquiry `.nullish()` unwraps: four sites → schema transform

`context`/`suggestSearch`/`attachFiles` are `.nullish()` per the tool-schema
rule, then `?? undefined`-unwrapped at four sites
(`ExternalInquiryTool.ts:406-408, 438-440`,
`ExternalInquiryRequestHandler.ts:82-84`, `externalInquiryStorage.ts:621-625`),
with two near-identical `basePermission` constructors.

**Fix:** `.transform(v => v ?? undefined)` on
`CommonExternalInquiryFieldsSchema` (the wire still accepts null — the rule is
about API input, not internal shape). **Delete:** the four unwraps; converge
the two permission constructors on one (two callers — allowed).

### A6. CLI config: one parse, one table, no `.catch`

`cliConfig.ts` validates every field twice through two hand-synced schema
tables (`:100-110` vs `:154-181`) because the extraction path uses
`.catch(undefined)` (`:184`) and therefore can't report issues.
`loadWorkspaceCliConfig` re-reads `.texra/config.json` from disk three times
per process (`cliContext.ts:390`, `chatDefaults.ts:78`, `agentRoster.ts:37`)
with no cache, alongside the platform's own `JsonStore` read.

**Fix:** one `z.object` + `safeParse` producing values *and* warnings in one
pass; memoize `loadWorkspaceCliConfig` per `cwd` **with an mtime check or
workspace-file-write invalidation** — not a blind process-lifetime memo
(§10.14). **Delete:** `collectValidationWarnings`' parallel table, the
per-field `.catch(undefined)`, the two duplicate `readFile` paths.

### A7. Agent YAML: parse once, one inheritance walk

Every YAML is read+parsed twice (`agentYamlScanner.ts:108-109` then
`agentLoad.ts:152-153`), the scanner casts its own parse result back to
`Record<string, unknown>` and re-derives fields via `as` casts
(`:150-152, 201-210`), and the `inherits` cycle walk is implemented twice,
kept in sync by comment (`agentLoad.ts:141-142`).

**Fix:** the load path reuses the scanner's parsed definition (or both call one
resolver); the scanner keeps its types. **Delete:** the second `readFile`+parse,
the untyped re-extraction, one of the two `inherits` walks.

### A8. Loud degradation on persisted work plans

`PersistedWorkPlanSchema` (`streamSnapshot.ts:71-73`) `.catch`es `todos`/`plan`
to empty — durable user state silently reading as empty, the guardrail's exact
named defect. **Fix:** per-field `safeParse` with a `warn` on the degradation
path, non-fatal per-field isolation (pattern: `parseUsageData`,
`streamData.ts:140-175`, the repo's best persisted read — see §10.13). Same
treatment for `UsageMonitor.ts:278`'s `.catch('unknown')` on accounting data
and `history.ts:132`. Display-only catches (taskGroup rows, `LogList`) stay —
sanctioned.

## 2. Workstream B — one usage-accounting fact

Nine accumulators fold the same `usage` events with four field-set rules; three
incompatible "is empty" predicates; and `inputTokens` means *total input* in
every UI but *cache-miss input* on the telemetry wire (`UsageMonitor.ts:289`,
undocumented at `UsageLogTypes.ts:18`).

**Decision to take first (owner call): the canonical field set.** Recommended:
`sumUsageStats`' six fields + `reasoningTokens` (what the CLI already bolts on)
+ the `usageRoute` consensus rule. One fold, one `isEmptyUsage`. Surfaces then
*select columns* from the canonical totals — display narrowing is a projection,
silent field-dropping in a private fold is not (§10.12).

| Item | Add | Delete |
| --- | --- | --- |
| B1. Canonical fold | widen `sumUsageStats` (`usage.ts:84-112`) to the decided set | `sumResumeUsageStats` bolt-on (`resumeHint.ts:82-92`) |
| B2. One empty-predicate | — | `usageHasTokens` (`resumeHint.ts:71-80`), `UsagePanel.hasUsage` (`UsagePanel.ts:189-198`), the inline check at `extension.ts:644` — all become `isEmptyUsage` |
| B3. Status bar consumes folded totals | subscribe the tracker to the snapshot-store fold it currently re-implements | `StatusBarUsageTracker.ts:52-63,74-82` hand-`+=` (3-field, drops route/cache — silent under-report) |
| B4. Webview stops re-folding per render | ship the folded total in the payload it already receives | `sumUsageStats(Object.values(runUsage))` at `ToolUseStreamContent.ts:76`, `WorkflowStreamContent.ts:63` |
| B5. Honest telemetry field | rename at the schema or document the divergence at `UsageLogTypes.ts:18` — the wire is external; renaming needs backend agreement | the ambiguity, not the field |

Not in scope: `RunUsageAccumulator`'s in-run accumulator (different layer, its
own documented legacy union — correct as is); the snapshot store's
overlay-replay design stays — fold its two copies of the sum
(`StreamSnapshotStore.ts:219-230/696-705`) into one function *without*
touching the overlay machinery.

## 3. Workstream C — projection rails (executes standing rulings + new finds)

Ordered so already-ruled items go first (pre-authorized), then new decisions.

### C1. D4 status rail — pre-authorized, one atomic PR

Per the standing D4 ruling (state-of-the-architecture `:265-330`, amended
2026-07-25): delete the three consumer trace-arms
(`ProgressFactApplier.ts:124-130`, `sessionProgressSubscription.ts:76-87`,
`runProgressRenderer.ts:197-199`) **and** the emitter guard in
`StreamStatusService.publishStatus` in the same PR, so the session fact is the
sole cross-process channel. Trace arm stays (persistence consumer, #9127).
Rail C stays. Headless NDJSON byte-parity is the acceptance test (§10.1).

### C2. Live bug: desktop `removeStream` no-op — pre-authorized (A1 in runtime-ui audit)

Shared applier becomes the single owner via a host deletion callback threaded
through the existing `createProgressBackendUiConfig`. No new port, no per-host
subscriber.

### C3. Dead legacy tool-edit approval fallback — pre-authorized (A2, −300..−450 LoC)

The triple-wired legacy channel is dead; delete end-to-end. IF-1 constraint:
`requestToolEditApproval` stays optional (its `undefined` is the dispatch
signal); the deletion is of the *legacy target*, not the dispatch.

### C4. `useHostInteractions` pass-through — pre-authorized (PT-2)

Delete `SessionHandle.useHostInteractions` (`SessionHandle.ts:661-663`);
retarget 13 callers to `session.interactions.use(...)`. Do **not** add
per-concern forwarders elsewhere (the recorded trap).

### C5. Approval-bypass state becomes a `SessionFact` — decision needed

Today one source (`streamApprovalQueue.ts:66`) fans out over a bespoke port
push (`setApprovalBypassState`, `HostInteractions.ts:532-534`) **and** a pull
path (`progressStreamControls` → sync `controls`), landing twice in the same
frontend fields; the CLI adds a third naming layer
(`ApprovalBypassNdjsonEvent`, `cliPresentationHost.ts:41-45`) outside the
governed NDJSON vocabulary.

This adds an arm to the **existing** `SessionFact` union (allowed; a new
vocabulary would not be). Emitted NDJSON names stay byte-identical — the
projection in `sessionProgressSubscription.ts` takes over emitting them.
Late-join state keeps flowing through the sync `controls` pull path, which
already exists and is authoritative (§10.2).

**Delete:** `SessionHostInteractions.setApprovalBypassState` + attachment
plumbing; `ApprovalBypassNdjsonEvent` + `emitApprovalBypassState`
(`cliPresentationHost.ts:41-45,148-157`); one of the two frontend bypass write
paths (one writer total); the TUI port fan-out
(`subscribeApprovals.ts:181-184`). **Prerequisite:** C9.

### C6. TUI artifact double path — one owner

Artifacts (`addOutputFiles`/`updateMissingOutputs`/`updateCompileFailures`)
are folded live into `cliState` (`subscribeRuntimeHost.ts:169-189`) *and*
re-read from `StreamSnapshotStore` on focus (`subscribeStreamArtifacts.ts:47-75`),
with a revision counter arbitrating disagreements.

**Fix:** snapshot store is the owner (matches the extension applier's
re-read-on-ping pattern); the live fold becomes an invalidation ping.
**Delete:** the live accumulator arms, the merge, `StreamArtifactRevision` /
`recordMissingOutputsReset` (`cliState.ts:326-346`).
**Prerequisite:** E1 (the subscriber-order invariant test, §10.3).

### C7. Pass-through and duplicate-hop deletions (mechanical batch)

| Item | Delete | Notes |
| --- | --- | --- |
| Desktop double Zod parse | the classification `safeParse` at `renderer/main.ts:462-467` | route on `dispatchMessage`'s existing unrecognized-command result; hot path (60fps `LOG_DELTA`) |
| Redundant re-checks | scope re-checks (`ProgressBackend.ts:421,427`), duplicate `hasTarget` (`:113`) | filter already guarantees both |
| `run.start`/`run.config` twin handlers | one of the two verbatim bodies (`ProgressFactApplier.ts:126-137`) | |
| Single-file payload round-trips | `UpdatePhaseStagePayload` (zero external consumers), the pack/unpack for round-stage + conversation-progress | pass plain args; `UpdateRoundStagePayload` survives only while the frozen NDJSON projection needs its type |
| `runFactSubscriptions.ts:9-21` | the 12-line field-by-field payload reconstruction | subscribe to the payload directly |
| Reveal-stream triplication | the two copies in `toolEditApproval.ts:117-131`, `ExternalInquiryTool.ts:421-432` | call `revealStream` (`progressHostInteractions.ts:89-104`) |
| Inbound forward chains | `ProgressViewHost`'s file-command re-forward (`ProgressViewHost.ts:119-140`); the 12 one-line arms delegate to controller methods directly | PT-1 scope only: `module:` fields + never-read `interactionHandler` also deletable; do **not** fold `handleInteractionEvent` (real guard) |
| `CliRuntimeHost` dissolution | the 4-member interface (`cliPresentationHost.ts`); no caller uses >2 members | split: presentation-event sink; renderer attaches directly at `runExecution.ts:193`. Shrinks further after C5 |
| Fake-incremental messages | `UPDATE_FILES`/`UPDATE_MISSING_OUTPUTS`/`UPDATE_COMPILE_FAILURES` (3 schemas + 3 updater methods + 3 handlers) fold into the sync path they duplicate (`ProgressFactApplier.ts:291-319` ship full snapshots today) | internal webview wire ships atomically with the app — free to change; the **public NDJSON keys are frozen** and keep emitting from the projection (§10.1) |
| Child roster derived fields | `ActiveChildInfo.status` + pre-formatted `elapsed`; `recordChildPhase` (`ProgressViewState.ts:504-528`); the roster regression guard (`:552-566`) | ship `childStreamId` + `startedAt`; renderers join (pattern: `BackgroundTasksPanel.ts:399-403`) and tick live (pattern: `ToolTimer`) |
| `replayTrace` hand-copies | the all-false controls literal (`replayTrace.ts:214-219`) → shared default; the hand-built `SyncStreamContentPayload` (`:195-220`) and `StreamTabInfo` (`:145-160`) → shared **pure** builder cores | the pure cores must be extracted to `src/shared/streams` first — trace-viewer must not import `src/controllers` (§10.7) |

### C8. Frontend compensation → fix at source

- Emit the stream description **with** registration; delete the
  `pendingDescriptions` race buffer and its three drain/cleanup sites
  (`streamMetaSlice.ts:26-34,59`, `streamLifecycleSlice.ts:78,89-94`).
- Backend already sorts and already resolves the active tab: delete the
  frontend re-sort (`streamMetaSlice.ts:36-48`) and `resolveActiveStreamId`
  (`streamLifecycleSlice.ts:121-128`) **only in the same PR that makes the
  wire ordering/active authoritative** (§10.4).
- The proposal SHOW-after-RESOLVE dedup (`permissionSlice.ts:140-150`) guards a
  transport that shows cards twice by design — fix the transport's ordering or
  explicitly sanction the guard with a comment; don't leave it ambient.

### C9. Loud fact switches (FB-2, +15-20 LoC)

Propagate the `never`-check into the four `SessionFact` consumer switches so an
added fact arm fails compilation everywhere it must be handled or explicitly
ignored. Enabling change for C5 and any future fact promotion. (Recorded trap:
no fact-router; the explicit ignore arm is the feature.)

## 4. Workstream D — derived display: one source, host projections

### D1. Phase appearance: trait columns, not parallel maps

Labels are already single-source (`formatStreamStatusLabel`). Appearance is
not: two CSS maps with different colors for `running`
(`statusIndicatorStyles.ts:14-43` vs `groupStyles.ts:22-38`), a third class
scheme with dead keys (`StreamTab.styles.ts:49-70` — `status-error`,
`status-initializing` unreachable), a private icon switch
(`TaskGroupList.ts:73-85`), and two CLI tables with a deliberate divergence
documented only in a distant comment (`SubagentListDisplay.ts:20-39`).

**Fix:** per the lifecycle doc's standing rule ("never declare a status list by
hand — add a trait column"): add appearance columns (indicator class, icon,
CLI color) to `STREAM_STATUS_TRAITS`. Hosts read columns; the CLI's deliberate
divergence becomes a *named column*, not a distant table.
**Delete:** the `groupStyles` divergent map, the dead `status-*` keys and the
third scheme, the private icon switch, `childStatusColor` /
`TASK_GROUP_APPEARANCE` as free-standing tables.

### D2. Session activity: one predicate

Three derivations, two rules, drift currently invisible
(`terminalTitle.ts:47-62`, `desktopWindowTitle.ts:24-34`,
`extension.ts:662-680` — which also hand-rolls its labels). **Fix:** one shared
`deriveSessionActivity(statusMap, pendingCount)` beside `formatSessionTitle`;
all three hosts consume it; the extension status bar formats from the shared
result. Desktop's "deliberately exact `RUNNING`" comment is an owner question,
not something to erase silently (§10.11). **Delete:** the three private
predicates and the literal `"TeXRA: Running"`/`"Idle"` strings.

### D3. Stream display names: one builder

`buildStreamTabInfo` is canonical for extension+desktop; the CLI has a parallel
label stack (`streamViews.ts:105-133` → `childExecutionLabel`) and the
trace-viewer hand-builds the record (C7). The desktop palette adds a fifth
fallback chain (`desktopCommandPalette.ts:374-386`).

**Fix:** extract the *pure* label core of `buildStreamTabInfo` (name cleaning,
workflow decoration, model label — no worktree probe) into `src/shared/streams`
and have the CLI stack, palette, and trace-viewer consume it. Relocation + two
deletions, not a new layer: **delete** `childExecutionLabel`'s independent rule
and the palette's private chain.

### D4. Durations: one family, no emission-time formatting

The same child's elapsed flips formatter at run end (`formatDuration` frozen
at emission, `executionRegistry.ts:366`, vs `formatCompactDuration` live,
`childControls.ts:24-34`); the same live/terminal split is re-implemented at
`SubagentList.tsx:331-364`.

**Fix:** C7 already deletes `ActiveChildInfo.elapsed`; extend the rule —
duration fields on events carry **milliseconds or a start timestamp, never a
pre-formatted string**. Converge on the two shared formatters; **delete** the
private `formatElapsed` (`runProgressRenderer.ts:424-430`) by giving
`formatCompactDuration` the no-hour-rollover style it needs, and the second
live/terminal switch in `SubagentList`.

### D5. File display paths: one rule set, honest field names

Four `FileLocation`→string functions with three different `external`-file
rules; `output.ts:182-186` is a byte-identical private re-implementation of
`getComparablePath`; `OutputFileSummary.relativePath` (`output.ts:192`) can
hold an **absolute** path, which `workflowOutput.ts:152-154` papers over.

**Fix:** `fileLocation.ts` exports the one comparable-path and one
short-display rule; **delete** the private `displayPath` duplicate and the CLI
compensation. The dishonest field: if persisted/wire, document the misnomer at
the schema and normalize at its entry point; if internal, rename. Host
`relativeDisplayPath` implementations stay host-specific (presentation), but
both get the same out-of-workspace rule stated at the port
(`ToolEditApprovalController.ts:76`).

### D6. Registry bypasses

- `statusBarDisplay.ts:173-184` uses the runtime model registry on one branch
  and raw `MODEL_CONFIGS` on the other; `cliConfig.ts:46,51,62` reads raw too.
  **Fix:** CLI reads `getRuntimeModelConfig` everywhere a user-visible value is
  derived. **Delete:** the raw-import branch.
- `texra agents list` (`agents.ts:298-308`) bypasses
  `computeAgentOptionsData` — different order and no derived badges vs the
  `/agent` picker. **Fix:** consume `entriesToOptionData` + `sortAgentEntries`.
- The `?? AgentCategory.Workflow` default appears four times in
  `ProgressFactApplier` alone — state it once at the state boundary.

### D7. Follow-up readers

The invalidate-and-re-read design is correct; two wrinkles: `/status` reads
the live queue while the rest of the TUI reads the slice mirror
(`sessionCommands.ts:91-94` vs `StatusBar.tsx:205`) — pick the mirror; the
extension writes the same list via two paths per sync
(`ProgressFactApplier.ts:357` + `:679`) — drop the targeted push inside the
full-sync call path. (Superseded in part by F1, which owns the emit.)

## 5. Workstream F — one language across hosts

The cross-host audit's headline: the *seam layer* is genuinely shared
(`resolveAndResumeStream`, `prepareMainViewExecutionLaunch`,
`createProgressViewCommandHandlers`, `SettingsAgentControllerFactory`,
`nodeHost.ts`, `HistoryActionOutcomes`); what is restated per host is the
**sequence layer directly above those seams**, and three of those restatements
have already produced silent behavioral divergence. The CLI `/config` panel is
the reference shape: it consumes the `stateSettings.ts` catalog through
`readSetting`/`writeSetting` with zero parallel definitions — the webview hosts
should be pulled toward it.

### F1. Follow-up submission: one owner (live correctness bug)

`SessionHandle.repairWaitingIfResumable` documents itself as "all three hosts
share one repair" — **only the extension calls it**
(`followUpCommand.ts:66`). On desktop and CLI, a follow-up to a stream whose
phase settled terminal while its flow record stayed resumable routes to
`no_session` — exactly the bug the method exists to prevent.

**Fix:** fold probe → submit → `updateQueuedFollowUps` emit →
`presentFollowUpResult` mapping into the owning domain
(`src/agent/followUp/`): `submitHostFollowUp(streamId, item, {session,
present})`, or move the probe inside `submitFollowUp` itself.
**Delete:** ext `followUpCommand.ts:14-53` (~40 L), desktop
`desktopAgentExecution.ts:1239-1272` (~34 L), CLI `runChatTui.tsx:717-768`
(~50 L) — each collapses to its presentation verb. Ship labeled as a behavior
fix for desktop/CLI, with a regression test (§10.9).

### F2. Settings credential/profile sequences: one actions module

The 14-port controller construction is duplicated ~40 lines
(`SettingsViewMessageHandler.ts:162-196` vs
`desktopCredentialSettingsController.ts:129-170`); streaming/endpoint writes,
`refreshAfterKeyChange`, ChatGPT sign-in/out (byte-identical warning strings),
and the api-access-mode switch are restated 2-3×. `setCliApiMode`
(`apiAccessMode.ts:53-71`) is a **verbatim clone** of
`SettingsProfileController.setApiAccessMode`, comment string included.

**Fix:** `SettingsCredentialActions` in `src/controllers/settingsView/backend/`
(the pattern `SettingsAgentActions.ts` already establishes); a free
`applyApiAccessMode(deps)` consumed by the controller and the CLI.
**Delete:** ~140 L extension, ~180 L desktop, 19 L CLI clone. Fold the CLI's
`looksLikePlaceholder` key rejection **into** the shared
`commitProviderKey` — today only the CLI rejects `sk-xxxxxx`; extension and
desktop persist it and fail later at call time.

### F3. Generic state-setting write + snapshot rebroadcast

Identical 5-step write sequence and identical 6-case snapshot dispatch table
in both webview hosts (`SettingsViewMessageHandler.ts:692-766` vs
`desktopSettingsIpc.ts:243-301`), with one divergence: the extension has a
workspace-folder guard the desktop lacks.

**Fix:** `applyStateSettingWrite(key, value, {stores, reportError,
postSnapshot})` + a snapshot→builder table beside the existing
`resolveStateSettingWrite`. The workspace-folder guard becomes shared policy.
**Delete:** ~75 L extension, ~59 L desktop.

### F4. History flows: one actions module, three hosts

Delete/clear/rerun/restore/export are restated in both webview hosts (~185 L
ext, ~155 L desktop, structurally identical export bodies) while the CLI has a
**third variant** that bypasses the shared outcome describers and
`resolveHistoryRunStatus` entirely (`runtime/history.ts:113-129, 489-513`).

**Fix:** `SettingsHistoryActions` (host injects `openPath`/`showInfo`/
`runExecution`/`restoreConfig`); CLI re-points at the shared describers.
**Delete:** the two host flow bodies and the CLI's private status resolver and
result shapes.

### F5. Bootstrap completion (two desktop behavior gaps + composition fold)

Verified divergences: desktop **never** calls `refreshModelListStateIfNeeded`
(the CLI's comment claiming otherwise is false — stale models persist) and
**never** initializes `UsageLogService` (desktop runs invisible to usage
accounting); git-author config applies only when the settings IPC constructs;
the extension bypasses `nodeHost.ts` entirely, inlining three of its helpers
for bundle-size reasons.

**Fix (three PRs, §10.10):**
1. Behavior: desktop gains the two missing calls (usage-log init gated on the
   telemetry setting — owner decision 6).
2. `initSharedHostStartupState({versionStateKey, currentVersion})` folds the
   `seedDisabledToolDefaults` + model-refresh pair so the gap cannot reopen.
3. Split the Lean-free helpers into `hostRuntime.ts` so the extension can
   consume them, deleting its inlined copies (`extension.ts:185-187, 268,
   276-281`) without the bundle regression that justified the inlining.
   All folds are named-helpers-called-in-order (constraint 11).

### F6. Session/store bring-up: one open sequence

`openOrEphemeral` + ephemeral warning + `waitUntilReady` + the `SessionStores`
literal (goal-forget closures, `onCanonicalStreamDeleted`) is written **three
times independently** (`extension.ts:257-267` + `ProgressViewState.ts:179-191`;
desktop `index.ts:1166-1204` + `desktopProcessStores.ts:14-26`; CLI
`transcriptSession.ts:43-66`), and two of three call `sweepOrphanedStreams`
while the extension path does not — an undocumented asymmetry to resolve
before unifying (§10.9, owner decision 8).

**Fix:** `openHostSession(...)` + `createSessionStores(session)` in the
runtime/storage layer. **Delete:** the three literals (~100 L total).

### F7. Agent-tab mutations and team presets

Visibility toggles, custom-dir set/reset, template creation, and the three
team-preset flows (identical result switches, identical `formatResultCount`
sentences) are restated ~230 L ext / ~200 L desktop.
**Fix:** extend `SettingsAgentActions.ts` (it already owns 4 of 13 actions).

### F8. Main-view options fan-out

The "agent + team + model options" repost triple is assembled 3×, and the
two-category `computeModelOptionsData` pair is written 4×.
**Fix:** `loadMainViewStartupOptions()` + `loadModelOptionsByCategory()` in
`src/controllers/mainView/`, used as `MainViewStartupController`'s default
`loadOptions`. **Delete:** ~45 L ext, ~70 L desktop.

### F9. Settings-infrastructure clones (batch)

Tool dashboard sequences ×2 + a CLI re-derivation that skips
`buildToolDashboardItems` (`runtime/tools.ts:54-80`); the
`LatexToolingController` port literal ×2; the executions-dir watcher ×2
(same debounce, near-identical comments). **Fix:** shared derivation +
`createNodeLatexToolingController(overrides)` + `watchExecutionsDir(onChange)`.
Also close the found gap: desktop hardcodes `getReliabilitySettings: () => []`
(`desktopSettingsIpc.ts:157`) leaving its Reliability panel **permanently
empty** although the config-backed controller is instantiated — wire it.

### F10. `texra init` joins the settings catalog

The wizard hand-declares literal keys and writes raw JSON
(`initConfig.ts:27-42, 70-76`), bypassing `settingsAccess` and the catalog —
a key rename in `stateSettings.ts` silently orphans every wizard-written
config. **Fix:** the wizard's steps derive from `CLI_STATE_SETTINGS` and write
through `writeSetting`. **Delete:** `InitConfigShape`'s parallel key list.
(Coordinates with the approval-policy PRD Stage C, which hoists the
`approvalPolicy` key — do the hoist once.)

### F11. Runners-up (fold opportunistically)

Resume recovery claim/release incantation + the duplicated "no resumable
session state" sentence (→ `resolveAndResumeStream` owns the claim;
`src/shared/copy` owns the sentence); the launch-result presentation ladder
(~18 L × 2); the non-VS-Code unavailable-tools base list (2 hand-maintained
copies); the file-picker dropdown/banner policy (~60 L × 2); the
`secondTierActions` retry-ports literal (~25 L × 2).

## 6. Workstream E — gates and doc truth

1. **Order-invariant test** for hub subscribers (prereq of C6).
2. **NDJSON parity fixture** — byte-comparison harness for headless output,
   run across C1/C5/C7 (the D4 ruling's acceptance criterion generalized).
3. **Normalizer retirement gates** (Style-2 vitest, per the approval-policy
   PRD's Stage E pattern): the `GROUP_END` mapping exists once (A1); the usage
   fold and empty-predicate exist once (B1/B2). Symbol-scoped, with the
   >100-files vacuity guard. Added **after** the corresponding deletions land.
4. **Extension bundle-size check** riding F5's `hostRuntime.ts` split (the
   inlining it deletes existed for bundle reasons; the gate proves the reason
   is gone).
5. **Doc corrections:** `cli-runtime-round-trips.md` missing the
   `StreamSnapshotStore` edge; `state-of-the-architecture.md:1112-1113` stale
   trace-arm sentence; `cliState.ts:41-44` false "mirrors the webview" comment;
   `repairWaitingIfResumable`'s "all three hosts" doc becomes true via F1;
   `initPlatform.ts:293-296`'s false "as the extension and desktop hosts do"
   comment dies with F5.

## 7. Ordering

```
A1–A8 (independent, land anytime)
B decision → B1..B5
C9 → C5          C1, C2, C3, C4 (pre-authorized, independent)
E1 → C6          C7, C8 (C7 replayTrace items after the D3 pure-core split)
D1–D7 (independent of C except D4 ⇢ C7's elapsed deletion)
F1, F5.1 (behavior fixes — early, standalone PRs)
F2–F4, F6–F11 (sequence folds — any order; F10 after approval-PRD Stage C hoist)
E2 rides C1/C5; E3 rides A1/B; E4 rides F5.3; E5 anytime
```

Approval-policy PRD Stages A–E proceed in parallel; shared files of
consequence: `cliPresentationHost.ts` (C5/C7), `SessionMeta.approvalPolicy`
(that PRD's Stage B), the settings-catalog hoist (F10 coordinates with its
Stage C).

## 8. Consolidated deletion ledger

Symbols that cease to exist (relocations excluded, per §0):

**Workstream A:** `taskGroupProjection.ts:27-36` legacy branch;
`StreamLogStore` private status map; `metadataToStreamStatePartial`;
`syncSlice` stage unwraps; `childExecutions` tri-state branch;
`stateUtils.ts:106`; duplicate `TokenUsageStats` transform + `as` cast; four
external-inquiry unwraps + one duplicate permission constructor;
`collectValidationWarnings` parallel table + config `.catch(undefined)` + two
duplicate config reads; second YAML parse + one `inherits` walk + scanner
re-extraction casts; three silent `.catch`es on persisted/accounting data
(replaced by loud reads).

**Workstream B:** `sumResumeUsageStats` bolt-on; `usageHasTokens`;
`UsagePanel.hasUsage`; `extension.ts:644` inline predicate;
`StatusBarUsageTracker` hand-sum; two webview render-time re-folds; one of the
two snapshot-store fold copies.

**Workstream C:** three status projector trace-arms + emitter guard (D4); the
legacy tool-edit approval channel (−300..−450); `useHostInteractions`;
`setApprovalBypassState` + `ApprovalBypassNdjsonEvent` +
`emitApprovalBypassState` + one frontend bypass write path; TUI live artifact
fold + `StreamArtifactRevision` machinery; desktop classification parse;
redundant scope/`hasTarget` re-checks; one `run.start`/`run.config` twin;
`UpdatePhaseStagePayload` (+ round-trip pack/unpacks);
`runFactSubscriptions.ts` reconstruction; two reveal-stream copies;
`ProgressViewHost` file re-forward + 12 one-line arms + inert `module:` fields
+ never-read `interactionHandler`; `CliRuntimeHost` as an interface; three
fake-incremental messages (schemas, updater methods, handlers);
`ActiveChildInfo.status`/`.elapsed` + `recordChildPhase` + roster regression
guard; `replayTrace` hand-built controls/payload/tab-info;
`pendingDescriptions` buffer + three drains; frontend re-sort +
`resolveActiveStreamId`.

**Workstream D:** `groupStyles` divergent color map; dead `status-*` keys +
third class scheme; `TaskGroupList` icon switch; `childStatusColor` +
`TASK_GROUP_APPEARANCE` free tables; three session-activity predicates + the
literal status-bar strings; `childExecutionLabel` independent rule + palette
fallback chain; private `formatElapsed` + second live/terminal switch; private
`displayPath` duplicate + `workflowOutput` compensation; raw `MODEL_CONFIGS`
branch; `agents list` private formatting; three redundant
`?? AgentCategory.Workflow` restatements; `/status` live-queue bypass;
extension double follow-up push.

**Workstream F:** three follow-up submission wrappers (~124 L); the CLI
`setCliApiMode` clone; duplicated credential-controller construction +
refresh fan-outs + ChatGPT auth sequences (~320 L across two hosts); two
state-setting write sequences + two snapshot dispatch tables (~134 L); two
history flow bodies + the CLI private status resolver (~340 L + CLI shapes);
extension's inlined `nodeHost` helper copies; three `SessionStores` literals;
two agent-tab mutation sequence sets (~430 L); three options fan-out
assemblies + four `computeModelOptionsData` pairs (~115 L); two tool-dashboard
sequences + CLI re-derivation + two `LatexToolingController` literals + two
executions watchers (~195 L); `InitConfigShape`'s parallel key list; the
desktop `() => []` reliability stub.

## 9. Decisions needed from the owner

1. **B (usage):** canonical field set (recommended: 6 + `reasoningTokens` +
   route consensus) and whether the telemetry `inputTokens` misnomer is
   renamed (backend coordination) or documented.
2. **C5:** confirm promoting bypass state into the existing `SessionFact`
   union (new arm, not new vocabulary).
3. **C7 fake-incrementals:** fold into sync (recommended) vs make them real
   deltas.
4. **D5:** `OutputFileSummary.relativePath` — rename (if internal) vs
   document-and-normalize (if frozen).
5. **`UPDATE_STREAM_METADATA` vs its four targeted subset messages:** one
   transport rule for `phaseStage`/`roundStage`; currently arbitrary.
6. **F5:** desktop `UsageLogService` enablement — confirm it must respect the
   telemetry setting, and whether enabling it on existing desktop installs
   needs a release note (it changes what leaves the machine).
7. **D2:** desktop's "deliberately exact `RUNNING`" title predicate — adopt
   the shared activity rule, or make strictness a named parameter. Do not
   erase the comment silently.
8. **F6:** why the extension session path skips `sweepOrphanedStreams` —
   investigate, then either add it (with the same guard the other hosts have)
   or document the asymmetry as intended.

## 10. Adversarial analysis — how this goes wrong, and the clean fix

Each entry: the failure mode, the symptom you'd see, and the clean fix (which
is in all cases *already folded into the workstream items above* — this
section is the reasoning, so a future implementer doesn't "simplify" the
safeguard away).

### 10.1 Frozen-wire breakage (C1, C5, C7, D3 clock)

**Risk:** moving a fact's channel (status → session-only; bypass → fact) or
deleting an internal message changes headless NDJSON ordering, duplicates an
event during a transition window, or drops a frozen key. The D4 ruling already
recorded the concrete case: guard-drop and projector-arm deletion in separate
PRs → a dual window where NDJSON emits status twice.
**Symptom:** CI green, downstream NDJSON consumers (scripts, the GitHub
action) silently double-count or lose events.
**Clean fix:** the internal webview wire ships atomically with each host and
may change freely; the **public NDJSON vocabulary is frozen** and only the
projection file may emit it — so every channel move keeps
`sessionProgressSubscription.ts` emitting byte-identical records, verified by
the E2 parity fixture (record → replay → byte-compare) run in the same PR.
Deletions of public keys ride the D3 deprecation clock, never a refactor.

### 10.2 Late-join and replay loss (C5)

**Risk:** the bypass port push targets the *active attachment*; the session
fact fan-out has no replay. A webview attaching mid-run could miss a toggle
emitted between its initial sync and its subscription.
**Symptom:** stale bypass badge until the next toggle.
**Clean fix:** the sync `controls` pull path is already the late-join
authority (it reads the live bypass map at sync time). The migration keeps
that pull path and orders "subscribe, then initial sync" in the attach
sequence — the same convention the log rail already uses
(status-before-projection in `subscribeStreamStatus`). One attach-ordering
test per host in the C5 PR.

### 10.3 The unstated subscriber-order invariant (C6, and existing code)

**Risk:** `ProgressFactApplier` re-reads `StreamSnapshotStore` on fact arrival;
this is correct only because the store subscribes first (SessionHandle
constructor) and `SessionEventHub` iterates its `Set` in insertion order.
C6 extends this pattern to the CLI. Anyone who reorders construction, or
"optimizes" the hub's subscriber storage, breaks every re-read consumer
simultaneously — with no failing test today.
**Symptom:** UI shows the previous artifact state, off-by-one against events;
intermittent, load-order dependent.
**Clean fix:** E1 lands *before* C6: a kernel test that asserts
store-before-projection delivery order, plus a sentence on
`SessionEventHub.subscribe` documenting that ordering is part of the contract.
If the hub ever needs unordered delivery, the applier switches to
version-checked re-reads — an explicit migration, not an accident.

### 10.4 Deleting frontend compensation before the backend guarantee (C8)

**Risk:** removing the tab re-sort, `resolveActiveStreamId`, or
`pendingDescriptions` before the backend actually guarantees ordered,
complete, race-free data → visibly unsorted tabs, missing subagent
descriptions, wrong active tab.
**Symptom:** immediate, user-visible; worst on slow machines where the races
the buffers papered over actually occur.
**Clean fix:** anti-mixed-state applies *within* each item: the backend
guarantee (emit description with registration; wire carries authoritative
order/active) and the frontend deletion land in one atomic PR, with a test
encoding the guarantee. If the guarantee can't be written as a test, the
compensation isn't deletable yet — sanction it with a comment instead.

### 10.5 Schema transforms leaking into the write path (A1, A2, A5)

**Risk:** `GroupLogPayloadSchema` (and stage/inquiry schemas) may be used to
*construct or validate writes*, not just reads. A normalizing `.transform()`
on a shared schema would then rewrite legacy spellings on disk (churning
persisted bytes), or worse, run twice (read → normalize → re-persist →
re-normalize) and mask a producer writing the legacy form today.
**Symptom:** transcript diffs on untouched sessions; a producer bug that A1's
gate can never catch because the schema silently launders it.
**Clean fix:** normalization transforms live on **read-side** schema variants
(the `AgentWorkspaceState` pattern: a canonical-only schema for interiors, the
union+transform at the boundary). Before A1 lands: grep every use of the
payload schema, split read/write variants if both exist, and add a test that
the *writer* emits only canonical spellings — making the legacy arm read-only
archaeology by construction.

### 10.6 The ratchet that cries wolf (E3, and the approval PRD's Stage E)

**Risk:** retirement gates scoped by bare string (`'never'`, `GROUP_END`
values, usage field names) false-positive on unrelated vocabularies (Codex's
`'never'`, `echo: 'never'`), get noisy, and are deleted within a month —
taking their protection with them.
**Symptom:** gate removed "temporarily" in an unrelated PR; the mirror it
guarded regrows.
**Clean fix:** symbol-scoped scanning (files importing the guarded symbol),
the >100-files vacuity guard, and landing each gate only *after* its deletion
completes so the allowlist is minimal. A gate whose allowlist must include
something the plan was supposed to delete has found an incomplete migration —
that is its job; finish the deletion rather than widening the list.

### 10.7 Layering violations dressed as sharing (C7 replayTrace, D3, F-items)

**Risk:** "call the real builder" naively makes `packages/trace-viewer` import
`src/controllers/progressView/backend` — a new architecture edge the ratchets
forbid (and should); settings folds could similarly pull host-only modules
into `src/shared`, or grow a host facade.
**Symptom:** `architecture-edges` baseline widens; or worse, it's widened
"just this once" in review.
**Clean fix:** extract the **pure core** (label building, payload shaping,
default controls) into `src/shared/streams` first — honestly accounted as a
relocation — then point controllers, trace-viewer, and CLI at it. Never widen
a baseline to share code; if sharing requires a new edge, the shared code is
in the wrong directory. The F-items follow the two already-sanctioned shapes
only: `SettingsAgentActions`-style modules in `src/controllers/settingsView`,
and named `nodeHost.ts` helpers. Anything that starts to look like
`installEverything(config)` is the banned BootstrapConfig.

### 10.8 The bundle-size regression that re-justifies inlining (F5)

**Risk:** making the extension consume `nodeHost.ts` drags the direct Lean
adapter (the stated reason for the current inlining) into the webpack bundle.
**Symptom:** extension package size jump; marketplace publish friction.
**Clean fix:** the split is the fix — `hostRuntime.ts` holds only the
Lean-free helpers; `nodeHost.ts` keeps the rest. E4's bundle-size check rides
the same PR so the claim "the reason for inlining is gone" is proven, not
asserted.

### 10.9 Behavior changes smuggled inside refactors (F1, F6, B3)

**Risk:** several "folds" are actually behavior fixes: desktop/CLI gain the
follow-up repair probe (F1); the extension would gain `sweepOrphanedStreams`
(F6); the status bar totals change when the hand-sum dies (B3). Landing these
inside refactor-labeled PRs makes regressions undiagnosable and buries product
changes nobody signed off on.
**Symptom:** "the refactor broke resume" bug reports that are actually the fix
working; or data (orphaned streams) deleted by a "no-op" refactor.
**Clean fix:** behavior-carrying items ship as their own labeled PRs with
regression tests (F1: terminal-but-resumable follow-up on all three hosts),
and F6's sweep asymmetry is *investigated before unification* (owner decision
8) — if the extension skips the sweep for a reason, that reason becomes a
parameter, not a casualty. The shared-fold PR that follows is then genuinely
behavior-neutral and reviewable as such.

### 10.10 Unification erasing deliberate divergence (D1, D2, F5)

**Risk:** the desktop title's "deliberately exact `RUNNING`" predicate, the
CLI's intentional `completed`/`waiting` color divergence, and desktop's
telemetry posture are *choices*, not drift. A zealous unifier flattens them
and silently changes product behavior (worst case: F5 turning on usage
logging for desktop users who never consented — a privacy change, not a
refactor).
**Symptom:** subtle UX changes nobody asked for; in the telemetry case, a
trust violation.
**Clean fix:** deliberate divergence survives unification as a **named
parameter or trait column in the shared source** (D1 does exactly this for
CLI colors; D2 makes strictness explicit), and every formerly-implicit choice
becomes an owner decision (6, 7). The rule: sharing must make divergence
*visible and named*, never impossible — and never accidental.

### 10.11 The half-migration plateau (F2–F9)

**Risk:** the sequence folds are many small PRs; if the effort stalls halfway,
the codebase has *three* spellings (shared module + two host restatements)
instead of two — strictly worse than not starting.
**Symptom:** a shared `SettingsCredentialActions` with one consumer while the
other host keeps its copy "for now".
**Clean fix:** each F-item is atomic per sequence: the shared module lands
*with both hosts' deletions in the same PR* (anti-mixed-state). If a fold
can't take both hosts in one PR, it is not ready. The knip dead-code ratchet
backstops this: a shared export with one consumer while a twin restatement
survives is exactly the "exports are contracts" violation it flags.

### 10.12 Canonicalized numbers changing what users see (B1–B4)

**Risk:** widening the fold changes displayed totals (status bar suddenly
includes cache fields; CLI totals gain `reasoningTokens`), which reads as a
billing regression to users comparing before/after.
**Symptom:** "TeXRA says I spent more after the update."
**Clean fix:** canonical *fields* with explicit per-surface *column
selection*: each display keeps its current columns in the migration PR
(pure refactor, snapshot-tested output), and any column change ships
separately as a labeled display fix. The B3 under-report fix (status bar
missing route/cache) is one such labeled change, not a silent side effect.

### 10.13 Loud reads becoming fatal reads (A8)

**Risk:** replacing `.catch()` with strict parsing can turn "corrupt field →
silent default" into "corrupt field → whole file unreadable → user loses the
readable 95%", trading silent degradation for loud data loss.
**Symptom:** one bad byte in `workPlan.json` nukes the plan panel entirely.
**Clean fix:** the `parseUsageData` pattern is the template precisely because
it does neither: per-field/per-run isolation, unparsed parts preserved
verbatim, loud `warn` with the cause. A8 is "make degradation loud", never
"make parsing brittle".

### 10.14 Caching away liveness (A6)

**Risk:** memoizing `loadWorkspaceCliConfig` for process lifetime freezes
config for long-lived TUI sessions — a user edits `.texra/config.json`
mid-session and nothing changes (today's per-call re-read honors it).
**Symptom:** "config changes don't apply until restart" — a regression the
per-request-`getConfig` ruling (constraint 9) explicitly protects against
elsewhere.
**Clean fix:** memo keyed by mtime (or invalidated by the existing
workspace-file-write signal), so the three redundant disk reads collapse
without changing observable liveness. The adjacent trap — "while we're here,
cache the approval getConfig reads too" — is already closed by constraint 9.

### 10.15 Decision deadlock (§9)

**Risk:** items gated on owner decisions (B field set, C5, fake-incrementals,
telemetry) stall, and implementers either guess (re-introducing exactly the
silent divergence this plan exists to kill) or skip to unblocked items,
leaving the highest-value fixes last.
**Clean fix:** every gated item has a recommended default recorded in §9; the
pre-authorized and decision-free items (A*, C1–C4, C7 mechanical rows, D1
mechanics, F1) form a full work queue that never blocks on §9. A decision
changes *which* PR lands, never whether progress continues.
