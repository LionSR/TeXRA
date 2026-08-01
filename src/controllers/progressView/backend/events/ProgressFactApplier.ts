import {
  createChannelTrace,
  RUN_FACT_EVENT_TYPES,
  type AgentEvent,
  type AgentTrace,
} from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { SessionFact } from '@agent/runtime/SessionEventHub';
import type { StreamPhaseState } from '@agent/runtime/StreamStatusService';
import { WebviewBridge } from '@controllers/progressView/backend/WebviewBridge';
import {
  ProgressViewState,
  type ActiveStreamId,
  type StreamExecutionState,
} from '@controllers/progressView/backend/state/ProgressViewState';
import { WebviewUpdater } from '@controllers/progressView/backend/WebviewUpdater';
import {
  STREAM_PHASE,
  type AddOutputFilesPayload,
  type ClearMissingOutputsPayload,
  type ConversationProgress,
  type GoalStatus,
  type InquiryThreadUpdatedEvent,
  type SetActiveStreamPayload,
  type SetParentStreamPayload,
  type StreamPhase,
  type StreamSubstate,
  type StreamTabId,
  type UpdateCompileFailuresPayload,
  type UpdateConversationProgressPayload,
  type UpdateMissingOutputsPayload,
  type UpdatePhaseStagePayload,
  type UpdatePlanPayload,
  type UpdateQueuedFollowUpsPayload,
  type UpdateRoundStagePayload,
  type UpdateStreamDescriptionPayload,
  type UpdateStreamUsagePayload,
  type UpdateTodosPayload,
} from '@shared/schemas';
import { isGoalInFlight } from '@shared/schemas/goal';
import { diffActiveChildren } from '@shared/streams/childActivityReducer';
import { isActivePhase } from '@shared/streams/streamStatus';
import { GoalStore } from '@tools/goal';
import {
  assertNever,
  createFlushableDebounce,
  mapToRecord,
  type FlushableDebounce,
} from '@utils/core';

import { withEventErrorHandling } from './errorHandling';

/** Throttle interval for conversation progress webview pushes (ms). */
const PROGRESS_THROTTLE_MS = 500;

/**
 * Memory bound on retained finished children, per stream per kind. A long
 * session can finish thousands; the oldest `finishedAt` is evicted first and
 * live entries are never evicted. Mirrors `RESOLVED_PROPOSAL_IDS_CAP`.
 */
const RETAINED_FINISHED_CHILDREN_CAP = 200;

export type ProgressEventSubscription = {
  dispose(): void;
};

interface ProgressStreamBypassControls {
  bashBypass: boolean;
  toolEditBypass: boolean;
  superYoloBypass: boolean;
}

export type ProgressStreamControls = ProgressStreamBypassControls &
  (
    | { goalActive: false }
    | { goalActive: true; goalStatus: GoalStatus; goalObjective: string }
  );

export type GetProgressStreamControls = (
  stream: StreamTabId,
) => ProgressStreamControls;

type RunFactType = (typeof RUN_FACT_EVENT_TYPES)[number];

type RunFactHandlers = {
  [K in RunFactType]: (
    streamId: StreamTabId,
    event: Extract<AgentEvent, { type: K }>,
  ) => void | Promise<void>;
};

function getDefaultProgressStreamControls(): ProgressStreamControls {
  return {
    bashBypass: false,
    toolEditBypass: false,
    superYoloBypass: false,
    goalActive: false,
  };
}

/** Applies session and run facts to progress-view state and webview updates. */
export class ProgressFactApplier {
  private readonly logger: AgentTrace;
  private readonly progressDebounce: FlushableDebounce =
    createFlushableDebounce(
      () => this.flushProgressUpdates(),
      PROGRESS_THROTTLE_MS,
    );
  private readonly pendingProgressUpdates = new Map<
    StreamTabId,
    ConversationProgress
  >();

