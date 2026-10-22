---
created: 2026-09-03
status: implemented
---

# One fold, three renderers

This note owns how the hosts render run and session state. It describes the
code on `main`. Code comments cite it by section number ("PRD
one-fold-three-renderers, 5.2"), so the numbering is kept; sections that
only recorded the build plan are gone.

**In one sentence:** every process that shows a session runs the same
fold over the same session events into one `SessionView`; the transport
carries events and requests, never a view; a renderer owns only the
interaction state of its own view instance; and the TUI, the desktop and the
extension paint the same `TranscriptRow`s from it.

```
session event table ──► SessionEvents (one publisher, ordered reads)
                              │ listing · aggregate history · tail, + live text
                              ▼
                 updater.apply(input) ─► SessionView ─► RunView.transcript.rows
                 (same updater in the runtime,       (TranscriptRow, @shared/transcript)
                  a webview, the TUI)                      │
                                                           ▼
                         Ink TUI · Lit progress app (extension, desktop) · headless/SDK
```

## 1. Why

Before this design each host kept its own copy of run state: the extension
rebuilt it in the webview from commands, the TUI re-read a host-side state
class, and the desktop wired its own shell. The same fact reached three
hosts through three paths and rendered three ways. One fold over one event
vocabulary removes the copies.

## 2. Goals

1. One `SessionView`, produced by one fold, identical in every process
   that shows a session: runtime, extension webview, Electron renderer, TUI,
   headless, SDK.
2. The transport carries the fold's input down and requests up.
3. A renderer owns a `Surface` (and, on the desktop, a `Shell`) and nothing
   else.
4. One conversation shell for the extension and the desktop.
5. One desktop process holds one session per open project.

## 3. Non-goals

- A new UI framework: components stay Lit and Ink.
- A second schema system for data: Zod is the source of truth (the
  `texra serve` RPC edge wraps Zod payloads in a thin Effect Schema,
  `packages/texra/src/controllers/server/protocol.ts`).

## 4. Governing rules

**G1. One fold, everywhere.** `makeSessionViewUpdater(key)`
(`packages/harness/src/shared/session/sessionViewUpdate.ts`) returns one
session's updater, `{ current, apply }`. `apply` takes `SessionViewInput`
(`packages/harness/src/shared/schemas/sessionViewInput.ts`) in order: durable
events tagged by the read that delivered them, live text chunks, this
process's local runtime state, the transcript subscription set, the debug
flag, and the replay and drain markers. The updater owns the working state
beside the view, each run's transcript state included, so the same inputs in
the same order give the same view. Every process that shows a session
runs it. No process holds a mirror of another process's fold output. A
process that does not own a run has fewer inputs (no live text) and renders
the settled prefix, never a different reading of the same input.

**G2. The transport carries input, never output.** Down: durable events and
live text chunks, commit ordered. Up: `runtime.request` and `host.request`.
A generic setter applying view patches would be a second reducer and is not
built.

**G3. Facts versus interaction.** A fact is derivable from the durable
events and lives in the fold. Interaction state (selection, drafts,
recording, expansion overrides, focus, scroll, layout) lives in the
renderer's `Surface` and is never a session fact.
`src/test-kernel/architecture/sessionPresentationBoundary.vitest.ts` pins
the interaction-state names out of the shared schemas.

**G4. The fold states facts; hosts own presentation of width and clock.**
Rows and run views carry what is a function of facts alone (labels, a status
key and `tone`, complete text). The app's copy tables (`@ui/copy`) word the
keys. Hosts own every function of width, locale, color depth and the clock:
elision is measured by the painter at its own width, and live elapsed time is
a host call.

**G5. No render-time compensation.** A renderer never patches the data: no
`Date.now()` for a fact, no synthetic ids, no dedup. A wrong picture is fixed
in the fold or upstream of it.

## 5. The state

### 5.1 `SessionView`

Zod schema in `packages/harness/src/shared/session/sessionView.ts`; types by
`z.infer`. It is fold output: never persisted, never parsed, and it holds
`Map`s because it never crosses a bridge.

- `key`: the session (the storage root).
- `runs: Map<RunId, RunView>` and `order`: top-level runs, newest creation
  first.
- `cursor`: the commit ordinal of the durable prefix the last drain
  completed.
- `transcriptSeq: Map<AggregateId, seq>`: one entry per subscribed aggregate, the
  highest seq the fold has retained for it.
- `rollup`, `requests` (pending requests, each with its `runId` and
  `requestId`), `policy` (latest approval policy per run), `pluginFacts`
  (plugin-aggregate facts), `queuedFollowUps`, `debug`.

`RunView` carries the run's identity, owner (`ownerId`, `ownedHere`,
`readOnly`), labels and title, model, worktree, status (`status`, `substate`,
`durableOutcome`, `statusNotice`, `statusKey`, `tone`), timing, parent and
fork edges (`parentId`, `ancestors`, `childIds`, `forkedFrom`), the
descendant `rollup`, `approval` (`none | own | descendant`),
`resumeBlocked`, the `actions` a host may offer, `group`
(`running | waiting | interrupted | recent`), usage, `facts` (the run's
latest `plugin.fact` values) and `transcript` (`TranscriptView`: rows, task
groups, settled-row count).

