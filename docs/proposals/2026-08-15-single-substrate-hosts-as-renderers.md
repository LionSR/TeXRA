# Single substrate, hosts as renderers (2026-08-15 directive)

> **Status:** Adjudicated design, 2026-08-15. Companion to
> `2026-08-15-cross-host-consolidation.md` (the audit register); this doc is
> the target architecture and staged plan for the maintainer's directive:
> *"consolidate as much as possible; use the same data structure; just the UI
> is rendered differently; collapse projectors, adaptors, bridges, and all
> other forms that cheated with cleaner designs; get a single source of
> truth."* Produced by four deep sweeps at worktree HEAD `bc64b7cab4`
> (layer census, transcript row-model study, session-state field study,
> prior-rulings register). Every number below is verified-at-citation;
> re-open sites before acting — eight campaign PRs are landing around these
> files.

## 0. The directive as a ruling, and what it does to prior rulings

The prior-art register (§9 below has the full disposition table) reduces to
three facts:

1. **The "rejected shared reducer" already exists.** The 2026-07-03 coupling
   audit rejected merging the per-host event→UI reducers (+80..+180 LoC
   estimate then). Since then `SessionFactApplier` → `SessionState` →
   `SessionRendererPort` landed and **is** the shared reducer for all three
   hosts (`ProgressBackend.ts:181` for ext+desktop,
   `sessionSignalsAdapter.ts:325` for CLI). The ruling's goal was reached by
   a different mechanism; its live residue is only: *hosts keep persistence,
   async race handling, and genuinely-local UI state*. This plan finishes the
   collapse onto that structure — it does not build a new one.
2. **One prior ruling is squarely superseded, by name:**
   `2026-08-03-ssot-consolidation-plan.md` §0.1 item 8, the clause *"the CLI
   `StreamSlice` vs extension slice fragmentation stays (no shared reducer,
   no merged host implementations)"*. The maintainer's 2026-08-15 directive
   overrides that clause. Items 1, 2, 4, 6*, 7, 11 of the same list stay
   binding (*item 6's progress-view-IPC freeze is partially superseded — see
   §6, the one other supersession this plan requests).
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

