import { SubscriptionRef } from 'effect';

import type { DeleteStreamResult } from '@agent/storage';
import type { StreamPhaseState } from '@agent/runtime/StreamStatusService';
import type { SessionRendererPort } from '@controllers/session/SessionRendererPort';
import {
  SessionState,
  type StreamExecutionState,
} from '@controllers/session/SessionState';
import { withEventErrorHandling } from '@controllers/session/eventErrorHandling';
import {
  STREAM_PHASE,
  type SessionEvent,
  type SetParentStreamPayload,
  type StreamPhase,
  type StreamStage,
  type StreamSubstate,
  type StreamTabId,
  type UpdateConversationProgressPayload,
  type UpdateStreamDescriptionPayload,
  AgentCategory,
} from '@shared/schemas';
import { roundedUtilizationPercent } from '@shared/streams/contextUtilization';
import { streamStageFromStageStart } from '@shared/streams/stage';
import {
  isActivePhase,
  isTerminalOutcomePhase,
} from '@shared/streams/streamStatus';
import { assertNever } from '@utils/core';

/**
 * Memory bound on retained finished children, per stream per kind. A long
 * session can finish thousands; the oldest `finishedAt` is evicted first and
 * live entries are never evicted. Mirrors `RESOLVED_PROPOSAL_IDS_CAP`.
 */
const RETAINED_FINISHED_CHILDREN_CAP = 200;

/** A provisional removal barrier and the facts its async delete deferred. */
interface PendingDeletion {
  readonly facts: SessionEvent[];
}

type SessionFactApplierOptions = {
  /**
   * Host durable-delete for a removed stream. The resolved outcome decides
   * the removal barrier's fate: `active`/`failed` mean the stream was
   * retained — still alive — so the applier retires the barrier and its
   * facts flow again; `deleted` (or a host that reports nothing) keeps it.
   *
   * A host that rebuilds retained presentation state must invoke
   * `beforeRetainedRepair` with its `active`/`failed` outcome before that
   * rebuild enumerates selectable streams. The callback retires the
   * provisional removal barrier and replays buffered facts; rebuilding first
   * would omit the still-live stream because selectable projections hide
   * provisional removals. Hosts without a selectable-stream repair path may
   * ignore the optional hook; a retained `active`/`failed` outcome still
   * retires the barrier through normal promise settlement.
   */
  deleteStream: (
    stream: StreamTabId,
    beforeRetainedRepair?: (outcome: 'active' | 'failed') => void,
  ) =>
    | void
    | DeleteStreamResult
    | undefined
    | Promise<void | DeleteStreamResult | undefined>;
  /**
   * Whether the host is presenting `stream` right now (focused, selected, or
   * open in a reader). A presented stream keeps its sidecar record resident
   * for the reads the presentation makes synchronously; every other finished
   * child releases it at its terminal status. A host that never presents
   * finished children may omit this.
   */
  isStreamPresented?: (stream: StreamTabId) => boolean;
};

/**
 * Every stream identity an event names, in one place: the removal tombstone
 * guards all of them, so an identity extracted anywhere else would be a fact
 * the tombstone does not own. An event's aggregate is its stream, except an
 * inquiry thread's, whose stream is the parent edge on its payload (5.1).
 * `stream.removed` is listed for completeness but is never refused: it is
 * the tombstone writer.
 */
function eventStreamIds(event: SessionEvent): StreamTabId[] {
  switch (event.type) {
    case 'inquiryThreadUpdated':
      return event.parentStreamId ? [event.parentStreamId] : [];
    case 'setParentStream':
      return event.parentStreamId
        ? [event.aggregateId, event.parentStreamId]
        : [event.aggregateId];
    default:
      return [event.aggregateId];
  }
}

