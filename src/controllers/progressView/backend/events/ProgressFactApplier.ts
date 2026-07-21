import {
  createChannelTrace,
  RUN_FACT_EVENT_TYPES,
  type AgentEvent,
  type AgentTrace,
} from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { TaskState } from '@agent/core/state/TaskState';
import type { SessionFact } from '@agent/runtime/SessionEventHub';
import type { StreamPhaseState } from '@agent/runtime/StreamStatusService';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import { WebviewBridge } from '@controllers/progressView/backend/WebviewBridge';
import {
  ProgressViewState,
  type ActiveStreamId,
  type StreamBadgeSnapshot,
  type StreamExecutionState,
} from '@controllers/progressView/backend/state/ProgressViewState';
import { buildStreamInfos } from '@controllers/progressView/backend/streamInfoUtils';
import { WebviewUpdater } from '@controllers/progressView/backend/WebviewUpdater';
import {
  STREAM_PHASE,
  type AddOutputFilesPayload,
  type ClearMissingOutputsPayload,
  type ConversationProgress,
  type ExecutionId,
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
  type UpdatePlanPayload,
  type UpdateProcessOutputPayload,
  type UpdateQueuedFollowUpsPayload,
  type UpdateRoundStagePayload,
  type UpdateStreamDescriptionPayload,
  type UpdateStreamUsagePayload,
  type UpdateTodosPayload,
} from '@shared/schemas';
import { isGoalInFlight } from '@shared/schemas/goal';
import { buildStreamContentSync } from '@shared/streams/streamContentSync';
import { diffActiveChildren } from '@shared/streams/childActivityReducer';
import { isActivePhase } from '@shared/streams/streamStatus';
import { GoalStore } from '@tools/goal';
import { assertNever, mapToRecord } from '@utils/core';

import { withEventErrorHandling } from './errorHandling';

/** Throttle interval for conversation progress webview pushes (ms). */
const PROGRESS_THROTTLE_MS = 500;

type SetTaskStateProgressFact = {
  streamId: StreamTabId;
  executionId?: ExecutionId;
  taskState: TaskState;
};

export type ProgressEventSubscription = {
  dispose(): void;
};

interface ProgressStreamBypassControls {
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
    toolEditBypass: false,
    superYoloBypass: false,
    goalActive: false,
  };
}

/** Applies session and run facts to progress-view state and webview updates. */
export class ProgressFactApplier {
  private readonly logger: AgentTrace;
  private progressThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingProgressUpdates = new Map<StreamTabId, ConversationProgress>();

  /**
   * Run-fact dispatch table (see `RUN_FACT_EVENT_TYPES`); keys stay exhaustive.
   * Handlers hold only their own logic and RETURN it — `handleRunFact` wraps
   * each dispatch in `applyFact` once. Returning (rather than discarding) the
   * call keeps async handlers' promises flowing to `applyFact`, so a rejection
   * after an await is still logged instead of becoming an unhandled rejection.
   */
  private readonly runFactHandlers: RunFactHandlers = {
    usage: (_streamId, event) => this.handleUpdateStreamUsage(event.payload),
    'run.config': (_streamId, event) =>
      this.handleSetTaskState({
        streamId: event.streamId,
        executionId: event.executionId,
        taskState: agentConfigToTaskState(event.config),
      }),
    status: (_streamId, event) =>
      this.setStreamStatus(
        event.streamId,
        event.phase,
        event.previousPhase,
        event.substate,
      ),
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
      this.updateActiveChildren(event.parentStreamId, {
        activeField:
          event.kind === 'subagents' ? 'activeSubagents' : 'activeProcesses',
        countField:
          event.kind === 'subagents'
            ? 'finishedSubagentCount'
            : 'finishedProcessCount',
        next: [...event.items],
      }),
    'process.output': (_streamId, event) =>
      this.handleUpdateProcessOutput({
        parentStreamId: event.parentStreamId,
        executionId: event.executionId,
        stdout: event.stdout,
        stderr: event.stderr,
      }),
  };

