# D5 measurement: stable published views versus the in-place fold

> **Status:** measured 2026-09-05 on `main` at `a816322f10`
> (`sessionFold.ts` SHA-256 `fb23facb...340e66`). Part of
> [#11864](https://github.com/LionSR/TeXRA/issues/11864). Decision D5 on the
> "Agent SDK on the Fold" page and the decision gate in
> [PR #11893](https://github.com/LionSR/TeXRA/pull/11893) ask whether the
> session fold can publish immutable views with structural sharing within
> budget, instead of today's in-place level. This document is the answer.
> No production code changes, and no benchmark script is checked in: the
> script mirrors the fold's private spelling, so section 4 points at the
> commit that carried it instead.
>
> **Adoption:** [PR #11915](https://github.com/LionSR/TeXRA/pull/11915) adopts
> D5 in `sessionFold.ts` (2026-09-06); the adopted fold, re-measured with the
> same method against `origin/main` on one machine, is tabled in that PR.

## 1. Question and gate

Today `fold(view, input)` replaces the `SessionView` envelope and every
`StreamView` and `TranscriptView` value it changes, but the six session
`Map`s (`streams`, `policy`, `folded`, `latest`, `inflight`,
`queuedFollowUps`) and the `rows` and `taskGroups` arrays of a transcript are
appended in place. A reader holding an older view therefore sees a later
level through those containers, which the SDK README and `AgentRun.view` state
as an out-of-contract fact. D5 proposes the alternative: each published level
is immutable, with untouched branches shared by reference.

The gate, as stated on the SDK page and in this task: copy-on-touch stays
within 2x of the current fold on cold replay and within the 16 ms frame budget
on sustained streaming.

## 2. Results

Machine: Node v26.7.0, macOS arm64, Apple M1 Ultra, 20 cores, 64 GiB. Vitest
4.1.11, one process, no other builds running. Values are the second of two
runs; the first run agreed within noise on every row.

### Session workload: 3,000 streams, 39,005 rows, 62,077 replay inputs, 5 streaming, 400 frames

300 workflow roots each with three agent children, 1,800 top-level agent runs;
every agent run has a user message and 13 settled replies; five children of
the last five roots stream, one 40-character append each per 16 ms frame.

| Metric                                   | current   | copy-on-touch | bucketed  |
| ---------------------------------------- | --------- | ------------- | --------- |
| Cold replay, frames of 512 (median of 5) | 186.48 ms | 292.76 ms     | 316.40 ms |
| Cold replay, slowest frame, median of 5  | 4.58 ms   | 5.29 ms       | 6.88 ms   |
| Cold replay, one batch (median of 5)     | 170.61 ms | 167.71 ms     | 223.45 ms |
| Streaming fold per frame p50             | 0.12 ms   | 1.19 ms       | 0.29 ms   |
| Streaming fold per frame p95             | 0.28 ms   | 2.19 ms       | 0.61 ms   |
| Streaming fold per frame max             | 1.50 ms   | 4.85 ms       | 1.34 ms   |
| Frames over 16 ms                        | 0         | 0             | 0         |
| Heap allocated per frame (sampled)       | 52 KiB    | 577 KiB       | 94 KiB    |
| Retained by the last 10 levels           | 0.03 MiB  | 1.63 MiB      | 0.75 MiB  |
| Retained by the last 100 levels          | 0.04 MiB  | 17.84 MiB     | 8.01 MiB  |
| Older level unchanged after 400 frames   | no        | yes           | yes       |
| Untouched stream shared by reference     | yes       | yes           | yes       |

### Long transcript: 1 stream, 40,001 rows, 40,008 replay inputs, 1 streaming, 400 frames

One agent run whose single transcript holds 40,000 settled rows and one live
reply; the same 40-character append per frame.

| Metric                                   | current   | copy-on-touch | bucketed  |
| ---------------------------------------- | --------- | ------------- | --------- |
| Cold replay, frames of 512 (median of 5) | 111.23 ms | 113.70 ms     | 136.21 ms |
| Cold replay, slowest frame, median of 5  | 3.49 ms   | 3.87 ms       | 4.11 ms   |
| Cold replay, one batch (median of 5)     | 109.40 ms | 108.43 ms     | 131.50 ms |
| Streaming fold per frame p50             | 0.07 ms   | 0.18 ms       | 0.18 ms   |
| Streaming fold per frame p95             | 0.20 ms   | 0.96 ms       | 0.91 ms   |
| Streaming fold per frame max             | 0.91 ms   | 5.74 ms       | 4.83 ms   |
| Frames over 16 ms                        | 0         | 0             | 0         |
| Heap allocated per frame (sampled)       | 10 KiB    | 325 KiB       | 325 KiB   |
| Retained by the last 10 levels           | 0.00 MiB  | 2.88 MiB      | 2.89 MiB  |
| Retained by the last 100 levels          | 0.01 MiB  | 31.64 MiB     | 31.75 MiB |
| Older level unchanged after 400 frames   | no        | yes           | yes       |
| Untouched stream shared by reference     | n/a       | n/a           | n/a       |

The `current` column's retained numbers are near zero because its levels
share one set of mutable containers: holding ten `current` levels does not
preserve ten states, as the "older level unchanged" row shows. The two
retained rows are the heap the 9 (respectively 99) older levels beyond the
latest hold, since the latest level is held in both measurements (section 4,
"Metrics"). "Slowest frame, median of 5" is the median over the five cold
replays of each replay's slowest 512-input frame, not the slowest frame seen
across all five.

## 3. Reading

Copy-on-touch passes both gates with room. Cold replay published once per
512-input frame costs 292.8 ms against 186.5 ms today, 1.57x, inside the 2x
line; folded as one batch, which is how `SessionViewService` receives a
completed replay (PRD 7.2), the two are indistinguishable (167.7 ms against
170.6 ms), because a container is copied at most once per published level and
a one-level replay copies each once. On sustained streaming the copy-on-touch
fold spends 1.19 ms per frame at p50 and 2.19 ms at p95, with no frame over
16 ms across 400 frames; that is eight times today's p95 of 0.28 ms and 14
percent of the frame budget. The long transcript is cheaper still: 0.96 ms at
p95 for a 40,001-row array copied every frame. The bucketed variant, which
shares the session maps 64 ways instead of copying them whole, brings
streaming down to 0.61 ms at p95 and halves the memory of retained levels, at
the price of hashing on every `get`, which shows as a 31 percent slower
one-batch replay.

What dominates is the whole copy of `view.streams`. The two variants differ
only in how that map is copied, and the difference is 0.9 ms and 480 KiB per
frame of the 1.19 ms and 577 KiB copy-on-touch spends: at 3,000 streams a
`new Map(old)` per level is the cost, not the five sliced transcripts of 15
rows each or the envelope. On cold replay in frames the extra 106 ms is the
same copy repeated 122 times for `streams`, `folded`, and `latest` (about
three entries per stream) as they grow, and it vanishes when the replay is
one batch. In the long transcript the 40,001-row `rows.slice()` is what a
frame pays: about 0.1 ms and 0.3 MiB per level (325 KiB allocated per frame,
2.9 MiB retained by nine older levels). Time is not the issue there; memory
is, and only when a reader retains levels. A chunked transcript array would
remove that copy, but at 40,000 rows the copy is already inside the budget by
two orders of magnitude, so this measurement does not justify changing the
published `rows` shape.

## 4. Method

The measurement script is intentionally not checked in. It bundles a
source-transformed copy of `sessionFold.ts` and counts the fold's in-place
mutation sites by their spelling, so any behavior-preserving edit to the fold
would break it without saying anything about the fold; a script like that
belongs to the measurement, not to the test kernel. The exact script that
produced the tables above was carried by commit `32da0de1f7` on the PR branch
as `src/test-kernel/shared/session/foldPublication.bench.vitest.ts`, a Vitest
file gated on `TEXRA_FOLD_BENCH=1`. To reproduce, check out `main` at
`a816322f10` (or any commit where `sessionFold.ts` still matches the SHA-256
above), restore the script from that commit, and run it from the repository
root with other builds paused:

```sh
git show 32da0de1f7:src/test-kernel/shared/session/foldPublication.bench.vitest.ts \
  > src/test-kernel/shared/session/foldPublication.bench.vitest.ts
TEXRA_FOLD_BENCH=1 npx vitest run --config vitest.config.mjs \
  src/test-kernel/shared/session/foldPublication.bench.vitest.ts
```

`TEXRA_FOLD_BENCH_OUT=/path/report.json` also writes the raw numbers. The run
takes about one minute. Delete the restored file afterwards. Section 5 links
the earlier independent measurement at its recorded revision. D5 is now
adopted; [PR #11915](https://github.com/LionSR/TeXRA/pull/11915) reports the
measurement of the production fold.

**Variants.** All three columns run the production
[`sessionFold.ts`](../../src/shared/session/sessionFold.ts), bundled with
esbuild through the repository's `tsconfig.json` paths. `current` is the
source unchanged. The two variants are the same source with a transform
applied at bundle time, in the benchmark only: `export function fold` becomes
a private `mutableFold`; the 17 in-place `set` and `delete` calls on the six
session maps go through `writableMap(view, key)`; `replaceTranscript` passes
`rows` and `taskGroups` through `writableArray`; and the exported `fold`
resets a per-call ownership set before delegating. A container is copied the
first time a frame writes it and reused for the rest of that frame, so a
published level is never written again, and untouched branches are shared. The
transform counts its sites and fails if the source drifts. `copy-on-touch`
copies with `new Map(old)` and `old.slice()`. `bucketed` replaces the six
maps with a 64-bucket persistent map (a write copies the 64-entry spine and
one bucket); transcript arrays are still sliced. The fold's private indexes
(row and group positions, compaction state, streaming cursors, session
indexes) stay single-owner working state carried to the copied containers,
so both variants support sequential publication only, not folding new inputs
into an older level.

**Parity.** Before timing, the untransformed bundle and the source fold are
checked to produce the same digest for a small seed plus eight frames, and
every variant's final view after each workload is digest-compared; the run
fails if they diverge. The "older level unchanged" row re-reads the streaming
rows through the pre-streaming level after 400 frames; the "untouched stream"
row compares one unstreamed top-level stream by identity across the run.

**Seed.** Events are built with the `Log` fixture from
[`fanOutScenario.ts`](../../src/test-kernel/shared/session/fanOutScenario.ts),
so seq, commit, and owner are stamped the way the event table keys them. The
replay is one `subscriptions` input for every stream, then every event in
commit order, then a `local` snapshot naming this process as owner.

**Metrics.** Cold replay folds the replay in frames of 512 inputs from an
empty view; one warm-up pass, then the median of five, with an explicit GC
before each; "slowest frame" is the median over those five runs of each run's
slowest frame. "One batch" folds the same inputs in one `fold` call. Streaming
runs 400 frames scheduled 16 ms apart with `setTimeout`, each frame one
40-character chunk per streaming stream (2,000 chunks in the session
workload); only the `fold` call is timed, and p50, p95, and max are
nearest-rank over the 400 samples. Allocation per frame is a separate unpaced
pass under V8's sampling heap profiler (`HeapProfiler.startSampling`, 32 KiB
interval, collected objects included), total sampled bytes divided by 400; it
is an estimate. Retained memory holds the last 10 (and 100) published levels
in an array during an unpaced 400-frame pass, forces GC, reads `heapUsed`,
releases every level but the latest, forces GC again, and reports the
difference. Because the latest level is held on both sides, the difference is
what the 9 (and 99) older levels retain beyond the latest, so a per-level
cost is the row divided by 9 or 99, not by 10 or 100.

## 5. Relation to the measurement in #11911

The earlier [D5 measurement](https://github.com/LionSR/TeXRA/blob/e6c76a6ae74ad90ec2139e267366d7b45f540bd0/docs/proposals/2026-09-05-session-fold-immutable-publication-measurement.md)
from [PR #11911](https://github.com/LionSR/TeXRA/pull/11911) used the same
transform idea on a different seed: 2,048 streams, 101,176 rows, 600 frames,
and a copy-on-touch p99 of 4.05 ms for 32 concurrent transcripts. Its
[script](https://github.com/LionSR/TeXRA/blob/e6c76a6ae74ad90ec2139e267366d7b45f540bd0/packages/desktop/design-harness/measure-session-fold.mjs)
and [raw report](https://github.com/LionSR/TeXRA/blob/e6c76a6ae74ad90ec2139e267366d7b45f540bd0/packages/desktop/design-harness/session-fold-performance-2026-09-05.json)
remain available at that pinned revision. This document agrees with its
direction and adds the seed shape named on the SDK page, p50 and p95 per
frame, cold replay in frames of 512 beside one-batch replay, retention of
the last 10 levels rather than 600, and a second shape that isolates what
dominates.

[PR #11915](https://github.com/LionSR/TeXRA/pull/11915) adopted D5 and measured
the production fold. The earlier transformed-copy script, raw report, and
superseded September 5 report are retired from the current tree; they are
historical evidence, not a benchmark for the adopted implementation. In
particular, that transform expected a `transcript.compaction` array that no
longer exists. Future measurements should exercise the production fold.

## 6. Recommendation

**Adopt.** Publish immutable levels by copying touched containers once per
`fold` call, exactly the transform above, without changing the published
`rows` shape. The cost on the workload D5 named is 1 ms per frame and about
0.18 MiB per retained level at 3,000 streams (1.63 MiB across the 9 older
levels the 10-level measurement holds beyond the latest; 17.84 MiB across 99
gives the same 0.18 MiB), and nothing on one-batch replay. Do not adopt the
chunked transcript: the array copy is inside the frame budget by two orders
of magnitude at 40,000 rows, and a change to the `rows` shape would touch
every renderer for a memory saving that only matters to a reader retaining
many levels of a very long transcript, which the residency rule (PRD 5.2)
already bounds.

Keep the bucketed map as the identified next step, not part of this
adoption: it removes most of the per-frame cost and half the retained memory
by changing the copy shape alone, but it hashes on every `get` and shows a 31
percent slower one-batch replay. It becomes worth its weight if sessions grow
well past 3,000 streams or if readers routinely lag by many levels; neither
is the case today.

Adopting also changes the contract from "a caller holds the latest view
only" to "an older view is stable to read; it is not a fold input". The
fold's private indexes remain single-owner, so folding new inputs into an
older level stays unsupported, which is what every consumer does today.

## 7. What deletes if adopted

- `packages/agent/README.md` lines 73 to 76, the clause "Each view is the
  runtime's own value, not a copy: a yielded view supersedes the one before
  it, and the maps and arrays beneath an older view may already show a later
  level", replaced by one sentence stating that every yielded view is
  immutable and an older view stays what it was.
- `packages/agent/src/index.ts` lines 126 to 131, the `AgentRun.view` doc
  comment carrying the same out-of-contract note ("a value read through an
  older view may already show a later level").
- `src/shared/session/sessionFold.ts` header, lines 36 to 47: "a
  transcript's arrays are appended in place (a copy per entry would make a
  replay quadratic)" and "A caller holds the latest view only". The
  quadratic worry does not apply to copy-on-touch, which copies per
  published level, not per entry; a one-batch replay copies each array once.
- `src/shared/session/sessionView.ts` lines 53 to 58, the `TranscriptView`
  doc: "`rows` and `taskGroups` are appended in place by the fold".
- Renderer code that defends against in-place mutation: none exists to
  delete. The extension's `TaskGroupList` and the CLI's `transcriptLines`
  memoize by row object identity, which already holds because rows are
  replaced today; `sessionSurfaces.ts` compares view envelopes by identity,
  which also holds. No renderer copies `rows` or snapshots a view.

The production change itself is about 30 lines in `sessionFold.ts` (the
ownership set, `writableMap`, `writableArray`, re-keying `SESSION_INDEXES`
to the copied `streams` map, and the `fold` wrapper), which is the transform
the measurement script applied and checked for parity.

## 8. Limitations

- The fold alone is measured: no rendering, transport framing, event
  parsing, or persistence. The 16 ms budget is shared with all of those.
- The seed is synthetic. Chunk text contains no `<`, so the embedded
  follow-up scan in `foldTextChunk` never ran; workflow boards were exercised
  on replay but not on sustained board updates.
- 400 frames (6.4 s) per workload on one machine; allocation is a V8 sampling
  estimate; the smallest retention numbers are within GC noise.
- The bucketed variant is a benchmark shape (64 fixed buckets, a string
  hash), not a design; its cold-replay penalty is what that shape costs, not
  what a tuned persistent map would.
- Both variants support sequential publication only; branching from an older
  level is unmeasured because it is unsupported.