/**
 * Host-neutral session fact applier: mutates {@link SessionState} and notifies
 * a {@link SessionRendererPort}. Push policy (active-only, debounce, bridge)
 * lives in the host renderer. It consumes the session's event plane
 * (`events.all`, PRD one-fold-three-renderers 7.1): every arm the view folds,
 * applied here to the canonical stores and the renderer's invalidation hints
 * until the extension and desktop renderers read the view (lane 4).
 *
 * Attachment and focus are separate operations. This applier registers
 * session facts; a host presentation decides whether an attachment should
 * become its focused stream. Do not use `streamLogs.has` as a proxy for
 * "host already has this tab" — the
 * transcript store outlives a renderer session (and can be warm from disk
 * before this host's in-memory tab map exists).
 */
export class SessionFactApplier {
  /** Streams this renderer has already received metadata for. Not reset when
   * a webview closes and reopens — `ProgressViewProvider.markWebviewReady`'s
   * resolve-time full metadata resync (`syncFullView`) re-registers every
   * stream with the reopened view, so a stale "already delivered" entry here
   * cannot starve it. */
  private readonly registeredWithRenderer = new Set<StreamTabId>();

  /**
   * Provisional removal barriers by stream: the facts arriving while each
   * delete was still in flight. A removal is final (decision 9), so one
   * barrier per stream is ever installed.
   */
  private readonly pendingDeletions = new Map<StreamTabId, PendingDeletion>();

  constructor(
    private readonly state: SessionState,
    private readonly renderer: SessionRendererPort,
    private readonly options: SessionFactApplierOptions,
  ) {}

  private handleRunningTransition(
    streamId: StreamTabId,
  ): AgentCategory | undefined {
    const provisionalCategory = this.getStreamCategory(streamId);
    this.state.resetStreamMetadataForRun(streamId);
    const knownCategory =
      this.getStreamCategory(streamId) ?? provisionalCategory;
    // Absent is pending, never Workflow: the state is created once the run's
    // config resolves a real category (run.config lands before RUNNING on
    // live paths, and the snapshot seed supplies it on rehydration).
    if (knownCategory) {
      // The reset above just cleared the ephemeral metadata this category
      // came from (provisionally, before the reset). Write it back so
      // `getStreamMetadata(...).agentCategory` (what renderers read) doesn't
      // silently regress to undefined until an unrelated later fact
      // (`run.config`) happens to refill it — `getOrCreateStreamState` below
      // already commits the same resolved category to the execution-state
      // side, and metadata must not drift from it.
      this.state.updateStreamMetadata(streamId, {
        agentCategory: knownCategory,
      });
      this.state.getOrCreateStreamState(streamId, knownCategory);
    }
    this.state.resetPerRunChildState(streamId);
    this.renderer.clearPendingConversationProgress(streamId);
    return knownCategory;
  }

  /** Drop buffered renderer work; called by host dispose. */
  dispose(): void {
    this.registeredWithRenderer.clear();
    this.renderer.dispose();
  }

  /** Push metadata and mark the stream as registered with this renderer. */
  private pushStreamMetadata(
    streamId: StreamTabId,
    options?: {
      phaseOverride?: StreamPhaseState;
    },
  ): void {
    this.registeredWithRenderer.add(streamId);
    this.renderer.onStreamMetadataChanged(streamId, options);
  }

  /**
   * Apply one session event. Returns whether it was admitted: an event
   * naming a removed stream is stale and refused (removal is final), and
   * callers that react to an event beyond state application, presentation
   * activation, leases, must not react to a refused one. A refused event
   * whose stream has a provisional barrier (delete still in flight) is
   * buffered so a retained deletion can replay it; a committed tombstone has
   * no pending barrier, so the event is simply stale and dropped.
   */
  apply(event: SessionEvent): boolean {
    if (
      event.type !== 'stream.removed' &&
      eventStreamIds(event).some((streamId) =>
        this.state.isStreamRemoved(streamId),
      )
    ) {
      this.defer(event);
      return false;
    }
    // Wrap once, and RETURN each case so async handlers' promises reach
    // `withEventErrorHandling` (a discarded promise would let a post-await
    // rejection escape its thenable check as an unhandled rejection).
    withEventErrorHandling(
      'SessionFacts',
      `failed to handle ${event.type} fact`,
      () => this.applyAdmitted(event),
    );
    return true;
  }

