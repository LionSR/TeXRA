---
created: 2026-06-28
---

# Sub-PRD 07: UI as a Pure Reactive Projection of the Runtime

> **Re-scoped by the unified design pass (2026-06-29).** Phase A (the **status +
> display-identity projection slice**) lands now: fold status, pending approvals,
> and ephemeral counters into one projection, delete the desktop fork, and fix the
> renderer-reload prompt-parity bug. Phase B (the `ProgressViewDelta` patch type
> and the frontend mirror-reducer deletion) is the **medium-term direction**, not
> a quick win - the record-store delta type does not exist yet and must ship
> first. The status slice consumes #6722's tool-result union and 04's carried
> `resolvedAgentName`. CLI keeps its Ink-native signal on the same status
> authority (not charged to the store). See `00-overview.md`.

## Context

The runtime emits through exactly one typed channel, `AgentRuntimeHost.emit<K>(event, payload)` (`src/hosts/AgentRuntimeHost.ts:28-37`), carrying the `ProgressEventPayloads` map (`src/eventBus/ProgressEventBus.ts:79-272`), with `noopAgentRuntimeHost` (`AgentRuntimeHost.ts:35-37`) as the Null Object for headless. That 37-event protocol is correct and stays verbatim; it is the only cross-process wire (the `bus` is an in-process `EventEmitter` and never crosses host to webview).

A shared store-and-notify backend already exists: `ProgressBackend` (`src/shared/progressView/backend/ProgressBackend.ts:69-110`) welds `ProgressViewState`, `WebviewUpdater`, `WebviewBridge`, and `ProgressEventHandler` into one host-neutral graph. This sub-PRD is **subtractive**: it makes every host a derive of that one store and deletes the duplicate reductions. It introduces **no universal UI layer** (a stated PRD Non-Goal) and adds no new cross-cutting framework. It generalizes and **partly absorbs Sub-PRD 01** (the desktop fork is the same drift class, viewed from the store side), and it depends on 01 landing the lifecycle and permission seams first.

## Problem

The same event is reduced up to four times into three stores, and a fourth reduction runs on desktop.

- **Backend reduce welds projection into reduction.** Each handler in `ProgressEventHandler.setupEventListeners` (`ProgressEventHandler.ts:108-261`) mutates `ProgressViewState` and, in the same closure, hand-pushes a per-field webview message behind the `sendIfActive` active-stream gate (`:174,183,192,280`). Reduction and projection are one tangle.
- **The store is not reactive.** `ProgressViewState` is a getter/setter bag with no `subscribe`, no `getSnapshot`, no selector API (confirmed: the only `release*` methods at `state/ProgressViewState.ts:196-198` are eviction, not reactivity). It can only be poked from outside by `ProgressEventHandler`. That missing surface is the single thing blocking pure derive.
- **The frontend re-reduces into a second store.** The webview turns `WebviewUpdater`'s commands back into `appState` (`packages/extension/src/progressView/frontend/progressState.ts`) via `dispatchMessage` plus ten slices. This reducer is **shared by the extension webview and the desktop renderer**, so it is a de-duplication target, not a fork.
- **The desktop main process forks the backend reduction.** `desktopProgressEventBridge` runs a second reduction alongside the shared `ProgressBackend`, wired by a double-dispatch that fans every event to both `bus.emit` and the bridge (`packages/desktop/src/main/desktopAgentExecution.ts:745-751`), with an inline delete path (`:787-844`) and a `pendingPermissionStreams` mirror. It has already drifted (dropped `warning` severity, broken delete-all; see `00-overview.md:64-78`).
- **The CLI runs a third reducer.** `subscribeRuntimeHost.applyToState` reduces ~18 events into `cliState` signals (`packages/cli/src/chat/tui/state/cliState.ts`), bypassing `ProgressBackend`. This is the closest-to-pure reference render layer, and the cheapest reduction to leave alone (no IPC boundary).

This is Pattern 1 Shotgun Surgery one layer up: a board-state change must be authored in four reducers, and the copies lag.

