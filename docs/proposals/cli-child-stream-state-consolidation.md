# CLI child-stream state consolidation

> **Status:** Design gate for [issue #7864](https://github.com/LionSR/TeXRA/issues/7864). This document is
> grounded on `origin/main` commit `4cd0881b4` (2026-07-10). It proposes no production change. Implementation
> remains gated on maintainer review of this design.

## Decision

Consolidate the CLI TUI's three subagent relationship representations into one CLI-local
`Map<childStreamId, ChildStreamEntry>`:

- the live `StreamSlice.activeSubagents` roster;
- the retained `StreamSlice.childStreams` history; and
- the current child-to-parent `parentStream` topology.

These are three views of one child-stream record, but they are not the same view. The new map must retain their
different authority and lifetime rules and expose them through pure selectors.

`StreamSlice.activeProcesses` is not part of this consolidation. A process has an `executionId`, but no
`childStreamId` or independent `StreamSlice`; its output tail and completion transcript have their own ordering
contract. Process state remains unchanged until a separately reviewed second-phase design exists.

The implementation must remain CLI-local. It must not introduce a shared CLI/webview reducer, a new event plane,
or a new cross-host vocabulary. The existing `SessionEventHub` remains the ordered delivery path. The existing
`StreamSnapshotStore` remains the durable per-stream sidecar owner, not the live TUI roster owner.

## Scope and terminology

The current names obscure four distinct domains.

1. **Active subagent roster (`activeSubagents`).** A parent-scoped snapshot of subagent executions currently in
   the runtime registry. Absence from a later snapshot means "not active now".
2. **Retained child history (`childStreams`).** An insertion-ordered record of child stream tabs previously seen
   for a parent. Completion does not remove it; this is what keeps a completed or waiting child available in the
   task picker and transcript controls.
3. **Current parent topology (`parentStream`).** The present child-to-parent edge used by focus, labels, ancestor
   lookup, transcript scope, and follow-up routing. Promotion explicitly removes this edge.
4. **Active process domain (`activeProcesses`).** Parent-scoped process executions and output tails. Processes do
   not own stream tabs and cannot be keyed by `childStreamId`.

The proposed map owns only domains 1-3. A child's transcript, description, category, and lifecycle status remain
in that child's `StreamSlice` in the existing `streams` map.

## Architectural prerequisites already satisfied

Issue #7864 was gated until the session-history unification had landed. The prerequisite is now present on
`origin/main`:

- `SessionHandle` owns one event hub, status machine, execution registry, transcript store, and follow-up queue
  per session (`src/agent/runtime/SessionHandle.ts:87-101`, `:110-139`).
- `SessionEventHub.emit()` invokes matching subscribers synchronously in registration order
  (`src/agent/runtime/SessionEventHub.ts:94-128`). Producers therefore define event order once, and every attached
  subscriber observes that order.
- The hub enforces that run-scoped subscribers are attached before activation in tests and development assertions
  (`src/agent/runtime/SessionEventHub.ts:173-190`).
- The CLI attaches `StreamSnapshotStore` to the session event hub before starting interactive runs
  (`packages/cli/src/chat/tui/runChatTui.tsx:407-416`).
- `StreamSnapshotStore` is explicitly the single writer of durable `streamData/{id}/*` sidecars, and explicitly
  does not persist active children or live status (`src/transcript/StreamSnapshotStore.ts:1-17`). It consumes
  durable facts from the hub (`:241-327`), including `setParentStream` (`:300-315`, `:836-840`).

This distinction is essential. The event hub preserves the order of live facts. `StreamSnapshotStore` persists
durable facts needed for history and resume. The proposed CLI map projects the live TUI roster, topology, and
retained in-process history. Making `StreamSnapshotStore` answer live roster questions would contradict its
deliberate liveness exclusion and would couple rendering to asynchronous persistence.

The same `setParentStream` fact may therefore be observed by both stores without constituting a dual write:
`StreamSnapshotStore` owns durable resume metadata, while the CLI map owns the live presentation projection. They
have different lifetimes and answer different questions.

## Current-state census

At `4cd0881b4`, `StreamSlice` stores `status`, `activeSubagents`, `activeProcesses`, and retained `childStreams`
together (`packages/cli/src/chat/tui/state/cliState.ts:102-142`). A separate signal stores the parent topology
(`cliState.ts:415-480`). Status changes are copied into every list containing the child
(`cliState.ts:245-336`).

Production references under `packages/cli/src/chat/tui/`, measured with `rg --count-matches`, are:

| Name              | Occurrences | Files | Disposition                                     |
| ----------------- | ----------: | ----: | ----------------------------------------------- |
| `activeSubagents` |          30 |     8 | Remove as stored state; replace with a selector |
| `childStreams`    |          26 |     8 | Remove as stored state; replace with a selector |
| `parentStream`    |         168 |    13 | Remove as stored state; derive topology         |
| `activeProcesses` |          41 |     8 | Keep unchanged; second design gate              |

The union of the first three names touches 16 production files. This is a broad consumer migration even though
the owner change is small. The implementation PR must repeat the census because line numbers and consumers change
quickly on this repository.

## Load-bearing race census

The following is the complete ordering census for the proposed scope. Each item states both the present evidence
and the behavior that must survive consolidation.

### 1. Subscribers must exist before activation

The CLI attaches its TUI fact subscription while constructing the run host
(`packages/cli/src/chat/chatSessionController.ts:235-266`), before `executeAgent` starts
(`chatSessionController.ts:281-302`). Both the general launch path and direct child-stream path assert this
ordering (`src/agent/runtime/AgentLaunchContext.ts:349-350`;
`src/tools/childStream.ts:97-105`).

This is the outer ordering guarantee. The new map must consume the existing hub; it must not add a second queue,
replay layer, or asynchronous reducer whose subscription can miss the initial roster.

### 2. Attachment and status can precede both relationship facts

Direct child streams emit `setActiveStream` before creating and tracking the execution handle
(`src/tools/childStream.ts:107-120`, `:147-159`). Tracking with an initial status publishes that status before
the handle is put into the active roster (`src/agent/runtime/executionRegistry.ts:248-260`).

Native launches admit the opposite local order between status and attachment: stream reservation publishes
`RUNNING/STARTING` (`src/agent/runtime/StreamStatusService.ts:68-84`), and
`buildAgentLaunchContext` reserves before assembling and activating the stream
(`src/agent/runtime/AgentLaunchContext.ts:471-480`, `:591-620`; activation is emitted at `:349-362`).

Consequently, a child `StreamSlice` and its status may exist before either a roster record or a parent edge. The
relationship owner must not require a parent entry before creating or updating the child slice. Conversely, an
attachment alone must not classify a root stream as a child.

### 3. Roster-before-edge is the normal tracked-subagent order

`ExecutionRegistry.track()` emits `child.activity(subagents)` and only then emits `setParentStream`
(`src/agent/runtime/executionRegistry.ts:227-237`). The present CLI roster handler compensates by deriving a
parent edge from every roster row before updating the two parent arrays
(`packages/cli/src/chat/tui/state/subscribeRuntimeHost.ts:130-148`).

Without that compensation, there is a visible interval in which the child row exists but focus and transcript
scope cannot reach the child. The proposed map must let a roster establish provisional topology until the
explicit edge arrives.

### 4. Edge-before-roster is also an admitted consumer order

The edge is a session fact while the roster is a run fact
(`src/agent/runtime/SessionEventHub.ts:27-71`). They have independent handlers
(`packages/cli/src/chat/tui/state/subscribeRuntimeHost.ts:248-260`, `:321-360`). A resumed, restored, test-driven,
or future producer can therefore present the edge first even though the current `track()` producer presents the
roster first.

The focus implementation explicitly preserves this case: it combines slice-derived rows with the independent
edge map so a child registered before its parent slice is updated remains reachable
(`packages/cli/src/chat/tui/state/focusCycle.ts:40-66`).

The proposed map must allow an edge-only, metadata-incomplete entry. It contributes to topology once the child
slice exists, but it contributes no control row until a roster supplies display metadata.

### 5. Completion removes the active roster before terminal status lands

Terminal finalization calls `ExecutionRegistry.untrack()` and only then transitions the child stream to its
terminal status (`src/agent/runtime/AgentRunLifecycle.ts:145-180`). Untracking a subagent emits a new roster that
omits it (`src/agent/runtime/executionRegistry.ts:288-305`). Thus an empty/shorter roster can arrive before the
child's `COMPLETED`, `FAILED`, or `CANCELLED` status.

The current retained list absorbs this interval. A later status event updates the child slice and also scans every
parent list to rewrite copied status values (`packages/cli/src/chat/tui/state/cliState.ts:275-317`). The new map
must clear active membership without deleting retained history, and its retained-row selector must read status
from the child slice so no cross-list status rewrite is needed.

### 6. Promotion is an explicit edge removal followed by a roster refresh

Detaching children first mutates each execution handle to top-level, then emits
`setParentStream(child, null)`, and finally emits the old parent's refreshed roster
(`src/agent/runtime/executionRegistry.ts:542-566`; handle mutation is
`src/agent/runtime/ExecutionHandle.ts:147-151`).

The hub normally preserves this exact order. Nevertheless, the data model must also be safe if a previously
prepared non-empty roster is delivered after the promotion fact. The current roster path would call
`registerChildStreams` and could recreate the removed edge
(`packages/cli/src/chat/tui/state/subscribeRuntimeHost.ts:130-148`;
`packages/cli/src/chat/tui/state/cliState.ts:469-479`).

An explicit edge fact must therefore outrank roster-derived topology. Once an explicit `null` is observed, an old
roster may update retained display metadata but must not restore active membership or the parent edge. Only a
later explicit non-null edge may reattach the child.

### 7. Explicit removal follows completion and must dominate late facts

Auto-close finalizes the run, disposes its trace, and only then emits `removeStream`
(`src/tools/childStream.ts:203-276`). Current removal deletes the child slice, scrubs all parent lists, clears
focus, and removes topology edges (`packages/cli/src/chat/tui/state/cliState.ts:574-605`).

The new owner must make removal final for that activation. A late roster, edge, or status from the completed
activation must not recreate a selectable child. A subsequent `setActiveStream` for the same stream id is the
only event that may begin a new activation and clear that removal guard.

### 8. Retained order and live overlay have different lifetimes

`mergeChildStreams` keeps the first-seen insertion order while replacing metadata for a repeated key
(`packages/cli/src/chat/tui/state/childExecutions.ts:16-25`). `visibleSubagentRows` then overlays active metadata
on the retained order and appends an active-first fallback for partial state (`childExecutions.ts:27-44`).

The new owner must preserve first-retained order even when roster snapshots reorder, shrink, or arrive before an
edge. Active membership may disappear; retained order may not, except on explicit removal.

### 9. Process output has a separate start and completion race

Only subagents have `childStreamId`; processes are discriminated separately
(`src/shared/schemas/streamState.ts:18-24`, `:63-78`). Process output is stored by `executionId` and can be updated
independently of the active process roster (`packages/cli/src/chat/tui/state/subscribeRuntimeHost.ts:151-187`).

At process start, `ExecutionRegistry.track()` registers the output poller before publishing the process roster
(`src/agent/runtime/executionRegistry.ts:238-241`). Poller registration starts its asynchronous loop
(`src/agent/runtime/ProcessOutputPoller.ts:62-67`, `:126-150`), so process output and roster remain independently
addressed even though the polling delay normally lets the roster arrive first.

At completion, the registry must perform the final output read before emitting the roster that removes the
process (`src/agent/runtime/executionRegistry.ts:299-318`). The CLI then materializes a completed transcript from
the old roster and tail before the shared process reducer prunes the tail
(`packages/cli/src/chat/tui/state/subscribeRuntimeHost.ts:151-175`;
`packages/cli/src/chat/tui/state/completedProcessTranscript.ts:80-98`). The poller also guards an asynchronous
read that outlives unregister (`src/agent/runtime/ProcessOutputPoller.ts:168-210`).

A `Map<childStreamId, ...>` cannot represent this domain. Folding processes into it would either invent fake
stream ids or change the key to `executionId`, losing the topology property the map is meant to establish. This
race remains under the existing process owner in phase one.

## Proposed CLI-local owner

Use one signal-backed map in the existing CLI state area. The exact private helper names are not API, but the
owned shape is:

```typescript
export interface ChildStreamEntry {
  /** Latest roster metadata, excluding identity and status. */
  readonly summary?: Omit<SubagentChildInfo, 'childStreamId' | 'status'>;

  /** Parent whose latest roster includes this child. */
  readonly activeParentStreamId?: StreamTabId;

  /** Parent under which the child first acquired a retained row. */
  readonly retainedParentStreamId?: StreamTabId;
  readonly retainedOrder?: number;

  /**
   * undefined: no explicit edge fact observed; use retained parent provisionally
   * string: explicit current parent
   * null: explicitly promoted to top-level
   */
  readonly edgeParentStreamId?: StreamTabId | null;

  /** Explicit removeStream tombstone, cleared only by a new activation. */
  readonly removed: boolean;
}

const CHILD_STREAMS = signal<ReadonlyMap<StreamTabId, ChildStreamEntry>>(
  new Map(),
);
```

The map key is the child identity; `ChildStreamEntry` does not repeat `childStreamId`. No field stores lifecycle
status. No entry is created merely because a root or child stream is attached.

`retainedOrder` is assigned from the current maximum for that parent when a roster first retains the child. It is
computed from the map during the uncommon insertion transition, so no second mutable order counter is needed.

The owner should live in an existing CLI state module, preferably by deepening
`packages/cli/src/chat/tui/state/childExecutions.ts`, rather than adding a new state plane or a rename-only module.
It should expose one small object or similarly narrow surface containing transition methods, the readonly signal,
and selectors. It must not export raw writable maps.

## Derived selectors

All former views are computed from `CHILD_STREAMS` and, where status or existence matters, `streams`.

### Effective parent

For a non-removed entry:

1. a string `edgeParentStreamId` is the current parent;
2. `null` means no parent; and
3. `undefined` falls back to `retainedParentStreamId`, which is the provisional parent learned from a roster.

This precedence preserves roster-before-edge while preventing a late roster from reversing promotion.

### Active subagents for a parent

Select entries whose `activeParentStreamId` equals the requested parent and whose effective parent is that same
parent. Require `summary`. Reconstruct `SubagentChildInfo` by adding the map key as `childStreamId` and reading
`status` from `streams.get(childStreamId)?.status`.

The active selector, not status, determines whether a control is killable. A terminal status that arrives after
roster removal cannot make a retained child active again.

### Retained child streams for a parent

Select non-removed entries whose `retainedParentStreamId` equals the requested parent, require `summary`, and sort
by `retainedOrder`. Reconstruct each row with status from the child `StreamSlice`.

Promotion does not erase this historical row. Explicit `removeStream(child)` does.

### Current topology

Derive `parentStreamIdFor(child)` from the effective-parent rule. Consumers that need a complete map may derive a
readonly map in one pass; it is not stored or independently mutated.

The focus-order selector preserves the current union: first emit retained children recorded for the requested
parent, in retained order, and then current-topology children not already present, in map insertion order. Continue
to require a child `StreamSlice` before making the child focusable, preserving the present guard in
`focusCycle.ts:46-48`. This selector is deliberately broader than current topology. A promoted retained row stays
available as a historical focus target from its former parent, but parent/back routing treats the promoted stream
as top-level once focused.

### Visible subagent rows

The former `visibleSubagentRows` becomes a composition of the retained and active selectors. Retained order is
primary; active metadata overlays the matching retained row; active children not yet retained are appended as a
partial-state fallback. The result is a value, not another signal or cache.

## Authority and transition semantics

The map transition is deterministic for the ordered fact sequence delivered by `SessionEventHub`. Event type,
not arrival time alone, determines authority.

The precedence for relationship state is:

```text
removeStream tombstone
    > explicit setParentStream(id or null)
    > roster-derived provisional parent
    > no relationship
```

Status has a separate authority chain: the child `StreamSlice.status` is the TUI projection owner. Roster status
is never stored in `ChildStreamEntry`.

### Subagent roster snapshot

For `child.activity(kind: 'subagents', parentStreamId, children)`:

1. Treat `children` as the complete active-membership snapshot for that parent at this hub position.
2. Clear `activeParentStreamId` for entries previously active under that parent but absent from the snapshot.
3. For each included, non-tombstoned child, update `summary` after removing `childStreamId` and `status`.
4. Set `activeParentStreamId` to the payload parent.
5. On the first roster observation, set `retainedParentStreamId` and append `retainedOrder` in payload order.
6. Do not write `edgeParentStreamId`. A roster supplies provisional topology only through the effective-parent
   fallback.
7. Discard the roster's copied `status` for TUI state. The independently delivered lifecycle transition updates
   the child `StreamSlice`; until it arrives, a derived row may have an undefined status.

Rule 7 prevents a stale roster from overwriting a newer lifecycle event and leaves exactly one TUI status owner.

### Explicit parent edge

For `setParentStream(child, parent)`:

- upsert an entry even if metadata is not yet known;
- set `edgeParentStreamId` to the parent id or `null`;
- never delete retained metadata or retained order; and
- ignore the fact while the entry is tombstoned by `removeStream`.

A non-null edge can explicitly reattach a promoted child. A roster cannot.

### Stream attachment

For `setActiveStream(child)`:

- create or patch only the child's existing `StreamSlice`, as today;
- do not create a `ChildStreamEntry` without relationship evidence; and
- if a tombstone exists for this same id, remove the tombstone as the start of a new activation.

The subsequent roster or edge determines whether the activated stream is a child.

### Stream status

For a status change:

- update only `streams.get(child).status`, `substate`, and `runStartedAt`;
- do not scan parent entries; and
- ignore a late status for a tombstoned child until a new attachment clears the tombstone.

This deletes `updateChildStatusReferences`, `withMirroredChildStreamStatus`, and the three-list traversal in
`setStreamStatusInCliState`.

### Completion

When a roster omits a previously active child:

- clear active membership;
- retain metadata, order, and current topology; and
- let the later terminal status change only the child `StreamSlice`.

The child remains visible and focusable through retained history and current topology unless it is promoted or
explicitly removed.

### Promotion followed by a late roster

For the sequence `edge(parent) -> roster(parent, child) -> edge(null) -> late roster(parent, child)`:

- `edgeParentStreamId` remains `null`;
- the effective parent remains absent;
- the active selector excludes the child because the roster parent does not equal the effective parent;
- retained metadata may be refreshed, and the historical row remains under the former parent; and
- only a later explicit `edge(newParent)` can restore current topology.

Thus a promoted child is top-level for parent/back routing, while the former parent may still show and focus its
non-killable historical task row.

### Explicit removal and parent removal

For `removeStream(child)`:

- delete the child `StreamSlice` and clear active focus as today;
- replace any map entry with a minimal `removed: true` tombstone;
- exclude the tombstone from every selector; and
- ignore late roster, edge, and status facts until a new `setActiveStream(child)` clears it.

The tombstone is bounded by the same session lifetime as retained history and is cleared by `resetCliState()`.

If the removed stream is itself a parent, perform the current cross-reference cleanup in the map: clear active and
retained associations to that parent and remove its current topology edges. Existing child slices remain, but no
selector may return the removed parent as their ancestor.

### Retained history

Retention begins on the first roster, not on an edge-only observation, because an edge contains no execution
label or stable display order. A child may therefore be topologically reachable before it has a control row.

Roster omission, completion, and promotion do not erase retention. Explicit child removal or parent removal does.
An updated roster may refresh execution metadata for a resumed child stream, but it cannot change first-retained
order.

## Invariants

The implementation is acceptable only if all of the following hold after every event, not merely after a settled
run.

1. **One relationship owner.** Every child stream id has at most one `ChildStreamEntry`; no writable
   `activeSubagents`, `childStreams`, or `parentStream` collection remains.
2. **No status duplication.** `ChildStreamEntry` has no status field. Every derived row takes status from the
   child's `StreamSlice`.
3. **Explicit topology wins.** Once an explicit edge is observed, roster facts cannot change current topology.
   Explicit `null` means top-level until another explicit non-null edge.
4. **Roster exactness.** For a given parent, active membership after a roster fact is exactly the compatible,
   non-tombstoned children in that fact.
5. **Retention monotonicity.** A retained row and its order survive roster omission and terminal status. Only
   explicit removal of the child or its parent erases the association.
6. **Focus does not invent topology.** Retained history may remain a forward-focus candidate, as it is today, but
   it cannot restore parent/back routing for a promoted child. An edge-only child becomes focusable only when its
   child slice exists.
7. **Removal is final per activation.** Late facts cannot recreate a removed child. A new activation is explicit.
8. **Determinism.** Replaying the same ordered hub facts from empty CLI state yields byte-identical derived focus
   and control snapshots.
9. **No persistence dependency.** Live selectors do not read, await, or subscribe to `StreamSnapshotStore`.
10. **Process isolation.** `activeProcesses`, `processOutput`, and completed-process transcript behavior are
    unchanged in phase one.
11. **No cross-host state abstraction.** No type, reducer, command union, or store is added to `src/shared/` or the
    webview for this migration.

## No-dual-write migration

The implementation must not shadow-write the new map alongside the three legacy collections. A shadow period
would double the transition surface precisely where event ordering is load-bearing and would make mismatches
ambiguous.

Use this sequence:

1. **Characterize the old implementation.** Extend existing tests and the PTY harness with the ordering matrix
   below. Record deterministic focus/control projection bytes while the old representation is still the sole
   owner. This commit changes tests only.
2. **Perform one atomic production cutover.** In one compiling commit, add the map owner and transition methods,
   route subagent roster/edge/removal events only to it, switch every CLI reader to selectors, and delete the two
   `StreamSlice` fields plus the writable parent map and status-mirroring helpers.
3. **Compare through outputs, not shadow state.** Run the same characterization fixtures against the new owner and
   require byte identity. Do not retain a runtime equivalence adapter or compatibility write.
4. **Keep process state untouched.** Any proposed process consolidation stops the PR and returns to a separate
   design gate.

Pure call-site adapters are permitted only when they compute a view from the map in the current call. They must
not cache, signal, or mutate a legacy-shaped result.

## Race-regression plan

### Ordered unit matrix

Extend `src/test-kernel/cli/TuiStateAndFocus.vitest.mts`; do not create a new suite. Use the following symbols:

- `A`: `setActiveStream(child)`;
- `S(running|terminal)`: child status transition;
- `R+`: parent roster includes the child;
- `R-`: parent roster omits the child;
- `E+`: explicit parent edge;
- `E0`: explicit `null` edge (promotion); and
- `X`: `removeStream(child)`.

Drive at least these sequences with `test.each`, asserting after every step:

1. Canonical: `A, S(running), R+, E+`.
2. Roster first: `R+, A, S(running), E+`.
3. Edge first: `E+, A, S(running), R+`.
4. Status first: `S(running), A, E+, R+`.
5. Completion: `A, S(running), R+, E+, R-, S(terminal)`.
6. Promotion with stale roster: `A, S(running), R+, E+, E0, R+`.
7. Explicit reattachment: sequence 6 followed by `E+` and a fresh `R+`.
8. Removal with late facts: sequence 5 followed by `X, R+, E+, S(terminal)`.
9. Fresh activation after removal: sequence 8 followed by `A, S(running), E+, R+`.
10. Two-child retention: add children in one order, reorder and shrink rosters, complete one, and verify stable
    retained order and active overlay.

The checkpoint assertions must cover effective parent, active rows, retained rows, focus forward/back, numeric
focus targets, stream labels, follow-up routing, control-row killability, and removal cleanup.

### Byte-identical focus/control snapshots

Before the cutover, add a deterministic serializer in the existing test file that records only public behavior:

```typescript
{
  activeRowsByParent,
  retainedRowsByParent,
  parentByChild,
  streamTree,
  focusForwardByStart,
  focusBackByStart,
  subagentControlsByParent,
  taskControlsByParent,
  numericFocusTargets,
}
```

Sort object keys and topology pairs, preserve semantic row order, and serialize with `JSON.stringify`. Fix all
timestamps or omit `startedAt` so elapsed labels are deterministic. Capture the old implementation's serialized
strings as literals or committed Vitest snapshots. After cutover, compare strings with `toBe`, not structural
matching; the UTF-8 bytes must be identical for the canonical, roster-first, edge-first, status-first, completion,
and two-child retention cases.

Promotion and removal intentionally correct ambiguous old transient behavior. Give those cases explicit new
goldens and assert the invariants above rather than claiming old-byte equivalence.

Extend `src/test-kernel/cli/ChildControls.vitest.mts` for row labels and killability, and keep the existing process
completion tests unchanged as a negative-scope guard.

### PTY ordering tests

The current harness seeds child arrays and edges directly
(`packages/cli/scripts/tui-harness.tsx:989-1125`). Add an opt-in event-driven fixture instead of modifying the
default scenarios:

1. `HARNESS_CHILD_EVENT_ORDER` selects `canonical`, `roster-first`, `edge-first`, `status-first`,
   `promotion-late-roster`, or `completion-remove`.
2. The fixture emits the real session/run facts through a `SessionEventHub` attached by
   `attachTuiRunFactSubscription`; it does not call the new map mutators directly.
3. Each step is separated by a deterministic harness checkpoint so Ink renders the intermediate state. Use fixed
   ids and no wall-clock-derived elapsed labels.
4. Add validator scenarios that exercise Tab focus, backward focus, the subagent picker, the task picker, and
   focus-follow-up routing at those checkpoints.
5. For the four order-equivalent settled cases, extend `validate-tui.mjs` with an `equivalentFrameTo` assertion.
   Compare the exact rendered text returned by its existing `renderFrame()`
   (`packages/cli/scripts/validate-tui.mjs:3153-3163`), not only `expect` substrings. With equal dimensions and fixed
   data, the focus/control frames must be byte-identical.
6. For promotion and removal, assert that no stale parent label, active count, focus target, or kill control
   appears after the late facts. Then send the focus keys to prove that the TUI remains interactive.

The PTY layer is necessary because pure selectors cannot detect an Ink subscription wired to the wrong signal or
a transient frame that exposes a stale control.

### Existing suites that must remain green

At minimum, run the focused CLI suites covering:

- `TuiStateAndFocus.vitest.mts`;
- `ChildControls.vitest.mts`;
- `StreamTabsStrip.vitest.mts`;
- `StatusBar.vitest.mts`;
- `ConversationPane.vitest.mts`; and
- the selected `validate:tui` ordering and existing subagent scenarios.

Then run the repository's normal typecheck, lint, format, CLI architecture check, and full Vitest suite before
submission.

## R6 net-element estimate

This is an estimate for the future implementation PR, not a census of this design-only commit. The PR must replace
it with counts from the actual diff using the method in
[`fewer-elements-2026-07.md`](./fewer-elements-2026-07.md): files, `^[+-]export`, class/interface/enum declarations,
and net lines.

### Baseline and target

- **Authoritative mutable collections:** delete 3 (`activeSubagents`, `childStreams`, `PARENT_STREAM`), add 1
  (`CHILD_STREAMS`): **net -2**.
- **`StreamSlice` fields:** delete 2 (`activeSubagents`, `childStreams`), add 0: **net -2**. `activeProcesses`
  remains.
- **Exported symbols:** expected deletion of `parentStream`, `setParentStream`, `registerChildStreams`,
  `mergeChildStreams`, and `visibleSubagentRows`; expected addition of `ChildStreamEntry` and one narrow owner
  facade: **+2 / -5, net -3**.
- **Class/interface/enum declarations:** add `ChildStreamEntry`, delete `ParentStreamEdgeUpdate`, add no class or
  enum: **net 0 declarations**.
- **Callable declarations:** the target deletes approximately 12 merge, mirror, scrub, parent-map, and slice-order
  functions and replaces them with approximately 6 transition/selector methods: **estimated net -6**.
- **Production files:** add 0 by deepening an existing state module; modify approximately 12-16 current consumers.
- **Test files:** add 0; extend existing suites and the existing TUI harness/validator.
- **New shared planes, vocabularies, schemas, reducers, or persistence stores:** **0**.
- **Production lines:** estimated **net -40 to -100** after deleting status mirroring and repeated collection
  plumbing. Regression tests will add lines, but they are permanent behavior tests rather than temporary
  scaffolding.

The implementation fails its R6 gate if it leaves any writable compatibility collection, adds a new production
file without a measured need, has a positive exported-symbol delta, or has a positive authoritative-collection
delta. A non-negative production-line result requires explicit maintainer re-review even if tests pass.

## Rejected alternatives

### Mechanically merge all four collections

Rejected. It erases the different lifetimes of active roster, retained history, topology, and process output. It
also violates the issue's design gate.

### Key the map by execution id and include processes

Rejected. A resumed child stream may acquire updated execution metadata while preserving one stream tab, whereas
a process has no stream tab at all. An execution-keyed map cannot answer child topology without another index.
`activeProcesses` requires a separate design because its output-finalization ordering is load-bearing.

### Put status in `ChildStreamEntry`

Rejected. This would preserve the current stale-row problem under a new shape. Focused routing already has tests
that prefer the child slice over stale retained-row status
(`src/test-kernel/cli/TuiStateAndFocus.vitest.mts:1453-1498`). Status remains in the child `StreamSlice`.

### Let the latest roster overwrite topology

Rejected. It would make a late pre-promotion roster resurrect an explicitly promoted child. Explicit edge facts
have stronger authority than roster inference.

### Derive retained history from the current roster only

Rejected. Completion removes the child from the active roster before terminal status, and completed child tabs
must remain available. Retention is a separate selector over retained fields in the same entry.

### Make `StreamSnapshotStore` the live TUI owner

Rejected. The store intentionally excludes active children and live status, serializes asynchronous disk writes,
and serves history/resume across hosts. It should continue persisting the durable parent edge, but it must not
become an Ink state store or a source for live controls.

### Add a shared CLI/webview reducer

Rejected by the maintainer decision and by the runtime-to-UI audit. The extension/webview crosses an IPC boundary
and has different rendering and hydration constraints; the CLI projects in-process hub facts. Sharing a reducer
would add a new cross-host state plane while preserving host-specific adapters on both sides.

### Add sequence numbers, replay, or a second event queue

Rejected. `SessionEventHub` already preserves producer order synchronously. The missing information is authority
between event types, represented locally by the tri-state explicit edge and removal tombstone. A second ordering
system would violate R4 and create a new failure mode.

### Shadow-write and compare old and new state at runtime

Rejected. It doubles the number of race-sensitive transitions and cannot identify which owner is correct when
they disagree. Characterization snapshots provide equivalence without production dual writes.

### Cache every derived legacy view in another signal

Rejected. Cached `activeSubagents`, retained rows, or parent maps would recreate the triplication. Child counts are
small; selectors should be direct first. Any later performance work requires profiling and a separate review, and
may memoize computation only without introducing another writable owner.

## Implementation acceptance gate

An implementation PR may begin only after this design is accepted. It must then demonstrate all of the following:

1. one CLI-local child-stream map and no legacy writable subagent relationship collections;
2. the transition precedence and invariants in this document;
3. no production dual-write stage;
4. byte-identical focus/control snapshots for behavior-preserving orderings;
5. PTY coverage of real event ordering, promotion, completion, and removal;
6. no phase-one changes to `activeProcesses` or its output lifecycle;
7. no shared CLI/webview reducer and no live-roster role for `StreamSnapshotStore`; and
8. an updated, actual R6 census in the PR description.
