# Single substrate, hosts as renderers (2026-08-15 directive)

> **Status:** Adjudicated design, 2026-08-15. Companion to
> `2026-08-15-cross-host-consolidation.md` (the audit register); this doc is
> the target architecture and staged plan for the maintainer's directive:
> _"consolidate as much as possible; use the same data structure; just the UI
> is rendered differently; collapse projectors, adaptors, bridges, and all
> other forms that cheated with cleaner designs; get a single source of
> truth."_ Produced by four deep sweeps at worktree HEAD `bc64b7cab4`
> (layer census, transcript row-model study, session-state field study,
> prior-rulings register). Every number below is verified-at-citation;
> re-open sites before acting — eight campaign PRs are landing around these
> files.
>
> **Re-verified against origin/main `3122ace2bc` (2026-08-15, post-campaign
> merges):** no structural claim died; corrections are folded in below and
> the full stale-claims register lives in
> `2026-08-15-shared-contracts-and-retirement.md` §5. The load-bearing
> changes: B4 (#10611) already banked −163 of Wave C by deleting
> `WebviewUpdater` into `LitSessionRenderer`; B2/#10541 banked the dead
> `StreamSlice.files` field; Wave C is revised to the ruling-clean
> derivation form (§6, per the contracts doc §2.3) so the §0.1-item-6
> supersession is **withdrawn**; and B3's set-based ratchet adds a new
> obligation — every PR deleting a host's last `@agent/*` deep import must
> prune `config/ratchets/host-agent-import-baseline.json` in the same
> commit, or CI fails on stale headroom.
>
> **Review round applied (2026-08-16):** corrections folded in inline —
> B-1 revised to the `sourceSeqNo` form (settlement ordering stays CLI
> modality), the redaction ruling withdrawn (record-time redaction is
> canonical), the 6d hydrator re-targeted to a browser-safe DTO, and three
> §4 promotion rows corrected (`compactingActive` withdrawn, `resumable` →
> `resumeEligible`, root-run identity → execution-keyed query).
>
> **Reconciled against origin/main `e00b9317f7` (2026-08-19).** Wave A's three
> steps landed — #10892 (child state + the status rail onto `SessionState`),
> #10895 (`StreamSlice` retyped, adapter mirrors deleted), #10932 (port
> `invalidate` narrowing, a headless `SessionRendererPort`, shared stream
> labels). Wave C landed in its revised form (#10719 derivation, #10889
> builder fold + the 6d replay hydrator, #10932 port collapse). B-1 landed as
> a shared `compareBySeqNo` (#10717) — the wire field is `seqNo`, not the
> `sourceSeqNo` this doc named. **Wave D is withdrawn** (§7). What remains
> genuinely open is most of the §4 promotion list — `contextState` (still the
> live CLI gauge bug), `runStartedAt`, `thinkingActive`, root-run stream
> identity, run input files + `plannedRounds` — plus B-2, whose five policy
> rulings the maintainer's 2026-08-19 directive supplied and which is in
> flight on `track/transcript-parity`, and the two §6-item-4 stragglers
> (`contentStore`, `streamMetaSlice`), both gated behind projection-zero.
> The LoC arithmetic did not survive contact: the CLI containers deleted
> real duplication but landed well short of the per-file targets
> (`sessionSignalsAdapter` 372 → 312 against ~90, `runProgressRenderer`
> 573 → 535 against ~395, `cliState` 929 → 876 against ~490) — read the §3
> table as a direction, not a budget.

## 0. The directive as a ruling, and what it does to prior rulings

The prior-art register (§9 below has the full disposition table) reduces to
three facts:

1. **The "rejected shared reducer" already exists.** The 2026-07-03 coupling
   audit rejected merging the per-host event→UI reducers (+80..+180 LoC
   estimate then). Since then `SessionFactApplier` → `SessionState` →
   `SessionRendererPort` landed and **is** the shared reducer for all three
   hosts (`ProgressBackend.ts:181` for ext+desktop,
   `sessionSignalsAdapter.ts:325` for CLI). The ruling's goal was reached by
   a different mechanism; its live residue is only: _hosts keep persistence,
   async race handling, and genuinely-local UI state_. This plan finishes the
   collapse onto that structure — it does not build a new one.
2. **One prior ruling is squarely superseded, by name:**
   `2026-08-03-ssot-consolidation-plan.md` §0.1 item 8, the clause _"the CLI
   `StreamSlice` vs extension slice fragmentation stays (no shared reducer,
   no merged host implementations)"_. The maintainer's 2026-08-15 directive
   overrides that clause. Items 1, 2, 4, 6, 7, 11 of the same list stay
   binding — including item 6's progress-view-IPC freeze: the originally
   drafted Wave C would have needed to supersede it, but the revised Wave C
   (§6, per the contracts doc §2.3) derives the targeted messages from one
   canonical projection shape while keeping every literal, so **no
   supersession of item 6 is requested**. Item 8 is the program's only
   supersession.
3. **Everything else is compliant, not superseded.** No new bus, hub, plane,
   or vocabulary anywhere in this plan (R4's mechanism ban stands). The
   sanctioned channel is the existing one: `SessionEventHub`
   (`session.events`) → shared `SessionFactApplier` → `SessionState`, hosts
   subscribing through `SessionRendererPort`. Hosts are **read-only
   downstream** of the applier (plane rule 1). The A16
   pending-interaction-table trap, the platform-port NEVER-collapse rows, the
   NDJSON freeze, the host-parity fence rows, and the presentation-boundary
   architecture tests all remain in force and this plan is shaped to pass
   them (§9).

Every collapse PR follows the A17 template sentence — **relocate ownership,
don't duplicate it** — and the abstraction-cost gate: build implies delete in
the same PR, R6 net-element accounting and R8 consumer-grep in every PR body.

## 1. Target architecture

One state plane, already built, promoted to _the only_ state plane:

```
                     SessionEventHub  (session.events: AgentEvent | SessionFact)
                            │
              SessionFactApplier  (the one fact→state reducer)
                            │
        ┌───────────────────┼──────────────────────┐
   SessionState        StreamSnapshotStore     StreamLogStore
   (live session/run   (persisted artifacts,   (transcript rail —
    structure: metadata, single writer)         stays separate, trap #7)
    status, roster,
    stage, progress)
        │                        │                  │
        └────────── SessionRendererPort ── StreamLogFeed (one delta pump, §7)
                            │                       │
     ┌──────────────┬───────┴──────┬────────────────┤
  Lit renderer   TUI renderer   headless text     NDJSON (frozen wire,
  (ext+desktop,  (Ink paint     renderer          untouched)
   via derived    over shared    (paint over
   wire, §6)      state)         shared state)
```

The rule that makes it stick, stated once and enforced by the existing
architecture tests: **a host may hold state only if it is (a) modality
(width, focus, selection, animation, Ink `<Static>` settlement, Lit
re-render generations), (b) a wire-mandated mirror across a real process
boundary, or (c) a frozen compatibility surface. Everything else reads the
shared structure.** Selection/focus stay host-side by construction —
`sessionPresentationBoundary.vitest.ts` forbids `activeStream`/presentation
in `SessionState` and focus policy in the applier, and this plan keeps that
test exactly as-is.

Three real process boundaries survive, each with a named minimal contract:

- **B1 webview/IPC** (ext postMessage, desktop Electron IPC): the existing
  literals, with every targeted arm derived from one canonical projection
  shape (§6 revised). `WebviewBridge`'s resync handshake is load-bearing
  and keeps.
- **B2 NDJSON stdout**: frozen public vocabulary; `sessionProgressSubscription`
  - `cliPresentationHost` keep as-is, protected by the import fence
    (parity-audit fence row 32).
- **B3 archived trace.json**: the three compat readers in `replayTrace.ts`
  (~90 LoC) keep; the other ~100 LoC of hand-built payloads collapse via a
  `TraceDocument → SessionState` hydrator (§6d).

The CLI has **no** process boundary — the TUI and headless renderers run
in-process with `SessionState`. That is where the parallel state is entirely
convention, and where the collapse is cheapest and largest (§3).

## 2. The census: what actually sits between state and pixels

Full table in the census sweep; the totals, against ~19,900 LoC currently in
the state→pixels band (excluding leaf Ink/Lit components):

| bucket              | LoC       | meaning                                                        |
| ------------------- | --------- | -------------------------------------------------------------- |
| pass-through        | **1,733** | reshapes/renames with zero policy — pure deletions             |
| parallel-derivation | **2,624** | recomputes what a shared structure owns — converge by deletion |
| wire-translation    | ~1,200    | real boundaries; keep minimal (some shrink under §6)           |
| modality            | rest      | keep                                                           |

**Theoretical ceiling ≈ 4,357 LoC (~22% of the band), and four independent
per-stream state containers collapse to one.** The realistic first-tranche
number after the honest per-item studies (which cut several census estimates
down) is **≈ 2,600–3,000 LoC net deletion** across §3–§7, plus ~150–200 LoC
added in `src/controllers/session` and `src/shared/schemas` for promotions.
The gap between ceiling and realistic is itemized honestly in §8 (things that
looked collapsible and are not).

Named pass-through band (each item cites the census; **corrected for B4**,
which deleted `WebviewUpdater.ts` into `LitSessionRenderer` — now one
483-LoC file with ≈ −290 remaining headroom on the renderer band, −163
already banked): `ProgressStreamProjectionBuilder` (158, stateless 1:1
repack of `SessionState` + snapshot getters, 3 refs), the
`LitSessionRenderer` renderer band (~290 collapsible under §6's revised
form), frontend slices `runTrackingSlice`/`syncSlice`/`streamStateMerge`/
`taskSlice`/`inquirySlice` (263 combined — each unpacks exactly what the
backend packed), `subscribeStreamArtifacts` (135), `streamViews` label
re-derivation (~120), `approvalAdapter` result-shape renames (~150, gated —
see §8), desktop sync wrappers (15), `replayTrace` payload hand-building
(~100), `streamMetadata`+`streamTabInfo` builders (133 — fold into a
`SessionState.getStreamTabInfo()`), ~200 LoC of `sessionSignalsAdapter`
single-field patches.

## 3. Wave A — the CLI collapse (largest, no boundary defending it)

Per the session-state field study; **≈ 983–1,058 LoC deleted in
`packages/cli` against ~100 added in `src/`** (corrected for the two items
main already banked). Ratchet rider for every PR in this wave: the CLI's
`host-agent-import-baseline` list pins 14 specifiers (followUp, TaskState,
contextUtilization among them) — deleting a specifier's last import
without pruning the baseline in the same commit **fails** the set-based
ratchet. Two structural unlocks carry
~70% of it:

**LANDED.** U1 shipped in #10693; U2 in #10805 (stable-identity read cache on
`SessionState`) and #10932 (the port narrowed to `invalidate(streamId, slice)`).
The container rows below landed across #10892 / #10895 / #10932 with the
per-file nets stated in the reconciliation header; two rows did not land and
are marked in place.

- **U1 — stop dropping retained children.** One line:
  `sessionSignalsAdapter.ts:208` filters `finishedAt === undefined` out of
  the roster the shared applier just computed (retention, phase-merge,
  200-cap). Deleting the filter removes the reason `childExecutions.ts`
  exists. This is simultaneously the live #9021-class fix from the audit doc
  §4a.
- **U2 — give `SessionState` stable-identity reads + an invalidation
  signal.** `getStreamMetadata` allocates a fresh object per read
  (`SessionState.ts:246-249`), which is why every CLI consumer deep-compares;
  and the renderer port is the only change notification. Cache the merged
  record, invalidate on patch; the port shrinks toward
  `invalidate(streamId)`. (No new subscribe surface — the port already
  exists; this narrows it.)

Then, container by container:

| container                           | today | survives                           | net            | notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ----- | ---------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `childExecutions.ts`                | 585   | ~110 (~35 with tombstone promoted) | **−475..−550** | roster/parent/tombstone all re-derive `StreamExecutionState.subagents` + `metadata.parentStreamId`; the cap constant is a self-admitted copy of `RETAINED_FINISHED_CHILDREN_CAP` ("as a value, not an import", `:71-76`). Two real riders: (1) `resetPerRunChildState` (`SessionState.ts:310-332`) drops retained children on a new RUNNING while the CLI's exit hint needs them — retention scope becomes a declared per-host policy on the shared structure, not a second container; (2) the removal tombstone is promoted (§4), because `SessionFactApplier.ts:353` re-mints state for deleted streams in ext+desktop too — the CLI's "extra" code was masking a shared bug. |
| `cliState.ts` `StreamSlice`         | 929   | ~490                               | **−438**       | 26 of 30 fields are field-for-field re-derivations of the shared `StreamState` schema + `StreamTabInfo` (table in the study). The slice becomes `StreamState & CliOnlyFields` where `CliOnlyFields` = `runStartedAt`, `latestLine`, `thinkingActive`, `compactingActive` + fold working state (until §4 promotes the first four). The dead `files` field is **already removed on main** (B2/#10541, −12 banked). **This is the §0.1-item-8 supersession, executed.**                                                                                                                                                                                                            |
| `sessionSignalsAdapter.ts`          | 372   | ~90                                | **−280**       | ~200 LoC of single-field patch forwarders delete under U2; ~80 LoC of metadata/usage re-derivation deletes when the slice holds shared records verbatim; keeps: dispatch-generation staleness guard (genuine TUI-reset modality), the slice-minting gate, `onGoalPaused` local row. Also deletes the **dual status path**: `:337` drops the status fact so `subscribeStreamStatus.ts` (57) can re-subscribe separately, bypassing the applier's ordering guarantees — two subscribers to one fact, merged back into the port.                                                                                                                                                   |
| `runProgressRenderer.ts` (headless) | 573   | ~395                               | **−175**       | `RenderState`'s six fields and the child bookkeeping are all owned by `StreamExecutionState`/metadata; attach a ~40-LoC headless `SessionRendererPort` and delete the hand-rolled `handleSessionFact`/`apply*` machinery. Bonus: the "clear child descriptions before roster repaint reuses a stale label" bug-guard becomes unnecessary — the roster row carries the description. ANSI repaint/throttle/heartbeat keep (modality).                                                                                                                                                                                                                                             |
| `subscribeStreamArtifacts.ts`       | 135   | 0                                  | **−135**       | copies `StreamSnapshotStore` getters into the slice; CLI reads the store directly (it already holds the session).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `streamViews.ts`                    | 262   | ~140                               | **−120**       | label/parentLabel re-derivation replaced by `buildStreamTabInfo` output (this also fixes the drift where ext and CLI print different names for the same run — `getCleanAgentName(runIdentityName(…))` vs `runIdentityDisplayName`).                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `statusBarDisplay.ts` context gauge | ~35   | ~8                                 | **−27**        | needs the `contextState` promotion (§4); until then the CLI's context window is _wrong_ on subscription/compaction routes — this is a correctness fix wearing a refactor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `resumeHint.ts` targets             | ~42   | ~27                                | **−15**        | needs the `resumable` promotion (§4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Row-by-row status at `e00b9317f7` (2026-08-19):**

- `childExecutions.ts` — **LANDED #10892**, 585 → 241; the module is now a
  bound `SessionState` + revision signal with no state of its own. The
  tombstone rider landed separately (#10805) as `SessionState._removedStreams`.
- `cliState.ts` `StreamSlice` — **LANDED #10895** as a retype, not a
  composition: 30 fields → 15, every mirror deleted, but the slice is still a
  standalone interface rather than the `StreamState & CliOnlyFields` shape this
  row named, and the file is 876 L against the ~490 target. The §0.1-item-8
  supersession is executed.
- `sessionSignalsAdapter.ts` — **LANDED #10892/#10895/#10932** for the
  mechanism (the per-field patch forwarders and the dual status path are gone;
  `subscribeStreamStatus.ts` is deleted), **not** for the arithmetic: 372 →
  312 against a ~90 target.
- `runProgressRenderer.ts` — **LANDED #10932**: a real headless
  `SessionRendererPort` implementation over the shared applier, `RenderState`'s
  six fields down to a three-field `RootRunConfigState`. Net −38, not −175.
- `subscribeStreamArtifacts.ts` — **PARTIAL #10718/#10735/#10895.** The
  slice-copying is gone (renderers read the canonical projection), but the file
  survives at 222 L holding the async disk-preload edge and its invalidation.
  The "−135 to zero" line was wrong: there was a real asynchronous concern
  underneath the copying.
- `streamViews.ts` — **LANDED #10932**; the CLI calls `buildStreamTabInfo`, so
  the ext/CLI name drift this row named is closed.
- `statusBarDisplay.ts` context gauge — **OPEN.** Still
  `MODEL_CONFIGS[model]?.contextWindow`; the correctness bug this row called
  "a correctness fix wearing a refactor" is live, gated on the `contextState`
  promotion (§4).
- `resumeHint.ts` targets — **LANDED #10754** via the `resumeEligible` roster
  field.

Ratchet note for the whole wave: anything relocated lands in
`src/controllers/session/` (the CLAUDE.md-sanctioned home for host-neutral
orchestration) and is imported via existing `@controllers/*` aliases — the
ratchet-cheapest direction. No new `@agent/*` deep-import specifiers, so
`host-agent-import-baseline` does not move.

## 4. The promotion list — facts one host computes that belong in the substrate

Each of these is a fact currently computed host-side; promoting it deletes
the host copy _and_ fixes a feature gap in the other hosts. Promotions land
in `SessionState`/`StreamExecutionState` (not `StreamSnapshotStore`, whose
public surface is ratcheted caller-honest — growth there fails
`storePublicSurfaceRatchet` and needs explicit accounting; the one exception
is noted).

| fact                                       | today                                                                                       | promote to                                                                                                                                                      | fixes                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contextState` (window/tokens/utilization) | webview extracts from its log fold (`logSlice.ts:134`); CLI re-derives from `MODEL_CONFIGS` | `StreamExecutionState` (already in the wire schema, `streamState.ts:159`)                                                                                       | CLI gauge wrong on subscription/compaction routes; single authoritative source                                                                                                                                                                                                      |
| removal tombstone / resurrection guard     | CLI only (`childExecutions.ts:353-434`)                                                     | `SessionState` beside `clearStream`                                                                                                                             | shared bug: applier re-mints state for deleted streams in ext+desktop                                                                                                                                                                                                               |
| `runStartedAt`                             | CLI only (`cliState.ts:482`)                                                                | `StreamExecutionState`                                                                                                                                          | webview gains a live elapsed-time source; also kills the `elapsed` dual-derivation (audit C22)                                                                                                                                                                                      |
| `thinkingActive` only                      | CLI only (`subscribeStreamLog.ts:376-380`)                                                  | `StreamExecutionState`                                                                                                                                          | _(Narrowed on review: `compactingActive` is WITHDRAWN — the webview already has compaction liveness via the shared `CompactionActivityBlock` `running` state; promoting it would mint a second owner beside the transcript-owned lifecycle. `thinkingActive` assessed separately.)_ |
| `resumeEligible` (per-subagent)            | **Promoted in this slice:** authoritative live producer                                     | roster row (current)                                                                                                                                            | Admission **eligibility** (native agent ∧ tool-use), not durable resumability — it checks no persisted checkpoint/lease; actual resumability remains derived at the durable-state boundary on demand.                                                                               |
| root-run stream identity                   | three CLI copies (`runProgressRenderer.ts:398`, `cliState.ts:606,617`)                      | a query keyed by execution id (NOT a session field — review-caught: GUI sessions hold multiple concurrent roots, so a single session-wide value is ill-defined) | headless and TUI can disagree which stream is "the run"                                                                                                                                                                                                                             |
| run input files + `plannedRounds`          | headless renderer only (`:298-300,518`)                                                     | `SessionStreamConfigDetails`                                                                                                                                    | GUI hosts cannot show input subject or planned rounds                                                                                                                                                                                                                               |
| `cumulativeUsage` sum rule                 | CLI eager-sums, webview lazy-sums                                                           | one owner; if it must be the snapshot store, the +1 surface unit is declared in the PR                                                                          | two summing sites, one rule                                                                                                                                                                                                                                                         |
| display-label rule                         | `buildStreamTabInfo` vs `runIdentityDisplayName`                                            | one of them (ruling)                                                                                                                                            | same run, two names                                                                                                                                                                                                                                                                 |

**Promotion status at `e00b9317f7` (2026-08-19)** — this is where the program's
remaining work concentrates:

- `contextState` — **OPEN.** Not on `StreamExecutionState`; the webview still
  folds it out of the log rail and `statusBarDisplay.ts:221` still reads
  `MODEL_CONFIGS[model]?.contextWindow`. The §7.4 revival note explains why it
  is the hard one: it has no fact-rail writer today.
- removal tombstone / resurrection guard — **LANDED #10805**, as
  `SessionState._removedStreams` + `isStreamRemoved`, documented as the single
  owner of the rejection; the shared applier honors it for every host, which
  is the cross-host bug this row predicted.
- `runStartedAt` — **OPEN.** Still CLI-only (`cliState.ts`).
- `thinkingActive` — **OPEN.** Still derived CLI-side from the log rail.
- `resumeEligible` — **LANDED #10754** on the roster row
  (`streamState.ts:34`), produced by `executionRegistry.ts`.
- root-run stream identity — **OPEN.** Three copies survive (two in
  `cliState.ts`, one in `runProgressRenderer.ts`); no execution-keyed query
  exists.
- run input files + `plannedRounds` — **OPEN.** Still headless-only, now in
  `RootRunConfigState`, whose own comment concedes no shared record carries
  them.
- `cumulativeUsage` sum rule — **LANDED.** One owner,
  `StreamArtifactProjection.sumUsageStats`; the CLI reads it rather than
  eager-summing.
- display-label rule — **LANDED #10932** for the ruling
  (`buildStreamTabInfo` wins, the CLI adopted it); residual direct
  `runIdentityDisplayName` calls survive in `childExecutions.ts` and three
  webview components, which is projection, not a second rule.

## 5. Wave B — transcript: collapse the rules, keep the containers

The deep study's reframe: there are not two row models — there is **one
(CLI) and an absence (the webview renders raw entries in one step)**, and the
webview **discards `settlementSeqNo` and orders by `timestamp`**, which is a
live ordering bug (upserted entries keep their start time; ties lean on sort
stability). The honest accounting kills the naive "one shared fold"
ambition: ~700 LoC of `transcriptFold` is Ink-specific incremental
machinery with no webview consumer, and moving it to `src/shared/` for one
caller is the banned extraction. What is shared is the **policy**:

- **B-1 — LANDED #10717.** The shared comparator is `compareBySeqNo`
  (`src/shared/streams/streamOrdering.ts`), consumed by the webview's
  `messageIndex`; the wire field is spelled `seqNo`, not the `sourceSeqNo`
  this row named (`sourceSeqNo` is a CLI-side name). One timestamp comparator
  survives on the timeline path and is deliberate.
- **B-1 (do first, pays in LoC): the ordering slice — REVISED on review.**
  _(The original form shared the settlement key with the webview; review
  correctly objected that a mutable in-place-updating timeline ordered by
  `settlementSeqNo` would visibly reorder rows that settle late — e.g. a
  planned call settled as skipped jumps to the end. Settlement order is
  Ink-`<Static>`-scrollback semantics; the webview's chronological
  in-place model is deserved.)_ Revised form: the webview replaces its
  three `timestamp` comparators with **`sourceSeqNo`** — the same
  chronology it approximates today, minus the tie/clock-skew fragility
  (the field is already on the wire and currently discarded at
  `toLogMessage`); the CLI keeps its settlement key. One shared
  `compareBySourceSeq` helper, two consumers. Net still ≈ −40..−49; the
  "webview ordering bug" claim narrows to ties/skew rather than
  settlement-vs-start.
- **B-2 — RULINGS GRANTED, IN FLIGHT.** The five policy rulings this row
  waited on were supplied by the maintainer's 2026-08-19 directive — _"the TUI
  should render the same state extension/desktop have"_ — which settles
  membership, error-detail shape, tool-output suppression, header assembly, and
  the settlement predicate in favour of parity rather than per-host editorial
  lines. The shared `src/shared/transcript/` row model implementing it
  (`projectTranscriptRow`, `toolRowModel`, `transcriptText`) is in flight on
  branch `track/transcript-parity`; it is **not** on main at
  `e00b9317f7`. The declared +60 LoC is the one estimate to re-check against
  the landing PR.
- **B-2: one row model, projected per entry.** A pure
  `projectTranscriptRow(entry, ctx): TranscriptRow | undefined` in
  `src/shared/transcript/` (~350–420 LoC, the `workflowCall.ts` register:
  one membership rule, one settlement predicate, one error/detail shape
  carrying **untruncated** text plus elision _metadata_ — hosts apply width
  at paint, which dissolves the truncation drift by construction). The
  webview's formatters take `TranscriptRow`; `toLogMessage` +
  `LogMessageDataSchema` delete; the CLI's `renderLogEntryFresh` moves. The
  postMessage boundary is a non-issue — the frontend already imports
  `@shared/*` and the wire already ships full entries; **rows never cross
  the wire**. One small prerequisite: unify model-label projection (the
  bridge pre-projects `getRuntimeModelLabel`, the CLI post-applies —
  pick pre-projection).
  **Honest accounting: ≈ +60 LoC net.** This is a drift-elimination
  purchase, not a deletion: it retires five silently-divergent policies
  (membership, error fields, tool output suppression, header assembly,
  settlement predicate) between two shipped surfaces. _(Redaction claim
  WITHDRAWN on review: there is no renderer security gap for
  assistant/error text — `TexraTranscriptRecorder` redacts at record time
  for all hosts, and the CLI's render-time calls are documented legacy
  defense over already-redacted data. The shared row consumes the canonical
  redacted content; tool inputs/results remain the separately-documented
  exception.)_ Under build-implies-delete it qualifies because both host
  copies delete in the same PRs; under the net-positive rule the PR body
  states this paragraph as the reason.
- **Containers keep:** `transcriptFold`'s incremental machinery (~620),
  `transcriptEntries`' settlement scan (~210), all HTML section markup
  (~1,400), all width/ANSI code. The transcript rail stays separate from the
  fact rail (trap #7, still binding).

Policy rulings needed before B-2 — **granted 2026-08-19** by the directive
above; the parity answer applies to all five (each one sentence from the
maintainer):
membership set (CLI's 5-type allowlist vs webview's 15 formatters, or one
allowlist + per-host mode), error-detail shape (1 capped field vs 11
uncapped), quota-hint canon (CLI API-switch hint vs webview relay label),
tool-output suppression rule (two unrelated rulesets today), phase as
row vs group. _(The former fifth ruling — redaction — is withdrawn; see the
correction above: record-time redaction is already canonical.)_

## 6. Wave C — the webview wire, derived instead of restated (REVISED)

_Revised 2026-08-15 after the contract census and rulings re-check: the
originally drafted form retired ten `UPDATE_*` literals, which required
superseding §0.1 item 6 — and item 8 explicitly blesses the
snapshot+targeted dual path as the intended end state. The census found a
strictly better, ruling-clean path; the supersession request is withdrawn.
Full detail: `2026-08-15-shared-contracts-and-retirement.md` §2.3._

**LANDED (2026-08-19).** Item 1 in #10719 (`pickProjection` over a
`projectionShape` declared once, 10 arms derived; #10810 deleted the dead
shape bundle it left behind), item 2 in #10932 (`invalidate(streamId, slice)`;
`onParentStreamChanged` has zero occurrences repo-wide; port 22 → 18 methods),
item 3 **as amended** — `progressEvents.ts` keeps its interfaces (they are the
`SessionFact` vocabulary, upstream of the wire, and the doc said they do not
delete) but their members are now `z.infer` of the message schemas — item 4
and 6d in #10889 (`ProgressStreamProjectionBuilder` deleted with no shim,
`replayTrace` hydrating through `buildStreamContentRender` /
`buildStreamMetadata` on the browser-safe DTO path). Two item-4 stragglers
remain **OPEN and gated**: `contentStore.ts` (127 L — the upheld
Lit-DOM-modality dispute, deletable only under B-2) and `streamMetaSlice.ts`
(169 L — whole-module death only under projection-zero).

The verified fact stands, sharper than before: **12 of the 30 outbound
arms are single-field projections of the `SYNC_STREAM_CONTENT` render
payload, declared twice and independently** — a field added to the
snapshot silently misses the targeted path and vice versa. The fix that
respects both rulings:

1. Declare the canonical projection shape **once** and derive every
   targeted arm from it via `pickProjection(...)` (the
   `RoundUpdateMessageSchema` factory already proves the idiom). Every
   literal keeps; both delivery paths keep; the two paths gain the
   compile-time link they currently lack.
2. `SessionRendererPort` gains `invalidate(streamId, slice)`; the four
   payload-free notification methods and `onParentStreamChanged`'s dead
   second argument collapse into it (5 methods × 2 implementations).
3. The ~8 `progressEvents.ts` payload interfaces duplicating outbound
   schemas become `z.infer` of them.
4. The still-open renderer-band items proceed unchanged:
   `ProgressStreamProjectionBuilder` folds away (158, the renderer reads
   `SessionState` directly), the remaining renderer band tightens
   (≈ −290 headroom after B4's banked −163), `contentStore` (127) and
   `streamMetaSlice`'s re-derivations (~90) delete, and the pass-through
   slices shrink to their wire-mandated minimum.

**≈ −450..−550 LoC on this wave** (down from the originally claimed
≈ −1,050: B4 banked −163, and keeping the literals keeps their thin
handler arms), all inside the ext+desktop pair, no behavior change,
ProgressBridge suite as the parity harness.

- **6d. Replay joins the same path — browser-safety rider (review-caught):**
  the hydrator must NOT target the concrete `SessionState` class — its
  import graph reaches Node built-ins (`node:async_hooks`, `node:crypto`)
  and the trace-viewer is a browser-only bundle that must run under
  `file://`. Hydrate the browser-safe projection **input shape** (the same
  DTO the projections read) instead, so `replayTrace()` calls the same
  builders as live (~−100 LoC); the three archived-format compat readers
  keep (~90, fenced).

## 7. Wave D — one delta pump

> **WITHDRAWN — premise stale (2026-08-19, issue #10673 closed NOT_PLANNED).**
> A re-audit before execution found the shared pieces already extracted: the
> buffer/gap-detect/resync half is one implementation, `StreamLogDeltaBuffer`
> (`src/transcript/StreamLog.ts:64`), consumed by both `WebviewBridge` and
> `subscribeStreamLog`; and the coalescing half is `createFlushableDebounce`
> (`@utils/core`), which already has ten consumers including both sites.
> What is left in each file is not the same algorithm written twice — it is
> divergent host policy over one shared substrate: the bridge's 16 ms frame
> interval and postMessage resync handshake versus the TUI's mode-flip
> invalidation, generation guards, non-restarting scheduler, and residency
> lease. Extracting a `StreamLogFeed` over that would be a single shared
> abstraction with two consumers that each need to override it — the shape the
> repo's own LOC lesson says net-adds. The `transcriptResidencyLeaseSites`
> allowlist row therefore stays on `subscribeStreamLog.ts`; the claimed
> −180 LoC is withdrawn from the program total.

`WebviewBridge` and `subscribeStreamLog` implement the same
subscribe/buffer/16 ms/gap-detect/resync algorithm over
`StreamLogStore.onChange`; the CLI copy is the stronger fork (mode-flip
invalidation, generation guards). Extract one `StreamLogFeed` in
`src/transcript/` (~120 LoC); `WebviewBridge` = feed + postMessage +
resync handshake; `subscribeStreamLog` = feed + fold. **≈ −180 LoC** and one
class of resync bug. Compliance note: `transcriptResidencyLeaseSites`
allowlists `.ensureLoaded(` at exactly 7 sites including
`subscribeStreamLog.ts` — the extraction _moves_ an allowlist row to the new
owner (visible, reviewable, one-for-one), it does not widen the list.

## 8. Honest non-collapses (new fence rows)

Found collapsible-looking and adjudicated **keep**, so the next sweep stops
re-flagging them:

- **`workflowPlainOutput.ts` (235).** Looks like a duplicate of the
  task-group projection; is actually a write-once line emitter over arrival
  order whose 27-line buffer exists to handle calls arriving before their
  `stage.start`. Folding it over `TaskGroup[]` snapshots requires
  snapshot→line diffing — strictly more code. Nets positive; leave it.
- **The log-fold container split** (`transcriptFold` machinery vs Lit
  re-render). Correctly split; only the _rules_ converge (§5).
- **NDJSON projection** (`sessionProgressSubscription`, 216) — frozen wire,
  deliberate de-normalization, import-fenced. Keep byte-for-byte.
- **Trace-viewer compat readers** (~90) — immutable archived formats,
  documented permanent.
- **Approval/interaction registries.** The census flags ~200 LoC of
  `subscribeApprovals`↔`permissionSlice`↔`ApprovalRequestHandler` overlap and
  ~150 of `approvalAdapter` renames — but per-host interaction registries
  are the **deliberate resting state** (HOST-2), and the cross-host settle
  table was attempted, reverted, and NET_LOSS-adjudicated twice (A16). Only
  the `approvalAdapter` result-shape renames are safely collapsible
  (into `HostInteractions` result types, no registry merge); the rest is
  fenced unless the maintainer supersedes A16 by name — **this plan does not
  ask for that.**
- **`DesktopProgressBridge`** beyond its three 2-line sync wrappers — it is
  IPC + host callbacks, not a state layer.
- **Platform ports, vocabulary aliases, `SessionHostInteractions` forwards**
  — NEVER-collapse rows from the simplifier campaign, unchanged.

## 9. Compliance map (rulings × this plan)

| binding constraint                                    | how this plan passes                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4: no new plane/bus/vocabulary/coordinator           | zero new emitters or vocabularies; every PR deletes the layer it replaces; the only new module names are `StreamLogFeed`, `projectTranscriptRow`, and a headless renderer port — each with ≥2 consumers at birth                                                                                              |
| "no new subscribe surface"; sanctioned channel        | hosts stay on `SessionEventHub` via `SessionRendererPort`; U2 _narrows_ the port                                                                                                                                                                                                                              |
| plane rule 1 (facts flow one way)                     | shared structures are read-only downstream of the applier; host writes go through existing plane-2/3 APIs                                                                                                                                                                                                     |
| `sessionPresentationBoundary.vitest.ts`               | selection/focus/presentation stay host-side; test untouched                                                                                                                                                                                                                                                   |
| `storePublicSurfaceRatchet`                           | promotions land in `SessionState`, not the ratcheted stores; the one candidate exception (usage sum) declares its +1 unit or stays out                                                                                                                                                                        |
| `transcriptResidencyLeaseSites`                       | allowlist rows move one-for-one with relocated owners; no widening                                                                                                                                                                                                                                            |
| `hostAgentDeepImportRatchet` / `subsystemEdgeRatchet` | relocations target `src/controllers/session` via existing aliases; any new src-edge is declared in the PR. **Post-B3 the host-agent ratchet is set-based and fails in both directions** — every deletion PR that removes a package's last import of a listed specifier prunes the baseline in the same commit |
| host-parity fence rows 7/29/30/32                     | per-host status-label projectors, per-host display budgets, TUI output-file-fact drop, NDJSON import fence — all untouched                                                                                                                                                                                    |
| D1/T9, D7/T14, ModelCell scope                        | persisted `result.outcome` untouched; no keyed one-instance registry anywhere; no `HostUiBus`                                                                                                                                                                                                                 |
| build-implies-delete, R6/R8                           | every wave's PRs pair the shared landing with the host deletion; R6 element deltas and R8 subscriber greps in each body                                                                                                                                                                                       |
| supersession requested (by name, the only one)        | SSOT §0.1 item 8 "CLI `StreamSlice` fragmentation stays" — item 6 is no longer touched (§6 revised)                                                                                                                                                                                                           |

## 10. Staged execution

Order chosen so each wave is independently shippable and the risky ruling
(§6's wire supersession) is not on the critical path of the biggest deletion
(§3):

1. **A0 (unlocks):** U1 one-line filter deletion + the promotion of the
   tombstone; U2 stable-identity + invalidation. Small PRs, each with the
   regression tests named in the study (exit-hint retention scope, deleted-
   stream resurrection).
2. **A1–A6:** the CLI containers, one PR each, in the table order of §3.
   ≈ −1,000.
3. **B-1:** ordering slice in its revised `sourceSeqNo` form (−40..−49,
   fixes tie/clock-skew ordering fragility). **B-2**
   waits for the six policy rulings; lands as 2–3 PRs (row model + webview
   adoption + CLI adoption), declared +60.
4. **C (revised):** the derivation contract + renderer-band deletions, no
   supersession needed. ≈ −450..−550. ProgressBridge suite is the gate.
5. **D:** `StreamLogFeed`. ≈ −180.
6. **Promotions (§4)** ride whichever wave first needs them; each fixes a
   named cross-host gap and cites it.

**Execution status at `e00b9317f7` (2026-08-19):** steps 1–2 landed (#10693,
#10805, #10892, #10895, #10932 — the §0.1-item-8 `StreamSlice` supersession is
executed, and it remains the program's only one); step 3's B-1 landed
(#10717) and B-2 is in flight on `track/transcript-parity` with its rulings
granted; step 4 landed (#10719, #10810, #10889, #10932); **step 5 is
withdrawn** (§7); step 6's promotions are where the residual work sits — two
of eight landed (#10754, #10805), one was already single-owner
(`cumulativeUsage`), one was ruled (`buildStreamTabInfo`), and four remain
open. The LoC total below is stale in both directions: Wave A's deletions
were real but smaller per file than projected, Wave D's −180 is withdrawn,
and the honest reading is that the deliverable landed (one substrate, hosts
reading it) while the arithmetic did not.

Rough program total (post-verification, and adding the contracts +
retirement doc's own waves): **≈ −2,100..−2,500 LoC net**, four per-stream
state containers reduced to one, the snapshot and targeted wire paths
compile-linked, and every remaining host-side structure justifiable by the
three-part rule in §1 — which is the deliverable the directive actually
names: not fewer lines, but one source of truth with renderers that cannot
drift because they have nothing left to re-derive.
