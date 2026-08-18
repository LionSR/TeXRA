---
created: 2026-08-18
updated: 2026-08-18
---

# PRD: The session event journal — single-authority transcript persistence

**Status:** draft for owner ratification. This is the "newly specified
single-authority design" that the 2026-08-17 closures of the JSONL/settlement
family (#10817, #10819, #10820, #10841, #10845) named as the precondition for
any future transcript-persistence work. It is designed from the current
single-authority surface (post-#10805/#10811/#10839 main), not ported from
the retired attempts, which it cites as evidence only.

**Decision in one sentence:** the durable transcript becomes one append-only
JSONL journal of immutable, admission-redacted session events per stream —
persisting the fact stream instead of the mutable fold — introduced for NEW
sessions in v0.41 with no conversion of existing data; every display and
sidecar surface becomes a derived fold of that journal.

**Ratification protocol (load-bearing):** this document merges only by the
repository owner personally, after adversarial review rounds. Once merged,
supersession or closure of this spec's family requires a rulings-ledger
entry in this document citing the ruling; closures without one are protocol
violations and are reopened. (Three prior attempts died from cross-session
authority collisions, including one overnight reversal; this clause is the
fix.)

## 1. Constraints (extracted from the closure rulings — the spec is invalid if it violates one)

- **C1 — one ordering coordinate.** No parallel ordering state. Source:
  #10817's closure ("adds new parallel ordering state").
- **C2 — no second persistence chain.** No format coexistence inside one
  code path, no data converter, no temporary compat reader in the new path.
  Source: #10819/#10845's closures ("not maintaining a second persistence
  migration chain", "one-shot legacy conversion and a temporary reader").
- **C3 — designed from the current surface.** The Stream tab is the only
  history surface (#10811); `SessionState` owns removal tombstones and
  incarnation fences (#10805, #10839); presence-proven leases (#10778).
  These are foundations, not problems.
- **C4 — the sidecar/overlay chain is in scope.** The design must collapse
  `StreamSnapshotStore`'s parallel persistence (seed chains, overlay replay,
  dirty-write coherence), not only `streamLogs/`. Source: #10820's closure
  ("without a second Settings History or sidecar/overlay chain").
- **C5 — supersede, don't revive.** #10773 and its family stay closed. This
  spec supersedes the transcript-persistence claims of
  `docs/proposals/2026-08-15-single-substrate-hosts-as-renderers.md` and
  `docs/prds/2026-08-11-transcript-memory-architecture.md`; the SQLite PRD
  (`2026-08-16-sqlite-workspace-state.md`) stays parked and untouched.

## 2. Problem

The verified 2026-08-17 storage audit (ledger on #10773; six full-file
readers, 43 adversarial verdicts) established that roughly 60% of
`StreamLogStore` and 70% of `StreamSnapshotStore` is compensation for one
substrate property: the durable format is a whole-file rewrite of a MUTABLE
fold. Because persisted entries mutate (`update`/`settle`/`appendText`),
every substrate change attempted so far needed a mutation story — patch
records, settle-record replay, conversion seeds, temporary readers — and
each of those stories is what the closures rejected. Meanwhile main has
moved the OPPOSITE direction since v0.40.2: the storage/session area grew
+2,924/−958 (deletion-authority machinery hand-built on the old substrate),
and a measured workspace carries 991 MB of transcripts whose every save is
O(stream).

The root fix is to stop persisting the fold. The session already has an
authoritative, immutable fact stream — the run/session events admitted
through `SessionFactApplier` (the single admission door #10805 finished
building) and the `AgentEvent` trace plane. Events do not mutate. A durable
log of events is append-only BY NATURE, not by compensation.

Survey evidence (2026-08 snapshots, verified in-tree): deepseek-harness
persists exactly this shape ("model-visible means logged"; the log is the
only truth; messages are derived by fold; seq = log length), pi persists an
immutable entry tree with append-only lines, and codex's rollout lines are
immutable at creation. All three get torn-tail crash tolerance, O(1)
appends, and zero cache-coherence machinery from the same property this
spec adopts: **rows never change**.

## 3. Design

### 3.1 The journal

One append-only file per stream: `streamJournals/{streamId}.jsonl`.

- **Line 1 — header:** stream identity (streamId, executionId at creation,
  parentStreamId), format version (one integer), createdAt, and the bounded
  listing metadata (identity label, model, workingDirectory, agentCategory;
  a process run's command line — an agent run's full instruction text never
  enters the header, preserving today's command-bounding policy).
- **Every later line — one admitted session event**, in admission order,
  redacted at admission (§3.5). Events are immutable at birth. There is no
  update, no settle record, no patch line: nothing on disk ever changes
  except by appending.
- `seq` is implicit: the line's position. The fold validates contiguity;
  a torn final line is sealed (newline-terminated) on open-for-append and
  ignored by the fold — a crash loses at most one partial line.
- Metadata changes (description updates, parent attachment, follow-up
  support) are appended meta events; the listing tier folds header + meta
  events, reading only the header line and a bounded tail for the common
  list view.

### 3.2 The fold (single ordering coordinate — C1)

The transcript the Stream tab renders is a deterministic fold of the
journal: `fold(events) -> ConversationEntries`. The fold owns entry
assembly (streamed text materialization, tool call/result correlation,
group open/close, compaction shadowing) — the logic that lives in
`TexraTranscriptRecorder`'s event mapping today moves from
"map event to store mutation" to "map event to fold state", and the
recorder's writer choreography is deleted.

Ordering is the event order. Display-level settlement ("this row can enter
append-only scrollback") becomes a PURE fold property — a row is settled
when the fold has seen its terminal event — computed identically from a
live tail and a cold read, because both consume the same event sequence.
There is no persisted ordering field at all, so the v3 cold-replay defect
(replay reassigning slots in settle order) is unrepresentable, and C1 is
satisfied by construction rather than by discipline.

### 3.3 Derived surfaces (C4)

Everything that is not the journal is a discardable fold of it (#9434
derived tier, discard-and-rebuild, never migrate):

- **Listing/summaries:** folded from headers + meta events; the
  `streamLogSummaries/` cache directory, its mtime staleness heuristic, and
  the #9947 mirror/antechamber apparatus are not carried into the new path.
- **Usage:** usage events fold to totals; a periodic usage checkpoint event
  (appended, immutable, self-superseding) bounds the cold cost of the
  status bar's usage-only read.
- **Work plan / todos / compile failures / output files:** the run facts
  `StreamSnapshotStore` projects into six sidecar files today are already
  events; they fold from the journal. The snapshot store's seed chains,
  overlay replay, per-category write mutexes, dirty-write coherence, and
  refresh rollback have no equivalent in the new path.
- **Resume:** `StreamSnapshot` assembly becomes a fold; liveness clamping
  stays host-side as today.

### 3.4 Writes, durability, streaming

- **Single writer per stream:** the session's admission door is the only
  producer; writer authority rides the existing execution model (presence
  leases, #10778) unchanged.
- **Durability policy:** boundary events (turn/tool/group/stream terminal
  events, user prompts) append eagerly — durable at once, no batching
  window. High-frequency non-boundary facts may share a bounded max-wait
  coalescer ONLY if profiling demands it (the one verified residue of the
  old write-behind tier).
- **Streaming deltas are live-only.** Text/thinking chunks reach renderers
  through the existing delta plane and are never persisted; the terminal
  event carries the materialized, redacted whole text. Ratified trade
  (recorded on #10845): a crash mid-stream loses the in-flight streamed
  entry, not ≤300 ms of tail — in exchange, a secret split across chunks
  can never reach disk, and the journal stays one line per event.

### 3.5 Redaction

`redactSecrets` runs once, at event admission, on the materialized event
payload — a single door instead of today's per-sink calls. Because deltas
are not persisted, the v2/v3 redaction-permanence hazard (un-redacted
intermediate lines permanent in a raw append-only file) cannot occur.

### 3.6 Deletion and crash recovery

- **Deletion is decide-first** on the #10805 foundations: `SessionState`
  commits the tombstone + incarnation fence, then the journal is unlinked
  and derived state dropped; the id stays unavailable until cleanup
  completes; a startup sweep removes derived/artifact residue for ids
  absent from the registry. The staged rename transaction, rollback
  recovery machine, and buffered-write diversion have nothing to guard.
- **Crash recovery is a fold property:** an unterminated group/stream/tool
  at the end of the journal folds as interrupted-terminal (today's
  `endRunningGroupsForStreams` semantics), optionally recorded as an
  appended recovery event on next open so later folds are cheap. Nothing
  is truncated; nothing is rewritten.

## 4. Migration (C2): version-gated, zero conversion

- **v0.40.3 ships current main unchanged** (deletion-authority release).
- **v0.41: new sessions write the journal.** The journal path contains no
  legacy knowledge — no converter, no compat reader, no dual-write.
- **Existing streams stay on the current store as a FROZEN legacy
  surface** — bugfix-only, read/resume via the code that ships today —
  until a dated horizon (proposed: two releases or 90 days after v0.41,
  whichever is later), after which the legacy store, its directories, and
  its tests are deleted in one retirement PR. Retention and user deletion
  drain the data; the retirement PR removes the code.
- This is C2 satisfied literally: there is never a second chain — there is
  the shipped chain, frozen with a death date, and the new chain, born
  clean. The cost is honest: legacy transcripts never become journals; they
  age out.
- **Open fork for the owner (§8):** whether legacy sessions stay resumable
  through the horizon (recommended — resume uses the frozen path and keeps
  writing legacy format for that stream only) or become view-only at v0.41.

## 5. What this deletes (from the verified audit inventory; re-verify per PR)

| Retired with the journal (by stage) | ~LOC |
| --- | --- |
| `StreamLogStore` write-behind tier (throttle, dirtyIds, writeQueue, generations, tombstones, flush loop) | 355 |
| `StreamLogStore` residency tier (eviction, hydrate-merge, leases, loadFailed) | 400 |
| Summary tier + #9947 mirror/antechamber (store + snapshot sides) | 310 |
| Corrupt-file round-trip + legacy normalization arms | 130 |
| `StagedDeletionCoordinator` + snapshot integration | 730 |
| `StreamSnapshotStore` coherence protocol (seed/overlay/mutex/dirty-write/refresh/version/flush) | ~1,000 |
| Recorder writer choreography + consumer ceremony (reservedWriter threading, ensureLoaded preloads, archive store ceremony, timestamp latch) | ~200 |
| Pinned test suites retired with their machinery | ~2,500 |

New code: journal writer + fold + listing (~500–700), well under the
deletions. Tests: a few at the durable boundary (journal round-trip, fold
determinism, torn tail, recovery), per the testing-discipline budget.
Estimates are the audit's; each stage's PR re-measures (R6).

## 6. Stages (each build-implies-delete; gates filed as issues on merge)

1. **Journal writer + fold for new sessions** behind the existing store
   surface; header listing for journal streams.
2. **Renderer/read paths consume the fold** for journal streams (CLI,
   webview, trace viewer); delta plane unchanged.
3. **Decide-first deletion** for journal streams; coordinator bypassed.
4. **Sidecar folds** replace snapshot projections for journal streams.
5. **Legacy retirement** at the horizon: delete the frozen store, the
   coordinator, and their suites in one PR.

## 7. Non-goals

No SQLite (the parked PRD is untouched; a derived, rebuildable index over
journals remains a later evidence-gated option). No conversion tooling. No
provider stream resumption. No multi-writer. No CRDT/sync. No change to
execution KV records, leases, or goals. Not published (internal `docs/prds/`).

## 8. Open questions (owner decisions)

1. Legacy sessions during the horizon: resumable via the frozen path
   (recommended) or view-only?
2. Horizon length: two releases / 90 days (proposed) or shorter, given the
   intermediate-data-disposable policy?
3. Journal granularity: per stream (proposed — matches deletion and
   listing) vs per session.

## 9. Supersessions and rulings ledger

- 2026-08-18: this spec supersedes the transcript-persistence claims of
  `2026-08-15-single-substrate-hosts-as-renderers.md` and
  `2026-08-11-transcript-memory-architecture.md`; Waves A–C's in-memory
  consolidation continues as its own program and is unaffected. #10773,
  #10774, #10809, #10842–#10844, #10817, #10819, #10820, #10841, #10845
  remain closed and are cited as evidence only.
