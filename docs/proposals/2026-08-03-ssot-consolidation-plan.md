---
created: 2026-08-03
updated: 2026-08-03
---

# SSOT consolidation plan: projections, normalization, and derived data

**Status:** Draft plan (v1 — grounded in six parallel codebase audits, 2026-08-03)
**Branch:** `claude/texra-9597-design-review-5tyyls`
**Companion docs:**
[`2026-07-09-state-of-the-architecture.md`](./2026-07-09-state-of-the-architecture.md) (D1–D8, M/C/IF/FB items),
[`2026-08-01-architecture-rulings-ledger.md`](./2026-08-01-architecture-rulings-ledger.md) (closed questions),
[`2026-07-09-tech-debt-design-philosophy.md`](./2026-07-09-tech-debt-design-philosophy.md) (PT/SHALLOW/DI rulings),
[`2026-06-10-error-pipeline-and-ownership.md`](./2026-06-10-error-pipeline-and-ownership.md) (catch budget, rejected findings),
[`2026-06-10-lifecycle-status-ownership.md`](./2026-06-10-lifecycle-status-ownership.md) (trait-table rule),
[`../prds/2026-08-03-prd-approval-policy-unification.md`](../prds/2026-08-03-prd-approval-policy-unification.md) (approval policy; Stage references below)

## 0. Charter and method

Six audits (three over the run-fact projection rails runtime→extension/desktop/CLI,
one over entry-point normalization, one over derived-data recomputation, one over
standing rulings) produced a consolidated inventory of: duplicate channels for one
fact, mid-layer format normalization, independent re-folds of the same event
stream, and pass-through hops. This plan turns that inventory into ordered,
bounded workstreams.

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
9. Per-request `getConfig` reads in `src/tools/approval/*` are **correct**
   (in-memory map lookup; live mid-run toggles). Do not cache them.
10. The Zod `.catch()` budget: never on persisted/authoritative data; the
    sanctioned exceptions are display-only view state.

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
(`src/shared/schemas/taskGroup.ts:56-66`) as a `.transform()`, so every parser
of the payload inherits it.
**Delete:** `taskGroupEndStatus`'s legacy branch (`taskGroupProjection.ts:27-36`);
the equivalent mapping inside `StreamLogStore.ts:204-224` (the entry point now
parses the payload schema); the legacy fallback arm in `replayTrace.ts`.
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
consumers receive `undefined` uniformly.
**Delete:** `metadataToStreamStatePartial` (`streamStateMerge.ts:9-21`) and the
`activeStateFields` unwraps (`syncSlice.ts:19-25`).

### A3. `parentStreamId`: one nullability spelling

Three schema spellings (`.nullish()` / `.nullable()` / `.optional()`), a
tri-state consumer branch (`childExecutions.ts:173-181` branches on
`undefined` vs `null` vs value), and a `...(x !== undefined && { x })` idiom
copy-pasted in three hosts.

**Fix:** `.nullish()` at the wire with a `.transform()` to `undefined`; the
"explicit clear" case, if needed, becomes a dedicated flag rather than a
tri-state. **Delete:** the tri-state branch; `stateUtils.ts:106`; two of the
three spread idioms (`desktopAgentResume.ts:93,156`,
`resumeFromResumeData.ts:66` converge on one helper only if a third caller
exists — otherwise inline the same two-line spelling, per the
single-caller-extraction ban).

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
about API input, not internal shape). **Delete:** the four unwraps; converge the
two permission constructors on one (they have two callers — allowed).

### A6. CLI config: one parse, one table, no `.catch`

`cliConfig.ts` validates every field twice through two hand-synced schema
tables (`:100-110` vs `:154-181`) because the extraction path uses
`.catch(undefined)` (`:184`) and therefore can't report issues.
`loadWorkspaceCliConfig` re-reads `.texra/config.json` from disk three times
per process (`cliContext.ts:390`, `chatDefaults.ts:78`, `agentRoster.ts:37`)
with no cache, alongside the platform's own `JsonStore` read.

