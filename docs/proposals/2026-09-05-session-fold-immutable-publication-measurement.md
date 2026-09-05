# Immutable session-view publication: D5 measurement

Date: 2026-09-05. Part of [#11864](https://github.com/LionSR/TeXRA/issues/11864).

**Finding:** copying touched containers once per publication fits the measured
16 ms fold-time budget, but keeping older publications has a substantial memory
cost. On a session with 2,048 streams and 101,176 transcript rows, the experimental
fold's 99th-percentile frame time was 4.05 ms for 32 simultaneous streams and
2.46 ms for a single long transcript. Holding 600 publications required an
additional 261 MiB and 300 MiB respectively. These measurements support continued
work at the existing fold owner; they do not establish a production memory budget
or browser-rendering budget. This change leaves the production fold untouched.

## Method

The [measurement script](../../packages/desktop/design-harness/measure-session-fold.mjs)
bundles the current [fold](../../src/shared/session/sessionFold.ts) twice. One
bundle is unchanged. In the other, a confined source transformation copies each
written session Map and each touched transcript's three arrays at most once per
frame. Unchanged streams retain identity. Session and transcript indexes remain
private working state, with their references carried to the copied containers.
The transformation checks its source locations and stops if they have changed.
It neither duplicates the reducer nor changes a production file.

The seed uses `Log` from
[fanOutScenario.ts](../../src/test-kernel/shared/session/fanOutScenario.ts), with
aggregate-local sequence numbers and one session commit order. It contains 64
parent groups of 32 streams. Each stream has 24 settled rows and one live row,
except the final stream, which has 50,000 settled rows and one live row. Cold
replay folds all 105,274 inputs as one publication. The two streaming workloads
append 32 characters per active stream per frame: either 32 short transcripts or
one 50,001-row transcript. Each runs 600 frames scheduled 16 ms apart, representing
9.6 seconds of publication.

Measurements ran in separate Node v26.7.0 processes on macOS arm64, Apple M1 Ultra,
20 logical CPUs, 64 GiB RAM, with concurrent repository builds paused. Cold replay
means an empty view after module loading and a small warm-up; the table gives the
median of three replays. Timed streaming has no allocation profiler attached.
Allocation is measured in a separate pass using V8 heap sampling at 32 KiB,
including collected allocations. It is an estimate, not an exact byte count.
Retention runs the same frame sequence without wall-clock waits. The heap delta
is measured after explicit GC, before and after releasing an observable root of
old publications; temporary counting objects have already left scope.

## Results

| Workload             | Fold             | Cold replay median, ms | Frame median, ms | Frame p99, ms | Frame maximum, ms | Sampled allocation per 600 frames, MiB |
| -------------------- | ---------------- | ---------------------: | ---------------: | ------------: | ----------------: | -------------------------------------: |
| 32 short transcripts | Current in-place |                 305.61 |             0.58 |          1.70 |              5.25 |                                 202.79 |
| 32 short transcripts | Copy on touch    |                 324.27 |             0.73 |          4.05 |              7.69 |                                 584.73 |
| One long transcript  | Current in-place |                 302.56 |             0.09 |          0.39 |              4.98 |                                   6.76 |
| One long transcript  | Copy on touch    |                 326.21 |             1.51 |          2.46 |              5.40 |                                 611.67 |

No measured fold call exceeded 16 ms. Copy-on-touch allocation corresponds to
about 61 and 64 MiB/s at the stated publication rate.

| Additional retained heap beyond the latest view | 60 publications | 600 publications |
| ----------------------------------------------- | --------------: | ---------------: |
| Copy on touch, 32 short transcripts             |       40.75 MiB |       261.09 MiB |
| Copy on touch, one long transcript              |       30.04 MiB |       300.18 MiB |
| Current in-place, either workload               |  about 0.01 MiB |   about 0.10 MiB |

The current fold's small retention cost comes from sharing mutable containers:
those retained envelopes do not preserve earlier states. The experiment retained
60 or 600 distinct stream Maps and correspondingly distinct changed row arrays.
Small heap deltas are subject to GC noise, which is retained in the raw results.

Before timing, 40 successive publications from the recorded fan-out scenario,
with additional compaction, live-text and eviction inputs, matched the current
fold after every input and remained unchanged after subsequent folds. The check
also verifies identity sharing for an untouched stream. Both large workloads
produced identical final-view SHA-256 digests for the two variants.

## Proposal and limits

Proceed with a confined implementation at the fold owner, preserving batched cold
replay and sharing unchanged branches. Treat old-view retention as a measurable
cost of the API contract. Native Map copies grow with session size; transcript
array copies grow with the changed transcript, even when only one row changes.
The measured 16 ms threshold covers the fold alone. Rendering, transport, event
parsing, persistence, continuous transcript growth, subscriber churn, and browser
engines still need representative measurements before adopting this publication
contract. The large seed uses native-agent hierarchy; the smaller parity scenario
covers workflow boards, but their sustained-update cost was not measured here.

This candidate guarantees stable sequential publications for the exercised
inputs. It does not support branching computation from an older view, and it
does not prevent consumers from mutating a returned Map. Copying all three arrays
of a touched transcript is conservative; the experiment does not claim that every
one of those arrays changed.

The [raw report](../../packages/desktop/design-harness/session-fold-performance-2026-09-05.json)
records revision `48c5cca091bd324981160fc23a2386dcc2491637`, the fold's SHA-256,
all timings, heap deltas and parity digests. Reproduce from the repository root:

```sh
node packages/desktop/design-harness/measure-session-fold.mjs --output /tmp/texra-d5.json
```
