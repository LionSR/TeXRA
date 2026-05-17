# Logger Simplification — Feasibility Assessment

**Status:** Proposal / analysis. Not approved.
**Date:** 2026-05-17
**Reference:** Claude Code (`~/Library/Mobile Documents/com~apple~CloudDocs/Downloads/claude-code-main`)

## TL;DR

About **800–1,200 lines** of logger code can be removed without losing
capability. The reduction comes from collapsing a four-step sink chain
(`AgentLogger → logUtils → structuredLogger → LogBackend → consoleLog`),
inlining 30-line micro-modules, and dropping the `platform/log` indirection
that has exactly one implementation. **The remaining ~1,200 lines
(`StreamLogStore` + `AgentLogger` core) are mostly load-bearing** — TeXRA's
multi-stream, history-browsable, in-place-streamed log model is genuinely
more complex than Claude Code's single-session JSONL append. Trying to copy
Claude Code wholesale would break the History browser, multi-agent merge
flows, and CLI throttling.

Realistic plan: do Phase 1 (sink-chain flattening, ~600 LOC) now, Phase 2
(persistence format) only if disk format pain shows up, skip Phase 3.

---

## 1. What we have today

### Layer inventory

| Module                         |  Lines | Direct importers  | Notes                                                   |
| ------------------------------ | -----: | ----------------- | ------------------------------------------------------- |
| `AgentLogger.ts`               |    606 | 43                | Main facade. 26 instantiations across tools, agents, UI |
| `StreamLogStore.ts`            |    872 | 4 direct          | Lazy-load, eviction, summary cache, dirty tracking      |
| `StreamLog.ts`                 |    151 | (via store)       | Entry array + seqNo + dirty index                       |
| `logUtils.ts`                  |    183 | 25                | Legacy channel-keyed logger; independent facade         |
| `structuredLogger.ts`          |    184 | 2 (only logUtils) | Async-local groups, `LogSink` interface                 |
| `filterUtils.ts`               |     20 | 1                 | `shouldEmit()`                                          |
| `logOptions.ts`                |     11 | 3 (type-only)     | `LogOptions` interface                                  |
| `ProgressEventBus.ts`          |    309 | many              | **Different concern** (status events, not logs)         |
| `platform/interfaces/log.ts`   |     17 | —                 | `LogBackend` interface                                  |
| `platform/defaults/consoleLog` |     26 | —                 | The **only** `LogBackend` impl                          |
| **Total logger surface**       | ~2,070 |                   | (excluding ProgressEventBus)                            |

### Actual call graph

```
agent code ──→ AgentLogger ──→ logUtils ──→ structuredLogger ──→ LogBackend ──→ consoleLog
                    │
                    └──→ StreamLogStore ──→ StreamLog ──→ KVStore (per-stream JSON)

housekeeping ──→ logUtils ──→ structuredLogger ──→ LogBackend ──→ consoleLog
   (latexdiff, pack, clean — bypasses AgentLogger entirely)

UI side:
   StreamLogStore.onChange ──→ WebviewBridge (ext)         ──→ logSlice
   StreamLogStore.onChange ──→ subscribeStreamLog (CLI)    ──→ cliState
```

Two surprises from the deeper read:

1. **`logUtils` is not wrapped by `AgentLogger` — they coexist.** Both
   delegate to `structuredLogger`. Housekeeping modules (`latexdiff`,
   `pack`, `clean`, `indent` — 6 sites) use `logUtils` directly and never
   touch `StreamLogStore`.
2. **`ProgressEventBus` and `StreamLogStore.onChange` are not redundant.**
   The bus carries `odysseyStateChanged`, `inquiryThreadUpdated`,
   `resolveExternalInquiry` — three events, no log overlap. My first pass
   was wrong; do **not** merge them.

---

## 2. What Claude Code does instead

Three layers, ~5,500 lines (most in one file):

