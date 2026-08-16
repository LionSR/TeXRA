---
created: 2026-08-16
updated: 2026-08-16
---

# PRD: One SQLite database per workspace for app-owned durable state

**Status:** draft proposal. Companion to
`docs/prds/2026-08-11-transcript-memory-architecture.md` (the memory
evidence), `docs/proposals/2026-08-15-single-substrate-hosts-as-renderers.md`
(orthogonal campaign, no shared PRs), and issues #10702, #10773, #10774,
#10775. **Supersedes the JSONL prescription in #10773** (its diagnosis — the
whole-file rewrite primitive is the root defect — is exactly what this PRD
fixes; the prescription changes because the engine decision changes the
trade-off, §3.2).

**Decision in one sentence:** all app-owned durable workspace state moves into
one SQLite database per workspace (`node:sqlite`, WAL); files remain only for
user-owned documents and interchange/export formats.

## 1. Problem: the semantics layer keeps paying rent for missing primitives

Three times now, well-built coordination machinery has grown to compensate for
a storage primitive that provides no guarantee:

1. **No atomic write smaller than the whole stream.** `StreamLogStore`
   persists a transcript by re-serializing and atomically rewriting the entire
   entries array every 300 ms window (`writeStream` →
   `kv().write(streamId, logInstance.toPersistedEntries())`). Because any save
   can clobber history, the store carries dirty-tracking, write generations,
   tombstones, merge-disk-under-live-appends, a `loadFailed` quarantine, and
   an iterative flush loop — most of its 1,739 lines.
2. **No atomic multi-store operation.** "Delete a stream" spans four state
   holders (`SessionState`, `SessionStores`, `StreamLogStore`,
   `StreamSnapshotStore`), each with its own async queue. PR #10702
   (+1,076/−131, 12 commits, one follow-up revision per review round) had to
   hand-implement the textbook distributed-systems stack — incarnation
   numbers (SWIM), fencing tokens, a saga with compensation
   (`StagedDeletionCoordinator`, 612 lines), OCC re-validation after every
   await, and barrier-buffer-replay — because no transaction exists to buy
   those guarantees from.
3. **No read smaller than everything.** Opening a workspace scans and parses
   every summary file; hydrating a stream parses its whole JSON array;
   `StreamSnapshotStore` seeds six sidecar files per stream (measured
   workspace: 1,923 streams, 991 MB transcripts, 5,274 sidecar files holding
   22 MB) behind seed chains, `DiskState` provenance, and overlay-replay —
   most of its 2,164 lines.

Guard-based concurrency has a property the other debt classes lack: it does
not compose. Every future change touching stream state must be written by
someone who understands incarnations, barriers, and which awaits need
revalidation. That is the recurring maintenance cost this PRD removes.

### Survey evidence (2026-08 snapshots)

- **openai/codex** pairs append-only JSONL rollouts with a SQLite state
  database (`codex-rs/state`) for metadata, backfill, and search. Their cells
  are immutable at creation, which is what makes pure append-only viable for
  them (§3.2 on why it is not for us).
- **sst/opencode** made SQLite (Drizzle) the source of truth for
  sessions/messages/parts/events. Their storage engine choice is validated at
  production scale on Bun/Node; their *app-level transaction semantics*
  (ambient transaction context, post-commit effect queues) are the documented
  cautionary tale (`specs/storage/remove-opencode-db.md`) — §6 bans importing
  that shape here.
- **VS Code itself** stores extension state in SQLite (`state.vscdb`); the
  platform this project embeds in already made this call.

### What changed to make this viable

The Electron PRD (2026-05-02 §5.2) rejected `better-sqlite3` for a then-valid
reason: native dep + asar unpacking + migration tooling. `node:sqlite` ships
inside the Node runtime — zero dependencies, synchronous API. Verified
version floors: workspace `engines.node >= 22.9.0`, desktop Electron ^43,
extension `vscode ^1.125.0` — all three hosts run Node 22+ runtimes carrying
`node:sqlite`. Flag status per host is Stage 0's job to confirm.

## 2. The rule