Aggregate ids are kind-qualified (`qualifyAggregateId(kind, logicalId)`), and
every fact lives on the aggregate of its logical target: one run owns one
aggregate, `('run', runId)`, holding its display rows and its private
records; a plugin's own facts ride the plugin's aggregate. No sentinel run id
exists.

### 5.2 Fold rules

**Duplicates.** The listing, an aggregate's history and the tail overlap by
construction. A listing fact is ordered by commit within its
`(aggregate, listing type)` entry and ignored when it is not above the
latest folded. A transcript row folds only when its seq is above
`transcriptSeq` for its aggregate, which it then advances. The reads that can carry
a subscribed aggregate's rows are sequenced, not raced (listing, histories,
the replay marker, then the tail), so the threshold never passes a row the
fold has not retained.

**Residency.** Transcript rows fold only for aggregates in the subscription
set; a row for any other aggregate is dropped without touching `transcriptSeq`.
Listing facts fold regardless. When an aggregate leaves the set the fold
drops its transcript tier and keeps every listing fact.

**Cursor.** `view.cursor` moves only on a `drained` input, the end of a
finite tail read, never on a listing or history row.

**Ownership.** The events are history. Current write ownership is the claim
the finite reads sample (`ExistenceReconciliation` on `replay.complete` and
`drained`); the envelope's `origin` is provenance only.
`LocalRuntimeState` supplies this process's owner ids, owners proven dead,
unreadable runs and resume blockers. A claim held by an owner with no
verdict is unprovable and held, never dead; only an explicit dead verdict
makes a foreign claim reclaimable. The prober is
`packages/harness/src/controllers/session/ownerLiveness.ts`.

- **Existence.** A run exists iff its `run.start` has folded and its
  `run.removed` has not. The two share one `latest` entry, so the tombstone
  is final under every read. Ids are never reused: a relaunch is a new run.
  Listing hydration is authoritative: at the replay marker every run no
  listing row named is removed the way a tombstone removes it.
- **Live text.** A `TextChunk` is `{ runId, rowId, from, to, text }`. A chunk
  whose `to` is not past the text held is ignored; otherwise the held text is
  truncated at `from` and the chunk appended. Redelivery in any order is a
  no-op, a `from: 0` chunk replaces the row, and adjacent chunks merge
  exactly (`applyLiveText`, `packages/harness/src/shared/session/transcriptReads.ts`).
- **Settled text is in the event.** The finalizing event carries the row's
  complete text; deltas are never durable or checkpointed.
- **In-flight text.** Live text is held per row beside the rows, in the
  transcript's working state (`transcriptState.ts`), and joined when a row
  paints. It is dropped when the row's finalizing event folds, the run ends
  or is removed, or the run loses its transcript tier (`clearLiveText`).