  /**
   * Run-fact dispatch table (see `RUN_FACT_EVENT_TYPES`); keys stay exhaustive.
   * Handlers hold only their own logic and RETURN it — `handleRunFact` wraps
   * each dispatch in `applyFact` once. Returning (rather than discarding) the
   * call keeps async handlers' promises flowing to `applyFact`, so a rejection
   * after an await is still logged instead of becoming an unhandled rejection.
   */
  private readonly runFactHandlers: RunFactHandlers = {
    usage: (_streamId, event) => this.handleUpdateStreamUsage(event.payload),
    'run.start': (_streamId, event) => {
      const streamId = event.descriptor.streamId;
      this.state.refreshStreamMetadataFromSnapshot(streamId);
      if (this.webviewUpdater.isAvailable()) {
        this.webviewUpdater.updateStreamMetadata(
          this.state,
          streamId,
          this.state.streamStatus.getAllStreamStates(),
        );
      }
    },
    'run.config': (_streamId, event) => this.handleSetTaskState(event.streamId),
    updateTodos: (_streamId, event) => this.handleUpdateTodos(event),
    updatePlan: (_streamId, event) => this.handleUpdatePlan(event),
    addOutputFiles: (_streamId, event) => this.handleAddOutputFiles(event),
    updateMissingOutputs: (_streamId, event) =>
      this.handleUpdateMissingOutputs(event),
    updateCompileFailures: (_streamId, event) =>
      this.handleUpdateCompileFailures(event),
    goalPaused: () => {
      // No progress-view state change; listed only to keep the run-fact type
      // set exhaustive (it stays in the subscription filter for parity).
    },
    'conversation.progress': (streamId, event) =>
      this.handleUpdateConversationProgress({
        streamId,
        progress: event.progress,
      }),
    'stage.start': (streamId, event) => {
      if (event.kind === 'phase') {
        return this.handleUpdatePhaseStage({
          streamId,
          phaseStage: {
            label: event.label,
            ...(event.index !== undefined ? { index: event.index } : {}),
            ...(event.total !== undefined && event.total > 0
              ? { total: event.total }
              : {}),
          },
        });
      }
      if (event.kind !== 'round') return;
      return this.handleUpdateRoundStage({
        streamId,
        roundStage: {
          index: event.index ?? 0,
          ...(event.total !== undefined && event.total > 0
            ? { total: event.total }
            : {}),
        },
      });
    },
    'child.activity': (_streamId, event) =>
      this.updateChildRoster(event.parentStreamId, [...event.items]),
  };

  constructor(
    private readonly state: ProgressViewState,
    private readonly webviewUpdater: WebviewUpdater,
    private readonly webviewBridge: WebviewBridge,
    private readonly hasPendingPermissions: (streamId: string) => boolean,
    private readonly deleteStream: (
      stream: StreamTabId,
    ) => void | Promise<void>,
    private readonly getStreamControls: GetProgressStreamControls = getDefaultProgressStreamControls,
  ) {
    this.logger = createChannelTrace('ProgressFactApplier');
  }

  private handleRunningTransition(
    streamId: StreamTabId,
  ): AgentCategory | undefined {
    const provisionalCategory = this.getStreamCategory(streamId);
    this.state.resetStreamMetadataForRun(streamId);
    const knownCategory =
      this.getStreamCategory(streamId) ?? provisionalCategory;
    const category = knownCategory ?? AgentCategory.Workflow;
    this.state.getOrCreateStreamState(streamId, category);
    this.state.resetPerRunChildState(streamId);
    this.pendingProgressUpdates.delete(streamId);
    return knownCategory;
  }

  /** Drop the work this applier has buffered; called by `ProgressBackend.dispose`. */
  dispose(): void {
    this.progressDebounce.cancel();
    this.pendingProgressUpdates.clear();
    this.webviewBridge.clearAll();
  }