  /** The single application body for an admitted event. Replay of buffered
   *  events must NOT call this directly: it re-runs the admission path
   *  (`apply`) so every identity a multi-stream event names is revalidated
   *  against the tombstone set. */
  private applyAdmitted(event: SessionEvent): void | Promise<void> {
    const streamId = event.aggregateId;
    switch (event.type) {
      case 'goalStateChanged':
        return this.renderer.onGoalActiveChanged(
          streamId,
          event.state.active,
          event.state.active
            ? { status: event.state.status, objective: event.state.objective }
            : {},
        );
      case 'inquiryThreadUpdated': {
        const {
          type: _type,
          aggregateId: _aggregateId,
          seq: _seq,
          commit: _commit,
          ownerId: _ownerId,
          at: _at,
          ...thread
        } = event;
        return this.renderer.onInquiryThreadUpdated(thread);
      }
      case 'updateQueuedFollowUps':
        return this.renderer.invalidate(streamId, 'queuedFollowUps');
      case 'updateStreamDescription':
        return this.handleUpdateStreamDescription({
          streamId,
          description: event.description,
        });
      case 'status':
        return this.setStreamStatus(
          streamId,
          event.phase,
          event.previousPhase ?? undefined,
          event.substate ?? undefined,
          event.runStartedAt ?? undefined,
        );
      case 'setParentStream':
        return this.handleSetParentStream({
          childStreamId: streamId,
          parentStreamId: event.parentStreamId,
        });
      case 'stream.removed':
        return this.handleStreamRemoved(streamId);
      case 'usage':
        // Latest gauge value is the event payload. The snapshot store may
        // accumulate per-key; hosts read cumulative totals from the store.
        return this.renderer.onRunUsageChanged(
          streamId,
          event.storageKey,
          event.usage,
        );
      case 'context.state':
        // The handler that produced the response is the only authority on the
        // window it actually used (subscription caps and compaction both move
        // it), so the substrate stores its number verbatim and every host reads
        // this one record instead of re-deriving from a model registry.
        this.state.updateStreamState(streamId, (prev) => ({
          ...prev,
          contextState: {
            inputTokens: event.inputTokens,
            contextWindow: event.contextWindow,
            utilizationPercent: roundedUtilizationPercent(
              event.inputTokens,
              event.contextWindow,
            ),
          },
        }));
        return this.renderer.invalidate(streamId, 'contextState');
      case 'run.start':
        return this.handleRunStart(streamId, event.category, event.isRemote);
      // Activation is a fold and wire fact; canonical state has nothing to
      // learn from it that `run.start` and the status rail do not carry.
      case 'run.activate':
        return;
      case 'run.config':
        return this.handleRunConfig(streamId);
      // Approval facts are the fold's; canonical state learns approvals from
      // the host port. The transcript tier is the store's own.
      case 'approval.requested':
      case 'approval.resolved':
      case 'approval.policy':
      case 'transcript.entry':
        return;
      // The lifecycle's last word is when the view's `durableOutcome` settles
      // for a run this process owns (a user stop published its terminal phase
      // earlier), and the wire's `statusDurablyFinal` travels with metadata.
      case 'result':
        return this.pushStreamMetadata(streamId);
      case 'updateTodos':
        return this.renderer.onTodosChanged(streamId, event.todos);
      case 'updatePlan':
        return this.renderer.onPlanChanged(streamId, event.plan);
      case 'addOutputFiles':
        return this.renderer.invalidate(streamId, 'files');
      case 'updateMissingOutputs':
        return this.renderer.invalidate(streamId, 'missingOutputs');
      case 'updateCompileFailures':
        return this.renderer.invalidate(streamId, 'compileFailures');
      case 'goalPaused':
        return this.renderer.invalidate(streamId, 'goalPaused');
      case 'conversation.progress':
        return this.handleUpdateConversationProgress({
          streamId,
          progress: event.progress,
        });
      case 'stage.start': {
        const stage = streamStageFromStageStart({
          label: event.label,
          ...(event.kind == null ? {} : { kind: event.kind }),
          ...(event.index == null ? {} : { index: event.index }),
          ...(event.total == null ? {} : { total: event.total }),
        });
        if (stage) return this.handleUpdateStage(streamId, stage);
        return;
      }
    }
    assertNever(event, 'Unhandled session event');
  }