- **Durable text wins.** A chunk for a row whose finalizing event has folded
  never reopens it, and a chunk for a run the view does not hold is dropped.
- **Incremental.** An event recomputes its run's arm and walks `parentId` to
  the root refreshing each ancestor's aggregates, touching `order` only when
  a top-level run moved: O(depth) per event, and a text chunk costs the
  chunk.
- **Publication.** Returned views are immutable and untouched branches keep
  identity: `apply` copies a branch once per call and returns the previous
  view when nothing changed. A throw leaves the updater partly advanced, so
  its owner discards it.

The transcript tier is one reducer, `transcriptUpdate.ts`, over its working
state in `transcriptState.ts`, the `log` rows in `transcriptLogRows.ts` and
the reads in `transcriptReads.ts` (all in
`packages/harness/src/shared/session/`). The session fold runs it for each
resident run, and `buildRunTranscript` runs the same reducer over one
aggregate's committed rows where no view is resident (export, host-exit
settlement: `packages/harness/src/transcript/runTranscript.ts`), so live and
cold reads cannot drift. A `log` payload is decoded once
(`decodeLogPayload`); one that fails its schema becomes an error row naming
the diagnostic, never a cast or a silent drop.

### 5.3 The row

`TranscriptRow` (`packages/harness/src/shared/transcript/transcriptRow.ts`,
`@shared/transcript`) is the one value every host paints: one row kind per
thing a run says (`assistant`, `thinking`, `user`, `tool`, `error`,
`webSearch`, `log`, …), carrying its typed payload and complete text. It is a
plain type built from already-decoded values, not a schema. The builders are
`projectTranscriptRow.ts` beside it. This is not `@transcript`
(`packages/harness/src/transcript/`), the run-transcript persistence layer.

## 6. Events

The durable vocabulary is `packages/harness/src/shared/schemas/sessionEvent.ts`;
the trace's `AgentEvent` is derived from its arms. Every arm rides one
envelope: aggregate, per-aggregate `seq`, the session-wide `commit`, the
writing `origin`, and the publish clock `at`.

1. **Requests.** `request.opened` and `request.decided` are run-scoped; the
   payload is what the UI shows, never a host handle.
2. **`approval.policy`** carries the full policy snapshot after a change,
   from the single policy authority. The initial snapshot rides the
   `run.start` payload, so a run never edited still has one, atomically with
   its existence.
3. **`run.start`** is the existence fact, seq 1 of the run's aggregate, once
   per run. **`run.end`** is the terminal fact, written once per lifecycle by
   the storage finalizer; the fold derives the terminal phase from it alone.
4. **`worktree`** is a field on `run.start`; the fold never shells out.
5. **No active-stream fact.** Focus is the `Surface`'s selection, never an
   event.
6. **Launch facts on `run.start`** (identity, follow-up support, parent edge,
   provenance, parent card, initial policy) are read verbatim; the fold
   derives nothing from a registry. Current ownership is the sampled claim,
   not `origin`.
7. **Snapshots, not invalidation hints.** A row says what changed
   (`followup.queued`/`followup.consumed`, a `plugin.fact` value), never "go
   look".
8. **`run.activate`** marks every activation (first launch and each resume);
   `run.start` happens once.

`run.removed` is the tombstone, the last row of its aggregate. Run-scoped
facts are written through the session log (CLAUDE.md "Event channels").

## 7. Effect services and layers

### 7.1 `SessionEvents`

`packages/harness/src/agent/runtime/SessionEvents.ts` is the session event
plane over the root's SQLite database, the service declared in
`packages/harness/src/shared/session/sessionEvents.ts`. Writes go through
its doors (`transact`, `detach`, `removeRun`, `drain`) and commit in enqueue
order. Reads: `listing()` (the latest listing rows, finite), an aggregate's
history (`Database.readAggregate`), and `all(fromCommit)` (every event above
a commit, then the tail). Wakes carry no payload; each tail wake drains a
committed prefix.