  handleSessionFact(fact: SessionFact): void {
    // Wrap once, and RETURN each case so async handlers' promises reach
    // `applyFact` (a discarded promise would let a post-await rejection escape
    // `withEventErrorHandling`'s thenable check as an unhandled rejection). The
    // switch is inlined here rather than in a single-caller helper, mirroring
    // `handleRunFact`'s inline table lookup. `assertNever` stays inside the
    // wrapper — an unreachable exhaustiveness guard that would only ever be
    // logged, never thrown, and the union is closed so it never fires.
    this.applyFact(`failed to handle ${fact.type} fact`, () => {
      switch (fact.type) {
        case 'goalStateChanged':
          return this.handleGoalStateChanged(fact.payload.streamId);
        case 'inquiryThreadUpdated':
          return this.handleInquiryThreadUpdated(fact.payload);
        case 'clearMissingOutputs':
          return this.handleClearMissingOutputs(fact.payload);
        case 'updateQueuedFollowUps':
          return this.handleUpdateQueuedFollowUps(fact.payload);
        case 'followUpSent':
          return;
        case 'setActiveStream':
          return this.handleSetActiveStream(fact.payload);
        case 'updateStreamDescription':
          return this.handleUpdateStreamDescription(fact.payload);
        case 'updateStreamStatus':
          return this.setStreamStatus(
            fact.payload.streamId,
            fact.payload.status,
            fact.payload.previousStatus,
            fact.payload.substate,
          );
        case 'setParentStream':
          return this.handleSetParentStream(fact.payload);
        case 'removeStream':
          return this.deleteStream(fact.payload.streamId);
      }
      assertNever(fact, 'Unhandled progress-view session fact');
    });
  }

  handleRunFact(streamId: StreamTabId, event: AgentEvent): void {
    // Widen the exhaustive table to the full event union so an unlisted type
    // (not in the subscription filter, but defensively tolerated) is a no-op
    // rather than a lookup on a missing key.
    const handlers = this.runFactHandlers as Partial<
      Record<
        AgentEvent['type'],
        (streamId: StreamTabId, event: AgentEvent) => void | Promise<void>
      >
    >;
    const handler = handlers[event.type];
    if (!handler) return;
    this.applyFact(`failed to handle ${event.type} fact`, () =>
      handler(streamId, event),
    );
  }

  private applyFact(context: string, handle: () => void | Promise<void>): void {
    withEventErrorHandling('ProgressFacts', context, handle);
  }

  public handleInquiryThreadUpdated(thread: InquiryThreadUpdatedEvent): void {
    this.webviewUpdater.updateInquiryThread(thread);
  }

  public handleUpdateStreamDescription({
    streamId,
    description,
  }: UpdateStreamDescriptionPayload): void {
    this.state.setStreamDescription(streamId, description);
    this.webviewUpdater.updateStreamDescription(streamId, description);
  }

  public handleSetParentStream({
    childStreamId,
    parentStreamId,
  }: SetParentStreamPayload): void {
    this.state.setStreamParent(childStreamId, parentStreamId);
    this.webviewUpdater.updateParentStream(
      childStreamId,
      parentStreamId ?? undefined,
    );
  }

  public handleAddOutputFiles({ streamId }: AddOutputFilesPayload): void {
    this.sendIfActive(streamId, () => {
      const rounds = this.state.snapshots.getOutputFiles(streamId);
      this.webviewUpdater.updateFiles(streamId, {
        rounds: Object.keys(rounds).length ? rounds : undefined,
      });
    });
  }

  public handleUpdateMissingOutputs({
    streamId,
  }: UpdateMissingOutputsPayload): void {
    this.sendIfActive(streamId, () => {
      const rounds = this.state.snapshots.getMissingOutputs(streamId);
      this.webviewUpdater.updateMissingOutputs(streamId, {
        rounds: Object.keys(rounds).length ? rounds : undefined,
      });
    });
  }