  /**
   * Provisional barrier: facts racing the host delete are refused now, but
   * the barrier becomes permanent only when the deletion actually commits. A
   * retained/live/failed outcome retires the barrier so a still-live stream
   * is not frozen. The host delete option must surface that outcome even
   * when presentation repair fails; any other rejection leaves the barrier in
   * place and is logged by the event-error wrapper, because the stream may
   * have deleted.
   */
  private handleStreamRemoved(streamId: StreamTabId): Promise<void> {
    const { changedRosterParents } = this.state.beginStreamRemoval(streamId);
    this.registeredWithRenderer.delete(streamId);
    const { pending, created } = this.beginPendingDeletion(streamId);
    // Establish tombstone and pending-fact ownership first. Renderer
    // delivery is best-effort and cannot prevent durable deletion.
    this.notifyRosterParents(changedRosterParents);
    let settled = false;
    const settleDeletion = (
      outcome: void | DeleteStreamResult | undefined,
    ): void => {
      // A prior `stream.removed` owns this deletion's settlement (the store
      // dedups its delete promise); only the owning barrier retires the
      // tombstone and replays.
      if (!created || settled) return;
      settled = true;
      // A host that reports nothing keeps the tombstone: the outcome is
      // unknown, so settle as if the deletion committed.
      this.settleRemoval(streamId, pending, outcome ?? 'deleted');
    };
    return Promise.resolve(
      this.options.deleteStream(streamId, settleDeletion),
    ).then(
      (outcome) => {
        settleDeletion(outcome);
      },
      (error) => {
        // Ambiguous failure: keep the barrier (the stream may have deleted),
        // but drop the provisional buffer: there is no outcome to replay
        // against. The error still propagates to the event-error wrapper.
        if (created && !settled) {
          this.finishPendingDeletion(streamId, pending);
        }
        throw error;
      },
    );
  }

  /**
   * Open (or reuse) the provisional buffer for `streamId`. A second
   * `removeStream` for the same stream reuses the existing buffer and does
   * not re-own the deletion settlement.
   */
  private beginPendingDeletion(streamId: StreamTabId): {
    readonly pending: PendingDeletion;
    readonly created: boolean;
  } {
    const existing = this.pendingDeletions.get(streamId);
    if (existing) return { pending: existing, created: false };
    const pending: PendingDeletion = { facts: [] };
    this.pendingDeletions.set(streamId, pending);
    return { pending, created: true };
  }

  private finishPendingDeletion(
    streamId: StreamTabId,
    pending: PendingDeletion,
  ): void {
    if (this.pendingDeletions.get(streamId) === pending) {
      this.pendingDeletions.delete(streamId);
    }
  }

  /**
   * Buffer a refused event into the most recent provisional barrier it
   * names. Events naming only committed tombstones (no pending barrier) are
   * stale and dropped.
   */
  private defer(event: SessionEvent): void {
    for (const streamId of eventStreamIds(event)) {
      const pending = this.pendingDeletions.get(streamId);
      if (pending) {
        pending.facts.push(event);
        return;
      }
    }
  }

  /**
   * Reapply buffered events in arrival order after a retained deletion. Goes
   * back through the public admission path rather than the raw apply body,
   * so a multi-stream event (e.g. `setParentStream`) is revalidated against
   * every identity it names: if another identity is still removed, the
   * replayed event is refused (and re-buffered/dropped) instead of being
   * applied through a stale barrier.
   */
  private replayDeferredFacts(facts: readonly SessionEvent[]): void {
    for (const deferred of facts) this.apply(deferred);
  }