One state plane, already built, promoted to *the only* state plane:

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
   via 3-message  over shared    (paint over
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

- **B1 webview/IPC** (ext postMessage, desktop Electron IPC): 3 outbound
  payloads + 1 inbound registry (§6). `WebviewBridge`'s resync handshake is
  load-bearing and keeps.
- **B2 NDJSON stdout**: frozen public vocabulary; `sessionProgressSubscription`
  + `cliPresentationHost` keep as-is, protected by the import fence
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

| bucket | LoC | meaning |
|---|---|---|
| pass-through | **1,733** | reshapes/renames with zero policy — pure deletions |
| parallel-derivation | **2,624** | recomputes what a shared structure owns — converge by deletion |
| wire-translation | ~1,200 | real boundaries; keep minimal (some shrink under §6) |
| modality | rest | keep |

**Theoretical ceiling ≈ 4,357 LoC (~22% of the band), and four independent
per-stream state containers collapse to one.** The realistic first-tranche
number after the honest per-item studies (which cut several census estimates
down) is **≈ 2,600–3,000 LoC net deletion** across §3–§7, plus ~150–200 LoC
added in `src/controllers/session` and `src/shared/schemas` for promotions.
The gap between ceiling and realistic is itemized honestly in §8 (things that
looked collapsible and are not).

Named pass-through band (each item cites the census):
`ProgressStreamProjectionBuilder` (158, stateless 1:1 repack of
`SessionState` + snapshot getters), ~230 LoC of `LitSessionRenderer`
3-line forwarders, ~229 LoC of `WebviewUpdater` beyond a table-driven
sender, frontend slices `runTrackingSlice`/`syncSlice`/`streamStateMerge`/
`taskSlice`/`inquirySlice` (263 combined — each unpacks exactly what the
backend packed), `subscribeStreamArtifacts` (135), `streamViews` label
re-derivation (~120), `approvalAdapter` result-shape renames (~150, gated —
see §8), desktop sync wrappers (15), `replayTrace` payload hand-building
(~100), `streamMetadata`+`streamTabInfo` builders (133 — fold into a
`SessionState.getStreamTabInfo()`), ~200 LoC of `sessionSignalsAdapter`
single-field patches.

## 3. Wave A — the CLI collapse (largest, no boundary defending it)

Per the session-state field study; **≈ 995–1,070 LoC deleted in
`packages/cli` against ~100 added in `src/`**. Two structural unlocks carry
~70% of it:

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

| container | today | survives | net | notes |
|---|---|---|---|---|
| `childExecutions.ts` | 585 | ~110 (~35 with tombstone promoted) | **−475..−550** | roster/parent/tombstone all re-derive `StreamExecutionState.subagents` + `metadata.parentStreamId`; the cap constant is a self-admitted copy of `RETAINED_FINISHED_CHILDREN_CAP` ("as a value, not an import", `:71-76`). Two real riders: (1) `resetPerRunChildState` (`SessionState.ts:310-332`) drops retained children on a new RUNNING while the CLI's exit hint needs them — retention scope becomes a declared per-host policy on the shared structure, not a second container; (2) the removal tombstone is promoted (§4), because `SessionFactApplier.ts:353` re-mints state for deleted streams in ext+desktop too — the CLI's "extra" code was masking a shared bug. |
| `cliState.ts` `StreamSlice` | 941 | ~490 | **−450** | 26 of 30 fields are field-for-field re-derivations of the shared `StreamState` schema + `StreamTabInfo` (table in the study). The slice becomes `StreamState & CliOnlyFields` where `CliOnlyFields` = `runStartedAt`, `latestLine`, `thinkingActive`, `compactingActive` + fold working state (until §4 promotes the first four). `files` field has no writer and no reader — −13 free. **This is the §0.1-item-8 supersession, executed.** |
| `sessionSignalsAdapter.ts` | 372 | ~90 | **−280** | ~200 LoC of single-field patch forwarders delete under U2; ~80 LoC of metadata/usage re-derivation deletes when the slice holds shared records verbatim; keeps: dispatch-generation staleness guard (genuine TUI-reset modality), the slice-minting gate, `onGoalPaused` local row. Also deletes the **dual status path**: `:337` drops the status fact so `subscribeStreamStatus.ts` (57) can re-subscribe separately, bypassing the applier's ordering guarantees — two subscribers to one fact, merged back into the port. |
| `runProgressRenderer.ts` (headless) | 573 | ~395 | **−175** | `RenderState`'s six fields and the child bookkeeping are all owned by `StreamExecutionState`/metadata; attach a ~40-LoC headless `SessionRendererPort` and delete the hand-rolled `handleSessionFact`/`apply*` machinery. Bonus: the "clear child descriptions before roster repaint reuses a stale label" bug-guard becomes unnecessary — the roster row carries the description. ANSI repaint/throttle/heartbeat keep (modality). |
| `subscribeStreamArtifacts.ts` | 135 | 0 | **−135** | copies `StreamSnapshotStore` getters into the slice; CLI reads the store directly (it already holds the session). |
| `streamViews.ts` | 262 | ~140 | **−120** | label/parentLabel re-derivation replaced by `buildStreamTabInfo` output (this also fixes the drift where ext and CLI print different names for the same run — `getCleanAgentName(runIdentityName(…))` vs `runIdentityDisplayName`). |
| `statusBarDisplay.ts` context gauge | ~35 | ~8 | **−27** | needs the `contextState` promotion (§4); until then the CLI's context window is *wrong* on subscription/compaction routes — this is a correctness fix wearing a refactor. |
| `resumeHint.ts` targets | ~42 | ~27 | **−15** | needs the `resumable` promotion (§4). |

Ratchet note for the whole wave: anything relocated lands in
`src/controllers/session/` (the CLAUDE.md-sanctioned home for host-neutral
orchestration) and is imported via existing `@controllers/*` aliases — the
ratchet-cheapest direction. No new `@agent/*` deep-import specifiers, so
`host-agent-import-baseline` does not move.

## 4. The promotion list — facts one host computes that belong in the substrate

Each of these is a fact currently computed host-side; promoting it deletes
the host copy *and* fixes a feature gap in the other hosts. Promotions land
in `SessionState`/`StreamExecutionState` (not `StreamSnapshotStore`, whose
public surface is ratcheted caller-honest — growth there fails
`storePublicSurfaceRatchet` and needs explicit accounting; the one exception
is noted).

| fact | today | promote to | fixes |
|---|---|---|---|
| `contextState` (window/tokens/utilization) | webview extracts from its log fold (`logSlice.ts:134`); CLI re-derives from `MODEL_CONFIGS` | `StreamExecutionState` (already in the wire schema, `streamState.ts:159`) | CLI gauge wrong on subscription/compaction routes; single authoritative source |
| removal tombstone / resurrection guard | CLI only (`childExecutions.ts:353-434`) | `SessionState` beside `clearStream` | shared bug: applier re-mints state for deleted streams in ext+desktop |
| `runStartedAt` | CLI only (`cliState.ts:482`) | `StreamExecutionState` | webview gains a live elapsed-time source; also kills the `elapsed` dual-derivation (audit C22) |
| `thinkingActive`/`compactingActive` | CLI only (`subscribeStreamLog.ts:376-380`) | `StreamExecutionState` | webview has no liveness indicator for token-less turns |
| `resumable` (per-subagent) | CLI only (`resumeHint.ts:171-180`) | roster row | webview cannot offer per-subagent resume today |
| root-run stream identity | three CLI copies (`runProgressRenderer.ts:398`, `cliState.ts:606,617`) | `SessionState` | headless and TUI can disagree which stream is "the run" |
| run input files + `plannedRounds` | headless renderer only (`:298-300,518`) | `SessionStreamConfigDetails` | GUI hosts cannot show input subject or planned rounds |
| `cumulativeUsage` sum rule | CLI eager-sums, webview lazy-sums | one owner; if it must be the snapshot store, the +1 surface unit is declared in the PR | two summing sites, one rule |
| display-label rule | `buildStreamTabInfo` vs `runIdentityDisplayName` | one of them (ruling) | same run, two names |

## 5. Wave B — transcript: collapse the rules, keep the containers

The deep study's reframe: there are not two row models — there is **one
(CLI) and an absence (the webview renders raw entries in one step)**, and the
webview **discards `settlementSeqNo` and orders by `timestamp`**, which is a
live ordering bug (upserted entries keep their start time; ties lean on sort
stability). The honest accounting kills the naive "one shared fold"
ambition: ~700 LoC of `transcriptFold` is Ink-specific incremental
machinery with no webview consumer, and moving it to `src/shared/` for one
caller is the banned extraction. What is shared is the **policy**:

- **B-1 (do first, pays in LoC and fixes the bug): the ordering slice.**
  One shared `TranscriptOrderKey` (`settlementSeqNo ?? sourceSeqNo`, tier,
  tieBreak) + comparator in `src/shared/`; the webview deletes its three
  timestamp comparators (~60–90 LoC), the CLI's key moves. **Net ≈ −49 and
  the webview gets stable, settlement-correct ordering for free.** The walk
  (Ink `<Static>` settlement scan) stays CLI-side — the key is shared, the
  walk is modality.
- **B-2: one row model, projected per entry.** A pure
  `projectTranscriptRow(entry, ctx): TranscriptRow | undefined` in
  `src/shared/transcript/` (~350–420 LoC, the `workflowCall.ts` register:
  one membership rule, one settlement predicate, one error/detail shape
  carrying **untruncated** text plus elision *metadata* — hosts apply width
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
  settlement predicate) between two shipped surfaces, plus the redaction
  asymmetry (CLI redacts assistant/error text, webview doesn't — a security
  edge that must be ruled, not inherited). Under build-implies-delete it
  qualifies because both host copies delete in the same PRs; under the
  net-positive rule the PR body states this paragraph as the reason.
- **Containers keep:** `transcriptFold`'s incremental machinery (~620),
  `transcriptEntries`' settlement scan (~210), all HTML section markup
  (~1,400), all width/ANSI code. The transcript rail stays separate from the
  fact rail (trap #7, still binding).

Policy rulings needed before B-2 (each one sentence from the maintainer):
membership set (CLI's 5-type allowlist vs webview's 15 formatters, or one
allowlist + per-host mode), error-detail shape (1 capped field vs 11
uncapped), quota-hint canon (CLI API-switch hint vs webview relay label),
tool-output suppression rule (two unrelated rulesets today), redaction
(fact or paint — if fact, the webview is under-redacted *today*), phase as
row vs group.

## 6. Wave C — the webview wire, narrowed to three messages

The census's sharpest webview finding: of the `PROGRESS_VIEW_COMMANDS`
vocabulary, ten `UPDATE_*` message types (todos, plan, files,
missingOutputs, compileFailures, runUsage, conversationProgress, badges,
description, status) are **narrower slices of three payloads that already
exist** — a bandwidth optimization masquerading as 8 handler slices, ~230
LoC of `LitSessionRenderer` forwarders, and 349 LoC of `WebviewUpdater`
method bodies. The minimal wire is:

1. `LOG_DELTA` (+ resync handshake) — untouched;
2. `UPDATE_STREAM_METADATA` — `StreamTabInfo[]` + `StreamMetadata` record
   (both already shared Zod schemas);
3. `SYNC_STREAM_CONTENT` — the existing discriminated union, extended to be
   the delta carrier for the ten retired messages (send the changed member,
   not the whole payload — the bandwidth property is kept, the vocabulary
   is not).

Downstream deletions this unlocks: the five pass-through slices (263),
`ProgressStreamProjectionBuilder` (158 — `WebviewUpdater` reads
`SessionState` directly), the forwarder band of `LitSessionRenderer`
(~230), `WebviewUpdater` shrunk to a ~120-LoC table-driven sender
(−229), `contentStore` (127 — state keyed by log id duplicating
`data` already on the row), `streamMetaSlice`'s ordering re-derivation and
`pendingDescriptions` race plumbing (~90). **≈ −1,050 LoC on this wave**,
all inside the ext+desktop pair, no behavior change, ProgressBridge suite
as the parity harness.

- **Supersession required:** `2026-08-03-ssot-consolidation-plan.md` §0.1
  item 6 freezes "progress-view IPC literals". Unlike the NDJSON rail this
  wire is **internal** — both ends ship in the same bundle, no external
  consumer exists, and the trace-viewer (the third consumer) goes through
  the same `dispatchMessage`. This plan requests that narrow supersession;
  the NDJSON and persisted-outcome freezes in the same item stay.
- **6d. Replay joins the same path:** a `TraceDocument → SessionState`
  hydrator lets `replayTrace()` call the same projections as live
  (~−100 LoC); the three archived-format compat readers keep (~90, fenced).

## 7. Wave D — one delta pump

`WebviewBridge` and `subscribeStreamLog` implement the same
subscribe/buffer/16 ms/gap-detect/resync algorithm over
`StreamLogStore.onChange`; the CLI copy is the stronger fork (mode-flip
invalidation, generation guards). Extract one `StreamLogFeed` in
`src/transcript/` (~120 LoC); `WebviewBridge` = feed + postMessage +
resync handshake; `subscribeStreamLog` = feed + fold. **≈ −180 LoC** and one
class of resync bug. Compliance note: `transcriptResidencyLeaseSites`
allowlists `.ensureLoaded(` at exactly 7 sites including
`subscribeStreamLog.ts` — the extraction *moves* an allowlist row to the new
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
  re-render). Correctly split; only the *rules* converge (§5).
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

| binding constraint | how this plan passes |
|---|---|
| R4: no new plane/bus/vocabulary/coordinator | zero new emitters or vocabularies; every PR deletes the layer it replaces; the only new module names are `StreamLogFeed`, `projectTranscriptRow`, and a headless renderer port — each with ≥2 consumers at birth |
| "no new subscribe surface"; sanctioned channel | hosts stay on `SessionEventHub` via `SessionRendererPort`; U2 *narrows* the port |
| plane rule 1 (facts flow one way) | shared structures are read-only downstream of the applier; host writes go through existing plane-2/3 APIs |
| `sessionPresentationBoundary.vitest.ts` | selection/focus/presentation stay host-side; test untouched |
| `storePublicSurfaceRatchet` | promotions land in `SessionState`, not the ratcheted stores; the one candidate exception (usage sum) declares its +1 unit or stays out |
| `transcriptResidencyLeaseSites` | allowlist rows move one-for-one with relocated owners; no widening |
| `hostAgentDeepImportRatchet` / `subsystemEdgeRatchet` | relocations target `src/controllers/session` via existing aliases; any new src-edge is declared in the PR; goal is baseline shrink, never growth |
| host-parity fence rows 7/29/30/32 | per-host status-label projectors, per-host display budgets, TUI output-file-fact drop, NDJSON import fence — all untouched |
| D1/T9, D7/T14, ModelCell scope | persisted `result.outcome` untouched; no keyed one-instance registry anywhere; no `HostUiBus` |
| build-implies-delete, R6/R8 | every wave's PRs pair the shared landing with the host deletion; R6 element deltas and R8 subscriber greps in each body |
| supersessions requested (by name, the only two) | SSOT §0.1 item 8 "CLI `StreamSlice` fragmentation stays"; §0.1 item 6 *progress-view IPC literals only* |

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
3. **B-1:** ordering slice (−49, fixes the webview ordering bug). **B-2**
   waits for the six policy rulings; lands as 2–3 PRs (row model + webview
   adoption + CLI adoption), declared +60.
4. **C:** wire narrowing behind the §0.1-item-6 supersession; then the slice/
   forwarder/builder deletions. ≈ −1,050. ProgressBridge suite is the gate.
5. **D:** `StreamLogFeed`. ≈ −180.
6. **Promotions (§4)** ride whichever wave first needs them; each fixes a
   named cross-host gap and cites it.

Rough program total: **≈ −2,300..−2,700 LoC net**, four per-stream state
containers reduced to one, ten wire messages reduced to three, and every
remaining host-side structure justifiable by the three-part rule in §1 —
which is the deliverable the directive actually names: not fewer lines, but
one source of truth with renderers that cannot drift because they have
nothing left to re-derive.