> **All app-owned durable state lives in `texra.db`, one database per
> workspace storage bucket. Files exist only for (a) user-owned documents
> (LaTeX sources, `original/` snapshots, user-editable memories) and (b)
> interchange formats (archived `trace.json`, chat exports).**

Corollaries:

- Rows own **existence**: a stream, execution, or run exists iff its row
  exists. Deletion is one transaction with `ON DELETE CASCADE`.
- No app-owned live state in files; no user documents in the database.
- Derived tables (FTS index, stats caches) keep the #9434 derived-tier
  contract: discard-and-rebuild from authoritative rows, never migrate.
- The rule is enforced by an architecture test (§7): persistence writes
  outside the database that are not on the documents/export allowlist fail CI.

## 3. Target architecture

### 3.1 Storage layout

```
workspace storage today                     workspace storage after
├── streamLogs/           991 MB            ├── texra.db      (all app state + FTS)
├── streamLogSummaries/   7.5 MB            ├── original/     (user document snapshots)
├── streamData/           5,274 files       └── memories/     (user-editable documents)
├── executions/ executionLeases/
├── executionLocks/ memories/ original/
```

Engine: `node:sqlite` (fallback: `better-sqlite3`, accepting the packaging
cost, if Stage 0 finds the built-in flagged or unfit on any host). Schema and
migrations: `drizzle-orm` + `drizzle-kit` (pure TS, no runtime codegen,
`drizzle-zod` bridges into the existing Zod-SSOT doctrine; `kysely` is the
named alternative if schema-first proves a bad fit). Pragmas at open:
`journal_mode=WAL`, `busy_timeout`, `foreign_keys=ON`, `integrity_check`
(quick) with the existing `openOrEphemeral` degradation path on failure.
Backup: `VACUUM INTO`.

### 3.2 Transcript entries are rows (supersedes #10773's JSONL prescription)

JSONL was the right call in a no-database architecture. Once the database
exists, a second bespoke file format *is* a mixed architecture — and the
inferior fit: TeXRA entries mutate until settled (`update`/`settle`/
`appendText`), so JSONL needs patch-lines, fold-on-read, and close-time
compaction — a hand-rolled LSM tree. Rows fit the mutation model natively:

- append = `INSERT`; mutation = `UPDATE` of one row; settled (#10774) = row
  never written again. The existing 300 ms save throttle batches dirty rows
  in one transaction — same cadence, O(changed rows) instead of O(stream).
- **Partial hydration**, which files structurally cannot give: opening a
  historical stream is `SELECT … ORDER BY seq DESC LIMIT n`, paging older on
  demand. Third independent attack on the memory PRD's problem.
- Transcripts join the same deletion cascade as everything else, so the
  #10702 problem class ends uniformly.

The in-memory `StreamLog` object and the delta/emission protocol are
**unchanged** — they are the UI contract. Only the persistence layer beneath
`StreamLogStore` swaps; the store's public surface stays frozen (the
store-public-surface ratchet is what makes this a swap, not a rewrite).

Entry payloads remain opaque JSON in a single column (Tier 3 stays Tier 3);
this PRD does not normalize entry internals. A separate `text` column feeds
FTS (§3.4).

### 3.3 Schema sketch (finalized in Stage 1, not incrementally)

```
streams        (id PK, incarnation, tombstone, created_ts, last_ts,
                has_running_group, has_running_streaming_text,
                has_nonterminal_workflow_call, parent_stream_id,
                summary_meta JSON)
entries        (stream_id FK CASCADE, seq, entry_id, settlement_seq NULL,
                timestamp, entry JSON, text NULL)  UNIQUE(stream_id, seq)
executions     (id PK, stream_id FK, meta JSON, config JSON)
run_usage      (stream_id FK CASCADE, storage_key, usage JSON)
round_facts    (stream_id FK CASCADE, kind {output|missing|compile},
                round, payload JSON)
work_plans     (stream_id FK CASCADE, plan JSON, todos JSON)
leases/locks   (execution-scoped rows; WAL provides cross-process safety)
entries_fts    (FTS5, contentless, derived; rebuildable)
```