  /**
   * The shared settlement machine for a removal barrier, fact- or
   * command-owned: drop the pending buffer, retire the tombstone when the
   * outcome kept the stream (`active`/`failed`/`superseded`), commit it
   * otherwise, and notify roster parents once for whichever applied.
   */
  private settleRemoval(
    streamId: StreamTabId,
    pending: PendingDeletion | undefined,
    outcome: DeleteStreamResult,
  ): void {
    if (pending) {
      this.finishPendingDeletion(streamId, pending);
    }
    const retained = outcome === 'active' || outcome === 'failed';
    const retirement =
      retained || outcome === 'superseded'
        ? this.state.retireStreamTombstone(streamId)
        : { retired: false, changedRosterParents: [] };
    const commitment =
      !retained && outcome !== 'superseded'
        ? this.state.commitStreamTombstone(streamId)
        : { committed: false, changedRosterParents: [] };
    this.notifyRosterParents([
      ...retirement.changedRosterParents,
      ...commitment.changedRosterParents,
    ]);
    // A retained deletion still lives: replay the facts buffered while it was
    // provisional so status/stage/roster/metadata are not stuck stale. A
    // committed deletion discards them (the stream is gone).
    if (retained && retirement.retired && pending) {
      this.replayDeferredFacts(pending.facts);
    }
  }

  /**
   * Begin a command-owned removal barrier and pending buffer, so facts racing
   * a host command deletion are buffered exactly as they are for a
   * `removeStream` fact. Returns `created === false` when a fact-path barrier
   * already owns the identity; the caller must then skip the deletion and
   * leave that barrier untouched.
   */
  beginCommandRemoval(streamId: StreamTabId): { created: boolean } {
    const { created, changedRosterParents } =
      this.state.beginStreamRemoval(streamId);
    this.registeredWithRenderer.delete(streamId);
    if (created) this.beginPendingDeletion(streamId);
    this.notifyRosterParents(changedRosterParents);
    return { created };
  }

  /**
   * Complete a command-owned removal once its host delete resolves. A retained
   * (`active`/`failed`) outcome retires the barrier and replays buffered facts;
   * a committed outcome discards the buffer; anything the command path reports
   * as `undefined` (reserved id, or the data directory cannot be used) retires
   * the barrier because nothing was deleted.
   */
  completeCommandRemoval(
    streamId: StreamTabId,
    outcome: DeleteStreamResult | undefined,
    created: boolean,
  ): void {
    if (!created) return;
    // An unreported command outcome means nothing was deleted, so the barrier
    // retires exactly as a retained deletion does.
    this.settleRemoval(
      streamId,
      this.pendingDeletions.get(streamId),
      outcome ?? 'active',
    );
  }

  /**
   * Drop a command-owned buffer on an ambiguous failure: keep the barrier (the
   * stream may have deleted) but discard the buffered facts, exactly as the
   * fact path does on a rejected host delete.
   */
  abortCommandRemoval(streamId: StreamTabId, created: boolean): void {
    if (!created) return;
    const pending = this.pendingDeletions.get(streamId);
    if (pending) this.finishPendingDeletion(streamId, pending);
  }

  private handleUpdateStreamDescription({
    streamId,
    description,
  }: UpdateStreamDescriptionPayload): void {
    this.state.setStreamDescription(streamId, description);
    this.renderer.onStreamDescriptionChanged(streamId, description);
    // Description generation outlives the run it describes, and writing one
    // makes a released record resident again. The value reaches disk and the
    // summary mirror either way, so this is another moment the rule can turn
    // true — not a second rule.
    this.retireSidecarIfFinishedChild(streamId);
  }

  private handleSetParentStream({
    childStreamId,
    parentStreamId,
  }: SetParentStreamPayload): void {
    this.state.setStreamParent(childStreamId, parentStreamId);
    // Topology hosts (TUI) and Lit both learn the edge here — the new value is
    // already on `SessionState` metadata, so the notification only names the
    // slice. Lit projects it onto `StreamTabInfo.parentStreamId` inside its
    // renderer; do not also fire `onStreamMetadataChanged` — that mints a
    // StreamSlice on signal hosts before attachment.
    this.renderer.invalidate(childStreamId, 'parentStreamId');
  }