```
agent event ──→ React state (message[])       ← UI reads from here
            └──→ Project.enqueueWrite()        ← single batched queue
                    └──→ 100 ms drain → fs.appendFile(JSONL)
```

Key design choices:

- **One `Entry` discriminated union** (~14 variants: user, assistant,
  tool, summary, snapshot, attribution, …). One schema, one append path.
- **No subscribe/stream layer between storage and UI.** React state _is_
  the queue; disk is write-only during a session.
- **JSONL append-only.** No in-place mutation of past entries.
- **Domain-split logging:** errors (`log.ts`, 362 L), conversation
  (`sessionStorage.ts`, 5,105 L), telemetry (`logging.ts`, 788 L). No
  unified facade.
- **No platform/log interface.** Writes go straight to `fs.appendFile`;
  sinks (stderr text, ndjson stdout) plug in at the renderer layer.

---

## 3. What blocks a wholesale copy

Four TeXRA features depend on behavior Claude Code doesn't have:

### 3.1 In-place mutation of streaming entries (load-bearing)

`AgentLogger.createStream()` writes **one** entry on first chunk, then
**updates that same entry** with each subsequent chunk via
`StreamLog.update()` (50 ms throttle, `STREAM_UPDATE_THROTTLE_MS`).
The CLI's `subscribeStreamLog.ts` uses `getRange(fromSeq, toSeq)` and
`drainDirtyUpdates()` to render only changed entries at 16 ms throttle.

Switching to append-only JSONL means **N append events per stream chunk**
(10–50× more entries per response), losing the dirty-set optimization
that keeps CLI rendering smooth.

**Verdict:** Keep in-place updates. They are not accidental complexity.

### 3.2 History browser needs random-access reads

`historySearch.ts` lists past streams via the **summaries** KV store
(`streamLogSummaries/`). When the user clicks an item, that **specific
stream** is lazy-loaded from `streamLogs/<streamId>`. Claude Code's
session JSONL is keyed by session ID too, but TeXRA does this at much
finer granularity (per agent run, sometimes dozens per session).

A single rolling JSONL won't work. **Per-stream files are essential.**

### 3.3 Multi-stream concurrency + eviction

`StreamLogStore` supports concurrent agent runs:

- `pendingLoads` dedupes parallel `ensureLoaded()` calls
- `flushing` set prevents eviction mid-write
- `pendingRelease` defers drops until safe
- Load concurrency capped at 8 (`STREAM_LOG_LOAD_CONCURRENCY`)

Claude Code's "React state is the queue" works because there's one
active session. TeXRA's merge flows and parallel agent fan-outs run many
streams simultaneously and need real memory management.

**Verdict:** Keep lazy load + eviction + pendingRelease. ~250 LOC,
non-negotiable.

### 3.4 Summary cache survives eviction

The sidebar shows `firstTimestamp` / `lastTimestamp` / `hasRunningGroup`
even when the full log has been evicted. Summaries live in their own
KVStore (`streamLogSummaries/`) and are recomputed when log mtime >
summary mtime. This is ~150 LOC worth keeping.

---

## 4. What can actually be cut

### Phase 1 — Flatten the sink chain (low risk, ~600 LOC)

**Delete:**

- `src/logger/structuredLogger.ts` (184 L) — only used by `logUtils`
- `src/platform/interfaces/log.ts` (17 L) — one impl
- `src/platform/defaults/consoleLog.ts` (26 L) — fold into a sink
- `src/logger/filterUtils.ts` (20 L) — inline into `AgentLogger`
- `src/logger/logOptions.ts` (11 L) — inline (type-only, 3 callers)

**Reshape:**

- Define a tiny `LogSink` interface (`write(entry)`) directly in
  `AgentLogger` or a new `logSinks.ts` (~40 L).
- `AgentLogger` writes to an array of sinks: `consoleSink`,
  `outputChannelSink` (registered from `extension.ts`),
  `storeSink` (writes to `StreamLogStore`).
