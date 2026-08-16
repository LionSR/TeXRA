import type { DeleteStreamResult } from '@agent/storage';
import { RUN_FACT_EVENT_TYPES, type AgentEvent } from '@agent/trace';
import type { SessionFact } from '@agent/runtime/SessionEventHub';
import type { StreamPhaseState } from '@agent/runtime/StreamStatusService';
import type { SessionRendererPort } from '@controllers/session/SessionRendererPort';
import {
  SessionState,
  type StreamExecutionState,
} from '@controllers/session/SessionState';
import { withEventErrorHandling } from '@controllers/session/eventErrorHandling';
import {
  STREAM_PHASE,
  isGoalInFlight,
  type ConversationProgress,
  type SetActiveStreamPayload,
  type SetParentStreamPayload,
  type StreamPhase,
  type StreamStage,
  type StreamSubstate,
  type StreamTabId,
  type UpdateConversationProgressPayload,
  type UpdateStreamDescriptionPayload,
  AgentCategory,
} from '@shared/schemas';
import { diffActiveChildren } from '@shared/streams/childActivityReducer';
import { streamStageFromStageStart } from '@shared/streams/stage';
import { isActivePhase } from '@shared/streams/streamStatus';
import { GoalStore } from '@tools/goal';
import { assertNever } from '@utils/core';

/**
 * Memory bound on retained finished children, per stream per kind. A long
 * session can finish thousands; the oldest `finishedAt` is evicted first and
 * live entries are never evicted. Mirrors `RESOLVED_PROPOSAL_IDS_CAP`.
 */
const RETAINED_FINISHED_CHILDREN_CAP = 200;

type RunFactType = (typeof RUN_FACT_EVENT_TYPES)[number];

/** The run-fact vocabulary `RUN_FACT_EVENT_TYPES` subscriptions deliver. */
export type SessionRunFactEvent = Extract<AgentEvent, { type: RunFactType }>;

type RunFactHandlers = {
  [K in RunFactType]: (
    streamId: StreamTabId,
    event: Extract<AgentEvent, { type: K }>,
  ) => void | Promise<void>;
};

export type SessionFactApplierOptions = {
  /**
   * Host durable-delete for a removed stream. The resolved outcome decides
   * the removal barrier's fate: `active`/`failed` mean the stream was
   * retained — still alive — so the applier retires the barrier and its
   * facts flow again; `deleted` (or a host that reports nothing) keeps it.
   */
  deleteStream: (
    stream: StreamTabId,
  ) =>
    | void
    | DeleteStreamResult
    | undefined
    | Promise<void | DeleteStreamResult | undefined>;
};

/**
 * Every stream identity a session fact names, in one place: the removal
 * tombstone guards all of them, so an identity extracted anywhere else would
 * be a fact the tombstone does not own. `removeStream` is listed for
 * completeness but is never refused — it is the tombstone writer.
 */
function sessionFactStreamIds(fact: SessionFact): StreamTabId[] {
  switch (fact.type) {
    case 'status':
      return [fact.streamId];
    case 'removeStream':
      return [fact.payload.streamId];
    case 'setParentStream':
      return fact.payload.parentStreamId
        ? [fact.payload.childStreamId, fact.payload.parentStreamId]
        : [fact.payload.childStreamId];
    case 'inquiryThreadUpdated':
      return fact.payload.parentStreamId ? [fact.payload.parentStreamId] : [];
    default:
      return fact.payload.streamId ? [fact.payload.streamId] : [];
  }
}