  public handleUpdateCompileFailures({
    streamId,
  }: UpdateCompileFailuresPayload): void {
    this.sendIfActive(streamId, () => {
      const rounds = this.state.snapshots.getCompileFailures(streamId);
      this.webviewUpdater.updateCompileFailures(streamId, {
        rounds: Object.keys(rounds).length ? rounds : undefined,
        reset: true,
      });
    });
  }

  public handleClearMissingOutputs(payload: ClearMissingOutputsPayload): void {
    const targets = this.state.snapshots.resolveMissingOutputTargets(payload);
    for (const streamId of targets) {
      this.sendIfActive(streamId, () =>
        this.webviewUpdater.updateMissingOutputs(streamId, {
          reset: true,
        }),
      );
    }
  }

  public handleUpdateStreamUsage({
    streamId,
    storageKey,
  }: UpdateStreamUsagePayload): void {
    const nextUsage = this.state.snapshots
      .getRunUsage(streamId)
      .get(storageKey);
    if (!nextUsage) return;
    this.sendIfActive(streamId, () =>
      this.webviewUpdater.updateRunUsage(streamId, storageKey, nextUsage),
    );
  }

  public handleUpdateTodos({ streamId, todos }: UpdateTodosPayload): void {
    this.sendIfActive(streamId, () =>
      this.webviewUpdater.updateTodos(streamId, todos),
    );
  }

  public handleUpdatePlan({ streamId, plan }: UpdatePlanPayload): void {
    this.webviewUpdater.updatePlan(streamId, plan);
  }

  public handleUpdateQueuedFollowUps({
    streamId,
  }: UpdateQueuedFollowUpsPayload): void {
    this.sendIfActive(streamId, () => {
      const messages = this.state.followUps.getAll(streamId);
      this.webviewUpdater.updateQueuedFollowUps(streamId, messages);
    });
  }

  /** Send to webview only if streamId is the active stream. */
  private sendIfActive(streamId: string, send: () => void): void {
    if (
      streamId === this.state.activeStream &&
      this.webviewUpdater.isAvailable()
    ) {
      send();
    }
  }

  public async handleSetActiveStream(
    payload: SetActiveStreamPayload,
  ): Promise<void> {
    const { streamId, isRemote } = payload;
    if (!streamId) {
      this.state.switchActiveStream('');
      this.webviewUpdater.setActiveStream('');
      return;
    }

    const wasKnownStream = this.state.streamLogs.has(streamId);
    this.state.streamLogs.ensureStream(streamId);
    // Only pass fields the event actually knows; omitted fields retain the
    // canonical metadata already owned by ProgressViewState.
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
    // Don't switch away from the current stream if it has pending permissions
    // (retry, tool-edit, bash approval, or agent proposal) — the user needs to
    // interact with the approval panel before losing sight of it.
    // Background child streams (bash, codex) pass `suppressViewSwitch` so the
    // tab appears without auto-switching the active view.
    const currentStream = this.state.activeStream;
    const shouldSwitch =
      payload.suppressViewSwitch !== true &&
      (!currentStream || !this.hasPendingPermissions(currentStream));
    if (shouldSwitch) {
      // The switch also releases the previously-active stream if it reached a
      // terminal status while visible — setStreamStatus skips release for the
      // active stream, so this is our only chance.
      this.state.switchActiveStream(streamId);
    }

    if (!this.webviewUpdater.isAvailable()) return;

    // Rehydrate a potentially-evicted stream before syncing content, so the
    // webview doesn't get an empty log. All synchronous state mutations are
    // already done above; the await here only gates webview delivery.
    await this.state.streamLogs.ensureLoaded(streamId);

    // A newer handleSetActiveStream may have resolved during our await and
    // already taken over the active tab; skip webview sync so we don't
    // overwrite its content with stale data.
    if (shouldSwitch && this.state.activeStream !== streamId) return;

    if (!wasKnownStream) {
      this.webviewUpdater.updateStreamMetadata(
        this.state,
        streamId,
        this.state.streamStatus.getAllStreamStates(),
        { activeStream: shouldSwitch ? this.state.activeStream : undefined },
      );
    } else if (shouldSwitch) {
      this.webviewUpdater.setActiveStream(streamId);
    }
    // Always sync content for the new stream so badges/parent info reaches
    // the webview — even when we suppress the view switch. includeActiveState
    // is only relevant when this IS the active stream.
    this.syncStreamContent(streamId, {
      includeActiveState: shouldSwitch && wasKnownStream,
    });
  }

