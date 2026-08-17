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
>
> **Review round applied (2026-08-16):** §2.2 bash request carve-out +
> atomic-rename preference, §2.3 delta-envelope precision, §2.4
> integration-row visibility carve-out, §2.6 legacy-inbound union for the
> snapshot status, §4b scope note (stream-state projection arms only) and
> owners-re-read correction (no duplicate SessionState fields), §7.4
> revival rows corrected. Reviews against the pre-campaign branch base
> disputed the set-based ratchet and `cardStatusFor` — both re-verified
> present at `3122ace2bc`; the docs branch has been merged with main so
> future reviews see the current tree.

Method: four sweeps on a fresh origin/main worktree — contract-surface
census, dead-code/retirement hunt, catalog-fragmentation study
(settings/status/capability), and claim-by-claim re-verification of the
companion docs. Every claim is verified-at-citation on `3122ace2bc`.

## 0. Binding constraints found in force (checked before proposing)

- `2026-08-03-ssot-consolidation-plan.md` §0.1: **item 2** — one _source_
  with projections, never one merged enum; **item 6** — frozen wire (CLI
  NDJSON names, progress-view IPC literals, persisted `result.outcome`,
  `'approveSuperYolo'`, `'updateSuperYoloBypassState'`); **item 7** —
  `SessionHostInteractions` forwards and `requestToolEditApproval`
  optionality are load-bearing; **item 8** — the snapshot+targeted dual path
  in the progress view **is the intended end state**.
- Every proposal below is shaped as _canonical schema + derivations that
  keep the existing literals_. Where a literal deletion would be needed, it
  is flagged as requiring a named supersession — and notably, the compliant
  derivation path found here means the companion doc's Wave C **no longer
  needs the §0.1-item-6 supersession it requested** (§4).
- Ratchets that bite: `shared-schemas-deep-import` (a new off-barrel
  specifier fails unless the barrel is widened in the same PR),
  `architecture-edges` (a new directed src-subsystem pair fails), and —
  new since B3 — `host-agent-import-baseline` is a **set** ratchet that
  fails in _both_ directions: a new specifier fails, and a listed specifier
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
"which host's runtime honors this" and "which host's _catalog-driven UI_
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
  both core-settings path lists _and_ the test-side reader registry, which
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
  _kinds_ — a real platform constraint; the fix is one slots map, not one
  backend.
- **Maintainer ruling (2026-08-15):** for the child-work policy toggles
  (`DETACH_SUBAGENTS_ON_STOP`, `ALLOW_ORCHESTRATOR_KILL`) the extension
  changes to match — the toggles move onto the shared `~/.texra` state
  store desktop and CLI already agree on, ending the Memento-vs-shared
  split for this class. Use this as the precedent when the same question
  recurs for other keys in the `slots` migration: prefer the shared store
  unless a worktree-scoping need is documented on the row.

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

1. Alias the hand-written `Host*Request` mirrors to their `prompts.ts`
   schemas **where the request is already schema-complete** (plan,
   proposal), exactly like their three alias siblings — precedent,
   justification, and comment already live in the target file.
   _(Carve-out from review: `HostBashApprovalRequest` stays a deliberate
   minimal request — `prepareBashApprovalPrompt()` generates `requestId`,
   computes `allowBypass` from the owning session, and normalizes
   stream/cwd to produce the presentation `BashPermission`; aliasing would
   force agent callers to manufacture host-derived presentation fields.
   Keep the explicit bash conversion; alias only the schema-complete
   types.)_ Type `ToolEditApprovalRequest.streamId: StreamTabId | null`
   (deletes the cast).
2. One id field: `requestId` everywhere at the schema level. _(Retirement
   condition added per review — no permanent compat machinery:)_ prefer an
   **atomic rename** (this is an internal monorepo wire, both ends in one
   bundle); if a parse-side alias is used at all it carries an
   introduction-date comment and a named removal release, per the
   compatibility-retirement policy. (Payload field names are not
   enumerated in the item-6 literal freeze — confirm with owner.)
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
derive the targeted arms from it. _(Precision from review: several arms are
NOT pure picks — the round updates carry a delta-only `reset` flag and
optional members, `GOAL_ACTIVE_UPDATED` flattens the discriminated
`controls.goal` — so the derivation is `pickProjection(...)` for the pure
slices and **shared value schemas + retained targeted envelopes** for the
delta-semantic arms; the envelope's reset/flattening rules are contract,
only the value shapes stop being restated.)_ Add
`invalidate(streamId, slice)` to the port and collapse the four
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
`hideFromCli` on external tool defs (a _second_ CLI statement,
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
its import, and `hideFromCli` **for agent-tool-backed rows only** —
_(review-caught: integration-only external defs like `texra-cli` have
`tools: []` and no registry row to derive from, so tool-less rows keep an
explicit visibility field; only rows whose tools all declare CLI
unavailability derive it)_. Deserved and kept: the probe cache
(different lifetime — refreshable vs static), `runtimeUnavailableTools` as
a run-context _parameter_ (subagent inheritance, test substitution),
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
   `StreamSnapshotSchema.status` to `StreamPhaseSchema` **on the write
   side, with a legacy-inbound union/transform on the parse side** —
   archived `trace.json` files carrying `ready`/`initializing`/`resuming`/
   `error`/`stopped` parse through `TraceDataSchema`, which extends this
   schema, so a hard enum swap would reject permanent-fenced files
   (review-caught). The canonical-shape-with-legacy-transform-at-entry
   pattern is the house Zod idiom.
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
   (the `RUN_OUTCOME_PROJECTION` idiom). _(Review rider: the
   phase-finalization branch that settles outstanding calls from the
   snapshot must also pass the run's cancelled outcome through — fixing
   the card union without the phase outcome would leave the fold
   half-repaired. Verified present at `3122ace2bc`; a review against the
   pre-campaign tree could not see `cardStatusFor` — re-anchor, don't
   re-litigate.)_
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
sites but invoked dynamically via ``executeCommand(`texra.${command}`)``
— the R8 trap in the flesh); all 68 progress-view literals (producer and
consumer each); all `SessionFact` arms (the empty handler arms are
`assertNever`-mandated); all citty CLI flags; all 8 desktop
`unsupported()` sites (they _are_ the capability SSOT);
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