**Fix:** one `z.object` + `safeParse` producing values *and* warnings in one
pass; memoize `loadWorkspaceCliConfig` per `cwd` for the process lifetime.
**Delete:** `collectValidationWarnings`' parallel table, the per-field
`.catch(undefined)`, the two duplicate `readFile` paths.
This also retires one of the two `.catch`-on-persisted-data guardrail hits.

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
path (pattern: `parseUsageData`, `streamData.ts:140-175`, the repo's best
persisted read). Same treatment for `UsageMonitor.ts:278`'s
`.catch('unknown')` on accounting data and `history.ts:132`. Display-only
catches (taskGroup rows, `LogList`) stay — sanctioned.

## 2. Workstream B — one usage-accounting fact

Nine accumulators fold the same `usage` events with four field-set rules; three
incompatible "is empty" predicates; and `inputTokens` means *total input* in
every UI but *cache-miss input* on the telemetry wire (`UsageMonitor.ts:289`,
undocumented at `UsageLogTypes.ts:18`).

**Decision to take first (owner call): the canonical field set.** Recommended:
`sumUsageStats`' six fields + `reasoningTokens` (what the CLI already bolts on)
+ the `usageRoute` consensus rule. One fold, one `isEmptyUsage`.

Then, in one PR each:

| Item | Add | Delete |
| --- | --- | --- |
| B1. Canonical fold | widen `sumUsageStats` (`usage.ts:84-112`) to the decided set | `sumResumeUsageStats` bolt-on (`resumeHint.ts:82-92`) |
| B2. One empty-predicate | — | `usageHasTokens` (`resumeHint.ts:71-80`), `UsagePanel.hasUsage` (`UsagePanel.ts:189-198`), the inline check at `extension.ts:644` — all become `isEmptyUsage` |
| B3. Status bar consumes folded totals | subscribe the tracker to the snapshot-store fold it currently re-implements | `StatusBarUsageTracker.ts:52-63,74-82` hand-`+=` (3-field, drops route/cache — silent under-report) |
| B4. Webview stops re-folding per render | ship the folded total in the payload it already receives | `sumUsageStats(Object.values(runUsage))` at `ToolUseStreamContent.ts:76`, `WorkflowStreamContent.ts:63` |
| B5. Honest telemetry field | rename at the schema or document the divergence at `UsageLogTypes.ts:18` — the wire itself is external; renaming needs the backend's agreement | the ambiguity, not the field |

Not in scope: `RunUsageAccumulator`'s in-run accumulator (different layer, its
own documented legacy union — correct as is); the snapshot store's
overlay-replay fold (`mergeUsagePatch` vs `applyUsageDeltaMemory`,
`StreamSnapshotStore.ts:219-230/696-705`) is acknowledged re-entrancy
machinery — fold the two copies into one function *without* touching the
overlay design.

## 3. Workstream C — projection rails (executes standing rulings + new finds)

