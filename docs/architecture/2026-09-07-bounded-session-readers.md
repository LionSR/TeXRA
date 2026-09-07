# Bounded session readers

A paused conversation view now stops its own source read. It cannot build an
unbounded host-message queue or slow another view. Saved events remain the
recovery authority; each renderer still runs the existing session fold.

## Delivery and recovery

Every subscription generation has contiguous frame sequence numbers starting at
one. The host awaits both delivery acceptance and `reader.progress` before sending
another frame. Progress acknowledges dequeue and staging, not durable publication.
The renderer posts it in a microtask after the decoder has handed its batch to the
fold. Thus incomplete replay is never a reconnect cursor. The host's send and
progress wait share a 30-second deadline.

The renderer accepts one queued frame. It stages a replay until its completion
marker, then publishes that complete batch through the existing fold. A sequence
gap, queue overflow, send failure, or stalled delivery ends that generation. One
automatic retry uses the **published view's** commit cursor and retained aggregate
sequences. A second failure reaches the existing conversation error notice. A
size rejection is terminal for that read. A fresh selection/reload can subscribe
again. Pending requests and surface drafts survive reader recovery.

`reader.stop`, replacement subscription, port close, and failure release the
port's transcript interests. A resubscription waits for its old fiber's cleanup.
Each attachment has a unique interest key, so detach followed by reuse of a public
port id cannot let the old finalizer clear the new attachment's set. Each port
has its own credit and fiber. The trace
viewer uses the same sequence/progress exchange and generates its event envelopes
incrementally from the already loaded trace document.

## Budgets and accounting

| Retention stage                       | Bound                                   |
| ------------------------------------- | --------------------------------------- |
| Collected source events and live text | 128 MiB encoded input, 1,000,000 inputs |
| Frame aggregation                     | 256 inputs, 256 KiB batching target     |
| One serialized frame                  | 16 MiB                                  |
| Outstanding host delivery             | One frame per port                      |
| Renderer inbox                        | One frame                               |
| Unpublished renderer replay           | 128 MiB encoded frames, 1,000,000 rows  |
| SDK unread callback trace             | 512 events and 8 MiB encoded events     |

The batching target is not a per-message truncation threshold. A retained row may
exceed 256 KiB and receives its own frame. The framer leaves 256 KiB for the frame
envelope, so one input may use at most 15.75 MiB, and the resulting frame is checked against
16 MiB. No saved row is split, edited, or silently omitted. A larger input or replay
fails that reader with an explicit size notice and releases its interest.

These are encoded-content budgets, **not a JavaScript heap ceiling**. The source
batch, staged replay, frame being folded, queued/in-flight frame, and aggregation
state can coexist. Objects, UTF-16 strings, serialization temporaries, and the
canonical transcript view require additional memory. ACK staging does not remove
those costs. Input iteration hands the aggregator one item at a time, avoiding a
whole replay array becoming an aggregation leftover. Intrinsic session/history
storage and immutable views retained by callers are outside auxiliary delivery
budgets.

The standalone file-store reader bounds actual file-stream bytes before JSON
decoding, preflights array row counts, and hydrates spill files sequentially within
the remaining source budget. Each subscribed transcript receives the remaining
cumulative budget. The in-memory event tail is materialized one row at a time;
live text includes both its encoded fragments and its row envelope in the shared
byte and row accounting. These display limits leave the saved files unchanged.

The SQLite integration accepts an optional budget on public reads. Its iterator
checks encoded raw-row bytes and row count before decoding/retaining the next row;
private execution/checkpoint events are filtered in SQL before public read budgets.
`readInputBatch` captures its high-water cursor, finite event prefix, and aggregate
claim state in **one transaction**. No page crosses a new snapshot. The canonical
runtime fold passes no display budget; a UI overload does not fail the owner or
mutate durable data. This integration is a separate patch on the persistence lane.

## SDK residency

A run's automatic transcript interest ends after its final hydrated fold. Every
`view` iterator has its own scoped interest, including descendants, and releases
it when iteration ends. A late terminal reader waits until its requested
aggregates are retained by the fold, so an evicted terminal listing cannot finish
its iteration before transcript replay. The package keeps no second final-view
cache. A caller may retain a yielded immutable view explicitly.

The trace callback cannot backpressure execution. An attached slow reader can now
exhaust either its row or byte budget; this fails only its trace and detaches its
callback. Its run/result continue. Canonical events and the hydrated session view
provide retained-state recovery. Closing a trace iterator clears its queued data.

## Reproducible measurements

Run `node scripts/measure-session-readers.mjs`. It bundles the actual framer,
receiver, and shared fold and executes synthetic model-response rows without
network calls or user data. On Node 26.8.1, a September 7 run at source commit
`86d17c674f` produced:

| Workload                          | Encoded source |   Max frame | Frames | Rows retained | Observed heap growth | Observed RSS growth |
| --------------------------------- | -------------: | ----------: | -----: | ------------: | -------------------: | ------------------: |
| 1,000 rows, 240 characters each   |      526,646 B |   135,319 B |      4 |         1,000 |         18,690,576 B |         5,079,040 B |
| 100,000 rows, 240 characters each |   53,833,658 B |   138,393 B |    391 |       100,000 |        150,825,744 B |       121,372,672 B |
| One 4 MiB retained response       |    4,194,867 B | 4,194,731 B |      3 |             1 |         29,704,552 B |        54,870,016 B |

Heap/RSS include source objects and the canonical folded transcript, not just
transport retention. Values are sampled during frame delivery and fold publication
plus a 1 ms timer; synchronous sub-operation peaks can be missed. Allocator reuse
and the 16 ms cadence make frame counts and memory measurements vary. These are
synthetic acceptance workloads, not a claim about the largest real user history.

The same script pauses a reader after its first frame while a healthy reader drains
100,000 rows from a lazy source. The paused reader's source pulls stayed at 257
before and after that interval; its outstanding frame count stayed at one. Settled
heap across both readers changed from 46,776,936 B to 47,117,840 B (+340,904 B),
after forced GC at both samples. This demonstrates bounded pulling during the
interval; it is not a universal flat total-process-memory guarantee.

Boundary regressions cover independent paused/healthy ports, explicit row/byte
trace overload with successful execution, a 4 MiB row without loss, replacement
of an unpublished replay from the published cursor, request preservation, and a
late SDK reader recovering evicted transcript rows. The persistence suite checks
both budget dimensions on all five public read paths and unchanged unbudgeted
history. Histories above the documented replay cap remain an explicit limitation;
this change does not claim unlimited display-history capacity.