  /**
   * The existence fact: the stream's transcript and execution state exist
   * from here, and the launch facts it carries (category, remoteness) land
   * on canonical metadata. Focus is not part of it; a host selects the
   * stream from its own launch callback.
   */
  private handleRunStart(
    streamId: StreamTabId,
    category: AgentCategory,
    isRemote: boolean,
  ): void {
    this.state.streamLogs.ensureStream(streamId);
    this.state.updateStreamMetadata(streamId, {
      agentCategory: category,
      isRemote,
    });
    this.state.getOrCreateStreamState(streamId, category);
    this.handleRunConfig(streamId);
  }

  private handleRunConfig(streamId: StreamTabId): void {
    // No explicit refresh: `getStreamMetadata` overlays the summary mirror —
    // already updated synchronously by the snapshot store's projection of
    // this same fact — at read time (#9947).
    if (this.renderer.isAvailable()) {
      // A run start or config change may update agent name, model, or label,
      // which the frontend tabs display even for background subagents. Patch
      // only the affected stream instead of rebuilding all historical tabs.
      this.pushStreamMetadata(streamId);
    }
  }

  private handleUpdateConversationProgress(
    data: UpdateConversationProgressPayload,
  ): void {
    const { streamId, progress } = data;

    // Always update state immediately so full metadata rebuilds include
    // the latest values when structural refreshes happen.
    this.state.updateStreamState(streamId, (prev) => ({
      ...prev,
      conversationProgress: progress,
    }));

    this.renderer.onConversationProgressChanged(streamId, progress);
  }

  private handleUpdateStage(streamId: StreamTabId, stage: StreamStage): void {
    this.state.updateStreamState(streamId, (prev) => ({ ...prev, stage }));
    this.renderer.onStageChanged(streamId, stage);
  }

  /**
   * Replace a parent stream's live child roster, retaining every non-process
   * child that just left it instead of folding it into a counter — a finished
   * subagent keeps its executionId, identity, status, and handle-generation
   * startedAt so hosts can list it and close that window with `finishedAt`.
   * Process children (background bash) are
   * ephemeral and are never retained. A retained row is only ever created from
   * an entry that was already in OUR roster and is absent from `next`, so a
   * first roster can never mark anything finished.
   *
   * `next` decides roster membership and identity only. A row we already track
   * keeps the phase `recordChildPhase` wrote, so the status-machine fact stays
   * the sole writer of `status` and a roster stamped before a later transition
   * cannot regress a resolved row. A row entering the roster (first sighting,
   * or a retained child going live again) has no recorded phase to keep, so it
   * takes the one stamped at emission.
   */
  applyChildRoster(
    parentStreamId: StreamTabId,
    next: StreamExecutionState['subagents'],
  ): void {
    // Roster facts can arrive before RUNNING/config creates the parent state
    // (TUI child-event-order `roster-first`). Provision a ToolUse bucket so
    // retention still runs; a later run.config refreshes the real category.
    const category =
      this.getStreamCategory(parentStreamId) ?? AgentCategory.ToolUse;
    this.state.getOrCreateStreamState(parentStreamId, category);

    this.state.updateStreamState(parentStreamId, (prev) => {
      const previous = prev.subagents;
      const liveBefore = previous.filter(
        (child) => child.finishedAt === undefined,
      );
      const recordedPhases = new Map(
        liveBefore.map((child) => [child.executionId, child.status]),
      );
      const live = next.map((child) => {
        const recorded = recordedPhases.get(child.executionId);
        return recorded === undefined || recorded === child.status
          ? child
          : { ...child, status: recorded };
      });
      const finishedAt = Date.now();
      const nextIds = new Set(next.map((child) => child.executionId));
      // Previously-retained rows first (already in ascending `finishedAt`
      // order), then the newly-vanished ones — so the list stays chronological
      // by construction and the cap evicts the oldest without a sort. A child
      // that reappears in `next` is live again, so drop its retained copy.
      // Process children (background bash) are ephemeral: autoClose removes
      // their stream tab, and retaining them only clutters Background Tasks.
      const retainable = (child: (typeof previous)[number]): boolean =>
        child.identity?.kind !== 'process';
      const retained = [
        ...previous.filter(
          (child) =>
            child.finishedAt !== undefined &&
            !nextIds.has(child.executionId) &&
            retainable(child),
        ),
        ...previous
          .filter(
            (child) =>
              child.finishedAt === undefined &&
              !nextIds.has(child.executionId) &&
              retainable(child),
          )
          .map((child) => ({ ...child, finishedAt })),
      ].slice(-RETAINED_FINISHED_CHILDREN_CAP);
      return { ...prev, subagents: [...live, ...retained] };
    });

    this.renderer.invalidate(parentStreamId, 'subagents');
  }