`streams.incarnation` + a terminal tombstone bit replace #10702's generation
protocol; compare-and-set (`… WHERE id = ? AND incarnation = ?`) is the
entire fencing mechanism. The one-bit tombstone and the single fact-gate at
`SessionEventHub` remain — that residue is essential as long as facts are
async.

### 3.4 Capabilities unlocked (not counted in the ledger)

Startup cost proportional to the visible page instead of workspace history;
FTS5 search across all transcripts ("which session proved that lemma?");
usage/cost analytics via `SUM`/`GROUP BY`; a real resume/history picker with
paging and filters; topology queries (recursive CTE over parent edges);
retention as policy (`DELETE` + cascade + file sweeper for exports);
recovery sweep as an indexed `WHERE`; safe concurrent hosts via WAL; later
and flagged: `sqlite-vec` embedding search over `memories/`.

## 4. Net-element accounting (R6)

Measured 2026-08-16 at `origin/main` 6fd0317 (+ #10702 draft). Storage layer
in scope ≈ 8,400 LoC.

| File | Today | After | Net |
| --- | --- | --- | --- |
| `StagedDeletionCoordinator.ts` | 612 | 0 | −612 |
| `StreamLogStore.ts` | 1,739 | ~650 | −1,050 |
| `StreamSnapshotStore.ts` | 2,164 | ~850 | −1,300 |
| `streamSnapshotRead.ts` | 307 | ~50 | −250 |
| `SessionStores.ts` (deletion orchestration) | 777 | ~430 | −350 |
| `executionRegistry.ts` (lease/lock portion) | 1,002 | — | −200 (softest; per-item study owed) |
| `streamDataPaths` + `ResidentStreamRegistry` + `KVStore(+Cache)` | 373 | ~50 | −320 (KV retires when `ExecutionKVStore` migrates) |
| #10702 machinery (draft) | +1,076 | ~150 | −900 |
| `completedRunArchive.ts` | 370 | ~320 | −50 |
| **Gross deletion** | | | **≈ −5,000** |
| Adds: schema (~200) + engine adapter (~200) + migrate-on-open importer (~300, temporary) | | | **+700** |
| **Net production** | | | **≈ −4,300** (range −3,800..−4,800) |

Test footprint pinned to deleted machinery: `StreamLogStoreLoad` 2,083,
`StreamSnapshotStore.vitest` 2,961, `SessionStores.vitest` 748,
`StagedDeletionCoordinator.vitest` 260, `CliPersistenceFlush` 103 — expect
−3,500..−4,500 retired or replaced smaller (tests are budget, per AGENTS.md).

Estimates are read-the-code, same epistemic class as the single-substrate
census; the `childExecutions` lesson (585 → 696 between census and
execution) applies — **re-verify each file's numbers in its own PR.**

## 5. Migration plan — one owner per datum at every moment

Phased adoption is fine; **dual ownership is banned**. Each stage is one PR
family: swap the engine behind the frozen store surface, migrate that store's
data on first open (read files → insert rows → rename old dir to
`*.pre-sqlite-backup`), and delete that store's coordination machinery in the
same PR (build-implies-delete). No long-term mirroring or dual-write.
Archived `trace.json` readers (B3) are untouched — exports are produced from
rows; export compat is not storage compat.

- **Stage 0 — spike (half day).** `node:sqlite` flag status on all three
  hosts; WAL behavior with CLI + extension concurrently open on one
  workspace; Electron 43 bundled Node minor. Go/no-go on the built-in vs
  `better-sqlite3`.
- **Stage 1 — schema + adapter.** The full §3.3 schema lands as one design
  (no incremental schema drift), plus open/migrate/integrity/backup adapter
  and the architecture test (§7).
- **Stage 2 — summaries table.** The pilot: `streamLogSummaries/` is
  contractually derived and discardable (#9434), so worst case is a rebuild.
  Deletes the mtime-staleness heuristic and scan-on-open.
- **Stage 3 — `streamData/` sidecars → rows.** The big machinery win in
  `StreamSnapshotStore` (seed chains, provenance, overlays, write mutexes).
- **Stage 4 — transcript entries → rows.** `StreamLogStore` engine swap;
  clobber machinery deletes; partial hydration lands. Gate: a benchmark PR
  proving the 300 ms batched-transaction path sustains streaming append load
  (~200 mutations/s) with headroom.
- **Stage 5 — registry, incarnation, terminal tombstone.** #10702's
  machinery collapses to the column + the hub gate. Record the
  identity ruling: **stream ids are never reused** — a workflow relaunch
  mints a fresh id; the deterministic slot maps to the current id.
- **Stage 6 — leases/locks → rows/WAL.**
- **Stage 7 — feature payoffs.** FTS5, retention policy, usage analytics.

Ordering with other programs: independent of Waves A–C (different band, no
shared PRs); #10774 (settled ⇒ immutable) should land before Stage 4 so the
bounded-write-set property holds from the first row written; #10775's spill
files become unnecessary once entries are bounded rows (amend that issue at
Stage 4).

## 6. Risks and mitigations

- **Corruption blast radius** (one DB vs per-stream files): bounded per
  workspace; `integrity_check` at open; `openOrEphemeral` degradation path
  unchanged; `VACUUM INTO` backups; the migration's renamed
  `*.pre-sqlite-backup` dirs are retained for a deprecation window.
- **`node:sqlite` maturity/flags**: Stage 0 gate; `better-sqlite3` fallback
  accepted with its packaging cost named.
- **Hot-path throughput**: Stage 4 benchmark gate before the swap ships.
- **The opencode trap** (the failure mode this PRD's survey documents):
  transactions are confined **inside store methods**. No ambient transaction
  context, no post-commit effect queues, no transaction types in app-level
  signatures, and the session event plane is untouched. A PR introducing a
  transaction parameter outside `src/transcript/` + `src/agent/storage/` is
  a review reject.
- **Migration failure**: migrate-on-open is idempotent per store; rollback =
  revert the release + restore the renamed dir. Rows-or-files, never both.
- **Scope creep toward SQL-as-UI-state**: §8 non-goals; the architecture
  test only allowlists the two stores' modules for DB access.

## 7. Invariants preserved (and one added)

Single-writer transcript authority (`TranscriptWriter`); the
delta/emission contract and `StreamLog` in-memory model; #9434 derived-tier
discard-and-rebuild; the loud-degradation rule (strengthened: `NOT NULL` /
`CHECK` / FK constraints reject corrupt writes at the source); frozen store
public surfaces (`store-public-surface-baseline`); hosts-as-renderers plane
rules untouched. **Added:** the §2 rule, pinned by a new architecture test —
app-state persistence outside `texra.db` fails CI unless the path is on the
documents/export allowlist.

## 8. Non-goals

No SQL as source of truth for UI state; no Effect or any framework buy-in;
no wire/protocol change (storage layer only); no cross-workspace global
database; no CRDT/sync layer (the schema does not preclude one later); no
normalization of entry payload internals; no publication of this doc
(internal `docs/prds/`, excluded by `publicDocs.js`).

## 9. Acceptance

- Opening the measured 1,923-stream workspace performs O(visible page) reads.
- Deleting a stream is one transaction; no state holder can observe a
  half-deleted stream; #10702's regression suite passes against the column
  mechanism.
- Kill -9 during streaming loses at most the current throttle window; the
  recovery sweep finalizes orphans from an indexed query.
- All ratchets green; no store public-surface change; Waves A–C unaffected.
- `WORKSPACE_STORAGE_LAYOUT` shrinks to `{ texra.db, original, memories }`.

## 10. Open questions

1. Drizzle vs Kysely — decide in Stage 1 with a one-page comparison on the
   actual schema, not in the abstract.
2. Are `memories/` user-editable documents (stay files) or app state (rows)?
   Owner call.
3. `ExecutionKVStore` / flow-checkpoint persistence: migrate in Stage 6 or a
   later phase 2? (KV layer cannot retire until this moves.)
4. Retention defaults (age? size cap per workspace?) once Stage 7 makes
   policy one statement.