  private handleGoalStateChanged(streamId: StreamTabId): void {
    const goal = GoalStore.getForStream(streamId);
    this.webviewUpdater.updateGoalActive(streamId, isGoalInFlight(goal), {
      status: goal?.status,
      objective: goal?.objective,
    });
  }

  private handleSetTaskState(streamId: StreamTabId): void {
    this.state.refreshStreamMetadataFromSnapshot(streamId);

    if (this.webviewUpdater.isAvailable()) {
      // setTaskState may change agentConfig (agent name, model, label), which
      // the frontend tabs display even for background subagents. Patch only
      // the affected stream instead of rebuilding all historical stream tabs.
      this.webviewUpdater.updateStreamMetadata(
        this.state,
        streamId,
        this.state.streamStatus.getAllStreamStates(),
      );
    }
  }

  public handleUpdateConversationProgress(
    data: UpdateConversationProgressPayload,
  ): void {
    const { streamId, progress } = data;

    // Always update state immediately so full metadata rebuilds include
    // the latest values when structural refreshes happen.
    this.state.updateStreamState(streamId, (prev) => ({
      ...prev,
      conversationProgress: progress,
    }));

    // Throttle webview pushes: buffer per-stream, flush on timer
    this.pendingProgressUpdates.set(streamId, progress);
    if (!this.progressDebounce.pending) this.progressDebounce.schedule();
  }

  public handleUpdateRoundStage(data: UpdateRoundStagePayload): void {
    const { streamId, roundStage } = data;
    this.state.updateStreamState(streamId, (prev) => ({
      ...prev,
      roundStage,
    }));

    this.sendIfActive(streamId, () =>
      this.webviewUpdater.updateRoundStage(streamId, roundStage),
    );
  }

  /**
   * A workflow-script run's phase is read from its *parent's* viewport (the
   * Background Tasks row for that run), so unlike `roundStage` this cannot be
   * pushed only for the active stream. It rides the existing per-stream
   * metadata patch instead of a new targeted message: phases advance a
   * handful of times per run, so the extra fields on the wire cost nothing
   * and no new command has to be added to the outbound union.
   */
  private handleUpdatePhaseStage(data: UpdatePhaseStagePayload): void {
    const { streamId, phaseStage } = data;
    this.state.updateStreamState(streamId, (prev) => ({
      ...prev,
      phaseStage,
    }));

    if (!this.webviewUpdater.isAvailable()) return;
    this.webviewUpdater.updateStreamMetadata(
      this.state,
      streamId,
      this.state.streamStatus.getAllStreamStates(),
    );
  }

  private flushProgressUpdates(): void {
    const { activeStream } = this.state;
    const progress = activeStream
      ? this.pendingProgressUpdates.get(activeStream)
      : undefined;
    if (progress && this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.updateConversationProgress(activeStream, progress);
    }
    this.pendingProgressUpdates.clear();
  }