| class                                                     | today                      | after the compliant plan               | after projection-zero                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------- | -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| parallel derivations (the cheats)                         | ~2,600 LoC                 | **0**                                  | 0                                                                                                                                                                                                                                                                                                                                                |
| targeted **stream-state projection** arms (progress view) | 12, hand-restated          | 12, derived (cannot drift)             | **0** — one full-snapshot message + `LOG_DELTA` + metadata. _(Scope, review-caught: this counts only the stream-state projection slice; lifecycle/interaction messages — `UPDATE_STREAMS`, `SET_ACTIVE_STREAM`, `SETTLE_STREAM_SELECTION`, `RELEASE_STREAM_CONTENT`, permission/inquiry/recording updates — are a different contract and keep.)_ |
| `SessionRendererPort` methods                             | 22 × 2 impls               | 17 (payload-free ones collapse)        | **~5** — `invalidate(streamId, slice)` + lifecycle; hosts read the store and paint                                                                                                                                                                                                                                                               |
| display tables (labels/icons/colors)                      | mostly centralized already | one parameterized table per vocabulary | same — collapsing further means canonical enum values _are_ the UX copy, coupling wire to wording; not recommended                                                                                                                                                                                                                               |
| frozen external wire (NDJSON, trace.json readers)         | ~4 fenced surfaces         | unchanged                              | unchanged — **permanent floor**                                                                                                                                                                                                                                                                                                                  |

What projection-zero requires beyond the current plan:

1. **Supersede §0.1 item 8's dual-path clause and item 6's progress-view
   literal freeze** (both by name — this is the radical Wave C the
   compliant §2.3 form was designed to avoid; with the maintainer's
   directive to reduce projections "really significantly", it is back on
   the table as the preferred end state, with §2.3 as the safe first
   stage that is a strict subset of the work).
2. **No new fields — re-read the existing owners** _(corrected on review:
   the original draft said "promote into `SessionState`", which would mint
   duplicate owners)_: `SessionState.snapshots` already owns todos/plan,
   `SessionState.followUps` already exposes queued follow-ups, and badges
   are already a projection of `StreamExecutionState.subagents`. A
   renderer receiving `invalidate(streamId, slice)` re-reads those members
   directly, exactly as `ProgressStreamProjectionBuilder` does today — the
   requirement is only that every port payload be synchronously re-readable
   from an existing owner, which these are. (For the in-process CLI this
   ends projections entirely: read the store, paint.)
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

## 5b. New-concept ledger (anti-reward-hack pass, 2026-08-15)

