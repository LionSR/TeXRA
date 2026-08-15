# Shared contracts and retirement (2026-08-15, round 3)

> **Status:** Adjudicated audit + design, 2026-08-15, pinned to **origin/main
> `3122ace2bc`** (post-campaign: #10475, A3 #10603, B2 #10608, B3 #10600,
> B4 #10611 all merged). Third doc of the set — companions:
> `2026-08-15-cross-host-consolidation.md` (host-divergence audit) and
> `2026-08-15-single-substrate-hosts-as-renderers.md` (state-substrate plan).
> This doc covers the two territories the maintainer's follow-up directive
> named: **shared consistent contracts** (the fragmented
> vocabularies/schemas/ports and what each fragment is doing) and
> **retirement** (dead code to remove, legacy surfaces past their era).
> §5 is the stale-claims register that re-verified the two companion docs
> against this main.

Method: four sweeps on a fresh origin/main worktree — contract-surface
census, dead-code/retirement hunt, catalog-fragmentation study
(settings/status/capability), and claim-by-claim re-verification of the
companion docs. Every claim is verified-at-citation on `3122ace2bc`.

## 0. Binding constraints found in force (checked before proposing)

- `2026-08-03-ssot-consolidation-plan.md` §0.1: **item 2** — one *source*
  with projections, never one merged enum; **item 6** — frozen wire (CLI
  NDJSON names, progress-view IPC literals, persisted `result.outcome`,
  `'approveSuperYolo'`, `'updateSuperYoloBypassState'`); **item 7** —
  `SessionHostInteractions` forwards and `requestToolEditApproval`
  optionality are load-bearing; **item 8** — the snapshot+targeted dual path
  in the progress view **is the intended end state**.
- Every proposal below is shaped as *canonical schema + derivations that
  keep the existing literals*. Where a literal deletion would be needed, it
  is flagged as requiring a named supersession — and notably, the compliant
  derivation path found here means the companion doc's Wave C **no longer
  needs the §0.1-item-6 supersession it requested** (§4).
- Ratchets that bite: `shared-schemas-deep-import` (a new off-barrel
  specifier fails unless the barrel is widened in the same PR),
  `architecture-edges` (a new directed src-subsystem pair fails), and —
  new since B3 — `host-agent-import-baseline` is a **set** ratchet that
  fails in *both* directions: a new specifier fails, and a listed specifier
  whose last live import is deleted fails as stale headroom. **Every
  deletion PR that removes a host's last `@agent/*` deep import must prune
  the baseline in the same commit.**

## 1. Already consolidated — cite as the model, do not re-flag

Verified at this HEAD; several proposals floating in older docs are stale
against these:

- **Desktop IPC is one channel each way** (`hostBridgeChannels.ts` is 2
  lines; pushes dev-asserted against a schema array). No per-view fan-out
  exists to consolidate.
- **The progress inbound registry is shared** (both hosts consume
  `createProgressViewCommandHandlers`; desktop subtracts its owned commands
  via `Omit`, not re-declaration).
- **Tool contracts** (`toolKind.ts` — explicitly the post-drift SSOT;
  `normalizeToolUseData` single producer; timeout/caps single table) and
  **platform ports** (14 ports, ~49 methods, `createNodePlatform` shared by
  CLI+desktop) — no fragmentation found.
- **Status vocabularies are the house rule working**: `RUN_OUTCOME` /
  `STREAM_PHASE` canonical; `TaskGroupStatus`, `HISTORY_RUN_STATUS`,
  `AGENT_ERROR_OUTCOME`, `RUN_OUTCOME_PROJECTION`,
  `streamStatusToLifecycleStatus` are all member-referencing projections.
  CP4 (the headless hand map) is **already deleted**; `APPROVAL_GATED` as a
  list no longer exists (per-definition `requiresApproval` replaced it).
  Two defects remain (§2.7); merging the enums stays forbidden (item 2).
- **`withLegacyUsageRoute`** wraps all three usage schemas (SSOT A4 landed);
  `stateSettingWrite.ts` is shared by both webview hosts (F3 landed);
  `unsupported()`/`unsupportedCommands()` + `SET_UNSUPPORTED_COMMANDS` is
  the correct capability mechanism — derived, not `isDesktopHost` ternaries.
- **Frozen surfaces** (fence, never "consolidate"): CLI NDJSON progress
  vocabulary + `CliNdjsonActiveChildRow` (which is the projection pattern
  done exactly right — the boundary alone re-projects `identity` to the
  frozen shape), `TaskState`, progress-view IPC literals, persisted
  `result.outcome`, the `trace.json` legacy status import path,
  `AgentDelegationScopeLegacySchema`, `LegacyLogMessageSchema`,
  `ExecutionMetaSchema.identity` optionality.

## 2. Contract fragmentation families, ranked

Ranked by contradiction count × drift risk. For each: the fragments, what
each is doing, the single contract, and what deletes.

### 2.1 Settings capability catalogs — ~30 contradicting rows, 6 answer-sites

Six places answer "does host H honor setting S, and where is it stored":
the `STATE_SETTINGS` rows' `hosts` + `store`/`cliStore`
(`stateSettings.ts:147-158`), `CLI_CORE_SETTING_PATHS` /
`EXTENSION_ONLY_CORE_SETTING_PATHS` (`coreSettings.ts:507-555`),
`KNOWN_TEXRA_KEYS` (derived), `PROVIDER_SETTINGS` (the Models tab's own
catalog with its own `defaultValue` and raw-write path,
`providers.ts:298-390`), `readGitAuthorSettingsFromState` (slot decided by
whichever store the caller passes), and `readPlatformSetting` (hardcodes
`host='extension'` in shared code that runs under the CLI).

What the fragments are doing: `hosts` conflates two different facts —
"which host's runtime honors this" and "which host's *catalog-driven UI*
shows this" (~22 rows use the second meaning; every provider-endpoint row
says `hosts:['cli']` while the Models tab reads and writes the same keys).
Eight rows contradict `CLI_CORE_SETTING_PATHS` outright
(`toolUse.requireEditApproval`/`requireBashApproval`, five `latex.*` rows,
`telemetry.enabled` — the CLI honors them, its own `/config` can't show
them). And the second catalog has second semantics: the Models tab's write
path (`SettingsProfileController.ts:199-203`) is a raw `globalState.update`
that **skips schema validation and the Kimi/OpenRouter mutual exclusion**
the CLI's write path enforces (`providerConfig.ts:170-179`) — a live
behavior split, not just bookkeeping.