  constructor(
    private state: ProgressViewState,
    private webviewUpdater: WebviewUpdater,
    private webviewBridge: WebviewBridge,
    private readonly hasPendingPermissions: (streamId: string) => boolean,
    private readonly deleteStream: (
      stream: StreamTabId,
    ) => void | Promise<void>,
    private readonly getStreamControls: GetProgressStreamControls = getDefaultProgressStreamControls,
    private readonly stateOwnership: 'backend' | 'session' = 'backend',
  ) {
    this.logger = createChannelTrace('ProgressFactApplier');
  }

  private maybeUpdateFilterForCategory(
    category: AgentCategory | undefined,
  ): void {
    if (
      category &&
      this.state.agentCategoryFilter !== 'all' &&
      this.state.agentCategoryFilter !== category
    ) {
      this.state.agentCategoryFilter = category;
    }
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
    this.state.resetFinishedChildCounters(streamId);
    this.pendingProgressUpdates.delete(streamId);

    if (this.state.activeStream === streamId) {
      this.maybeUpdateFilterForCategory(knownCategory);
    }
    return knownCategory;
  }

  createLocalSubscription(): ProgressEventSubscription {
    return {
      dispose: () => {
        if (this.progressThrottleTimer) {
          clearTimeout(this.progressThrottleTimer);
          this.progressThrottleTimer = null;
        }
        this.pendingProgressUpdates.clear();
        this.webviewBridge.clearAll();
      },
    };
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
    // Every type derives its context from `event.type`, except `child.activity`
    // — the one fact whose failure context was historically keyed on
    // `event.kind` (subagents vs processes), preserved so those failures stay
    // distinguishable in logs.
    let context = `failed to handle ${event.type} fact`;
    if (event.type === 'child.activity') {
      const activityKind = event.kind === 'subagents' ? 'subagent' : 'process';
      context = `failed to handle ${activityKind} activity fact`;
    }
    this.applyFact(context, () => handler(streamId, event));
  }

  private applyFact(context: string, handle: () => void | Promise<void>): void {
    withEventErrorHandling('ProgressFacts', context, handle);
  }

  public handleInquiryThreadUpdated(thread: InquiryThreadUpdatedEvent): void {
    if (this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.updateInquiryThread(thread);
    }
  }

  public handleUpdateStreamDescription({
    streamId,
    description,
  }: UpdateStreamDescriptionPayload): void {
    this.state.setStreamDescription(streamId, description, this.stateOwnership);
    if (this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.updateStreamDescription(streamId, description);
    }
  }

  public handleSetParentStream({
    childStreamId,
    parentStreamId,
  }: SetParentStreamPayload): void {
    this.state.setStreamParent(
      childStreamId,
      parentStreamId,
      this.stateOwnership,
    );
    if (this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.updateParentStream(
        childStreamId,
        parentStreamId ?? undefined,
      );
    }
  }

  public handleUpdateProcessOutput({
    parentStreamId,
    executionId,
    stdout,
    stderr,
  }: UpdateProcessOutputPayload): void {
    // Always send — output accumulates in frontend state per-stream,
    // so it must not be dropped when the stream is inactive.
    if (this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.updateProcessOutput(
        parentStreamId,
        executionId,
        stdout,
        stderr,
      );
    }
  }

  public handleAddOutputFiles({
    streamId,
    filesByRound,
  }: AddOutputFilesPayload): void {
    if (this.stateOwnership === 'backend') {
      this.state.snapshots.addOutputFiles(streamId, filesByRound);
    }
    this.sendIfActive(streamId, () => {
      const rounds = this.state.snapshots.getOutputFiles(streamId);
      this.webviewUpdater.updateFiles(streamId, {
        rounds: Object.keys(rounds).length ? rounds : undefined,
      });
    });
  }

  public handleUpdateMissingOutputs({
    streamId,
    filesByRound,
  }: UpdateMissingOutputsPayload): void {
    if (this.stateOwnership === 'backend') {
      this.state.snapshots.updateMissingOutputs(streamId, filesByRound);
    }
    this.sendIfActive(streamId, () => {
      const rounds = this.state.snapshots.getMissingOutputs(streamId);
      this.webviewUpdater.updateMissingOutputs(streamId, {
        rounds: Object.keys(rounds).length ? rounds : undefined,
      });
    });
  }