## The reactive target

Every host becomes a pure derive of one shared store: state to view; user intent flows out as typed requests; nothing flows in except store deltas.

**One framework-agnostic store.** Generalize `ProgressViewState` (it already owns the authoritative durable transcript, sidecar, ephemeral counters, and prefs) into a subscribable store: `getSnapshot(): ProgressViewProjection` (structured-clone-safe, generation-versioned), `subscribe(delta)`, and memoized `select(...)` so selectors live once. `StreamSnapshotStore.subscribe(bus)` (`src/transcript/StreamSnapshotStore.ts`) already proves a store can self-subscribe the protocol and reduce its sidecar with zero host code, while `ProgressEventHandler` re-invokes the same mutators a second time. Generalize that self-subscribe so the duplicate mutator calls disappear.

**Reduce splits from project, but the reducer does NOT become pure.** The deletable thing is the per-field `webviewUpdater.updateX(...)` call inside each handler; projection becomes "store emits delta, subscribers apply it." The handler keeps genuine imperative orchestration that has no place in a pure reducer and must stay explicit: memory eviction on switch and status (`releasePreviousActive`/`releaseEntries`, `ProgressEventHandler.ts:340,349,588-590`, non-active streams are released to disk, a memory model not a bandwidth tunable), the 500 ms progress throttle timer (`:39,79,420-422`), async usage accumulation (`:220`), and the permission-gated switch decision (`:323-333`). These stay as named imperative orchestration on the host-side bridge, not the store, so the store still reduces losslessly with zero subscribers (headless arms no timer).

**The projection must carry three facts that today force per-host re-derivation.** Stream **status** (today an injected `ProgressRuntimeStatus` port re-mirrored by the CLI) gets a `status` field in the projection while the port stays the source. **Pending approvals** (today in-memory `ApprovalRequestHandler.pending`, re-pushed by an extension-only `replayPendingPrompts` that desktop lacks) become a projected slice, so reconnect is one snapshot. **Ephemeral counters** ride the snapshot so a reconnecting renderer is whole.

**Per-host thin reactive bridge (genuine affordance, kept).** Webview and desktop renderer share one Lit `ReactiveController` that applies inbound `{ snapshot | delta }` and calls `host.requestUpdate()`; the existing pure selector computeds and `ProgressApp.render` are already a pure projection and stay. The CLI's `useSignal` (`Signal.subtle.Watcher` to `useSyncExternalStore`) is already the reference adapter and stays. Desktop main subscribes the shared store and serializes to the renderer over `postToRenderer`.