**The single contract** — one row type in `stateSettings.ts`; everything
else becomes a filter over it:

- `slots: {[host]?: store}` (replaces `store`+`cliStore`+caller-chosen
  slots), `honoredBy: {[host]?: {reader, reachability}}` (fact 1 — replaces
  both core-settings path lists *and* the test-side reader registry, which
  is today a third copy of the same knowledge), `surfaces` (fact 2 —
  absorbs the Models-tab display metadata), `onWrite` (fact 3 — one write
  side-effect owner, closing the mutual-exclusion split).
- Derived: `CLI_CORE_SETTING_PATHS`, `EXTENSION_ONLY_CORE_SETTING_PATHS`,
  `KNOWN_TEXRA_KEYS`, `/config` entries, Models-tab rows,
  `settingSlot(entry,host)` → `entry.slots[host]`.
- Deletes: the two path lists + their guard (~55 L), `cliStore` + the
  `settingSlot` branch, `ProviderSettingDef.defaultValue` + the fallback
  ladder, the raw-update arm (and with it the `MODEL_ROUTING_SETTING_KEYS`
  special case in the CLI form), and the duplicate reader registry rows.
- Deserved and kept: the `config`/`workspaceState`/`globalState` store
  *kinds* — a real platform constraint; the fix is one slots map, not one
  backend.

This family also owns the audit doc's V1/V3 rulings (three physical stores,
missing host argument at `desktopSettingsIpc.ts:258`) — same PR series.

### 2.2 Approval / host-interaction plane — 9 encodings × 7 kinds, 3 live divergences