  public handleUpdateCompileFailures({
    streamId,
    filesByRound,
  }: UpdateCompileFailuresPayload): void {
    if (this.stateOwnership === 'backend') {
      this.state.snapshots.updateCompileFailures(streamId, filesByRound);
    }
    this.sendIfActive(streamId, () => {
      const rounds = this.state.snapshots.getCompileFailures(streamId);
      this.webviewUpdater.updateCompileFailures(streamId, {
        rounds: Object.keys(rounds).length ? rounds : undefined,
        reset: true,
      });
    });
  }

  public handleClearMissingOutputs(payload: ClearMissingOutputsPayload): void {
    let targets: StreamTabId[];
    if (payload.streamId) {
      targets = [payload.streamId];
    } else if (payload.streamConfig) {
      targets = this.state.snapshots.findWorkflowStreamsMatching(
        payload.streamConfig,
      );
    } else {
      targets = [];
    }
    for (const streamId of targets) {
      if (this.stateOwnership === 'backend') {
        this.state.snapshots.clearMissingOutputs(streamId);
      }
      this.sendIfActive(streamId, () =>
        this.webviewUpdater.updateMissingOutputs(streamId, {
          reset: true,
        }),
      );
    }
  }

  public handleUpdateStreamUsage({
    streamId,
    usage,
    storageKey,
  }: UpdateStreamUsagePayload): void {
    const accumulated =
      this.stateOwnership === 'backend'
        ? this.state.snapshots.addUsage(streamId, storageKey, usage)
        : this.state.snapshots.getRunUsage(streamId).get(storageKey);
    void Promise.resolve(accumulated).then((nextUsage) => {
      if (!nextUsage) return;
      this.sendIfActive(streamId, () =>
        this.webviewUpdater.updateRunUsage(streamId, storageKey, nextUsage),
      );
    });
  }

  public handleUpdateTodos({ streamId, todos }: UpdateTodosPayload): void {
    if (this.stateOwnership === 'backend') {
      this.state.snapshots.setTodos(streamId, todos);
    }
    this.sendIfActive(streamId, () =>
      this.webviewUpdater.updateTodos(streamId, todos),
    );
  }

  public handleUpdatePlan({ streamId, plan }: UpdatePlanPayload): void {
    if (this.stateOwnership === 'backend') {
      this.state.snapshots.setPlan(streamId, plan);
    }
    if (this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.updatePlan(streamId, plan);
    }
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
      this.state.activeStream = '';
      this.webviewUpdater.setActiveStream('');
      return;
    }

    const wasKnownStream = this.state.streamLogs.has(streamId);
    const previousFilter = this.state.agentCategoryFilter;
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
    if (
      payload.suppressViewSwitch === true &&
      payload.ensureVisible === true &&
      this.state.agentCategoryFilter !== 'all' &&
      (!agentCategory || this.state.agentCategoryFilter !== agentCategory)
    ) {
      this.state.agentCategoryFilter = 'all';
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
      // Update the category filter only when actually switching. If we change
      // the filter while suppressing the switch, sendStreamMetadata →
      // pickValidActiveStream rebuilds the stream list with the new filter,
      // which may exclude the current stream and override state.activeStream —
      // completely bypassing the pending-permissions guard.
      this.maybeUpdateFilterForCategory(agentCategory);
      const previous = this.state.activeStream;
      this.state.activeStream = streamId;
      // Release the previously-active stream if it reached a terminal
      // status while visible — setStreamStatus skips release for the
      // active stream, so this switch is our only chance.
      if (previous && previous !== streamId) {
        this.state.releasePreviousActive(previous);
      }
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

    const filterChanged = this.state.agentCategoryFilter !== previousFilter;
    if (filterChanged && payload.ensureVisible === true) {
      this.webviewUpdater.sendStreamMetadata(
        this.state,
        this.state.streamStatus.getAllStreamStates(),
      );
    } else if (!wasKnownStream || filterChanged) {
      this.webviewUpdater.updateStreamMetadata(
        this.state,
        streamId,
        this.state.streamStatus.getAllStreamStates(),
        {
          activeStream: shouldSwitch ? this.state.activeStream : undefined,
          agentFilter: filterChanged
            ? this.state.agentCategoryFilter
            : undefined,
        },
      );
    } else if (shouldSwitch) {
      this.webviewUpdater.setActiveStream(streamId);
    }
    // Always sync content for the new stream so badges/parent info reaches
    // the webview — even when we suppress the view switch. includeActiveState
    // is only relevant when this IS the active stream.
    this.syncStreamContent(streamId, {
      includeActiveState: shouldSwitch && wasKnownStream && !filterChanged,
    });
  }