Ordered so already-ruled items go first (they're pre-authorized), then new
decisions.

### C1. D4 status rail — pre-authorized, one atomic PR

Per the standing D4 ruling (state-of-the-architecture `:265-330`, amended
2026-07-25): delete the three consumer trace-arms
(`ProgressFactApplier.ts:124-130`, `sessionProgressSubscription.ts:76-87`,
`runProgressRenderer.ts:197-199`) **and** the emitter guard in
`StreamStatusService.publishStatus` in the same PR, so the session fact is the
sole cross-process channel. Trace arm stays (persistence consumer, #9127).
Rail C stays. Headless NDJSON parity is the acceptance test — a dual window
duplicates output.

### C2. Live bug: desktop `removeStream` no-op — pre-authorized (A1 in runtime-ui audit)

Shared applier becomes the single owner via a host deletion callback threaded
through the existing `createProgressBackendUiConfig`. No new port, no
per-host subscriber.

### C3. Dead legacy tool-edit approval fallback — pre-authorized (A2, −300..−450 LoC)

The triple-wired legacy channel is dead; delete end-to-end. Blocked only on
respecting IF-1: `requestToolEditApproval` stays optional (its `undefined` is
the dispatch signal); the deletion is of the *legacy target*, not the dispatch.

### C4. `useHostInteractions` pass-through — pre-authorized (PT-2)

Delete `SessionHandle.useHostInteractions` (`SessionHandle.ts:661-663`);
retarget 13 callers to `session.interactions.use(...)`. Do **not** add
per-concern forwarders elsewhere (the recorded trap).

### C5. Approval-bypass state becomes a `SessionFact` — new decision needed

Today one source (`streamApprovalQueue.ts:66`) fans out over a bespoke port
push (`setApprovalBypassState`, `HostInteractions.ts:532-534`) **and** a pull
path (`progressStreamControls` → sync `controls`), landing twice in the same
frontend fields; the CLI adds a third naming layer
(`ApprovalBypassNdjsonEvent`, `cliPresentationHost.ts:41-45`) outside the
governed NDJSON vocabulary.

This adds an arm to the **existing** `SessionFact` union (allowed; a new
vocabulary would not be). Emitted NDJSON names stay byte-identical — the
projection in `sessionProgressSubscription.ts` takes over emitting them.

**Delete:** `SessionHostInteractions.setApprovalBypassState` + its attachment
plumbing; `ApprovalBypassNdjsonEvent` + `emitApprovalBypassState`
(`cliPresentationHost.ts:41-45,148-157`); the `permissionSlice` bypass write
path (`syncSlice` remains the one writer) — or vice versa, one writer total;
the TUI port fan-out (`subscribeApprovals.ts:181-184`).
**Check:** the FB-2 never-check (C9) lands first so all four fact switches
fail loudly on the new arm.

### C6. TUI artifact double path — one owner

Artifacts (`addOutputFiles`/`updateMissingOutputs`/`updateCompileFailures`)
are folded live into `cliState` (`subscribeRuntimeHost.ts:169-189`) *and*
re-read from `StreamSnapshotStore` on focus (`subscribeStreamArtifacts.ts:47-75`),
with a revision counter arbitrating disagreements.

**Fix:** snapshot store is the owner (matches the extension applier's
re-read-on-ping pattern); the live fold becomes an invalidation ping.
**Delete:** the live accumulator arms, the merge, `StreamArtifactRevision` /
`recordMissingOutputsReset` (`cliState.ts:326-346`).
**Prerequisite:** declare and test the subscriber-order invariant this relies
on (snapshot store attaches before projections; `SessionEventHub` iterates in
insertion order) — currently load-bearing and untested. One kernel test.

### C7. Pass-through and duplicate-hop deletions (mechanical batch)

| Item | Delete | Notes |
| --- | --- | --- |
| Desktop double Zod parse | the classification `safeParse` at `renderer/main.ts:462-467` | route on `dispatchMessage`'s existing unrecognized-command result; hot path (60fps `LOG_DELTA`) |
| Redundant re-checks | scope re-checks (`ProgressBackend.ts:421,427`), duplicate `hasTarget` (`:113`) | filter already guarantees both |
| `run.start`/`run.config` twin handlers | one of the two verbatim bodies (`ProgressFactApplier.ts:126-137`) | |
| Single-file payload round-trips | `UpdatePhaseStagePayload` (zero external consumers), the pack/unpack for round-stage + conversation-progress (`progressEvents.ts:61-124`, `ProgressFactApplier` internals) | pass plain args; `UpdateRoundStagePayload` survives only if the frozen NDJSON projection still needs its type |
| `runFactSubscriptions.ts:9-21` | the 12-line field-by-field payload reconstruction | subscribe to the payload directly |
| Reveal-stream triplication | the two copies in `toolEditApproval.ts:117-131`, `ExternalInquiryTool.ts:421-432` | call `revealStream` (`progressHostInteractions.ts:89-104`) |
| Inbound forward chains | `ProgressViewHost`'s file-command re-forward (`ProgressViewHost.ts:119-140`); the 12 one-line arms delegate to controller methods directly | PT-1 scope only: the `module:` fields + never-read `interactionHandler` are also deletable; do **not** fold `handleInteractionEvent` (real guard) |
| `CliRuntimeHost` dissolution | the 4-member interface (`cliPresentationHost.ts`); no caller uses >2 members | split: presentation-event sink; renderer attaches directly at `runExecution.ts:193`. Shrinks further after C5 |
| Fake-incremental messages | `UPDATE_FILES`/`UPDATE_MISSING_OUTPUTS`/`UPDATE_COMPILE_FAILURES` (3 schemas + 3 updater methods + 3 handlers) fold into the sync path they duplicate (`ProgressFactApplier.ts:291-319` ship full snapshots today) | the snapshot+targeted *design* stays (ruled); these three violate it in the other direction |
| Child roster derived fields | `ActiveChildInfo.status` + pre-formatted `elapsed`; `recordChildPhase` (`ProgressViewState.ts:504-528`); the roster regression guard (`:552-566`) | ship `childStreamId` + `startedAt`; renderers join (pattern exists at `BackgroundTasksPanel.ts:399-403`) and tick live (pattern: `ToolTimer`) |
| `replayTrace` hand-copies | the all-false controls literal (`replayTrace.ts:214-219`) → `getDefaultProgressStreamControls`; the hand-built `SyncStreamContentPayload` (`:195-220`) and `StreamTabInfo` (`:145-160`) → call the real builders (`ProgressFactApplier.syncStreamContent` shape / `buildStreamTabInfo`) | fixes the missing `modelLabel`/decoration in archived traces as a side effect |

### C8. Frontend compensation → fix at source

- Emit the stream description **with** registration; delete the
  `pendingDescriptions` race buffer and its three drain/cleanup sites
  (`streamMetaSlice.ts:26-34,59`, `streamLifecycleSlice.ts:78,89-94`).
- Backend already sorts and already resolves the active tab: delete the
  frontend re-sort (`streamMetaSlice.ts:36-48`) and `resolveActiveStreamId`
  (`streamLifecycleSlice.ts:121-128`) once the wire carries order/active
  authoritatively.
- The proposal SHOW-after-RESOLVE dedup (`permissionSlice.ts:140-150`) guards a
  transport that shows cards twice by design — fix the transport's ordering or
  explicitly sanction the guard with a comment; don't leave it ambient.

### C9. Loud fact switches (FB-2, +15-20 LoC)

Propagate the `never`-check into the four `SessionFact` consumer switches so an
added fact arm fails compilation everywhere it must be handled or explicitly
ignored. This is the enabling change for C5 and any future fact promotion.
(The recorded trap: no fact-router; the explicit ignore arm is the feature.)

## 4. Workstream D — derived display: one source, host projections

### D1. Phase appearance: trait columns, not parallel maps

Labels are already single-source (`formatStreamStatusLabel`). Appearance is
not: two CSS maps with different colors for `running`
(`statusIndicatorStyles.ts:14-43` vs `groupStyles.ts:22-38`), a third class
scheme with dead keys (`StreamTab.styles.ts:49-70` — `status-error`,
`status-initializing` unreachable), a private icon switch
(`TaskGroupList.ts:73-85`), and two CLI tables with a deliberate,
undocumented-in-place divergence (`SubagentListDisplay.ts:20-39`).

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
result. **Delete:** the three private predicates and the literal
`"TeXRA: Running"`/`"Idle"` strings.

### D3. Stream display names: one builder

`buildStreamTabInfo` is canonical for extension+desktop; the CLI has a parallel
label stack (`streamViews.ts:105-133` → `childExecutionLabel`) and the
trace-viewer hand-builds the record (fixed in C7). The desktop palette adds a
fifth fallback chain (`desktopCommandPalette.ts:374-386`).

**Fix:** extract the *pure* label core of `buildStreamTabInfo` (name cleaning,
workflow decoration, model label — no worktree probe) and have the CLI stack
and palette consume it. This is a relocation + two deletions, not a new layer:
**delete** `childExecutionLabel`'s independent rule and the palette's private
chain.

### D4. Durations: one family, no emission-time formatting

The same child's elapsed flips formatter at run end
(`formatDuration` frozen at emission, `executionRegistry.ts:366`, vs
`formatCompactDuration` live, `childControls.ts:24-34`), and the same
live/terminal split is re-implemented at `SubagentList.tsx:331-364`.

**Fix:** C7 already deletes `ActiveChildInfo.elapsed`; extend the rule —
duration fields on events carry **milliseconds or a start timestamp, never a
pre-formatted string** (existing `durationMs` fields are already right).
Converge on the two shared formatters; **delete** the private `formatElapsed`
(`runProgressRenderer.ts:424-430`) by giving `formatCompactDuration` the
no-hour-rollover style it needs, and the second live/terminal switch in
`SubagentList`.

### D5. File display paths: one rule set, honest field names

Four `FileLocation`→string functions with three different `external`-file
rules; `output.ts:182-186` is a byte-identical private re-implementation of
`getComparablePath`; `OutputFileSummary.relativePath` (`output.ts:192`) can
hold an **absolute** path, which `workflowOutput.ts:152-154` then papers over.

**Fix:** `fileLocation.ts` exports the one comparable-path and one
short-display rule; **delete** the private `displayPath` duplicate and the CLI
compensation. The dishonest field: if `OutputFileSummary` is persisted/wire,
document the misnomer at the schema and normalize at its entry point; if
internal, rename. Host `relativeDisplayPath` implementations (desktop basename
fallback vs VS Code multi-root) stay host-specific — that's presentation — but
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

The invalidate-and-re-read design is correct; two wrinkles:
`/status` reads the live queue while the rest of the TUI reads the slice mirror
(`sessionCommands.ts:91-94` vs `StatusBar.tsx:205`) — pick the mirror; and the
extension writes the same list via two paths per sync
(`ProgressFactApplier.ts:357` + `:679`) — drop the targeted push inside the
full-sync call path.

## 5. Workstream E — gates and doc truth

1. **Order-invariant test** for hub subscribers (prereq of C6, protects the
   applier's re-read pattern).
2. **NDJSON parity fixture** — byte-comparison harness for headless output
   across C1/C5 (the D4 ruling's acceptance criterion generalized).
3. **Normalizer retirement gates** (Style-2 vitest, per the approval-policy
   PRD's Stage E pattern): the `GROUP_END` mapping exists once (A1); the
   usage fold and empty-predicate exist once (B1/B2). Symbol-scoped, with the
   >100-files vacuity guard. No baseline JSON — correct baseline is empty.
4. **Doc corrections** (cheap, prevent future mis-navigation):
   `cli-runtime-round-trips.md` missing the `StreamSnapshotStore` edge;
   `state-of-the-architecture.md:1112-1113` stale trace-arm sentence;
   `cliState.ts:41-44` false "mirrors the webview" comment (already flagged);
   `StreamLogStore.ts:185` becomes true via A1 (verify, then keep).

## 6. Ordering

```
A1–A8 (independent, land anytime, no cross-deps)
B decision → B1..B5
C9 (loud switches) → C5 (bypass fact)
C1 (D4, pre-authorized) ─ independent
C2, C3, C4 (pre-authorized) ─ independent
E1 (order test) → C6 (artifact owner)
C7, C8 (mechanical; C7's replayTrace items after A1)
D1–D7 (independent of C except D4 ⇢ C7's elapsed deletion)
E2 rides C1/C5; E3 rides A1/B; E4 anytime
```

Approval-policy PRD Stages A–E proceed in parallel; the only shared file of
consequence is `cliPresentationHost.ts` (C5/C7 vs nothing in that PRD) and
`SessionMeta.approvalPolicy` (owned by that PRD's Stage B — not duplicated
here).

## 7. Consolidated deletion ledger

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
fallback chain; private `formatElapsed` + second live/terminal switch;
private `displayPath` duplicate + `workflowOutput` compensation; raw
`MODEL_CONFIGS` branch; `agents list` private formatting of unsorted roster;
three redundant `?? AgentCategory.Workflow` restatements; `/status` live-queue
bypass; extension double follow-up push.

## 8. Decisions needed from the owner

1. **B (usage):** canonical field set (recommended: 6 + `reasoningTokens` +
   route consensus) and whether the telemetry `inputTokens` misnomer is renamed
   (backend coordination) or documented.
2. **C5:** confirm promoting bypass state into the existing `SessionFact`
   union (new arm, not new vocabulary).
3. **C7 fake-incrementals:** fold into sync (recommended) vs make them real
   deltas.
4. **D5:** `OutputFileSummary.relativePath` — rename (if internal) vs
   document-and-normalize (if frozen).
5. **UPDATE_STREAM_METADATA vs its four targeted subset messages** (from the
   projection audit): pick one transport rule for `phaseStage`/`roundStage`;
   currently arbitrary.

Everything else in this plan executes standing rulings or falls under the
design guardrails already in force.