The kind vocabulary (`PERMISSION_KIND`) is single and correct. Around it,
nine parallel encodings: canonical `*PermissionSchema`s (`prompts.ts` —
the true SSOT, `PermissionBaseSchema` + per-kind `.extend()`), the webview
`{kind,data}` union, the runtime `Host*Request` types, six settlement
unions, five inbound action unions, the CLI `{kind,payload}` union, the
CLI flat decision struct, the extension per-kind decision map, and a
zombie `ApprovalDecisionSchema` nothing parses.

What the fragments are doing — and the defect: **three of the seven
runtime request types are honest aliases of the canonical schemas, with an
in-file comment explaining why aliasing is correct**
(`HostInteractions.ts:193-198`: a field added to the permission payload
reaches every host without a hand-maintained mirror). The other four are
hand-written mirrors that drop fields (`plan` alone has no `allowBypass`;
`bash` re-derives it later; `toolEdit` types `streamId` as bare `string`,
forcing a cast at `HostInteractions.ts:564`). Three spellings of the same
id (`requestId`/`approvalId`/`proposalId`) force every consumer to switch
on kind. `ToolEditApprovalResult` alone uses `{accepted: boolean}` where
its five siblings use `{action}`, which is why `SettledInteractionKind`
covers 5 of 7 kinds and toolEdit hand-writes its cancellation literal.
The CLI's payload union diverges from the wire union on 2 of 7 arms
(re-computing `relativePath`/line counts the wire already carries).

**The single contract** (touches nothing item 6/7/8 pins):

1. Alias the four hand-written `Host*Request` mirrors to their
   `prompts.ts` schemas, exactly like their three siblings — the
   highest-leverage single change in this doc; precedent, justification,
   and comment already live in the target file. Type
   `ToolEditApprovalRequest.streamId: StreamTabId | null` (deletes the
   cast).
2. One id field: `requestId` everywhere at the schema level, parse-side
   alias for the old keys (payload field names are not enumerated in the
   item-6 literal freeze — confirm with owner).
3. CLI `ApprovalPayload` becomes the shared `PermissionPayload`, TUI-only
   adornments moved beside it keyed by requestId — a new wire arm becomes
   a CLI compile error instead of a silent gap.
4. `ToolEditApprovalResult` moves to `{action}`; `toolEdit` joins
   `HostInteractionResultByKind`; the hand-written cancellation literal
   deletes.
5. Delete the zombie `ApprovalDecisionSchema` (type stays, schema dies).

Deletes ≈ 20–25 declarations; kills the class of "approval kind added,
one host silently misses a field" bugs.

### 2.3 Progress-view fact wire — 12 targeted commands are slices of one payload

Verified precisely at this HEAD: 12 of the 30 outbound arms
(`UPDATE_TODOS`, `UPDATE_PLAN`, `UPDATE_FILES`, `UPDATE_MISSING_OUTPUTS`,
`UPDATE_COMPILE_FAILURES`, `UPDATE_RUN_USAGE`,
`UPDATE_CONVERSATION_PROGRESS`, `UPDATE_STAGE`, `UPDATE_STREAM_BADGES`,
`UPDATE_QUEUED_FOLLOW_UPS`, `UPDATE_BYPASS`, `GOAL_ACTIVE_UPDATED`) are
single-field projections of the `SYNC_STREAM_CONTENT` render payload —
declared twice, independently, so a field added to the snapshot silently
misses the targeted path and vice versa. On the port, 4 of
`SessionRendererPort`'s 22 methods carry no payload at all (the host
re-reads the store), and `onParentStreamChanged`'s second argument is
ignored by the Lit implementation.

**The compliant contract (ruling-clean — this replaces the companion doc's
Wave C literal-retirement proposal, §4):** keep every literal (item 6) and
both delivery paths (item 8); declare the projection shape **once** and
derive the 12 targeted arms from it via `pickProjection(...)` (the
`RoundUpdateMessageSchema` factory already proves the idiom for three of
them); add `invalidate(streamId, slice)` to the port and collapse the four
payload-free methods + the dead parameter; make the ~8 duplicate
`progressEvents.ts` interfaces `z.infer` of their schemas. Deletes ≈ −90 L
of hand-written field declarations, 5 port methods × 2 implementations,
~8 duplicate interfaces — and, more than the LoC, a compile-time link
between the snapshot and targeted paths that item 8's "intended end state"
currently lacks.