  /**
   * A child stream nobody is presenting and no live run in this process owns
   * releases its sidecar record as well as its transcript. Children are what
   * a long session accumulates; a root stream stays resident for the host's
   * history views. The store re-seeds on the next `preload`, which every
   * presentation path performs before reading, and warns on a synchronous
   * read that skipped it.
   *
   * The single owner of that rule, so every moment it can become true — the
   * run ends while nothing presents it, a host stops presenting a stream no
   * run owns, and an activation abandons a record it warmed — asks the same
   * question. The rule is re-read after the store's drain: a relaunch or a
   * fresh presentation during it keeps the record.
   */
  retireSidecarIfFinishedChild(streamId: StreamTabId): void {
    if (!this.isRetiredSidecarCandidate(streamId)) return;
    withEventErrorHandling(
      'SessionFacts',
      `failed to release the sidecar record of finished stream ${streamId}`,
      () =>
        this.state.snapshots.requestEviction(streamId, () =>
          this.isRetiredSidecarCandidate(streamId),
        ),
    );
  }

  private isRetiredSidecarCandidate(streamId: StreamTabId): boolean {
    // The view's rule, not the status machine: a child restored from disk has
    // no live phase, so keying off the machine kept every hydrated finished
    // child resident forever. A record is released once the stream's outcome
    // is one nothing can move (`durableOutcome`) and the stream is a child
    // nobody presents. A stream the view does not hold is not known to be
    // finished, and stays.
    const stream = SubscriptionRef.getUnsafe(this.state.view).streams.get(
      streamId,
    );
    if (!stream || stream.durableOutcome === null) return false;
    if (stream.parentId === null) return false;
    return this.options.isStreamPresented?.(streamId) !== true;
  }

  private notifyRosterParents(parents: readonly StreamTabId[]): void {
    withEventErrorHandling(
      'SessionFacts',
      'failed to notify roster changes',
      () => {
        if (!this.renderer.isAvailable()) return;
        for (const parent of parents) {
          // Read only to decide whether the parent still exists — a stream
          // with no state has nothing for a host to re-read.
          if (!this.state.getStreamState(parent)) continue;
          withEventErrorHandling(
            'SessionFacts',
            `failed to notify roster changes for ${parent}`,
            () => this.renderer.invalidate(parent, 'subagents'),
          );
        }
      },
    );
  }