Maintainer flag, verbatim intent: proposals can "reward hack" a
consolidation directive by _inventing a new concept_ that makes the design
read cleaner while adding vocabulary. This ledger is the adversarial pass
over every named new thing across the four docs. Verdicts: **REPLACEMENT**
(standards shape or N→1 that deletes its N in the same PR — allowed),
**REWORKED** (was an invented concept; replaced with call-site fixes),
**FLAGGED** (net-positive or borderline; needs its stated justification or
it doesn't land). Rule applied: a new name is only legitimate if the PR
that introduces it deletes ≥2 hand-rolled equivalents and the concept
already exists in the code's own vocabulary or the ecosystem's.

| Proposed name                                                                                                                             | Doc                           | Verdict                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ChildStopPolicy` table                                                                                                                   | lifecycle §4                  | **REWORKED** — the SSOT function already exists; fixed to 3 call-site repairs + 1 doc paragraph. No table.                                                                                                                                                                     |
| `DisposableStore`                                                                                                                         | lifecycle §2                  | REPLACEMENT — the ecosystem-standard shape; replaces ≥10 hand-rolled registries/arrays, each deleted as it migrates; vitest leak-assert makes it self-policing. Not a coordinator.                                                                                             |
| five "lifetime roots"                                                                                                                     | lifecycle §1                  | REPLACEMENT — all five anchors pre-exist; the "roots" are documentation of them, zero new objects.                                                                                                                                                                             |
| `invalidate(streamId, slice)`                                                                                                             | substrate §6 / contracts §2.3 | REPLACEMENT — deletes 5 port methods × 2 impls; port shrinks 22→17(→~5 under projection-zero). The `slice` key type reuses the projection shape's existing field names, no new vocabulary.                                                                                     |
| `pickProjection`                                                                                                                          | contracts §2.3                | REPLACEMENT — declares once what 12 arms restate; every field name already exists on the wire.                                                                                                                                                                                 |
| `StreamLogFeed`                                                                                                                           | substrate §7                  | REPLACEMENT — mechanical dedup of two identical drivers (~−180).                                                                                                                                                                                                               |
| `projectTranscriptRow` / `TranscriptRow`                                                                                                  | substrate §5 B-2              | **FLAGGED** — genuinely a new model on the webview side; honestly +60 LoC; lands only under its drift-elimination justification and the six policy rulings. B-1 (ordering key) alone is REPLACEMENT (−49 + bug fix).                                                           |
| `SettingEntry` expanded row (`slots`/`honoredBy`/`surfaces`/`onWrite`)                                                                    | contracts §2.1                | REPLACEMENT — one row absorbs six catalogs; every field renames an existing fact, and each absorbed catalog deletes in the same series. Watch: if any absorbed catalog survives "temporarily", this becomes a seventh catalog — the exact hack; land atomically per catalog.   |
| `defineTool({hosts})`                                                                                                                     | contracts §2.4                | REPLACEMENT — a field on the existing per-tool row; three rosters + `hideFromCli` delete.                                                                                                                                                                                      |
| `SUBSCRIPTION_PROVIDERS` registry                                                                                                         | audit C9                      | REPLACEMENT — registry-as-contract is an adjudicated KEEP species; 6 restatements → 2 rows.                                                                                                                                                                                    |
| `SET_BANNER` message                                                                                                                      | contracts §2.8                | REPLACEMENT — 12 literals delete with it.                                                                                                                                                                                                                                      |
| `HostInteractionRequestByKind` aliases                                                                                                    | contracts §2.2                | REPLACEMENT — the alias pattern already exists in-file for 3 of 7 kinds; this finishes it and deletes 4 interfaces.                                                                                                                                                            |
| `resumeStreamWithRecovery`, `describeResumeStateResolution`, `withUnhandledFailureReporting`, `validateOrReport`, `describeResumeFailure` | audit C1–C21                  | **FLAGGED** — helper extractions; the repo's history says extract-shared net-ADDS. Each is only legitimate because it deletes byte-identical copies in ≥2 hosts in the same PR and closes a named correctness gap; any that can't show net-≤0 _plus_ the bug fix doesn't land. |
| `JsonStoreSecrets` base + `withEnvOverride`                                                                                               | audit C6                      | **FLAGGED** — base-class extraction with 2 implementers; borderline under the LOC lesson. The non-negotiable part is the missing PQueue on Electron (a bug); the base class lands only if net-negative, else fix the bug alone.                                                |
| `TuiApprovalAdornments`                                                                                                                   | contracts §2.2 item 3         | FLAGGED-minor — relocates 2 existing fields out of the payload union; only worth it as part of the union unification, never alone.                                                                                                                                             |
| `TraceDocument → SessionState` hydrator                                                                                                   | substrate §6d                 | REPLACEMENT — deletes the hand-built payload duplication (~−100); the hydrator's target type exists.                                                                                                                                                                           |
| headless `SessionRendererPort` impl                                                                                                       | substrate §3                  | REPLACEMENT — a port implementation (the port exists); deletes the hand-rolled `RenderState` fold (~−175).                                                                                                                                                                     |

Standing guard for execution agents: any PR whose "consolidation" adds a
name not on this ledger, or lands a ledger name without its paired
deletions, is the flagged failure mode — reject in review.

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

## 7. Second-order removal map (2026-08-16 cascade round)

> Produced by a 12-agent workflow on origin/main `3122ace2bc`: five what-if
> cascade sweeps (Wave A, projection-zero, contracts, lifecycle, whole-module
> obviation) + a deep-module (Ousterhout) seam analysis, every risky
> last-consumer claim adversarially re-checked before inclusion.

Scope: what the five verified cascade sweeps (Wave A, projection-zero, contracts, lifecycle, whole-module obviation) prove is removable **beyond the first-order rows already tabled in this doc**, with adversarial verdicts applied — corrections folded in, refuted claims dropped, checked-negatives kept as an explicit register. All citations are at origin/main `3122ace2bc` unless noted. House rules apply to every PR in this map: **no new concept without a paired deletion in the same PR (§5b ledger)**; **R6 (consumer evidence, file:line) and R8 (looks-orphaned-but-isn't guard) sections in every PR body**; **set-based ratchet baselines pruned in the same commit as the last-import deletion** — never as a follow-up.

### 7.1 The deep-module frame

One thesis governs the map: the storage/protocol floor is already deep (lease, stores, handle); the debt is a shallow projection band between one substrate and N renderers. Every wave is one of two Ousterhout repairs — _narrow_ an interface that enumerates its implementation, or _pull downward_ complexity consumers re-implement.

| Seam                                                                            | Width today                                                                                      | Verdict                                                                                           | Industry pattern it maps to                                                                                                                           | Executing wave           |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `SessionRendererPort` (`src/controllers/session/SessionRendererPort.ts`, 113 L) | 22 methods × 2 impls; 18 are `on<Field>Changed`                                                  | **NARROW** → `invalidate(streamId, slice)`                                                        | Dirty-region / damage model (invalidate-then-paint)                                                                                                   | contracts §2.3, then §4b |
| `HostInteractions` shapes (`src/agent/runtime/HostInteractions.ts`)             | 7 kinds, 4 hand mirrors, 2 result idioms, 3 id spellings                                         | **KEEP surface / DEEPEN shapes** (alias to `prompts.ts`, unify `{action}`)                        | Parnas information hiding — one canonical shape, aliases at the seam; hexagonal port with default no-op adapter                                       | contracts §2.2           |
| Platform ports (`src/platform/platform.ts:36-57`)                               | 14 ports / ~49 methods                                                                           | **KEEP — fence row**                                                                              | Few-fat-ports hexagonal (depth = hidden decisions, not method count; `fileLocks.runExclusive`, `agentResume.tryResumeStream` are 1-method deep ports) | none                     |
| `SessionState` reads (`SessionState.ts`, 450 L)                                 | 16 methods + 5 sub-stores; fresh-object reads (`:239`) push change detection into every consumer | **DEEPEN** — U2 stable-identity reads + §4 promotions                                             | Pull complexity downward; single egress waist                                                                                                         | substrate A0 / Wave A    |
| `StreamSnapshotStore` (2,164 L)                                                 | 24 methods + 5 units, ratcheted                                                                  | **KEEP — cite as house model**                                                                    | Interface-width budget in CI (Ousterhout depth metric; `getRunMetadata`=5-units rule blocks the aggregate-getter cheat)                               | none                     |
| `StreamLogStore` (1,745 L)                                                      | 24 methods; twin delta pumps above it (`WebviewBridge` 189 L + `subscribeStreamLog` 500 L)       | **KEEP store; BUILD `StreamLogFeed`** (~120 L)                                                    | Missing deep module — pull resync/coalesce/gap-detect down once                                                                                       | substrate D              |
| `executionLease` (863 L / 18 verbs)                                             | wide-ish, every verb one protocol obligation                                                     | **KEEP untouched; fix callers**                                                                   | Define errors out of existence (`completeOwnedExecutionLease:706-722` completes-as-abandon); structured-concurrency scoped combinators                | lifecycle §3-2 / PR 4    |
| Settings access                                                                 | ≥9 entry points, 3 altitudes, 6 catalogs                                                         | **DEEPEN** — one `SettingEntry{slots, honoredBy, surfaces, onWrite}` row; catalogs become filters | Somewhat-general-purpose interface; single source of truth with derived views                                                                         | contracts §2.1           |
| PROGRESS_VIEW outbound (29 commands / 34 schemas)                               | 12 arms are single-field slices declared twice                                                   | **NARROW** — derive, then waist                                                                   | Narrow waist / hourglass (in-tree exemplar: frozen NDJSON rail with `CliNdjsonActiveChildRow` boundary re-projection)                                 | contracts §2.3 → §4b     |
| `SessionHandle` (1,215 L)                                                       | 13 methods + 16 subsystem fields; hand-rolled dispose at `:1073-1107`                            | **KEEP shape; DEEPEN dispose** via `DisposableStore`                                              | DDD aggregate root (Demeter-purism correctly discounted); LIFO disposable store                                                                       | lifecycle PR 3           |

The change-one-place test before/after: adding a stream-state field today touches ~7 sites (applier arm, port method, 2 impls, snapshot payload, targeted arm, frontend slice); post-program ≈ 2 (schema field + projection shape).

### 7.2 Removal map by unlocking wave

Consumer-evidence status legend: **V** = verified exhaustive by cascade sweep and confirmed by adversarial pass; **V-adj** = verified after adversarial correction (corrected consumer set is the binding one); **gated** = removal correct but blocked on a named ruling/supersession.

#### Wave A (unlocked by the A0 substrate PR: roster/tombstone/`parentStreamId`/`runStartedAt`/`contextState` promotions into `SessionState`)

| Item                                                                                                                                                                                                                                                                                                       | LOC      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Unlocking PR   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `packages/cli/src/chat/tui/state/childExecutions.ts` 585 → ~35 remnant                                                                                                                                                                                                                                     | −550     | **V-adj** — original per-export list REFUTED as incomplete; binding consumer set adds 4 files: `packages/cli/scripts/tui-harness.tsx:110-115` (imports 6 of the dying exports; uses at `:1364,:2042,:2092,:2161,:2209,:2214,:2259` — type-checked via workspace tsconfig though outside the ratchet's `packages/cli/src` scope), `StaticConversationTranscript.tsx:27-30` (reads `:1213-1214`), `StatusBar.tsx:38-39` (reads `:73-74,:257,:304`), `sessionCommands.ts:12-13` (reads `:103,:109,:117`). Every missed read is of roster/parent-map data the wave promotes; migration surface is 4 files larger than the cascade report claims. | Wave A main PR |
| `subscribeStreamStatus.ts`                                                                                                                                                                                                                                                                                 | −57      | **V-adj** — 3 consumers beyond `runChatTui.tsx:97,403`: `tui-harness.tsx:130,:2505` (plus ordering-contract comments `:287,:1281,:1506,:2495` pinning the attach-before-subscribe sequence the wave dissolves), `TuiStateAndFocus.vitest.ts:57,:381` (shared dispose — touches far more of that file than the two scoped blocks), `ConversationTranscript.vitest.ts:59,:326,:364`. Still deletable; all consumers inside the rewrite surface.                                                                                                                                                                                                | Wave A main PR |
| `subscribeStreamArtifacts.ts`                                                                                                                                                                                                                                                                              | −135     | **V** — exhaustive grep confirmed: production consumers `runChatTui.tsx:95,345`, `sessionCommands.ts:29-30,64,74`, `sessionSignalsAdapter.ts:45,77,314`, `registerBuiltins.tsx:82,279`; tests `SubscribeStreamArtifacts.vitest.ts` (dies), `SlashCommandDispatch.vitest.ts:43,180-181` (rewrites).                                                                                                                                                                                                                                                                                                                                           | Wave A main PR |
| `cliState.ts` 929 → ~490                                                                                                                                                                                                                                                                                   | −438     | **V** — 26/30 `StreamSlice` fields → `StreamState & CliOnlyFields`; tombstone guards `:505,:588,:869` → `SessionState` reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Wave A main PR |
| `sessionSignalsAdapter.ts` 372 → ~90                                                                                                                                                                                                                                                                       | −280     | **V** — patch forwarders `:103-290`, roster filter `:208` (U1), status bypass `:340`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Wave A main PR |
| `streamViews.ts` 262 → ~140                                                                                                                                                                                                                                                                                | −120     | **V** — label half dies; scope/ancestor helpers keep (`StreamViews.vitest.ts` 77 L survives whole)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Wave A main PR |
| `runProgressRenderer.ts` 573 → ~395                                                                                                                                                                                                                                                                        | −175     | **V** — `handleSessionFact`/`handleRunFact`/roster bookkeeping `:209-405`; ANSI/throttle/heartbeat keep                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Wave A main PR |
| `statusBarDisplay.ts` context gauge `:207-226,:320`                                                                                                                                                                                                                                                        | −27      | **V** — reads promoted `contextState`; shared model symbols keep (6 other CLI consumers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Wave A main PR |
| `resumeHint.ts` `collectResumeTargets:150-191`                                                                                                                                                                                                                                                             | −15      | **V** — `formatResumeCommand` & friends keep (3 external consumers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Wave A main PR |
| Tests: `SubscribeStreamArtifacts.vitest.ts` (350, whole), `support/childStreamEntries.ts` (136, whole — **V**, exactly 4 consumers), `TuiStateAndFocus` blocks `:3938-4261` (324) + `:3192-3905` (~713 majority) + child-edge tests `:398-648` (~150-200), `RunProgressRenderer.vitest.ts:643-1003` (~360) | ≈ −1,900 | **V** / **V-adj** (`ConversationTranscript.vitest.ts` rewrite is larger than "roster fixture swap" — it also consumes `subscribeStreamStatus`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Wave A main PR |

#### Compliant wire (unlocked by contracts §2.3 `pickProjection` PR; survives into projection-zero as a strict subset)

| Item                                                                                                                    | LOC     | Evidence                                                                                                                                                                                                                                       | Unlocking PR   |
| ----------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `pickProjection` derivation replaces hand-written field declarations in `outbound.ts`                                   | −90     | **V** (superseded by §4b A1 if projection-zero lands)                                                                                                                                                                                          | §2.3 PR        |
| Port 22→17: 4 payload-free methods + `onParentStreamChanged` dead param, ×2 impls                                       | −60     | **V**                                                                                                                                                                                                                                          | §2.3 PR        |
| `progressEvents.ts` ~8 interfaces → `z.infer`                                                                           | −40     | **V** — file does NOT delete (SessionFact vocabulary, upstream of wire)                                                                                                                                                                        | §2.3 PR        |
| `ProgressStreamProjectionBuilder.ts` (158 L → 0; net −80 after `streamContent():77-135` relocates as the SYNC snapshot) | −80 net | **V** — consumers `LitSessionRenderer.ts:5-7,55`, `ProgressBackend.ts:17,104,147`, `StreamContentSync.vitest.ts:9,101` (rewrites). **Rider:** replayTrace 6d hydrator must land same wave (`replayTrace.ts:228` hand-builds the same payload). | Wave C         |
| `replayTrace.ts:166-260` hand-built payloads → 6d hydrator                                                              | −100    | **V** — compat readers `:105-163` fenced permanent                                                                                                                                                                                             | Wave C / 6d PR |
| `messageIndex.ts` timestamp machinery (`insertByTime:27-44`, `messageTime:46-48`, `toSorted:218-222`)                   | ~−50    | **V**, **B-1-dependent** — not projection-zero                                                                                                                                                                                                 | B-1 PR         |

#### Projection-zero-only (gated: §4b's two named supersessions + bandwidth measurement before deletion — runUsage maps are the flagged chunky member)

| Item                                                                                                    | LOC        | Evidence                                                                                                                                                                                                                                                                                                                                                | Unlocking PR        |
| ------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `outbound.ts` 12 schemas + union rows (`:97-110,:134-182,:236-245,:365-370,:382-411`)                   | −95        | **V** — sole producer `LitSessionRenderer.ts`, sole consumer surface the five frontend slices; trace-viewer emits only the 3 kept messages; desktop has no independent producer. **V-adj:** `scripts/capture-walkthrough-media.mjs:427,:438` injects `updateFiles`/`updateRunUsage` into the frontend dispatcher — must update in the same change.      | §4b supersession PR |
| `src/shared/ipc.ts` 12 literal keys (`:131-152,:182`)                                                   | −12        | **gated** — frozen by §0.1 item 6; requires the §4b item-1 supersession (with item 8's dual-path clause) named in the PR                                                                                                                                                                                                                                | §4b supersession PR |
| `runTrackingSlice.ts` whole file (76) + `stateUtils.updateRounds:24-34` (last consumer dies)            | −87        | **V** — sole importer `messageDispatcher.ts:22`; `updateWorkflowState`/`setStreamStateForId` survive elsewhere                                                                                                                                                                                                                                          | §4b PR              |
| `taskSlice.ts` whole file                                                                               | −30        | **V** — sole importer `messageDispatcher.ts:21`; `updateToolUseState` survives ×6 sites                                                                                                                                                                                                                                                                 | §4b PR              |
| `streamMetaSlice.ts:165-187` + `permissionSlice.ts:88-118` + `followUpSlice.ts:60-67`                   | −62        | **V** — `deriveGoalState` survives (`StreamHeader.ts`)                                                                                                                                                                                                                                                                                                  | §4b PR              |
| `LitSessionRenderer.ts` targeted-send band + debounce apparatus (`:162-306,:434-480,:35,:44-52,:94-96`) | −170 net   | **V** — `updateBypassState`'s one caller `progressBackendUiConfig.ts:277` confirmed; `followUps` ctor dep referenced only at `:284` (dying) → `@agent/followUp` type import drops                                                                                                                                                                       | §4b PR              |
| `SessionRendererPort.ts` 113 → ~35                                                                      | −78        | **V** — open point: `onStreamDescriptionChanged`/`onInquiryThreadUpdated` (kept wire) unruled                                                                                                                                                                                                                                                           | §4b PR              |
| `sessionSignalsAdapter.ts` per-field patches `:185-307`                                                 | (−125)     | **V — do not double-count:** these lines are inside Wave A's −438/−280; count once                                                                                                                                                                                                                                                                      | —                   |
| `SessionFactApplier.ts` notify half `:82-110,:277-315`                                                  | −40        | **V** — file survives (owns fact→state)                                                                                                                                                                                                                                                                                                                 | §4b PR              |
| Tests: `ProgressBackendFactProjection.vitest.ts` targeted-delivery/debounce suites (`:622-732,:1076`)   | −250..−350 | **V** — false positives excluded: `CodexProgressEvents`/`ToolUseProgressEvents`/`OutputProgressEvents`/`CliSessionProgressSubscription`/`SessionEventHub`/`StreamSnapshotStore`/`RunExecution` vitest files match only run-fact **types** (`sessionProgressSubscription.ts:100-160` projects onto the frozen NDJSON wire, which keeps) — NOT casualties | §4b PR              |

#### Contracts (unlocked by the §2.x family PRs)

| Item                                                                                                                                                                                                                                                                                             | LOC                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                 | Unlocking PR |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `CLI_CORE_SETTING_PATHS` + `EXTENSION_ONLY_CORE_SETTING_PATHS` + `_AssertEveryCorePathClassified` (`coreSettings.ts:507-565`)                                                                                                                                                                    | −85                               | **V-adj** — code consumers complete (`knownKeys.ts:2,25` rewrites; `stateSettings.vitest.ts:14,16,536-560` dies), **but** both names sit in `shared-schemas-deep-import-baseline.json:120,124` and the `does not shrink the leaf-aware published surface` gate fails on export disappearance regardless of importers → baseline regen (`TEXRA_UPDATE_SHARED_SCHEMAS_BASELINE=1`) in the same PR          | §2.1 PR      |
| Test reader registry `stateSettings.vitest.ts:455-514,:535-588`                                                                                                                                                                                                                                  | −90..−100 test                    | **V** — third catalog copy absorbed by `honoredBy`                                                                                                                                                                                                                                                                                                                                                       | §2.1 PR      |
| `cliStore` field + `settingSlot` branch (`stateSettings.ts:156,:349-400`; `settingsAccess.ts:45`)                                                                                                                                                                                                | ~−8 + rewrites                    | **V**                                                                                                                                                                                                                                                                                                                                                                                                    | §2.1 PR      |
| `PROVIDER_SETTINGS` record (`providers.ts:389-454`) + 7 `*_PROVIDER_SETTING` exports (`:314-387`, sole importer `stateSettings.ts`) + `ProviderSettingDef.defaultValue` + controller thinning (`SettingsProfileController.ts:100-115,:200-217,:241-251`)                                         | −140 + −45                        | **V** — the raw `globalState.update` bypass at `:200-204` routes via `applyStateSettingUpdate`                                                                                                                                                                                                                                                                                                           | §2.1 PR      |
| ~14 scalar-write literals → `UPDATE_STATE_SETTING` (`settingsView/inbound.ts` arms + ipc rows + ext handler `:447-483,:530-566,:1011-…` + desktop `:197-227,:377-407,:504-…`)                                                                                                                    | ≈ −180 across 4 layers            | **V** — orphan alert: `enabledFlag` (`inbound.ts:47-49`) has exactly 5 callers, all migrating → must delete same PR (knip)                                                                                                                                                                                                                                                                               | §2.5 PR      |
| `SettingsCredentialActions` extraction: ext `:434-446,:852-…` (~~−140), desktop `:344-375` (~~−180), CLI `providerApiKey.ts` (47)                                                                                                                                                                | flagged net-≤0                    | **V** — FLAGGED-class: must land net-≤0 with the sk-placeholder gap closed on all hosts; V3 rider `desktopSettingsIpc.ts:258` gains the missing `host` arg                                                                                                                                                                                                                                               | §2.5 PR      |
| `packages/cli/src/runtime/unavailableTools.ts` whole file                                                                                                                                                                                                                                        | −35                               | **V-adj** — import list complete (`chatSessionController.ts:44,428,584,717`; `runExecution.ts:52,516`), but "zero test importers" is literal-only: `RunExecution.vitest.ts:25-26,164-169,:419,:429-437` and `DesktopAgentExecutionFactory.vitest.ts:14-15,:325-328` **reconstruct and pin the roster contents** without importing it — both suites rewrite against the `hosts` projection in the same PR | §2.4 PR      |
| `DESKTOP_UNAVAILABLE_TOOLS` (`desktopAgentLaunch.ts:18-22,:53`; `desktopAgentResume.ts:14,137`) + `hideFromCli` (`externalToolDefs.ts:109,:525-526,:549`; `cli/runtime/tools.ts:33`)                                                                                                             | −10 + filter                      | **V** — test pin `externalToolDefs.vitest.ts:56` rewrites                                                                                                                                                                                                                                                                                                                                                | §2.4 PR      |
| Approval aliasing: 4 mirrors → `prompts.ts` aliases (`HostInteractions.ts:175-191`; `toolEditApproval.ts:49-55` incl. the `:564` cast), `{accepted}`→`{action}` (`:62-73`, cancellation literal `:567` dies for `cancellationResultFor`), zombie `ApprovalDecisionSchema` (`prompts.ts:188-198`) | ≈ −35 decl + 7 test-file rewrites | **V** — extension's `ApprovalDecision` in `progressView/frontend/events.ts:140` is a different type, untouched                                                                                                                                                                                                                                                                                           | §2.2 PR      |
| `SET_BANNER`: 12+3 ipc rows (`ipc.ts:49-68`), schema arms (`mainView/outbound.ts:109-124,:160-171`), 2 bannerSlices collapse                                                                                                                                                                     | −100..−120                        | **V** — main-view literals not item-6 frozen; 4 test suites pin literals                                                                                                                                                                                                                                                                                                                                 | §2.8 PR      |
| Stream-schema §2.6: `streamSnapshot.ts:115` status fix (legacy-inbound union required — persisted data), `StreamIdentityFieldsSchema` declare-once (builders collapse)                                                                                                                           | ~−40                              | **V** — `STREAM_STATUS` enum does NOT delete (trace-viewer `replayTrace.ts:131-132` keeps it; fence only)                                                                                                                                                                                                                                                                                                | §2.6 PR      |
| `cardStatusFor` switch (`workflowScriptRun.ts:334-357`) → projection table; `cancelled` joins the union (ripple: 7 exhaustive consumers gain an arm; `waiting` key deletes)                                                                                                                      | −24 + ripple                      | **V**                                                                                                                                                                                                                                                                                                                                                                                                    | §2.7 PR      |
| Usage naming (`NormalizedUsage.ts:37,41`; `RunUsageAccumulator.ts:44,46`; `UsageMonitor.ts:144-145,:213,:269-291`)                                                                                                                                                                               | −10 + 3 mapping rows              | **V** — hard gate: `UsageLogTypes` external-consumer check first                                                                                                                                                                                                                                                                                                                                         | §2.9 PR      |

#### Lifecycle (unlocked by lifecycle PRs 2–8: `DisposableStore`, session-root lease settlement, join-with-deadline shutdown, run-scoped resources)

| Item                                                                                                                                                                                                  | LOC                                                         | Evidence                                                                                                                                                                | Unlocking PR |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `CLI_RUN_SHUTDOWN_GRACE_MS` race (`runExecution.ts:56,:446-467` + obsolete comments `:411-414,:429-437`)                                                                                              | −24 (+ test `:976-1001` moves to `LifecycleHost.vitest.ts`) | **V**                                                                                                                                                                   | PR 5         |
| CLI lease settlement (`sessionExitController.ts:18,:166-177`) → `SessionHandle.dispose`                                                                                                               | −12                                                         | **V** — `SessionExitLease.vitest.ts` (166 L) retires whole; behavior re-pins at session root                                                                            | PR 4         |
| CLI `disposers` arrays ×3 sites (`runChatTui.tsx:334+7 pushes`; `chatSessionController.ts:179,:195,:207-213,:383`; `sessionExitController.ts:79,:331`)                                                | −20                                                         | **V**                                                                                                                                                                   | PR 2         |
| `RESET_HOOKS`/generation machinery (`cliState.ts:879-889,:928`)                                                                                                                                       | −15                                                         | **V**                                                                                                                                                                   | PR 2         |
| `SessionHandle` teardown: `teardownOwners:1093-1107` → `store.dispose()`, hand-rolled aggregation `:1073-1091`, stale comments `:142,:1065-1072,:1099`                                                | −34                                                         | **V** — `throwAggregated` SURVIVES (5 other live sites: `SessionHandle.ts:872,963`; `StreamSnapshotStore.ts:1704`; `SessionStores.ts:431`; `executionLifecycle.ts:167`) | PR 3         |
| Extension registrations: polling `extension.ts:299-307` (+3 imports), recording hook `:293` (→ `killActiveRecording` internalizes, `audio.ts:26-27,:140`), UsageLog dual registration `:294,:495-499` | −15                                                         | **V**                                                                                                                                                                   | PRs 5, 8     |
| Desktop window-root ledger (`index.ts:1101-1145`) + `pendingDesktopDiffHostDispose` hand-off (`:158-169,:1108-1117,:1246`) + mutable-closure disposers (`:1228-1269`)                                 | −70                                                         | **V** — `ElectronCompositionRoot.vitest.ts:93-118` source-text pins retire (~35 test L)                                                                                 | PR 7         |
| `AgentLaunchResources.ts` whole file (98) → store `move()`                                                                                                                                            | −68 min                                                     | **V** — all consumers `AgentLaunchContext.ts:75,:290,:634,:643,:646`; `AgentLaunchResources.vitest.ts` (24) retires whole                                               | PR 8         |
| `agentCliSessionStores.ts` singletons + shutdown wiring (`:6-10,:19-29`) → session-keyed                                                                                                              | −12                                                         | **V** — `packages/agent/src/index.ts:34-35,:306,:309` re-exports die/become accessors; `AgentPackage.vitest.ts` surface pin drops 2 names                               | PR 8         |
| Stream→execution resolver dedup (`SessionStores.ts:314-334` vs `SessionHandle.ts:689-730`)                                                                                                            | −25..−35                                                    | **V** — `SessionRestartRepair.vitest.ts:88` re-anchors                                                                                                                  | PR 8         |
| `clearInlineAgents` (`agentRegistry.ts:149` + barrel) delete-or-wire                                                                                                                                  | −10 or 0                                                    | **V** — production-dead; consumers are 2 test files only                                                                                                                | ruling       |

### 7.3 Ratchet / baseline pruning obligations per wave

All `host-agent-import-baseline.json` prunes are **CI-forced same-commit**: the ratchet is set-based and "a listed specifier with no live import is stale headroom and also fails" (baseline semantics header; enforced by `hostAgentDeepImportRatchet.vitest.ts:158`).

- **Wave A:** prune exactly one `hosts.cli` row — `@agent/modelHandlers/support/contextUtilization` (sole CLI import `statusBarDisplay.ts:3`, dies with B5; shared symbol keeps 6 `src/` consumers — row goes, module stays). **V** — the other 13 CLI rows all retain live imports post-wave (`@agent/core/state/TaskState` via `cliNdjsonProgressEvents.ts:1`, frozen NDJSON). Standing watch: `@agent/trace`'s survivor margin after B2+B4 is 3 files — if a later wave removes them, that row becomes a same-commit prune too. Ratchet scope is `packages/cli/src` only, so `tui-harness.tsx` never masks a row — but the harness IS workspace-type-checked, so its rewires land in the same PR.
- **Projection-zero:** prune `@agent/followUp/ToolUseFollowUpQueueManager` (sole: `chatSessionController.ts:22`) when its import dies; `TaskState` likely keeps (NDJSON). **V-adj:** the stale `WebviewUpdater.ts` row at `shared-schemas-deep-import-baseline.json:547` (file deleted by #10611) is **voluntary hygiene, not CI-forced** — that ratchet only rejects new imports and surface shrink; prune opportunistically, don't block a wave on it.
- **Contracts:** §2.1 PR must regenerate `shared-schemas-deep-import-baseline.json` in-PR (surface-shrink gate fails on the deleted `CLI_CORE_SETTING_PATHS`/`EXTENSION_ONLY_CORE_SETTING_PATHS` exports independent of importers). knip orphan sweep per PR: `enabledFlag`, the 7 `*_PROVIDER_SETTING` exports, `saveProviderApiKey`/`providerApiKey.ts`, `ProviderSettingDef.defaultValue`. No `@agent/*` baseline movement expected (`approvalAdapter.ts` imports via `@tools`); re-verify on the toolEdit PR. `SettingsCredentialActions` lands under `src/controllers/` (outside the shared-schemas ratchet); verify no new `architecture-edges` pair (mirrors existing `SettingsAgentActions` edges).
- **Lifecycle:** `approvalPolicyAuthorityRatchet.vitest.ts:45` hardcodes `approvalAdapter.ts` by name — move the row if the file renames. `AgentPackage.vitest.ts` fenced-surface list drops `CodexThreads`/`ClaudeAgentSessions`.
- **Wave D:** `transcriptResidencyLeaseSites` allowlist row moves from `subscribeStreamLog` to `StreamLogFeed`.

### 7.4 Revival list — dead→live obligations the new architecture creates

1. **`thinkingActive` has no fact-rail writer** — it derives from the log rail (`subscribeStreamLog.ts:376-383`); promotion requires a **new session-owned fact emission** (allowed via `SessionHandle.events`, but net-new wire vocabulary the docs don't cost). Highest-risk promotion row. _(`compactingActive` is withdrawn from the promotion list entirely — the shared `CompactionActivityBlock` already owns compaction liveness on both hosts; see the substrate doc §4 correction.)_
2. **`contextState` becomes backend-written** (`streamState.ts:157` is frontend-owned today; `CONTEXT_STATE` is a log entry parsed at `logSlice.ts:135`) — same rail problem, plus the CLI's first-ever reader (zero refs in packages/cli today).
3. **`WORKFLOW_TASK_STATUS_LABEL.cancelled` goes live** — its 5 consumers (`SubagentList.tsx:289`, `WorkflowRunDetails.tsx:87,164`, `workflowPlainOutput.ts:33`, `workflowCallFormatter.ts:92`, `copy/workflowCall.ts:162`) start receiving a previously unproducible key; `waiting` deletes.
4. **Desktop `loginWithDeviceCode`** (C9) — desktop gains a device-code consumer it has never had.
5. **Desktop `UsageLogService.initialize` + `refreshModelListStateIfNeeded`** (V2) — dormant flush-timer/retired-model paths go live; first desktop writers for `editorType`/`extensionVersion`.
6. **AppSignals in desktop/CLI** (V7) — zero refs in either package today; wiring is net-add, uncosted.
7. **Per-subagent `resumeEligible` roster row** (§4, renamed on review — it is admission eligibility, not durable resumability; actual resumability derives at the durable-state boundary on demand) — new webview affordance + action plumbing.
8. **U1 retention policy** — deleting the `finishedAt` filter (`sessionSignalsAdapter.ts:208`) forces `resetPerRunChildState` (`SessionState.ts:310-332`) to grow a declared per-host retention policy.
9. **Shared tombstone writer** beside `clearStream` (fixes applier re-minting ~`:353`; deletes CLI `childExecutions.ts:353-434`).
10. **`clearInlineAgents`** — delete-or-wire; "wire" is a revival (new lifecycle-registration caller).
11. **Smaller:** CLI gains C2 early-bail, C4 degraded-store, C21 lease-active message; desktop gains C12 `docsCommand`; Electron secrets gain the PQueue; `RETAINED_FINISHED_CHILDREN_CAP` gains a cross-package import; `isEmptyUsage` gains 2 host consumers; `getProposalFileGroups`/`buildDelegationSections` gain CLI transcript consumers (§4 parity); `SessionState.getStreamTabInfo` gains the CLI (C20).

Every revival row is a §5b ledger entry: the PR introducing it must name its paired deletion.

### 7.5 Not-removable negatives register (checked; keep as R8 guards in PR bodies)

- **`SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES` deletion — REFUTED.** The "only two consumers" premise is false; the export does **not** delete with §2.4. Treat as keep (or at most the setup-module's own derivation) until a fresh consumer census says otherwise.
- **`STREAM_TRANSITION_CAUSE`** — keeps: `src/agent/runtime` (SessionHandle, StreamStatusService, AgentRunLifecycle, AgentLaunchContext, restartRepair), `nativeSubagentStrategy.ts:52`, `streamStatus.ts`, `tui-harness.tsx:67`.
- **`contentStore.ts` (127 L) — dispute upheld:** Lit-DOM modality (content-addressable registry; `LogList.ts:53`, `htmlBuilders.ts:35`, `toolFormatters.ts:48`, cleared at `streamLifecycleSlice.ts:215,241`). Deletable only under B-2's Lit-template adoption; the claimed −127 is **not** in any wave total.
- **`streamMetaSlice.ts`** — whole-module death only under projection-zero; `UPDATE_STREAM_STATUS:99-142` carries real policy, `UPDATE_STREAM_METADATA` carries the description-race buffer (`streamLifecycleSlice.ts:32`).
- **`approvalAdapter.ts` (319 L)** — headless `HostInteractions` impl + 3 shape converters keep; §2.2 reshapes ~40-60 L only. Allowlisted by name at `approvalPolicyAuthorityRatchet.vitest.ts:45`.
- **`classifyRejection`** (4 tool consumers) and **`cancellationResultFor`** (keeps and grows — toolEdit joins) — only the `:567` hand-written literal dies.
- **`streamStatusDisplay.ts`** — §2.7.2's exemplar idiom; gains a sibling, loses nothing. **`subagentFollowup.ts`** — zero removal (comment fix only). **`htmlMarkdownNormalize.ts`** — relocation, net ≈ 0.
- **`syncSlice.ts`, `streamStateMerge.ts`, `inquirySlice.ts`, `logSlice.ts`** — handlers of kept messages; survive (syncSlice becomes the primary content path).
- **`WebviewBridge.ts`** — survives projection-zero (LOG_DELTA is a kept path); only Wave D reshapes it.
- **`STREAM_STATUS` / `streamStatusToLifecycleStatus`** — trace-viewer-reachable; fence, don't delete. Runtime `streamStatus` registry vitest uses are a different surface — not casualties.
- **`replayTrace.ts` compat readers + `legacyTraceIdentity` (`:105-163`)** — fenced permanent. **`providers.ts` survivor set** — `providerDisplayName`, `KIMI_CODE_BASE_URL`, defaults, `PROVIDER_STATE_ENTRIES` all keep.
- **`LogMessageDataSchema` + `toLogMessage`** — B-2-gated only; threading through ~20 formatter files makes this a retyping cascade, not a deletion. Distinct from fenced `LegacyLogMessageSchema`.
- **Lifecycle survivors:** `SessionScope.vitest.ts` (pins isolation, not choreography), `throwAggregated`, sessionExitController signal handlers (`handOffCliShutdownSignalHandlers`, SIGTSTP/SIGCONT, `printResumeHintOnExit`), the entire `executionRegistry.ts` surface (1,002 L — nothing loses its last consumer; cross-root verbs kept by ruling), extension double-dispose comment (`extension.ts:289-292`).
- **`desktopAgentExecution.ts` sheds ~0 in projection-zero** — its registry is inbound + host-specific handlers; `UPDATE_RECORDING:583`, `UPDATE_FOLLOW_UP_TEXT:912,983`, `GETTING_STARTED_ACTION:953` all keep. Any claim otherwise is an R8 error.
- **`executionListing.ts` / `historyViewMessages.ts`** — both keep (§2.6.4 derives the triple only). **`ProviderSettingSchema`/`ProviderSettingDefSchema`** — survive as wire/derivation shapes (ruling-dependent for Models-tab rows).
- **Stale sub-claim narrowed:** the audit's "approvalQueue recomputes relativePath/line counts" did not reproduce outside `DiffView.statsFromHunks:52-63` — only that ~15 L dies (C17); `diffHunks.ts` keeps (3 consumers).

### 7.6 Honest totals and reconciliation against the first-order estimate

Production LOC, net, by wave (adversarial corrections applied):

| Wave                        | Production net                                                                              | Test/fixture net (separate ledger)                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Wave A                      | −983..−1,058                                                                                | ≈ −1,900 deletable (+ smaller retarget set)                                        |
| B-1 / B-2                   | −49 / +60 (flagged)                                                                         | messageIndex + `TaskGroupListIndex.vitest.ts` partial                              |
| Wave C compliant            | −323..−423 (−450..−550 **minus** the upheld contentStore dispute ~127)                      | `StreamContentSync` (309) retargets                                                |
| Wave D                      | −180                                                                                        | `WebviewBridge.vitest.ts` (546) reshapes                                           |
| Contracts §2.1–2.9          | −400..−600                                                                                  | `stateSettings.vitest` −90..−100; ~15 files section-rewrite (no whole-file deaths) |
| Retirement                  | −130 now / −120 dated                                                                       | 8 `cleanupAllApprovals` unwinds                                                    |
| Lifecycle                   | ≈ −240 (−300 deleted / +60 added: DisposableStore, self-registrations, `followUps.dispose`) | `SessionExitLease` (166) + `AgentLaunchResources.vitest` (24) retire; ~150 rewrite |
| **Compliant program total** | **≈ −2,000..−2,400**                                                                        | **≈ −3,000..−4,500 net (gross churn 8,000+)**                                      |
| Projection-zero (gated)     | **−400..−600 further**                                                                      | −400..−500 further                                                                 |

**Reconciliation with the program's existing ≈ −2,100..−2,500 first-order estimate — read carefully to avoid double-counting:**

1. **Already inside the estimate:** every production row in §7.2's Wave A, compliant-wire, contracts, and lifecycle tables. The cascades are the _verification_ of the first-order figures, not an addition — Wave A's −983..−1,058 matches the proposal band; the contracts families and lifecycle nets are the same LOC the docs already count. The second-order sweep **corrects the estimate downward by ~127** (contentStore is not removable under Wave C), landing the compliant program at ≈ **−2,000..−2,400** — the low end of the published band, honestly stated.
2. **Genuinely additional, production:** projection-zero-only rows (§7.2 third table) ≈ **−400..−600**, hard-gated on the two named §4b supersessions plus the bandwidth measurement — outside the first-order estimate by the docs' own accounting, and it stays outside until the supersession PR lands.
3. **Genuinely additional, non-production:** the test/fixture cascade — **uncosted in all four program docs** — ≈ −1,900 in Wave A alone; program-wide net ≈ −3,000..−4,500 with gross churn above 8,000 L (`SubagentListDisplay` 1,592, `RunProgressRenderer` 1,336, `DesktopSettingsIpc` 1,092 sections, `RunChatSignalOwnership` 531 mostly dies, whole-file deaths listed per wave above). Keep this on a separate ledger line; never fold it into the production total.
4. **Zero-LOC obligations:** ratchet/baseline prunes (§7.3) and the revival ledger (§7.4). Revivals are net-**adds** the first-order estimate does not offset — each must carry its §5b paired deletion in-PR, which is what keeps the grand total from silently eroding.

Grand total if the projection-zero supersessions land: ≈ **−2,400..−3,000 production**, plus the test ledger. Quote the compliant figure (−2,000..−2,400) in any external summary; quote the gated figure only with its gate named.