### 2.4 Tool/capability gating — 6 tools answered in up to 4 places

Eight fragments answer "can host H use tool T": the availability probe
cache, the `DISABLED_TOOLS` setting, `passesRuntimeGates`,
`CLI_UNAVAILABLE_TOOLS` (whole file), `DESKTOP_UNAVAILABLE_TOOLS`,
`hideFromCli` on external tool defs (a *second* CLI statement,
cross-referenced to the first only by a comment), per-tool
`EXECUTION_FLAGS`, and the diagnostics sub-command narrowing. The
extension's roster is the empty set **by omission** — "VS Code has
everything" is asserted nowhere and cannot be checked. And host-gated
exclusions are silent (`agentToolResolution.ts:143` bare `continue`),
unlike the registry-miss branch that logs.

**The single contract:** the per-tool row already exists —
`defineTool({...})`. Add `hosts: {[host]?: {available: false, reason}}`
beside `requiresApproval`; the three rosters, `hideFromCli`, and the
dashboard filter all become registry projections; the extension's
full-surface claim becomes computed; exclusion messages gain `reason` for
free. Deletes: `unavailableTools.ts` (whole file), the desktop roster +
its import, the `hideFromCli` field. Deserved and kept: the probe cache
(different lifetime — refreshable vs static), `runtimeUnavailableTools` as
a run-context *parameter* (subagent inheritance, test substitution),
`SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES` (absorbed as three declarations).

### 2.5 Settings command surface — ~14 bespoke literals over one generic write

The Zod contract and registry type are genuinely single; the fragmentation
is ~14 bespoke scalar-write literals (`SET_PROVIDER_ENDPOINT`,
`SET_PROVIDER_STREAMING`, `SET_HELPER_MODEL`, `SET_CHATGPT_PREFER_SUBSCRIPTION`,
…) beside the generic catalog write `UPDATE_STATE_SETTING` — including a
**confirmed dual write path** for provider endpoints (catalog on CLI,
bespoke literal on webview hosts; two validators). Moving these keys onto
the catalog (with 2.1's row shape) deletes each literal, its inbound arm,
and both hosts' handler entries (~14 literals, ~70 L of arms, ~28 registry
entries). Second item: `SettingsCredentialActions` in
`src/controllers/settingsView/backend/` following the existing
`SettingsAgentActions`/`HistoryActions` precedent — the duplicated
credential wiring is ~140 L extension + ~180 L desktop + a 19 L CLI clone,
and desktop's own comment admits the mirror. Fold the CLI-only
placeholder-key rejection into the shared `commitProviderKey` (today only
the CLI rejects `sk-xxxxxx`). Third: the two desktop bootstrap gaps
(`refreshModelListStateIfNeeded`, `UsageLogService`) re-confirmed — the
audit doc's V2, unchanged.

### 2.6 "A stream" — 11 schemas, mostly disciplined, four defects