**Intent flows out, emit-only.** Runtime intent (approvals, retries) goes to the shared `@agent/runtime/*Commands`; view intent (switch, delete, filter, follow-up) goes to the typed `PROGRESS_VIEW_COMMANDS` union. **Active-stream selection is local view state on every host** (the CLI already treats it that way; the webview's optimistic `draft.activeStreamId = streamId` at `eventHandlers.ts:47` is the same correct local write, not residue). The echo is needed only to hydrate the newly-active stream's content, not to own the selection. The deletable residue is narrow: the optimistic settle (`removePrompt`) and the out-of-order guard (`resolvedProposalIds`, `eventHandlers.ts:281,362-369`).

## IPC-replicated store, not a cross-process observable

Runtime and renderer are in different processes (extension host to webview; desktop main to renderer). There is no literal cross-process observable; the replica is **snapshot plus ordered serializable deltas**, with the 37 events as the upstream wire and a separate downstream sync channel.

Be honest about the cost: `WebviewBridge` is a **cursor over an append-only log** (monotonic `head`, `getRange`, `getDirtyUpdates`/`ackDirtyUpdates`, `WebviewBridge.ts:18-21,129-149`) and only covers log entries. The rest of the store (status, todos, plan, badges, files, usage, pending approvals) is last-writer-wins record fields with no `seq` to cursor over. So the delta vocabulary does **not** evaporate: a real `ProgressViewDelta` patch type (generation-versioned, last-writer-wins field patches plus the existing log cursor) must be shipped first. The genuine win is **de-duplicating the frontend mirror reducer** once the backend `ProgressViewState` shape and the frontend `ProgressState` shape are unified into one projection type, not eliminating the 25 message variants by fiat.

- **Generation-versioned snapshot on connect.** `getSnapshot()` returns one structured-clone-safe projection tagged with a monotonic `generation`. On `WEBVIEW_READY` the host sends one snapshot, replacing the fan-out of `sendStreamMetadata` + per-active-stream `syncStreamContent` + `replayPendingPrompts`.
- **Ordered deltas after the snapshot.** Each delta carries `{ baseGeneration, generation, patch }`; on mismatch the renderer requests a fresh snapshot. This is the replicated-store generalization of the cursor handshake `WebviewBridge` already runs for logs, extended to record fields.
- **Active-stream content bound preserved.** The store streams full content only for the active stream (today's `sendIfActive`); this stays as a deliberate bandwidth-and-memory policy, because non-active streams are evicted to disk. A switch re-derives the active slice from the next snapshot/delta.
- **Two hydration sources, sharply split.** Durable tier (`StreamLogStore` + `StreamSnapshotStore`) is the cold-launch source (`backend.load()`, `ProgressBackend.ts:112-114`, currently unused on desktop) and replaces desktop's `streams.json` ghost rail. Ephemeral tier (counters, hints, pending approvals, status) is the renderer-reconnect source and must be in the reconnect snapshot, so live approval prompts survive a renderer reload uniformly across hosts.

## Scope

**In:**

- Add `subscribe` / `getSnapshot` / `select` plus `ProgressViewProjection` and a `ProgressViewDelta` patch type to `ProgressViewState`; split per-field projection out of `ProgressEventHandler` (keep eviction, throttle, async persistence, permission-gated switch as explicit orchestration).
- Fold status, pending approvals, and ephemeral counters into the projection; delete `replayPendingPrompts`, the two-writer `permissions$`, and `resolvedProposalIds`.
- Unify backend `ProgressViewState` and frontend `ProgressState` shapes; replace `dispatchMessage` plus the ten slices with one `applySnapshot`/`applyDelta` in a shared Lit `ReactiveController` (extension and desktop renderer together).
- Move the four module-level render stores (`copyContentStore`, `proposalInputStore`, `resolvedProposalIds`, `pendingDescriptions`) onto the entry DTO at ingestion (Pattern 7).
- Delete the desktop double-dispatch (`desktopAgentExecution.ts:745-751`), the ghost reduction, and the `streams.json` ghost store; desktop calls `backend.load()`.

**Out (explicitly):**

- The desktop inline delete / delete-all / `pendingPermissionStreams` deletions belong to **Sub-PRD 01**, not here. 07 does not double-count them.
- `ProgressEventHandler` is NOT promised to become "pure." Re-scope to extracting the projection push; the orchestration stays.
- `handlePermissionAction` does NOT collapse. Only the optimistic settle and out-of-order guard delete (~20 lines); the yolo decomposition, the `ENABLE_*_BYPASS`-before-approve FIFO ordering, and provider derivation are legitimate commands-out and stay.
- The frontend-bound ignorable tier (`requestOpenFile`, `requestShowError`, `requestEnsureProgressView`, `*SubscriptionsChanged`, `toolAvailabilityChanged`; `AgentRuntimeHost.ts:19-23`, `ProgressEventBus.ts:231-271`) is fire-and-forget host commands with no projectable state and must NOT route through the replicated store.
- **CLI convergence is a stretch goal, not a core slice.** `ProgressBackend` welds the store to `postMessage`-shaped `WebviewUpdater`/`WebviewBridge` (`ProgressBackend.ts:85-92`); only pursue "CLI subscribes the shared store" if the store-plus-reducer is cleanly extractable from that transport. Otherwise leave the CLI fork: it has no IPC boundary, is the closest to pure already, and forcing it onto the backend is the one move most likely to be churn over win.

## Migration

Incremental, each PR independently mergeable and subtractive. Drift-bug fixes (`00-overview.md:64-78`) and Sub-PRD 01 land first.

**Phase A: every host becomes a subscriber of the one store (kill the forks).**

1. Add store reactivity: `subscribe` / `getSnapshot` / `select` + the projection and delta types; split projection out of `ProgressEventHandler`. No renderer change yet (keep `WebviewUpdater` as a temporary delta subscriber).
2. Fold status, pending approvals, and ephemeral counters into the projection; delete `replayPendingPrompts`, two-writer `permissions$`, `resolvedProposalIds`. This is the best ROI and fixes the real parity bug (desktop drops live prompts on renderer reload).
3. **Desktop-as-subscriber:** once the store has a cold-launch snapshot, delete `desktopProgressEventBridge`, the double-dispatch, and the `streams.json` ghost store; desktop calls `backend.load()`. (Desktop delete/permission seams come from Sub-PRD 01.)

**Phase B: pure-derive views (kill the optimistic handlers).** 4. Replace `dispatchMessage` plus ten slices with the shared Lit `ReactiveController` `applyDelta`/`applySnapshot` (extension and desktop renderer, which already share the reducer). Move the four render-time stores onto the entry DTO. 5. Emit-only intent: strip the optimistic settle and out-of-order guard from `eventHandlers.ts`; keep active-stream selection as local view state; keep the permission command dispatch. 6. **Stretch:** if the store-plus-reducer extracts cleanly, make `cliState` a signal projection of the shared snapshot/deltas and delete `applyToState`; else leave the CLI as-is.

## Acceptance

- Exactly one reducer over `ProgressEventPayloads`; the desktop fork, double-dispatch, and `streams.json` ghost store are gone.
- `appState` and the desktop renderer absorb the same `ProgressViewProjection` through one `applyDelta`/`applySnapshot`; the frontend ten slices are deleted.
- A renderer reload preserves live approval prompts on the extension and desktop (the snapshot carries pending approvals); `replayPendingPrompts` is gone.
- No renderer file references `Date.now()`, synthetic ids, or render-time dedup (Pattern 7); the four module-level render stores are gone.
- No inbound handler mutates the local store ahead of the echo, except active-stream selection (documented local view state).
- Headless `--print` / `--output-format json|ndjson` output is byte-identical; the store reduces with zero subscribers and arms no projection timer.

## Risk

- **Medium-high, concentrated in the delta patch type.** The record-store patch protocol does not exist today and `WebviewBridge` demonstrates only the log-cursor half. Ship the generation-versioned `ProgressViewDelta` and the backend/frontend shape unification first; do not assume the message vocabulary deletes for free.
- **`ProgressEventHandler` split is bigger than a rename.** Eviction, throttle, async persistence, and permission-gated switching must move to named orchestration, not vanish. Phase-A step 1 is the riskiest slice; gate it on the invariant that headless reduction is unchanged.
- **Do not flatten genuine affordances.** Lit + WebAwesome rail, Ink `<Static>` scrollback ownership and finalize-settled-prefix, and the Electron single-window route are per-host presentation and stay. Only the framework-agnostic store and its selectors are shared.
- **Do not force the CLI.** Treat convergence as a stretch goal contingent on clean extraction; the CLI fork is the cheapest reduction to leave intact.

## Relation to Sub-PRD 01

01 makes desktop adopt the shared `ProgressStreamLifecycleController` and the shared pending-permission tracking, deleting the desktop inline delete/delete-all and the `pendingPermissionStreams` mirror. 07 views the same desktop fork from the store side and deletes the remaining reduction (the `desktopProgressEventBridge`, the double-dispatch, the `streams.json` ghost store). 07 therefore **depends on 01** for the lifecycle and permission seams and **does not re-claim** those deletions. Where 01 lands the orchestration owner, 07 lands the projection owner; together they leave desktop as a pure subscriber of one store rather than a second design.
