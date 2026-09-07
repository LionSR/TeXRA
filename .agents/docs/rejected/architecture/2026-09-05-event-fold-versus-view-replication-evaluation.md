---
created: 2026-09-05
status: rejected — not adopted; main shipped one fold per renderer, the opposite transport
---

# Event folding versus authoritative view replication

Status: rejected — not adopted; main shipped one fold per renderer, the opposite transport

**Recommendation:** preserve one semantic fold and the durable event ledger, but
make runtime-owned presentation state the leading design for ordinary live
clients. In-process consumers receive immutable publications directly;
cross-process clients receive a snapshot and ordered, mechanical changes to the
same published schema. Reopen G1/G2's requirement that every renderer execute the
fold. Do not adopt the entire Chord runtime or implement a transport cutover on the
strength of this evaluation alone.

This is an architectural recommendation supported by source inspection and narrow
executable probes. It is not a demonstrated end-to-end performance win. A bounded
comparison slice must establish the remaining publication, interest and transport
costs before the governing PRD is amended for implementation.

Read this alongside the [SDK ownership proposal](../../proposed/architecture/2026-09-05-agent-sdk-architecture.md).
Its session, execution, interaction and lifecycle ownership contracts apply to either
transport. This evaluation proposes reconsidering its retained G1/G2 event-only
transport baseline; it does not supersede those ownership contracts. Neither document
ratifies a transport cutover without the comparison gate below.

## Evidence and scope

- TeXRA checkout: `3958a96edd453938e023f163c1aa5b358854d89d`.
- Existing proposals: July SDK north star, August Effect migration PRD, September
  one-fold PRD, and the companion September 5 SDK ownership proposal.
- Runtime/substrate proposals: local remote-tracking branch
  `origin/docs/effect-runtime-and-substrate`, commit
  `bc00f7ee5321aae71b4e5f7a575553e886ac52d2`. These are proposals, not current code.
- Pi: release `v0.85.1`, commit
  `d981de1229ef899957bbe968bc8dcda02a21f477`. Chord implementation, service
  publication and experimental Pi transcript integration were inspected.
- Three independent reviews challenged the current fold, Chord implementation,
  and SDK/authority decision. Claims below distinguish traced implementation,
  reproduced behavior, proposed design and unmeasured outcomes.

The present GUI does not implement the proposed event-only end state:
`ProgressBackend.ts:126` still constructs `SessionState`, `LitSessionRenderer` and
`SessionFactApplier`; `LitSessionRenderer.ts:256` sends existing projection
messages. The TUI binds to the runtime view (`runChatTui.tsx:330`). The event log is
explicitly an in-memory stand-in, with transcript references that materialize
current store entries (`SessionEvents.ts:11,89,209`). Comparing proposals must not
assume that the complete event transport or SQLite ledger has already shipped.

## Current production paths and concrete change boundary

This follow-up grounding pass rechecked the same HEAD. It narrows the claim:
**the concrete opportunity is removing the GUI's post-fold translation and
reconstruction. There is no separate TUI semantic fold to delete.** The current
GUI already reads some canonical folded state; it does not invent every status
independently.

### The existing owner and TUI path