The composition discipline here is largely the model (`.pick()` with
anti-drift comments; `StreamSlice` pinned by item 8 — and its supersession
is the substrate doc's business, not this one). The defects:

1. **The persisted snapshot is the last production writer of the retired
   7-value `STREAM_STATUS`** (`streamSnapshot.ts:115`), whose own doc says
   it's read-only residue for the trace-viewer import path only. Move
   `StreamSnapshotSchema.status` to `StreamPhaseSchema`; the retired enum
   stays reachable only from `replayTrace`.
2. `StreamTabInfo` and `SessionStreamMetadata` overlap on 7 of 9 fields
   with three builder entry points — declare `StreamIdentityFieldsSchema`
   once, derive both, collapse to one builder (~40 L).
3. `UPDATE_STREAMS`/`UPDATE_STREAM_METADATA` carry the same
   info/state split as two fields of one message — absorbed by the 2.3
   derivation work.
4. `HistoryItemSchema`'s config summary triple is parallel to the listing
   entry's projection rather than derived from it.

### 2.7 Status vocabularies — two defects, everything else fenced

1. **`cardStatusFor` folds `CANCELLED` into `failed`**
   (`workflowScriptRun.ts:334-357`) — the exact fold `RUN_OUTCOME`'s
   contract forbids in its own doc-comment — while
   `WORKFLOW_TASK_STATUS_LABEL` declares `waiting` and `cancelled` keys no
   producer can emit. Fix: add `cancelled` to the card union, delete the
   dead `waiting` key, replace the 24-line switch with a
   compile-exhaustive projection table beside `WORKFLOW_CALL_STATUS`
   (the `RUN_OUTCOME_PROJECTION` idiom).
2. **History status labels exist on one host** — the extension has
   `HISTORY_STATUS_BADGES`; the CLI prints the raw enum ("Status:
   resumable"). Move the label table beside `HISTORY_RUN_STATUS` as a
   shared display record (the `streamStatusDisplay` idiom); both hosts
   project.

### 2.8 Main-view banners — 12 literals for one concept

`SHOW_/HIDE_` × six banner kinds + two dismissals; 9 of 12 arms are
payload-free; historical accretion, already half-subsumed by the funnel
snapshot message. One `SET_BANNER {banner, visible, data?}` message deletes
12 literals, 12 union arms, 12 slice entries. Main-view literals are NOT in
the item-6 freeze (verified: the freeze names progress-view); confirm no
external consumer (none found) and land. The file-slot literals stay —
factory-derived, zero drift risk.

### 2.9 Usage shapes — one naming split

`NormalizedUsage` deliberately renames two cache fields
(`cachedInputTokens`, `cacheCreationTokens`) vs the canonical
`TokenUsageStatsBase` spellings, with real translation code at three
sites. Rename to the canonical spellings and `.extend()` instead of
`.pick()`+redeclare (~10 L + 3 mapping rows). Gated on checking whether
`UsageLogTypes` (persisted telemetry) is externally consumed.

## 3. Retirement — the removal list

Dead code to remove now, with two-direction grep evidence. knip's baseline
is at **8 findings** (already burned down); everything here is in its blind
spots.

### Tier 1 — pure-dead, high confidence

- **Land PR #10601 (B5).** The six keyed GitHub-subscription signals →
  one keyless signal (~55 L incl. the three-member union type on
  `StreamSubscriptionRegistry` and the unread `keys` payloads) is already
  an open, verified PR from the campaign — the sweep independently
  re-derived it and confirmed it is still unlanded. Merge, don't refile.
- **`cleanupAllApprovals`** (`src/tools/approval/index.ts:125-141`) — zero
  production callers since #8656 (2026-07-17) replaced the blunt
  session-wide reset with `cleanupUnscopedApprovals` + per-stream release.
  R8-checked: the consumer removal was deliberate, siblings are live. Its
  8 test consumers call the two-line body's constituents directly.
  ~17 L + test updates.
- **`DIAGNOSTICS_ADD_RUNTIME_CAPABILITY`** — declared and consumed
  (`agentToolResolution.ts:124-184` narrowing path), produced by **no
  host**. A whole schema-narrowing arm live for a capability nobody
  claims. Either a host starts producing it or the arm deletes; today it
  is a fenceless orphan. (~25 L across the plumbing.)

### Tier 2 — options with zero passers (the DR4 class, one PR)

Six option fields with a reader, a default, and **zero writers anywhere
including tests** — each collapses to its default: `configUtils.ts:16`
`ifUnset` (whose guarded branch is thereby permanently dead),
`mainView/outbound.ts:91` `shouldFilter` (always-`true` literal, consumer
never reads it — vestigial since filtering moved server-side),
`conversationFormat.ts:42` `truncationMarker`,
`directLspAdapter.ts:68` `resolveWorkspaceRoot`, `emptyState.ts:50`
`kickerIcon`, `webAwesomeIcons.ts:323` `canvas`. ≈ 35 L as one
"orphaned option bag" PR. (The sweep covered optional fields on `*Options`
interfaces; inline `options?: {…}` bags and required-but-unread fields were
not systematically swept — a follow-up seam.)

### Tier 3 — test-only production code (needs one house ruling)

`isAgentRegistryReady` (docstring describes a caller class that does not
exist), `withToolEnvironment` (self-labeled "Test helper:" in a production
module — move to test-kernel), `beforeModelSelectionMessage`,
`logsPane.cancelRefresh`, `clearLeanServerRegistry`, `pathFix.fixPath`.
Individually 4–15 L. The maintainer should rule once whether test-only
injection seams live in production modules or test-kernel; then this is
one mechanical PR.

### Scheduled retirements (dated — put on the calendar, not in a PR now)

- `LEGACY_ICON_ALIASES` — in-file retention date **2026-10-29** (~14 L).
- `midEraWorkflowOutputStem` + readers (~110 L) — looks like a textbook
  intermediate-era reader with zero writers, but ledgered with a horizon of
  **no earlier than 2027-04-21** (`2026-07-05-architecture-checkpoints.md:342`).
  Do not delete early. **Doc-drift fix owed**: that ledger row cites
  `legacyWorkflowOutput.ts` and `legacyWorkflowOutputStem`, both since
  renamed — a future deleter will grep for symbols that no longer exist;
  update the row.
- CLI NDJSON legacy names — D3 clock (0.40 deprecate / 0.41 delete).

### Verified alive — negative results, so nobody re-greps these

`texra.latexdiffvc`/`packLatexdiffvc`/`cleanLatexdiffvc` (zero literal call
sites but invoked dynamically via `` executeCommand(`texra.${command}`) ``
— the R8 trap in the flesh); all 68 progress-view literals (producer and
consumer each); all `SessionFact` arms (the empty handler arms are
`assertNever`-mandated); all citty CLI flags; all 8 desktop
`unsupported()` sites (they *are* the capability SSOT);
`spendCheckFailed` (external relay contract — keep pending relay check);
zero `@deprecated` markers repo-wide; no `SessionRendererPort` method is a
no-op in both hosts.

## 4. Revision to the substrate plan's Wave C

The companion doc proposed retiring the ten `UPDATE_*` literals, which
required superseding §0.1 item 6 for progress-view IPC. §2.3's derivation
contract achieves the drift-elimination goal **without touching a literal**
— so that supersession request is withdrawn. The only supersession the
program still needs is item 8's "CLI `StreamSlice` fragmentation stays"
clause (Wave A). Wave C's arithmetic also changes because B4 already
landed part of it (§5): the remaining Wave C is the §2.3 derivation
(≈ −150..−200 L plus the compile link) plus the still-open
`ProgressStreamProjectionBuilder` fold and the frontend pass-through slices
(≈ −290 headroom on the renderer band per the re-measure) — call Wave C
**≈ −450..−550** rather than the previous ≈ −1,050.

## 4b. The projection-zero option (maintainer follow-up, 2026-08-15)

The maintainer asked whether projections can be eliminated outright rather
than derived. Honest inventory of what "projection" covers and how far the
count can drop:

| class | today | after the compliant plan | after projection-zero |
|---|---|---|---|
| parallel derivations (the cheats) | ~2,600 LoC | **0** | 0 |
| targeted wire arms (progress view) | 12, hand-restated | 12, derived (cannot drift) | **0** — one full-snapshot message + `LOG_DELTA` + metadata |
| `SessionRendererPort` methods | 22 × 2 impls | 17 (payload-free ones collapse) | **~5** — `invalidate(streamId, slice)` + lifecycle; hosts read the store and paint |
| display tables (labels/icons/colors) | mostly centralized already | one parameterized table per vocabulary | same — collapsing further means canonical enum values *are* the UX copy, coupling wire to wording; not recommended |
| frozen external wire (NDJSON, trace.json readers) | ~4 fenced surfaces | unchanged | unchanged — **permanent floor** |

What projection-zero requires beyond the current plan:

1. **Supersede §0.1 item 8's dual-path clause and item 6's progress-view
   literal freeze** (both by name — this is the radical Wave C the
   compliant §2.3 form was designed to avoid; with the maintainer's
   directive to reduce projections "really significantly", it is back on
   the table as the preferred end state, with §2.3 as the safe first
   stage that is a strict subset of the work).
2. **Promote todos/plan/queuedFollowUps/badges snapshots into
   `SessionState`** so no port callback needs to carry a payload the host
   cannot re-read — this is what lets the port collapse to `invalidate`.
   (For the in-process CLI this ends projections entirely: read the store,
   paint.)
3. **A bandwidth check**: the targeted arms exist as a bandwidth
   optimization; under the existing 16 ms coalescer, resending the
   per-stream content snapshot on change is plausibly fine (it is small,
   per-stream, and already the resync path), but measure before deleting —
   if a payload member proves chunky (`runUsage` maps), diff once at the
   boundary mechanically rather than reintroducing per-field messages.

Recommended sequencing: land §2.3 (derivation) first — it is
ruling-clean, small, and every line of it survives into projection-zero —
then take the two supersessions and the port collapse as one reviewed
step with the ProgressBridge suite as the parity gate.

## 5. Stale-claims register (companion docs vs this main)

Headline: **no claim in the audit doc died**; most citations verified
byte-exact (`sessionSignalsAdapter.ts:208`, the resume triads, V1a's
missing host argument, the webview timestamp-ordering bug — all confirmed
at the cited lines). Three load-bearing corrections to the substrate doc:

- **S1 (structural):** #10611 deleted `WebviewUpdater.ts` (349 L) into
  `LitSessionRenderer` (297 → 483 L) — **−163 of Wave C already banked**,
  no shim left; the remaining renderer-band headroom is ≈ −290 and the
  actor is `LitSessionRenderer`. `ProgressStreamProjectionBuilder`
  survives (158 L, 3 refs).
- **S2 (banked):** #10608/#10541 already removed `StreamSlice.files`
  (−12); `cliState.ts` is 929 L; Wave A's slice collapse is ≈ −438 and
  the wave total ≈ −983..−1,058.
- **N1 (new obligation):** B3's host-agent ratchet is now set-based and
  fails on stale headroom — deleting a host's last `@agent/*` deep import
  without pruning `config/ratchets/host-agent-import-baseline.json` in the
  same commit fails CI. Live risk for Wave A (the CLI list pins 14
  specifiers including followUp/TaskState/contextUtilization entries that
  are plausible casualties of the collapse).
- Minor: line-number drift of ±6 on ~30 citations (corrected table in the
  verification sweep's register); webview formatter count is 16, not 15;
  the headless run-fact array is now `satisfies`-pinned to the canonical
  list (only membership is hand-chosen — soften CP5); `transcriptEntries.ts`
  lives under `panes/`, 359 L. #10475 churned `SessionHandle`
  (+265 lines) — re-verify the `:221,226`/`:622-628` anchors before
  quoting them in an execution PR.
- **N3:** the eleven merges left **zero** shims, re-exports, or
  debt markers behind — grep-verified.

Program total after corrections and §4: Wave A ≈ −983..−1,058, B-1 −49,
B-2 +60 (declared), C ≈ −450..−550, D −180, plus §2 contract deletions
(≈ −400..−600 across families 2.1–2.9) and §3 retirement (≈ −130 now,
~−120 dated) → **≈ −2,100..−2,500 net**, with the drift-elimination
compile links as the real deliverable.

## 6. Execution shape

1. **Now, no ruling needed:** land #10601; the `cleanupAllApprovals` +
   orphaned-options + `DIAGNOSTICS_ADD` removals (one or two PRs); the two
   status-vocabulary defects (§2.7); the checkpoint-ledger doc-drift fix.
2. **The two exemplar-following contract PRs:** approval-plane aliasing
   (§2.2 items 1/4/5 — precedent in-file) and the snapshot-projection
   derivation (§2.3). Each deletes its mirrors in the same PR, R6/R8 in
   the body.
3. **Catalog PRs behind one ruling each:** settings row shape (§2.1 —
   also carries V1/V3), `defineTool.hosts` (§2.4), scalar-writes onto the
   catalog + `SettingsCredentialActions` (§2.5), banners (§2.8), stream
   schema fixes (§2.6), usage naming (§2.9, after the telemetry check).
4. **Test-only seam ruling** (§3 Tier 3), then its mechanical PR.
5. Wave A of the substrate plan proceeds unchanged (with the N1 baseline
   pruning added to every PR); Wave C proceeds in its §4 revised form.