  /**
   * Apply a stream status transition into session state and notify the
   * renderer. Awaitable so callers that need rehydrate to finish (tests,
   * and any host that cannot fire-and-forget) can wait; the plane's `status`
   * fact reaches it through {@link apply}.
   */
  async setStreamStatus(
    streamId: StreamTabId,
    status: StreamPhase,
    previousPhase?: StreamPhase,
    substate?: StreamSubstate,
    runStartedAt?: number,
  ): Promise<void> {
    // A status for a removed stream is stale: removal is final, so the
    // transition must not re-mint the transcript or execution state the
    // removal dropped. Public entry (hosts also reach this method directly),
    // so the refusal lives here and not only in `handleSessionFact`.
    if (this.state.isStreamRemoved(streamId)) return;
    // Land the status-machine phase in the parent rosters before this handler
    // can suspend, so rows are written in fact order and a slow active-phase
    // rehydrate can never overwrite a later phase.
    //
    // This pre-await write is deliberately residual: a removal landing during
    // the rehydrate await below hides the child through the shared roster
    // projection, and a committed deletion later scrubs its canonical rows.
    const rosterParents = this.state.recordChildPhase(streamId, status);

    // Active phases keep the full log resident for runtime writes. Terminal
    // lifecycle requests release unconditionally; exact presentation and
    // writer leases decide whether the store can satisfy it yet.
    if (isActivePhase(status)) {
      const requiresPersistentRehydrate =
        this.state.streamLogs.mode.kind === 'persistent' &&
        this.state.streamLogs.has(streamId) &&
        !this.state.streamLogs.get(streamId);
      if (requiresPersistentRehydrate) {
        await this.state.streamLogs.ensureLoaded(streamId);
      }
    }
    // The rehydrate await is an interleaving window: a removal that landed
    // during it makes every mutation below — eviction, run-state minting,
    // renderer notification — stale. Revalidate before any of them.
    if (this.state.isStreamRemoved(streamId)) return;

    // Settlement watermark for status-time compaction finalization. Read after
    // any active-phase rehydrate and before inactive unfocused eviction —
    // summaries keep timestamps across release, but not the resident log head.
    const logHead = this.state.streamLogs.get(streamId)?.head ?? 0;
    if (!isActivePhase(status)) {
      this.state.streamLogs.requestEviction(streamId);
      this.retireSidecarIfFinishedChild(streamId);
    }

    const isNewRunningTransition =
      status === STREAM_PHASE.RUNNING && previousPhase !== status;
    const runningCategory = isNewRunningTransition
      ? this.handleRunningTransition(streamId)
      : undefined;

    if (!this.renderer.isAvailable()) return;

    // Push the rows just written whenever the parent holding them is on screen.
    this.notifyRosterParents(rosterParents);

    const isNewStream = !this.state.streamLogs.has(streamId);
    this.state.streamLogs.ensureStream(streamId);
    // Persisted streams may be in stream logs but missing from _ephemeralState.
    // The first RUNNING transition already created/reset the state above.
    const category = runningCategory ?? this.getStreamCategory(streamId);
    if (!isNewRunningTransition && category !== undefined) {
      this.state.getOrCreateStreamState(streamId, category);
    }

    if (isNewStream || isNewRunningTransition) {
      // The status being applied has not necessarily reached the status
      // machine yet (hosts and tests also call this method directly), so it
      // travels with the push instead of being re-read.
      //
      // Unless a hold was recorded while this handler was suspended in the
      // rehydrate await above: this status is then the older fact, and its
      // override would paint a live phase over the read-only detail the
      // refusal wrote (an override suppresses `statusDetail`). Push without
      // it and let the renderer read the resolved phase, hold included.
      const held = this.state.streamStatus.holdState(streamId) !== undefined;
      this.pushStreamMetadata(
        streamId,
        held
          ? undefined
          : {
              phaseOverride: {
                phase: status,
                ...(substate ? { substate } : {}),
                ...(runStartedAt !== undefined ? { runStartedAt } : {}),
              },
            },
      );
    } else {
      const lastTimestamp =
        this.state.streamLogs.getTimestampRange(streamId).last;
      this.renderer.onStreamStatusChanged(
        streamId,
        status,
        logHead,
        lastTimestamp,
        substate,
      );
      // `UPDATE_STREAM_STATUS` carries the phase but not `statusDurablyFinal`,
      // and a terminal transition is exactly when that bit flips: an
      // in-process run reaches this transition after `finalizeRunTerminal`
      // untracked its execution, so nothing can move the outcome any more.
      // Without a metadata push the view keeps the stale `false` and paints an
      // unclosed group as running until an unrelated refresh. Pushed without a
      // phase override — the status machine wrote this phase before publishing
      // the fact, so the renderer resolves it (hold and detail included) and
      // the durability bit travels with it, which an override would suppress.
      // One push per terminal transition, not per status.
      if (isTerminalOutcomePhase(status)) this.pushStreamMetadata(streamId);
    }
  }

  private getStreamCategory(streamId: StreamTabId): AgentCategory | undefined {
    return this.state.getStreamMetadata(streamId).agentCategory;
  }
}