/**
 * Host-neutral session fact applier: mutates {@link SessionState} and notifies
 * a {@link SessionRendererPort}. Push policy (active-only, debounce, bridge)
 * lives in the host renderer.
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
   * Run-fact dispatch table (see `RUN_FACT_EVENT_TYPES`); keys stay exhaustive.
   * Handlers hold only their own logic and RETURN it — `handleRunFact` wraps
   * each dispatch in `withEventErrorHandling` once. Returning (rather than
   * discarding) the call keeps async handlers' promises flowing to the
   * wrapper, so a rejection after an await is still logged instead of
   * becoming an unhandled rejection.
   */
  private readonly runFactHandlers: RunFactHandlers = {
    usage: (_streamId, event) => {
      // Latest gauge value is the event payload. The snapshot store may
      // accumulate per-key; hosts read cumulative totals from the store.
      const { streamId, storageKey, usage } = event.payload;
      this.renderer.onRunUsageChanged(streamId, storageKey, usage);
    },
    'run.start': (_streamId, event) => this.handleRunConfig(event.streamId),
    'run.config': (_streamId, event) => this.handleRunConfig(event.streamId),
    updateTodos: (_streamId, event) =>
      this.renderer.onTodosChanged(event.streamId, event.todos),
    updatePlan: (_streamId, event) =>
      this.renderer.onPlanChanged(event.streamId, event.plan),
    addOutputFiles: (_streamId, event) =>
      this.renderer.onFilesChanged(event.streamId),
    updateMissingOutputs: (_streamId, event) =>
      this.renderer.onMissingOutputsChanged(event.streamId),
    updateCompileFailures: (_streamId, event) =>
      this.renderer.onCompileFailuresChanged(event.streamId),
    goalPaused: (_streamId, event) =>
      this.renderer.onGoalPaused(event.streamId),
    'conversation.progress': (streamId, event) =>
      this.handleUpdateConversationProgress({
        streamId,
        progress: event.progress,
      }),
    'stage.start': (streamId, event) => {
      const stage = streamStageFromStageStart(event);
      if (stage) return this.handleUpdateStage(streamId, stage);
    },
    'child.activity': (_streamId, event) =>
      this.updateChildRoster(event.parentStreamId, [...event.items]),
  };

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
      streamStates?: Map<StreamTabId, StreamPhaseState>;
    },
  ): void {
    this.registeredWithRenderer.add(streamId);
    this.renderer.onStreamMetadataChanged(streamId, options);
  }

  /**
   * Apply one session fact. Returns whether the fact was admitted: a fact
   * naming a removed stream is stale and refused (removal is final), and
   * callers that react to a fact beyond state application — presentation
   * activation, leases — must not react to a refused one.
   */
  handleSessionFact(fact: SessionFact): boolean {
    if (
      fact.type !== 'removeStream' &&
      sessionFactStreamIds(fact).some((streamId) =>
        this.state.isStreamRemoved(streamId),
      )
    ) {
      return false;
    }
    // Wrap once, and RETURN each case so async handlers' promises reach
    // `withEventErrorHandling` (a discarded promise would let a post-await
    // rejection escape its thenable check as an unhandled rejection).
    withEventErrorHandling(
      'SessionFacts',
      `failed to handle ${fact.type} fact`,
      () => {
        switch (fact.type) {
          case 'goalStateChanged':
            return this.handleGoalStateChanged(fact.payload.streamId);
          case 'inquiryThreadUpdated':
            return this.renderer.onInquiryThreadUpdated(fact.payload);
          case 'clearMissingOutputs':
            return this.renderer.onMissingOutputsChanged(
              fact.payload.streamId,
              { reset: true },
            );
          case 'updateQueuedFollowUps':
            return this.renderer.onQueuedFollowUpsChanged(
              fact.payload.streamId,
            );
          case 'followUpSent':
            // Refresh from the follow-ups store (same as updateQueuedFollowUps):
            // the send itself is not a payload, but the queue may have changed.
            return this.renderer.onQueuedFollowUpsChanged(
              fact.payload.streamId,
            );
          case 'setActiveStream':
            return this.handleSetActiveStream(fact.payload);
          case 'updateStreamDescription':
            return this.handleUpdateStreamDescription(fact.payload);
          case 'status':
            return this.setStreamStatus(
              fact.streamId,
              fact.phase,
              fact.previousPhase,
              fact.substate,
            );
          case 'setParentStream':
            return this.handleSetParentStream(fact.payload);
          case 'removeStream': {
            const { streamId } = fact.payload;
            // Provisional barrier: facts racing the host delete are refused
            // now, but the barrier becomes permanent only when the deletion
            // actually commits. A retained/live/failed outcome retires the
            // barrier so a still-live stream is not frozen for the rest of
            // the session. The host delete option must surface that outcome
            // even when presentation repair fails; any other rejection leaves
            // the barrier in place and is logged by the event-error wrapper,
            // because the stream may have deleted.
            this.state.markStreamRemoved(streamId);
            this.registeredWithRenderer.delete(streamId);
            return Promise.resolve(this.options.deleteStream(streamId)).then(
              (outcome) => {
                if (outcome === 'active' || outcome === 'failed') {
                  this.state.retireStreamTombstone(streamId);
                }
              },
            );
          }
        }
        assertNever(fact, 'Unhandled session fact');
      },
    );
    return true;
  }

  handleRunFact(streamId: StreamTabId, event: SessionRunFactEvent): void {
    // `run.start` is the canonical claim on a stream identity. A deterministic
    // stream id (a WorkflowScriptTool relaunch reuses `workflow#<executionId>`)
    // legitimately re-claims a tombstoned id by starting a fresh run, so retire
    // the tombstone before the shared gate below refuses the run's own facts.
    if (event.type === 'run.start' && this.state.isStreamRemoved(streamId)) {
      this.state.retireStreamTombstone(streamId);
    }
    // Any other run fact for a removed stream is stale by definition — for
    // `child.activity` the fact's stream is the parent, so this also keeps a
    // late roster from re-minting a removed parent's state.
    if (this.state.isStreamRemoved(streamId)) return;
    // The table is exhaustive over `RunFactType`, so a slot always exists;
    // TypeScript just cannot correlate a union event with its own slot.
    const handle = this.runFactHandlers[event.type] as (
      streamId: StreamTabId,
      event: SessionRunFactEvent,
    ) => void | Promise<void>;
    withEventErrorHandling(
      'SessionFacts',
      `failed to handle ${event.type} fact`,
      () => handle(streamId, event),
    );
  }

  private handleUpdateStreamDescription({
    streamId,
    description,
  }: UpdateStreamDescriptionPayload): void {
    this.state.setStreamDescription(streamId, description);
    this.renderer.onStreamDescriptionChanged(streamId, description);
  }

  private handleSetParentStream({
    childStreamId,
    parentStreamId,
  }: SetParentStreamPayload): void {
    this.state.setStreamParent(childStreamId, parentStreamId);
    // Topology hosts (TUI) and Lit both learn the edge here. Lit projects it
    // onto `StreamTabInfo.parentStreamId` inside its renderer; do not also
    // fire `onStreamMetadataChanged` — that mint a StreamSlice on signal
    // hosts before attachment.
    this.renderer.onParentStreamChanged(childStreamId, parentStreamId ?? null);
  }

  private handleSetActiveStream(payload: SetActiveStreamPayload): void {
    const { streamId, isRemote } = payload;
    if (!streamId) return;

    this.state.streamLogs.ensureStream(streamId);
    // Only pass fields the event actually knows; omitted fields retain the
    // canonical metadata already owned by SessionState.
    const metadata = {
      ...(payload.agentCategory !== undefined && {
        agentCategory: payload.agentCategory,
      }),
      ...(isRemote !== undefined && { isRemote }),
    };
    if (Object.keys(metadata).length > 0) {
      this.state.updateStreamMetadata(streamId, metadata);
    }
    // Resolve category: use payload hint, fall back to existing stream state.
    // Approval flows (proposal, tool-edit, bash) emit without agentCategory;
    // the stream already exists by then so getStreamCategory() finds it.
    const agentCategory =
      payload.agentCategory ?? this.getStreamCategory(streamId);
    // Ensure stream state exists so it's included in getAllStreamStates()
    if (agentCategory) {
      this.state.getOrCreateStreamState(streamId, agentCategory);
    }
    if (!this.renderer.isAvailable()) return;

    // Register the attachment with this renderer. Transcript hydration and
    // focus policy belong to the host presentation, not the session fact.
    const firstHostDelivery = !this.registeredWithRenderer.has(streamId);
    if (firstHostDelivery) {
      this.pushStreamMetadata(streamId, {
        streamStates: this.state.streamStatus.getAllStreamStates(),
      });
    }
  }

  private handleGoalStateChanged(streamId: StreamTabId): void {
    const goal = GoalStore.getForStream(streamId);
    this.renderer.onGoalActiveChanged(streamId, isGoalInFlight(goal), {
      status: goal?.status,
      objective: goal?.objective,
    });
  }

  private handleRunConfig(streamId: StreamTabId): void {
    // No explicit refresh: `getStreamMetadata` overlays the summary mirror —
    // already updated synchronously by the snapshot store's projection of
    // this same fact — at read time (#9947).
    if (this.renderer.isAvailable()) {
      // A run start or config change may update agent name, model, or label,
      // which the frontend tabs display even for background subagents. Patch
      // only the affected stream instead of rebuilding all historical tabs.
      this.pushStreamMetadata(streamId, {
        streamStates: this.state.streamStatus.getAllStreamStates(),
      });
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
   * subagent keeps its executionId, agentName, status, startedAt, elapsed and
   * toolName so hosts can list it. Process children (background bash) are
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
  private updateChildRoster(
    parentStreamId: StreamTabId,
    next: StreamExecutionState['subagents'],
  ): void {
    // Rows naming a removed child stay removed: a stale roster cannot put a
    // tombstoned identity back. Both the incoming snapshot and the previously
    // stored roster are filtered, so the retention step below cannot re-add a
    // removed child as a finished row.
    next = next.filter(
      (child) => !this.state.isStreamRemoved(child.childStreamId),
    );
    // Roster facts can arrive before RUNNING/config creates the parent state
    // (TUI child-event-order `roster-first`). Provision a ToolUse bucket so
    // retention still runs; a later run.config refreshes the real category.
    const category =
      this.getStreamCategory(parentStreamId) ?? AgentCategory.ToolUse;
    this.state.getOrCreateStreamState(parentStreamId, category);

    this.state.updateStreamState(parentStreamId, (prev) => {
      const previous = prev.subagents.filter(
        (child) => !this.state.isStreamRemoved(child.childStreamId),
      );
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
      const vanishedIds = diffActiveChildren(liveBefore, next);
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
            (child) => vanishedIds.has(child.executionId) && retainable(child),
          )
          .map((child) => ({ ...child, finishedAt })),
      ].slice(-RETAINED_FINISHED_CHILDREN_CAP);
      return { ...prev, subagents: [...live, ...retained] };
    });

    const updated = this.state.getStreamState(parentStreamId);
    if (!updated) {
      this.renderer.onBadgesChanged(parentStreamId, { subagents: next });
      return;
    }
    this.renderer.onBadgesChanged(parentStreamId, {
      subagents: updated.subagents,
    });
  }

  /**
   * Apply a stream status transition into session state and notify the
   * renderer. Awaitable so callers that need rehydrate to finish (tests,
   * and any host that cannot fire-and-forget) can wait; the hub's `status`
   * fact path calls this without awaiting via {@link handleSessionFact}.
   */
  async setStreamStatus(
    streamId: StreamTabId,
    status: StreamPhase,
    previousPhase?: StreamPhase,
    substate?: StreamSubstate,
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
    // the rehydrate await below cannot undo it. That is safe because the child
    // untrack path emits `child.activity` before `removeStream`, so the parent
    // roster drop supersedes any status this row carries, and
    // `updateChildRoster` filters tombstoned children before retention.
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
    }

    const isNewRunningTransition =
      status === STREAM_PHASE.RUNNING && previousPhase !== status;
    const runningCategory = isNewRunningTransition
      ? this.handleRunningTransition(streamId)
      : undefined;

    if (!this.renderer.isAvailable()) return;

    // Push the rows just written whenever the parent holding them is on screen.
    for (const parent of rosterParents) {
      const parentState = this.state.getStreamState(parent);
      if (!parentState) continue;
      this.renderer.onBadgesChanged(parent, {
        subagents: parentState.subagents,
      });
    }

    const isNewStream = !this.state.streamLogs.has(streamId);
    this.state.streamLogs.ensureStream(streamId);
    // Persisted streams may be in stream logs but missing from _streamStates.
    // The first RUNNING transition already created/reset the state above.
    const category = runningCategory ?? this.getStreamCategory(streamId);
    if (!isNewRunningTransition && category !== undefined) {
      this.state.getOrCreateStreamState(streamId, category);
    }

    if (isNewStream) {
      this.pushStreamMetadata(streamId, {
        streamStates: this.buildStreamStatesForRefresh(
          streamId,
          status,
          substate,
        ),
      });
    } else if (isNewRunningTransition) {
      this.pushStreamMetadata(streamId, {
        streamStates: this.buildStreamStatesForRefresh(
          streamId,
          status,
          substate,
        ),
      });
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
    }
  }

  private getStreamCategory(streamId: StreamTabId): AgentCategory | undefined {
    return this.state.getStreamMetadata(streamId).agentCategory;
  }

  /**
   * Snapshot the status machine and splice in `streamId`'s about-to-be-applied
   * status/substate, which hasn't been written to the machine yet when this
   * is called during `setStreamStatus`. Combined into one map so the phase
   * and substate views can't diverge on which streams they cover.
   */
  private buildStreamStatesForRefresh(
    streamId: StreamTabId,
    status: StreamPhase,
    substate?: StreamSubstate,
  ): Map<StreamTabId, StreamPhaseState> {
    const statesForRefresh = this.state.streamStatus.getAllStreamStates();
    statesForRefresh.set(
      streamId,
      substate ? { phase: status, substate } : { phase: status },
    );
    return statesForRefresh;
  }
}