  private handleGoalStateChanged(streamId: StreamTabId): void {
    const goal = GoalStore.getForStream(streamId);
    this.webviewUpdater.updateGoalActive(streamId, isGoalInFlight(goal), {
      status: goal?.status,
      objective: goal?.objective,
    });
  }

  public handleSetTaskState(data: SetTaskStateProgressFact): void {
    const { streamId, executionId, taskState } = data;
    const isActiveStream = this.state.activeStream === streamId;
    const category = taskState.agentConfig.agentCategory;

    // Legacy compatibility payload. The snapshot store derives the current
    // config and run descriptor from this but no longer writes meta.taskState.
    this.state.setStreamTaskState(
      streamId,
      taskState,
      executionId,
      this.stateOwnership,
    );

    if (isActiveStream) {
      this.maybeUpdateFilterForCategory(category);
    }

    if (this.webviewUpdater.isAvailable()) {
      // setTaskState may change agentConfig (agent name, model, label), which
      // the frontend tabs display even for background subagents. Patch only
      // the affected stream instead of rebuilding all historical stream tabs.
      this.webviewUpdater.updateStreamMetadata(
        this.state,
        streamId,
        this.state.streamStatus.getAllStreamStates(),
        {
          agentFilter: isActiveStream
            ? this.state.agentCategoryFilter
            : undefined,
        },
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
    if (!this.progressThrottleTimer) {
      this.progressThrottleTimer = setTimeout(
        () => this.flushProgressUpdates(),
        PROGRESS_THROTTLE_MS,
      );
    }
  }

  public handleUpdateRoundStage(data: UpdateRoundStagePayload): void {
    const { streamId, roundStage } = data;
    this.state.updateStreamState(streamId, (prev) => ({
      ...prev,
      roundStage,
    }));

    if (
      this.webviewUpdater.isAvailable() &&
      this.state.activeStream === streamId
    ) {
      this.webviewUpdater.updateRoundStage(streamId, roundStage);
    }
  }

  private flushProgressUpdates(): void {
    this.progressThrottleTimer = null;

    const { activeStream } = this.state;
    const progress = activeStream
      ? this.pendingProgressUpdates.get(activeStream)
      : undefined;
    if (progress && this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.updateConversationProgress(activeStream, progress);
    }
    this.pendingProgressUpdates.clear();
  }

  public updateActiveChildren(
    parentStreamId: StreamTabId,
    opts: {
      activeField: 'activeSubagents' | 'activeProcesses';
      countField: 'finishedSubagentCount' | 'finishedProcessCount';
      next: StreamExecutionState['activeSubagents'];
    },
  ): void {
    let nextBadges: StreamBadgeSnapshot | null = null;

    this.state.updateStreamState(parentStreamId, (prev) => {
      const vanishedIds = diffActiveChildren(prev[opts.activeField], opts.next);
      const updatedState = {
        ...prev,
        [opts.activeField]: opts.next,
        [opts.countField]: (prev[opts.countField] ?? 0) + vanishedIds.size,
      };
      nextBadges = this.toBadgeSnapshot(updatedState);
      return updatedState;
    });

    if (
      this.webviewUpdater.isAvailable() &&
      parentStreamId === this.state.activeStream &&
      nextBadges
    ) {
      this.webviewUpdater.updateStreamBadges(parentStreamId, nextBadges);
    }
  }

  private toBadgeSnapshot(state: StreamExecutionState): StreamBadgeSnapshot {
    return {
      activeSubagents: state.activeSubagents,
      finishedSubagentCount: state.finishedSubagentCount,
      activeProcesses: state.activeProcesses,
      finishedProcessCount: state.finishedProcessCount,
    };
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
      this.webviewUpdater.sendSyncStreamContent(
        buildStreamContentSync({ action: 'clear' }),
      );
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
      stream,
      runUsage: mapToRecord(this.state.snapshots.getRunUsage(stream)),
      activeState,
    };

    if (kind === AgentCategory.Workflow) {
      this.webviewUpdater.sendSyncStreamContent(
        buildStreamContentSync({
          ...shared,
          kind,
          files: this.state.snapshots.getOutputFiles(stream),
          missingOutputs: this.state.snapshots.getMissingOutputs(stream),
          compileFailures: this.state.snapshots.getCompileFailures(stream),
        }),
      );
      return;
    }

    const { todos, plan } = this.state.snapshots.getWorkPlan(stream);
    const controls = this.getStreamControls(stream);
    this.webviewUpdater.sendSyncStreamContent(
      buildStreamContentSync({
        ...shared,
        kind,
        todos,
        plan,
        queuedFollowUps: this.state.followUps.getAll(stream),
        toolEditBypass: controls.toolEditBypass,
        superYoloBypass: controls.superYoloBypass,
        goal: controls.goalActive
          ? {
              active: true,
              status: controls.goalStatus,
              objective: controls.goalObjective,
            }
          : { active: false },
      }),
    );
  }

  private toActiveStreamContentSync(
    stream: StreamTabId,
    state: StreamExecutionState,
  ) {
    return {
      conversationProgress: state.conversationProgress,
      roundStage: state.roundStage ?? null,
      badges: this.toBadgeSnapshot(state),
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
      const previousFilter = this.state.agentCategoryFilter;
      this.maybeUpdateFilterForCategory(streamCategory);
      const filterChanged = this.state.agentCategoryFilter !== previousFilter;
      const matchesFilter =
        this.state.agentCategoryFilter === 'all' ||
        this.state.agentCategoryFilter === category;
      if (!this.state.activeStream && matchesFilter) {
        this.state.activeStream = streamId;
      }
      let activeStream: ActiveStreamId | undefined =
        !this.state.activeStream || this.state.activeStream === streamId
          ? this.state.activeStream
          : undefined;
      let activeStreamToSync: ActiveStreamId | undefined;
      if (filterChanged) {
        const selectableStreams = buildStreamInfos(
          this.state,
          this.state.agentCategoryFilter,
        ).map((stream) => stream.name);
        const nextActiveStream =
          selectableStreams.length === 0
            ? ''
            : this.state.pickValidActiveStream(selectableStreams);
        const previousActiveStream = this.state.activeStream;
        if (nextActiveStream !== previousActiveStream) {
          this.state.activeStream = nextActiveStream;
          activeStreamToSync = nextActiveStream;
          if (
            previousActiveStream &&
            previousActiveStream !== nextActiveStream
          ) {
            this.state.releasePreviousActive(previousActiveStream);
          }
        }
        activeStream = nextActiveStream;
      }
      this.webviewUpdater.updateStreamMetadata(
        this.state,
        streamId,
        this.buildStreamStatesForRefresh(streamId, status, substate),
        {
          activeStream,
          agentFilter: this.state.agentCategoryFilter,
        },
      );
      if (activeStreamToSync !== undefined) {
        await this.syncFilterDrivenActiveStreamContent(activeStreamToSync);
      }
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

  private async syncFilterDrivenActiveStreamContent(
    stream: ActiveStreamId,
  ): Promise<void> {
    if (!stream) {
      if (this.state.activeStream === '') {
        this.syncStreamContent('');
      }
      return;
    }

    await this.state.streamLogs.ensureLoaded(stream);

    // A newer tab switch may have happened while the released log was loading.
    if (this.state.activeStream !== stream) return;

    this.syncStreamContent(stream, { includeActiveState: true });
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