- `logUtils` either (a) becomes a thin module that exposes the same
  sinks for non-agent callers, or (b) is folded into `AgentLogger` and
  housekeeping switches to `AgentLogger` with a fixed scope. Option (a)
  keeps the housekeeping diff small.

**Net effect:** ~600 LOC removed, four layers → two, single mental model
for "where does a log line go."

**Risk:** Low. `structuredLogger` has 2 importers. `consoleLog` has zero
external callers. `LogBackend` has one impl. Tests under
`src/test/logger/` would need updates but the API surface for callers
(43 AgentLogger importers, 25 logUtils importers) stays the same.

### Phase 2 — Persistence format swap (medium risk, ~150 LOC)

**Idea:** Replace per-stream KVStore JSON arrays with per-stream JSONL.

**Pros:**

- Append is a single `fs.appendFile`, no read-modify-write
- Crash safety: partial writes only lose the last entry, not the file
- Easier to tail/inspect from outside the app

**Cons:**

- Have to rewrite KVStore-backed code paths and a chunk of
  `StreamLogStoreLoad.vitest.ts`
- **In-place updates need a coalesce step**: either compact-on-flush
  (rewrite file on update-heavy entries) or accept growth and compact
  on load. Both add complexity that partially offsets the save.
- Summary KV stays separate — no benefit there

**Verdict:** Defer. The current format works; touch only if disk size or
crash-corruption pain shows up. Estimated savings ~150 LOC, mostly in
KVStore wrappers, partially given back to JSONL parse + compact logic.

### Phase 3 — Drop dirty tracking, go append-only (NOT recommended)

Would let us inline `StreamLog` into `StreamLogStore` and remove
`drainDirtyUpdates()`, `getRange()` complexity. Saves maybe ~200 LOC.

**Costs:**

- CLI render perf regresses (50× more entries per response on streaming)
- `subscribeStreamLog.ts` and `logSlice` both need rewrites
- ~150 LOC of tests rewritten
- Live progress view stuttering during fast token streams

**Verdict:** Negative ROI. The dirty-tracking design exists because pure
append broke the UI; reverting would re-introduce the original problem.

---

## 5. Recommended plan

| Phase | Scope                                | LOC removed | Risk   | Do it? |
| ----: | ------------------------------------ | ----------: | ------ | ------ |
|     1 | Flatten sink chain, inline micros    |        ~600 | Low    | Yes    |
|    1b | Decide logUtils fate (merge vs keep) |        ~100 | Low    | Yes    |
|     2 | JSONL persistence                    |        ~150 | Medium | Defer  |
|     3 | Drop dirty tracking / pure append    |        ~200 | High   | No     |

**Expected outcome of Phase 1+1b:** ~2,070 LOC → ~1,370 LOC, four layers
collapsed to two, no behavior change for callers or users. `AgentLogger`
and `StreamLogStore` stay at their current size because they're doing
real work (multi-stream, lazy load, eviction, dirty tracking, summary
cache, in-place streaming updates) — that work is not the
over-abstraction.

## 6. What to do first

1. Decide Phase 1b: **fold `logUtils` into `AgentLogger`** (single
   facade, housekeeping switches to `AgentLogger.scoped('housekeeping')`),
   or **keep `logUtils` as a sibling** sharing sinks. Folding is cleaner
   but touches 25 housekeeping call sites; keeping is a smaller diff.
2. Sketch the new `LogSink` interface and the three concrete sinks
   (console, VS Code OutputChannel, StreamLogStore). Wire from
   `extension.ts` exactly once via `initPlatform`.
3. Land a no-op refactor PR: same behavior, fewer files, fewer imports.
   Tests under `src/test/logger/` get updated in the same PR.

Phase 2 and 3 stay in this doc as "considered and deferred" — useful
context for the next person who looks at the logger code and wonders
why it's not pure JSONL like Claude Code's.