### 7.2 `SessionView`

`SessionViewService` (`packages/harness/src/controllers/session/SessionView.ts`)
is a fold fiber, forked under the layer's scope, that folds complete ordered
input batches from `SessionInputs` (`packages/harness/src/shared/session/sessionInputs.ts`)
into a `SubscriptionRef`. The input reader captures the live text level
first, then drains the committed prefix, then yields text, so a committed
`run.start` reaches the fold before its first chunk. The three non-durable
levels (local runtime, text chunks, transcript subscriptions) are
`SubscriptionRef`s in `packages/harness/src/controllers/session/sessionSources.ts`.
Across a process boundary, `RemoteSessionView` folds the inputs its
transport serves (`@texra-ai/harness/transcript`).

### 7.3 `WorkspaceRoots` and the per-session layer

Each session graph is built per storage root in a `LayerMap`
(`packages/harness/src/controllers/session/sessionLayer.ts`). The graph reads
its roots from context (`packages/harness/src/controllers/session/WorkspaceRoots.ts`,
`@platform/workspaceRoots`), never from ambient state.

### 7.4 Transport framing

`SessionFramer` (`packages/texra/src/controllers/session/SessionFramer.ts`)
answers each `Subscribe` with the same ordered reader the runtime fold uses,
tags rows with their read, and frames with `Stream.groupedWithin(rows, 16
millis)` then `Stream.buffer({ strategy: 'suspend' })`: durable rows never
drop, and suspension parks the framer, not the publisher. Adjacent text
chunks merge losslessly per frame. A later `Subscribe` supersedes the replay
in flight by generation.

### 7.5 The signal bridge

Lit components read the view and the surface through signals
(`@lit-labs/signals`, `packages/texra/src/shared/signals.ts`), fed from the
view's Effect stream.

### 7.6 Requests, errors, ownership

`SessionRequests` (`packages/harness/src/controllers/session/SessionRequests.ts`)
answers every `RuntimeRequest` once, with an `Outcome` or a tagged request
error (`NotOwner`, `Unavailable`, `Cancelled`, `Rejected`, `Internal`;
`packages/harness/src/shared/session/requestErrors.ts`). Existence is read
from the sequence table first; a foreign claim without a death proof is
`NotOwner`.

### 7.7 Runtime per process

Each entry builds one process runtime over `processLayer`. A webview builds
one `ManagedRuntime` (`installWebviewRuntime`) with one graph per session key
in a `LayerMap` (`packages/texra/src/controllers/session/webviewSessionLayer.ts`);
the transport that installed it disposes it once.

## 8. The protocol

The Zod wire is `packages/texra/src/shared/session/sessionFrames.ts`.
`SessionBridge` (`packages/texra/src/controllers/session/SessionBridge.ts`)
owns a session's ports: one framer fiber per attached port, the `Subscribe`
handler and the two request handlers. A request runs in the bridge's scope,
uninterruptibly, so a decision sent just before a tab closes still
completes.

### 8.1 Down: `events`

An events frame carries the rows one `Subscribe` asked for, tagged by read,
then the tail; `cursor` is the commit the framer had drained when it cut the
frame, left-out rows included, and `generation` echoes the `Subscribe`. What
the host renders but does not own rides each port's frames as the `host`
snapshot.

### 8.2 Up: `runtime.request`

One discriminated union, `RuntimeRequest`
(`packages/harness/src/shared/session/runtimeRequest.ts`): `run.stop`,
`run.delete`, `run.compact`, `run.rename`, `run.fork`, `run.reset`,
`run.model`, `run.files`, `followUp.send`, `request.decide`,
`request.preview`, `policy.set`. Every host, the SDK's `Session.request`
and `texra serve` route it to the same handler.

### 8.3 Up: `host.request`