  /**
   * Replace a parent stream's live child roster, retaining every child that
   * just left it instead of folding it into a counter — a finished subagent
   * keeps its executionId, agentName, status, startedAt, elapsed and toolName
   * so hosts can list it. A retained row is only ever created from an entry
   * that was already in OUR roster and is absent from `next`, so a first
   * roster can never mark anything finished.
   *
   * `next` decides roster membership and identity only. A row we already track
   * keeps the phase `recordChildPhase` wrote, so the status-machine fact stays
   * the sole writer of `status` and a roster stamped before a later transition
   * cannot regress a resolved row. A row entering the roster (first sighting,
   * or a retained child going live again) has no recorded phase to keep, so it
   * takes the one stamped at emission.
   */
  public updateChildRoster(
    parentStreamId: StreamTabId,
    next: StreamExecutionState['subagents'],
  ): void {
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
      const vanishedIds = diffActiveChildren(liveBefore, next);
      const finishedAt = Date.now();
      const nextIds = new Set(next.map((child) => child.executionId));
      // Previously-retained rows first (already in ascending `finishedAt`
      // order), then the newly-vanished ones — so the list stays chronological
      // by construction and the cap evicts the oldest without a sort. A child
      // that reappears in `next` is live again, so drop its retained copy.
      const retained = [
        ...previous.filter(
          (child) =>
            child.finishedAt !== undefined && !nextIds.has(child.executionId),
        ),
        ...previous
          .filter((child) => vanishedIds.has(child.executionId))
          .map((child) => ({ ...child, finishedAt })),
      ].slice(-RETAINED_FINISHED_CHILDREN_CAP);
      return { ...prev, subagents: [...live, ...retained] };
    });

    const updated = this.state.getStreamState(parentStreamId);
    if (
      this.webviewUpdater.isAvailable() &&
      parentStreamId === this.state.activeStream &&
      updated
    ) {
      this.webviewUpdater.updateStreamBadges(parentStreamId, {
        subagents: updated.subagents,
      });
    }
  }

  public markAllRunningTasksAsCancelled(): void {
    for (const [stream, status] of this.state.streamStatus.entries()) {
      if (status === STREAM_PHASE.RUNNING) {
        this.state.streamStatus.transition(
          stream,
          STREAM_PHASE.CANCELLED,
          'restart-repair',
          { trace: this.logger },
        );
      }
    }
  }

  public syncStreamContent(
    stream: ActiveStreamId,
    options: {
      /** Include conversation progress, badges, and parent stream in the batch. */
      includeActiveState?: boolean;
    } = {},
  ): void {
    if (!this.webviewUpdater.isAvailable()) return;

    const { includeActiveState = false } = options;

    if (!stream) {
      // Clear the stream surface when no stream is active.
      this.webviewUpdater.sendSyncStreamContent({ action: 'clear' });
      return;
    }

    this.webviewBridge.syncStream(stream);

    const existingState = this.state.getStreamState(stream);
    const kind =
      this.getStreamCategory(stream) ??
      existingState?.kind ??
      AgentCategory.Workflow;

    const activeState = includeActiveState
      ? this.toActiveStreamContentSync(
          stream,
          this.state.getOrCreateStreamState(stream, kind),
        )
      : undefined;

    const shared = {
      action: 'render' as const,
      stream,
      runUsage: mapToRecord(this.state.snapshots.getRunUsage(stream)),
      ...(activeState ? { activeState } : {}),
    };

    if (kind === AgentCategory.Workflow) {
      this.webviewUpdater.sendSyncStreamContent({
        ...shared,
        kind,
        outputs: {
          files: this.state.snapshots.getOutputFiles(stream),
          missing: this.state.snapshots.getMissingOutputs(stream),
          compileFailures: this.state.snapshots.getCompileFailures(stream),
        },
      });
      return;
    }

    const { todos, plan } = this.state.snapshots.getWorkPlan(stream);
    const controls = this.getStreamControls(stream);
    this.webviewUpdater.sendSyncStreamContent({
      ...shared,
      kind,
      workPlan: {
        todos,
        plan,
        queuedFollowUps: this.state.followUps.getAll(stream),
      },
      controls: {
        bashBypass: controls.bashBypass,
        toolEditBypass: controls.toolEditBypass,
        superYoloBypass: controls.superYoloBypass,
        goal: controls.goalActive
          ? {
              active: true,
              status: controls.goalStatus,
              objective: controls.goalObjective,
            }
          : { active: false },
      },
    });
  }

  private toActiveStreamContentSync(
    stream: StreamTabId,
    state: StreamExecutionState,
  ) {
    return {
      conversationProgress: state.conversationProgress,
      roundStage: state.roundStage ?? null,
      phaseStage: state.phaseStage ?? null,
      badges: { subagents: state.subagents },
      parentStreamId: this.state.snapshots.getParentStreamId(stream) ?? null,
    };
  }

  async setStreamStatus(
    streamId: StreamTabId,
    status: StreamPhase,
    // Kept until Stage 5 removes the legacy bus projection; the status machine
    // now owns repair writes, so this projection no longer consumes it.
    _previousStatus?: StreamPhase,
    substate?: StreamSubstate,
  ): Promise<void> {
    // Land the status-machine phase in the parent rosters before this handler
    // can suspend, so rows are written in fact order and a slow active-phase
    // rehydrate can never overwrite a later phase.
    const rosterParents = this.state.recordChildPhase(streamId, status);

    // Active phases keep the full log resident for runtime writes. Inactive,
    // unfocused streams release heavy entries and rehydrate on demand.
    const requiresPersistentRehydrate =
      this.state.streamLogs.mode.kind === 'persistent' &&
      this.state.streamLogs.has(streamId) &&
      !this.state.streamLogs.get(streamId);
    if (isActivePhase(status)) {
      if (requiresPersistentRehydrate) {
        await this.state.streamLogs.ensureLoaded(streamId);
      }
    } else if (streamId !== this.state.activeStream) {
      this.state.streamLogs.requestEviction(streamId);
    }

    const isNewRunningTransition =
      status === STREAM_PHASE.RUNNING && _previousStatus !== status;
    const runningCategory = isNewRunningTransition
      ? this.handleRunningTransition(streamId)
      : undefined;

    if (!this.webviewUpdater.isAvailable()) return;

    // Push the rows just written whenever the parent holding them is on screen.
    for (const parent of rosterParents) {
      if (parent !== this.state.activeStream) continue;
      const parentState = this.state.getStreamState(parent);
      if (!parentState) continue;
      this.webviewUpdater.updateStreamBadges(parent, {
        subagents: parentState.subagents,
      });
    }

    const isNewStream = !this.state.streamLogs.has(streamId);
    this.state.streamLogs.ensureStream(streamId);
    // Persisted streams may be in stream logs but missing from _streamStates.
    // The first RUNNING transition already created/reset the state above.
    const streamCategory = runningCategory ?? this.getStreamCategory(streamId);
    const category = streamCategory ?? AgentCategory.Workflow;
    if (!isNewRunningTransition) {
      this.state.getOrCreateStreamState(streamId, category);
    }

    if (isNewStream) {
      if (!this.state.activeStream) {
        this.state.switchActiveStream(streamId);
      }
      const activeStream =
        !this.state.activeStream || this.state.activeStream === streamId
          ? this.state.activeStream
          : undefined;
      this.webviewUpdater.updateStreamMetadata(
        this.state,
        streamId,
        this.buildStreamStatesForRefresh(streamId, status, substate),
        { activeStream },
      );
    } else if (isNewRunningTransition) {
      this.webviewUpdater.updateStreamMetadata(
        this.state,
        streamId,
        this.buildStreamStatesForRefresh(streamId, status, substate),
      );
    } else {
      const lastTimestamp = this.state.streamLogs.getLastTimestamp(streamId);
      this.webviewUpdater.updateStreamStatus(
        streamId,
        status,
        lastTimestamp,
        substate,
      );
    }
  }

  private getStreamCategory(streamId: StreamTabId): AgentCategory | undefined {
    return this.state.getStreamMetadata(streamId).agentCategory;
  }

  getAllStreamStates(): Map<StreamTabId, StreamPhaseState> {
    return this.state.streamStatus.getAllStreamStates();
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