1. [SessionHandle.attachRunTrace](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/agent/runtime/SessionHandle.ts#L490)
   subscribes to run trace events; `publishRunEvent` maps supported arms through
   `runEventDraft`. `publish` applies existing snapshot bookkeeping before
   invoking the graph publisher. That persistence work cannot be removed by a
   presentation-transport change.
2. [SessionEventLog.appendAll](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/agent/runtime/SessionEvents.ts#L235)
   stamps aggregate sequence and session commit positions. This is the current
   memory implementation, including transcript references, not the proposed
   immutable SQLite ledger.
3. [SessionViewService](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/controllers/session/SessionView.ts#L87)
   sequences listing/history reads, merges local state and text, calls `fold`,
   and publishes to one `SubscriptionRef` at lines 136–150.
   [sessionGraphOpener](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/controllers/session/sessionLayer.ts#L423)
   exposes that same reference as `SessionGraph.view`.
4. [runChatTui](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/cli/src/chat/tui/runChatTui.tsx#L330) binds
   `runtimeSession.view` directly. Its
   [viewSignal](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/cli/src/chat/tui/state/sessionView.ts#L41)
   coalesces observations into a signal. It does not fold domain events again.
   The TUI currently subscribes to every stream because it renders the whole
   session; this is an explicit existing policy, not an example of selected-only
   transcript delivery.

The proposed publication owner is therefore an existing service, not a new
session registry or server object. For an in-process TUI, the change is stable
publication and the agreed canonical view shape, not a new RPC round trip.

### The GUI path after the fold

The real entry points are the extension's
[ProgressViewProvider](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/extension/src/progressView/ProgressViewProvider.ts#L98)
and desktop's
[desktopAgentExecution](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/desktop/src/main/desktopAgentExecution.ts#L284).
Both construct the shared
[ProgressBackend](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/controllers/progressView/backend/ProgressBackend.ts#L126)
and attach its listeners.

The backend's
[setupEventListeners](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/controllers/progressView/backend/ProgressBackend.ts#L878)
reads `session.folded(session.now())`, then invokes `SessionFactApplier.apply`.
This is deliberately after the canonical fold, so handlers can read the folded
view beside the event. `SessionState.view` is an alias of `session.view`
([constructor](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/controllers/session/SessionState.ts#L165)); that property
is not a second fold owner. The class also owns other metadata and persistence
coordination that must be evaluated separately.

| Current concrete work                                       | Source and production consumer                                                                                                                                                                                | Replacement candidate                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Translate canonical status into another metadata vocabulary | `LitSessionRenderer.metadataFor` reads `state.view`, maps `readOnly` to `STREAM_LIFECYCLE_UNAVAILABLE`, and maps `durableOutcome` to `statusDurablyFinal`; frontend status/metadata slices consume the result | Publish canonical status, availability and finality fields without that semantic translation                                   |
| Copy conversation progress after it has already folded      | `sessionFold.ts:1274` sets `stream.conversationProgress`; `SessionFactApplier.handleUpdateConversationProgress` updates execution state and notifies the renderer at line 577                                 | GUI reads the canonical published progress value; retain any required non-presentation owner separately                        |
| Assemble category-specific content snapshots                | `LitSessionRenderer.buildStreamContent` reads sidecars, execution state, follow-ups and controls; `syncSlice` unpacks `SYNC_STREAM_CONTENT` into another `StreamState`                                        | Replace the fact-only assembly and merge with the canonical publication, after proving every field's owner and update coverage |
| Reconstruct transcript rows and indexes in the GUI          | `WebviewBridge` emits `LOG_DELTA`; `logSlice.syncRow` calls `projectTranscriptRow`, and the handler maintains entries, rows, indexes and generations                                                          | Ordinary live GUI consumes the runtime's published transcript values                                                           |
| Recompute workflow presentation                             | `progressState.activeRunModel$` calls `workflowRunModel` from GUI rows, groups and child progress                                                                                                             | Consume the canonical runtime workflow model, after matching the complete input set                                            |
| Translate and regroup stream topology                       | Fact applier updates parent metadata; renderer emits tab metadata; `streamStateMerge` applies it and GUI selectors regroup streams                                                                            | Use canonical `order`, `parentId` and `childIds`; retain local selection and expansion intent                                  |

Exact source anchors for that table:

- [Metadata translation](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/controllers/progressView/backend/LitSessionRenderer.ts#L453)
  and [frontend status application](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/extension/src/progressView/frontend/slices/streamLifecycleSlice.ts#L219).
- [Folded progress](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/shared/session/sessionFold.ts#L1274) and
  [post-fold progress copy](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/controllers/session/SessionFactApplier.ts#L577).
- [Content assembly](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/controllers/progressView/backend/LitSessionRenderer.ts#L344)
  and [content merge](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/extension/src/progressView/frontend/slices/syncSlice.ts#L24).
- [Transcript feed](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/controllers/progressView/backend/WebviewBridge.ts#L31),
  [row projection](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/extension/src/progressView/frontend/slices/logSlice.ts#L55)
  and [delta handler](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/extension/src/progressView/frontend/slices/logSlice.ts#L225).
- [GUI workflow model](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/extension/src/progressView/frontend/progressState.ts#L380),
  [Lit context binding](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/extension/src/progressView/frontend/components/StreamConversation.ts#L134)
  and [actual row rendering](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/extension/src/progressView/frontend/components/LogList.ts#L172).
- [Parent update](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/controllers/session/SessionFactApplier.ts#L532),
  [metadata merge](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/extension/src/progressView/frontend/slices/streamStateMerge.ts#L29)
  and [GUI state containers](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/extension/src/progressView/frontend/store.ts#L89).

These are candidate function/path replacements, not an approved whole-file
deletion list. No runtime or GUI failure is inferred merely from extra
representations.

### Work that cannot be deleted as presentation plumbing

- [SessionFactApplier.setStreamStatus](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/controllers/session/SessionFactApplier.ts#L738)
  rehydrates transcripts, checks removal after an await, requests eviction and
  retires sidecars. These effects need a named runtime/store owner before removal.
- [applyChildRoster](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/controllers/session/SessionFactApplier.ts#L614)
  retains child phases and finished children and currently adds a timestamp on
  disappearance. A replacement needs explicit coverage for those live registry
  facts. A replicated value does not supply missing fold inputs automatically.
- [ProgressBackend.stopStream](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/controllers/progressView/backend/ProgressBackend.ts#L451)
  cancels retry interaction and stops execution;
  [deleteStream](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/controllers/progressView/backend/ProgressBackend.ts#L475)
  owns storage claims, ordering and retained/failed outcomes.
- [TUI approval decisions](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/cli/src/chat/tui/state/approvalQueue.ts#L412)
  route tool-edit, retry and external inquiry decisions through host settlement
  callbacks; other decisions use runtime requests. This is not replaceable with
  a view subscription. Remote attachment needs the corresponding interaction
  route and reservation semantics.
- [Runtime admission](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/src/controllers/session/SessionRequests.ts#L86)
  and decision handling remain authoritative. Client availability is informative.
- [Frontend focus intent](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/extension/src/progressView/frontend/slices/streamLifecycleSlice.ts#L225),
  [draft and foreground completion](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/extension/src/progressView/frontend/slices/followUpSlice.ts#L21),
  and [DOM/rendering behavior](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/extension/src/progressView/frontend/components/LogList.ts#L92)
  stay with their view instance.
- [AgentRun](https://github.com/LionSR/TeXRA/blob/3958a96edd453938e023f163c1aa5b358854d89d/packages/agent/src/index.ts#L106) currently exposes an event
  iterator, result and interrupt, not a session-view API. The SDK also constructs
  a per-run session with an ephemeral transcript store at line 275. The earlier
  SDK ownership proposal must be completed on its own merits; a replica codec
  does not implement that public API or fix session acquisition.

### What these deletions do and do not establish

**Both candidates can remove most of the old GUI path.** Completing the current
event-to-client-fold proposal would also retire bespoke `logSlice` projections,
metadata merges and category-specific state reconstruction. Counting those
deletions exclusively as a replication benefit would be misleading.

The incremental choice is narrower:

- Event folding makes the ordinary GUI run `sessionFold` and maintain its input
  hydration, cursor, residency and transient-state semantics in the renderer.
- Runtime publication keeps those semantics at the already-existing
  `SessionViewService`, but must pay for a real wire schema, stable publications,
  revision protocol and generic replica application.

Current code strongly supports convergence on one semantic model. It supports
runtime publication as a natural candidate because the TUI already observes that
owner. It does not, by itself, establish that replication has lower total cost
than completing the existing event-fold proposal. The comparison gate below must
measure that incremental difference.

## What the choice actually changes

Both designs can use the same durable events, the same semantic fold, scoped
Effect resources and runtime command authority. Both can support remote access,
replay and disconnection. Those capabilities do not distinguish the transports.

| Question                                                      | Events plus client fold                                                        | Runtime fold plus replicated publications                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Who interprets lifecycle, hierarchy and transcript semantics? | Each observer's copy of the fold                                               | The runtime serving the attachment                                               |
| What does a live UI receive?                                  | Selected facts, live chunks and observer context                               | Selected current state and revisioned structural changes                         |
| What must a client implement?                                 | Event interpretation, hydration and view construction                          | View schema, replica readiness and mechanical update application                 |
| Where is domain computation repeated?                         | At each folding observer                                                       | Once per serving authority, with publication and per-subscriber delivery costs   |
| What can coalesce?                                            | Transient chunks; durable event consumers have their own delivery requirements | Intermediate presentation states, but never exhaustive audit events              |
| What must be versioned?                                       | Event protocol and compatible semantic interpretation                          | Published view and replication protocol; plugins still need compatible renderers |
| Can history be replayed?                                      | Yes, locally with the fold                                                     | Yes, in runtime/replay tools; the resulting historical view can be published     |
| Can an in-process SDK avoid serialization?                    | Yes                                                                            | Yes                                                                              |

### Three arguments in the current documents need correction

1. **A generic patch applicator is not another business reducer.** G2 at
   `2026-09-03-prd-one-fold-three-renderers.md:130` prohibits patches on that basis.
   A mechanical set/delete/append operation does not infer status, approval or
   hierarchy. Read-only replicas are copies, but do not become competing
   authorities merely by existing.
2. **Text duplication depends on the representation and encoding.** The PRD at
   line 1674 rejects row-per-update patches. That is not a rejection of string
   append operations. Conversely, generic deltas do not guarantee small payloads
   if the published schema contains several derived copies of the same text.
3. **In-process embedding and replication are independent choices.** The SDK
   proposal's [alternatives table](../../proposed/architecture/2026-09-05-agent-sdk-architecture.md#10-alternatives-and-decision)
   does not establish that replicated
   presentation requires a daemon, HTTP or a forwarding SDK object. The local
   consumer can read the same publication directly.

## What TeXRA cannot simply replicate

### Authority is relative to a runtime

`withAggregates` (`sessionFold.ts:566`) derives `readOnly`, waiting and interrupted
presentation from `local.self`, `local.heldBy` and unreadability. Two independent
runtime processes reading the same paper need not have the same view. A single
globally broadcast paper view would change current semantics.

The coherent initial owner is **a runtime's paper session**. Attached clients use
that runtime's control route and perspective. Another independently launched
runtime remains a distinct authority with its existing foreign-owner behavior.
Remote control across owners is a separate routing decision. Attachment-specific
permission restrictions belong in authoritative capability checks, not client
transcript reducers. Current request admission already consults log existence and
the runtime view (`SessionRequests.ts:86`); a replica's button state must never be
authorization.

### The current object is not a public wire schema

`sessionView.ts:1` deliberately says the value is never parsed and explains its
Maps by saying it never crosses a bridge. Lines 59–80 use `z.custom` placeholders
for transcript rows, compaction blocks and workflow models. The value also
contains cursor, deduplication, residency and inflight bookkeeping.

`sessionFold.ts:36` documents reused Maps, mutable transcript arrays and
latest-value-only consumption. Replacing the outer envelope does not preserve
previous observations. The SDK proposal's [public contract](../../proposed/architecture/2026-09-05-agent-sdk-architecture.md#4-public-contract-expose-intent-and-lifetime)
already proposes stable immutable publications and explicitly requires performance evidence. That cost
exists whichever transport serves the SDK.

The replacement needs one canonical, validated publication shape and private fold
bookkeeping. A permanent adapter that constructs and maintains another semantic
view would recreate the architecture we intend to remove. Generic serialization
and structural selection do not themselves constitute semantic duplication.

### Interest remains bounded

`TranscriptSubscriptions` already unions readers' interests (`sessionSources.ts:103`).
The runtime can derive shared state over that union, but must not broadcast the
entire union to every reader. A promising shape is shared listing state plus keyed
transcript/workflow publications requested by each reader.

That shape needs an explicit consistency boundary: related listing and transcript
changes must have an identifiable publication revision or transaction, and a
reader must not expose a half-applied approval/status/topology update. Independent
documents are not an excuse to lose cross-document semantics.

Some current listing conveniences are residency-dependent: `thinkingActive`,
`compactingActive` and `latestLine` derive from retained transcript rows
(`sessionFold.ts:1080`). Their meaning must be resolved at the existing owner,
rather than allowing another reader's interests to silently change listing truth.

## What Pi actually implements

Pi's experimental transcript provider calls `reduceLaneSnapshot` and publishes
tracked state. It retains a forwarded event alongside the snapshot. This is
server-side semantic reduction followed by replication, not an elimination of
events or reducers. [Transcript provider][pi-transcript].

Chord's full service layer is stronger than its standalone delta helper:

- `ReplicatedStateReplica` verifies contiguous revisions and clears on a gap.
- It computes an immutable update before assigning the new visible value and
  sequence. A failing operation does not partially publish that batch.
- Service subscription activation buffers updates behind snapshot delivery.
- The surrounding product must still define authorization, permitted data,
  persistence and recovery policy. [Replica implementation][pi-state],
  [provider subscription][pi-provider].

An earlier discussion incorrectly generalized the standalone delta helper's lack
of sequencing to Chord services. This evaluation corrects that claim.

However, gap detection is not complete recovery. In the inspected service path,
`clear()` invalidates the stored value without notifying state listeners; update
handlers report failures but do not themselves initiate rehydration. Rebinding can
recover. The integrator must establish how consumers learn that their view is
stale and how a fresh snapshot is requested. Also, separate state members apply
sequentially: atomicity of one state value does not establish a transaction across
all services. These are adoption boundaries, not reproduced end-user Pi defects.
[Replica implementation][pi-state], [consumer handling][pi-consumer].

Chord does not make representation costs disappear. Its immutable patch path
copies ancestor containers per operation, including arrays; the tracker permits
JSON trees, not Maps, Sets or mutable aliases. Pi's lane reducer puts the active
streaming message outside historical transcript storage, avoiding a history-array
copy on every token update. That design deserves consideration independently of
whether we use Chord. [Delta implementation][pi-delta], [lane reducer][pi-reducer].

The released product boundary remains important: Pi 0.85.1 removes accidentally
published experimental client/plugin surfaces and server/client commands from the
supported distribution. The local SDK and stdio RPC remain supported. The new
server is source-level design evidence, not a verified production foundation for
TeXRA. [Release notes][pi-release].

## Executable probes

All probes ran on Node `v26.6.0`. They use synthetic data, not private user session
contents. They are separate measurements of different components and must not be
compared as an end-to-end event-versus-replica benchmark.

### Current TeXRA fold

The actual production fold was bundled with esbuild. A scratch build plugin only
exported the otherwise private event schema for fixture validation; it did not
change fold behavior. The fixture contains 10,000 completed assistant rows in one
flat stream, about 230 characters per row, folded in 64-input frames. Schema
validation occurs before timing. After warmup, five trials measured sequential
repetition for hypothetical observers; this is aggregate computation, not
concurrent client latency.

| Repetitions of the fold | Median total time |
| ----------------------- | ----------------: |
| 1                       |          15.65 ms |
| 3                       |          41.39 ms |
| 10                      |         133.80 ms |

This demonstrates that this simple replay is inexpensive on the tested machine.
It does not justify a claim that client fold CPU is currently a product bottleneck.
It excludes storage, parsing, transport, rendering and immutable publication.
Wide workflow hierarchies are unmeasured: current derivation scans approvals and
children (`sessionFold.ts:566`) and filters retained rows for workflow models
(`:697`), so the flat-chat result is not a bound for those cases.

Three correctness/representation observations were also reproduced:

- Retaining the prior view left its cursor at 10002, but appending one row changed
  its retained transcript array from 10,000 to 10,001 rows. The streams Map was
  shared. This matches the documented current contract; it is not a newly alleged
  bug in a supported immutable API.
- The same run events with owning versus foreign-owner context yielded
  `readOnly: false` versus `true`.
- Direct JSON serialization yielded `streams: {}` for a view with one actual Map
  entry. A wire representation change is required.

### Actual Chord immutable updates

The pinned source was imported directly. Five trials applied 500 prebuilt decoded
update batches; old revisions were retained to check snapshot stability. The probe
also checked unchanged subtree identity, failed-batch atomic publication, gap
invalidation and explicit rehydration.

| Synthetic representation, 50,000 historical messages    | Median update time | Heap growth retaining 500 revisions |
| ------------------------------------------------------- | -----------------: | ----------------------------------: |
| Append text inside last element of the history array    | 75.87 microseconds |                          190.88 MiB |
| Append text to a separate active message beside history |  1.22 microseconds |                           0.153 MiB |

These are consumer-only operations: no producer tracking, codec, network, UI or
business fold. The first case illustrates a naive adaptation of array-contained
streaming state; it is not Pi's actual lane streaming shape. The second mirrors
the relevant separation used in Pi and verifies that historical array identity
does not change. The large difference argues for deliberate publication shape,
not for a generic claim that immutable replication is slow or fast.

The [supporting evidence](../../evidence/2026-09-05-view-replication/README.md) includes
portable probe sources, pinned-source setup commands and captured outputs. These
are one-off architectural probes, not product tests or CI performance thresholds.
No production code or package dependencies were changed.

## Proposed amendment and decision gate

Replace the categorical transport rules with the following intended contract:

> Business presentation semantics have one implementation and one owner per
> serving runtime session. Ordinary live consumers observe the owner's immutable,
> bounded publications. Local consumers receive values directly; cross-process
> consumers reconstruct the same values mechanically. Replicas never write facts
> or decide execution permission. Interaction state remains local to each Surface.

Keep durable events for execution recovery, tracing and exhaustive programmatic
observation. In particular, CLI NDJSON requires individual transitions and reads
events directly (`sessionProgressSubscription.ts:212`); coalesced views cannot
replace that contract. This is a distinct observation purpose, not two competing
UI pipelines. Trace/replay tools can continue to use the same fold without making
it mandatory in ordinary live renderer bundles.

Before adopting the amendment for implementation, construct one disposable
comparison slice using the same ownership, input corpus, client interests, visible
fields and batching on both paths. Include:

1. Cold attach during streaming, including a large unselected transcript.
2. Two readers with disjoint interests; eviction/reopen and interest replacement
   during hydration. One reader must not affect the other's retained data.
3. Reconnect, missing/duplicate/out-of-order updates and a slow reader. Queues are
   bounded; gaps cannot leave a falsely ready replica; recovery is automatic.
   Subscription generation, schema version and publication revision are explicit.
   A publication revision is not a ledger commit cursor: live text and interest
   changes also produce publications without appending durable events.
4. Wide workflow child progress and approval/status changes crossing publication
   documents. Observers see coherent revisions.
5. Retained observations across await, sustained streaming and history appends.
6. Independent runtimes sharing a paper, preserving foreign-owner behavior.
7. Explicit schema/version mismatch, attachment revocation, redaction of the base
   and every intermediate delta, and existing exhaustive NDJSON behavior.
8. A plugin panel whose view is unknown to core rendering logic. Transporting data
   must not imply permission to render arbitrary code or access another scope.

Measure first usable paint, input latency, runtime/client CPU, allocation, retained
memory, wire bytes and total synchronization code. Include producer tracking and
hydration, not only the inexpensive consumer apply loop. Set workload budgets
before comparing implementations; record equal output and capability semantics.

**Choose replication** if it removes ordinary client domain/replay machinery while
meeting the same budgets and contracts with one canonical published shape.
**Keep event folding** if replication requires persistent per-client semantic
repair, a parallel view model, or exceeds budgets without compensating reduction
in client complexity. In either outcome, delete the displaced live UI mechanism
at cutover rather than preserving two feature-selectable transports indefinitely.

The evidence supports reopening the architectural rule and preferring the
replication hypothesis for the SDK direction. It does not yet support adopting
Chord wholesale, declaring performance superiority, or changing durable formats.

[pi-transcript]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/experimental/services/transcript-provider.ts#L59
[pi-state]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/chord/src/services/state.ts#L85
[pi-provider]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/chord/src/services/provider.ts#L238
[pi-delta]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/chord/src/delta/index.ts#L1014
[pi-reducer]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/reducer.ts#L93
[pi-consumer]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/chord/src/services/consumer.ts#L575
[pi-release]: https://github.com/earendil-works/pi/releases/tag/v0.85.1