A capability the host performs for the surface (open a file, export,
latexdiff, pack, clean, pickers, recording, launch, workspace file reads and
writes, …): `packages/texra/src/shared/session/hostRequest.ts`, handled per
host by `packages/texra/src/controllers/session/sharedHostRequests.ts`,
`packages/extension/src/progressView/extensionHostRequests.ts` and
`packages/desktop/src/main/desktopHostRequests.ts`. Only arms a component
dispatches are declared.

### 8.4 Down: `response`

Each request is answered once under its id: `ok` with its outcome, or the
request error on the wire.

### 8.5 Down: `surface.action`

The host acting on state a surface owns, and only these arms: `selectNew`,
`select`, `showSessions`, `submit`, `draft`, `chime`, `launch`.

### 8.6 What does not cross the bridge

A `SessionView`, a view patch, a `Surface`, or a host handle.

## 9. The Surface

`Surface` (`packages/texra/src/shared/session/surface.ts`) is every
interaction fact a renderer owns for one view instance and one session:
selection, launch fields, drafts and images, inquiry drafts, expansion,
group state, seen markers, the drawer, workbench layout. Components read it
and dispatch a `SurfaceAction`; the root applies it. Its persisted form is a
Zod schema whose maps are entry arrays, because webview state crosses
`JSON.stringify`. Per-run entries drop when the view no longer holds the run
(ids are never reused). Above it, `Shell` (`packages/texra/src/shared/session/shell.ts`)
records which project a desktop window shows and the rail order; on the
extension and the TUI it is degenerate.

## 10. Host switches

### 10.1 TUI

The Ink TUI binds the session's view in process (`bindSessionView`,
`packages/cli/src/chat/tui/state/sessionView.ts`; wired in
`packages/cli/src/chat/tui/runChatTui.tsx`) and paints its rows. The
composer's submit path (`packages/cli/src/chat/chatSessionController.ts`)
issues `RuntimeRequest`s through the same handler.

### 10.2 Extension and desktop

Both render the same Lit progress app
(`packages/extension/src/progressView/frontend/ProgressApp.ts`) from one
bundle: frames over the bridge, the fold in the webview through
`RemoteSessionView`, the `Surface` in the webview, and requests up.

### 10.3 Headless and SDK

`texra run`'s status line (`packages/cli/src/runtime/runProgressRenderer.ts`)
and plain script progress (`packages/cli/src/runtime/scriptPlainOutput.ts`)
read the view and derive nothing it states. The NDJSON output
(`packages/cli/src/runtime/sessionProgressSubscription.ts`) is a versioned
projection of every display event above the store's head, read with
`view.events(view.head())`, never the view; its one derived record,
`run.children`, comes from the fold. The SDK's `Session.view`
(`packages/harness/src/effect/sessions.ts`) exposes `current`, `changes` and
`watch`; a `LocalSession` adds `subscribe`, `read`, `head` and `events`.

## 11. Session roots and many papers

One process holds one session per open root, each with its own roots,
database and view. The desktop binds every open project for a window
(`packages/desktop/src/main/desktopProjectBindings.ts`), so the rail lists
each from its own view; switching projects relaunches nothing.

## 12. The shell

### 12.1 Extension: one surface

`<progress-app>` renders one of two states from `surface.selected`: the New
task empty state, or the selected run's conversation under one header row
(`RunHeader`). The Sessions drawer (`SessionDrawer`), the editor tab's docked
list, the composer (`SessionComposer`) and the Tools sheet (`ToolsSheet`,
LaTeXDiffs) hang off it. The extension attaches its sidebar webview and its
editor tab as two ports of one bridge.

### 12.2 Desktop: projects

The desktop draws its own rail and header around the same element; a run
selected in another project's tree selects that project too.

### 12.3 TUI

The TUI renders the same rows in its own transcript and panes; it has no
Shell beyond its one root.

### 12.4 Surface mapping

New task is the header's "+" (the New-task state). The run accelerator is
the composer's Send for the surface's resolved selection (`surface.action`
`submit`). The completion chime is decided once per process by the host and
sent to one port (`surface.action` `chime`), never a renderer transition
every subscriber would replay.
