---
created: 2026-09-21
status: proposed
---

# Runtime performance measurement record

This is the single measurement record
[#12427](https://github.com/LionSR/TeXRA/issues/12427) and the completion
protocol's §5 amendment ask for: the three measurements that stay after the
amendment struck the rest, each with machine, dataset, revision, units,
method, a proposed numeric budget, and a reading status. The three are
**cold open**, **stop latency with controlled non-zero work**, and
**commit latency under contention**; each is a _measure once_ item, not a
standing gate.

Every other criterion the protocol's §5 carried is struck and not re-listed
here: live idle memory, replay memory, two-project operation, bytes written
versus retained file size, and missed event-loop deadlines.

**No performance reading is taken in this record, and none is estimated.**
The environment facts below are the only numbers recorded here; they were
read headlessly from the machine. The three performance readings are marked
NOT TAKEN with the procedure to take them, because each needs the
maintainer's desktop (the built host binary, a real interactive stop) or a
purpose-built harness — and the pre-cutover harness was rejected for
mismeasuring, so building a correct one is its own engineering task, not a
record entry.

## Environment (taken headlessly)

| Field    | Reading                                                               | How it was taken                                                                             |
| -------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Machine  | Apple M5, 32 GiB RAM, 10 cores, macOS 26.7 (25G229)                   | `sw_vers`; `sysctl -n machdep.cpu.brand_string`; `sysctl -n hw.memsize`; `sysctl -n hw.ncpu` |
| Node     | v26.9.0                                                               | `node --version`                                                                             |
| Revision | `origin/main` `6eb322f83e75b81602a7f4fdcfede2d329af29f9` (2026-09-21) | `git rev-parse origin/main`                                                                  |

The revision is the baseline every procedure below pins. There is no
measurement harness on it: `scripts/measure-runtime-baseline.mjs` is absent
(`ls scripts/`), matching the issue's note that the #12068/#12502 harness was
never merged.

## 1. Cold open

- **Machine.** The table above.
- **Dataset.** Two SQLite session stores, both opened with the connection
  held inside the measured window (the DB scope must be open while the clock
  runs, not released first — issue comment #1):
  1. a fresh store (no sessions);
  2. a store seeded with one retained session of 10,000 settled message rows
     plus one live reply, mirroring the "long transcript" workload the
     September 5 D5 measurement used.
- **Revision.** `6eb322f83e75b81602a7f4fdcfede2d329af29f9`.
- **Units.** Milliseconds, wall-clock, reported as p50 and p95 over launches.
- **Method.** Launch the built host binary as a child process —
  `packages/cli/dist/bin/texra.js` or `packages/desktop/dist/main/index.js` —
  and time from `spawn` to the host's first signal that a run can be
  accepted (the moment the session store is open and the runtime installed).
  Measure cold (OS page cache dropped) and warm; 20 launches each. The timer
  must stop at the "session ready" boundary, with nothing after it included.
- **Proposed budget (unvalidated).** p95 cold open ≤ **1,000 ms** on the
  populated store and ≤ **500 ms** on the fresh store, on the reference
  machine. A p95 above its bound fails.
- **Reading.** NOT TAKEN — needs the built host binary on the maintainer's
  desktop (or a cold-open harness, which is not on `main`).

## 2. Stop latency with controlled non-zero work

- **Machine.** The table above.
- **Dataset.** A fixture run whose model invocation takes a fixed 100 ms per
  response and whose single tool takes a fixed 100 ms, stopped while that
  work is in flight. "Controlled non-zero work" means the in-flight work must
  actually run for its configured duration — the stop path joins it, it does
  not restart or drop it.
- **Revision.** `6eb322f83e75b81602a7f4fdcfede2d329af29f9`.
- **Units.** Milliseconds, from the stop request to the run's `halted` step
  committed and every admitted child joined (resources released only after
  the last permitted user finishes), reported as p95.
- **Method.** Drive a real run on `it.live` (real time) or the host; issue
  the stop signal mid-flight; time stop-request → full settlement. 100
  trials. The measured window ends at settlement, not at the process's later
  teardown.
- **Proposed budget (unvalidated).** p95 stop latency ≤ **500 ms** with
  100 ms of controlled in-flight work (stop overhead ≤ ~400 ms over the
  work's own completion). A p95 above the bound fails.
- **Reading.** NOT TAKEN — needs a live run with a controlled-delay
  model/tool and a real stop signal, which is an interactive/maintainer
  session (or a dedicated harness not on `main`).

## 3. Commit latency under contention

- **Machine.** The table above.
- **Dataset.** Two projects committing to one shared SQLite `texra.db` in
  WAL mode — the two-root scenario, named for projects (not papers, per the
  issue comment).
- **Revision.** `6eb322f83e75b81602a7f4fdcfede2d329af29f9`.
- **Units.** Milliseconds per commit, reported as p95; plus a hard deadline
  no single commit may exceed.
- **Method.** Two processes each commit a stream of session-event rows to the
  same store, overlapping. The timer for a commit stops at its write deadline:
  verification reads and connection teardown run after the clock stops
  (issue comment #5). Record whether commits serialize on the single SQLite
  writer, and the p95 of the serialized commit.
- **Proposed budget (unvalidated).** p95 commit latency ≤ **50 ms** under
  contention, and no commit exceeds a **1,000 ms** deadline. A p95 above
  50 ms fails.
- **Reading.** NOT TAKEN — needs two real processes over a shared store,
  which is a headless harness that is not on `main`.

## Status of the record

This record supplies the machine, dataset, revision, units, method, and
proposed budget for each of the three measurements the amendment keeps, and
records that none of the three readings has been taken. It is a _measure
once_ record, not a per-pull-request gate: when the three readings are taken
on the maintainer's desktop (or by a reviewed harness), each table gains a
`Reading` line, and any budget a reading contradicts is revised in the same
change before a satisfied budget is claimed.
