import type { AgentTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { StreamPhaseState } from '@agent/runtime/StreamStatusService';
import { isInFlightStatus } from '@common/constants/streamStatus';
import type {
  ProgressEvent,
  ProgressEventBusLike,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import { createChannelTrace } from '@logger';
import {
  STREAM_PHASE,
  type ConversationProgress,
  type GoalStatus,
  type StreamPhase,
  type StreamSubstate,
  type StreamTabId,
} from '@shared/schemas';
import { diffActiveChildren } from '@shared/streams/childActivityReducer';
import {
  WebviewUpdater,
  type LogContentExtras,
} from '@shared/progressView/backend/WebviewUpdater';
import { buildStreamInfos } from '@shared/progressView/backend/streamInfoUtils';
import { mapToRecord } from '@shared/progressView/backend/persistence/serializationUtils';
import {
  ProgressViewState,
  type ActiveStreamId,
  type StreamBadgeSnapshot,
  type StreamExecutionState,
} from '@shared/progressView/backend/state/ProgressViewState';
import { WebviewBridge } from '@shared/progressView/backend/WebviewBridge';

import { withEventErrorHandling } from './errorHandling';
import type { UICallbacks } from './UIEvents';

export type { UICallbacks };

/** Throttle interval for conversation progress webview pushes (ms). */
const PROGRESS_THROTTLE_MS = 500;

export type ProgressEventSubscription = {
  dispose(): void;
};

export interface ProgressStreamControls {
  toolEditBypass: boolean;
  superYoloBypass: boolean;
  goalActive: boolean;
  goalStatus?: GoalStatus;
  goalObjective?: string;
}

export type GetProgressStreamControls = (
  stream: StreamTabId,
) => ProgressStreamControls;

type ProgressEventRegistration<K extends ProgressEvent> = {
  readonly module: string;
  readonly context: string;
  readonly handle: (payload: ProgressEventPayloads[K]) => void | Promise<void>;
};

type ProgressEventRegistrationMap = {
  [K in ProgressEvent]?: ProgressEventRegistration<K>;
};

function getDefaultProgressStreamControls(): ProgressStreamControls {
  return {
    toolEditBypass: false,
    superYoloBypass: false,
    goalActive: false,
  };
}

/** Handles progress event bus subscriptions for the progress view. */
export class ProgressEventHandler {
  private readonly logger: AgentTrace;
  private readonly eventRegistrations: ProgressEventRegistrationMap;
  private progressThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingProgressUpdates = new Map<StreamTabId, ConversationProgress>();

  constructor(
    private state: ProgressViewState,
    private webviewUpdater: WebviewUpdater,
    private webviewBridge: WebviewBridge,
    private readonly uiCallbacks: UICallbacks,
    private readonly hasPendingPermissions: (streamId: string) => boolean,
    private readonly getStreamControls: GetProgressStreamControls = getDefaultProgressStreamControls,
  ) {
    this.logger = createChannelTrace('ProgressEventHandler');
    this.eventRegistrations = this.createEventRegistrations();
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
    const knownCategory = this.getStreamCategory(streamId);
    const category = knownCategory ?? AgentCategory.Workflow;
    this.state.clearStreamHints(streamId);
    this.state.getOrCreateStreamState(streamId, category);
    this.state.resetFinishedChildCounters(streamId);
    this.pendingProgressUpdates.delete(streamId);
    this.state.pruneInterruptHandles();

    if (this.state.activeStream === streamId) {
      this.maybeUpdateFilterForCategory(knownCategory);
    }
    return knownCategory;
  }

  private createEventRegistrations(): ProgressEventRegistrationMap {
    return {
      setActiveStream: {
        module: 'ProgressEvents',
        context: 'failed to handle setActiveStream',
        handle: (payload) => this.handleSetActiveStream(payload),
      },
      updateStreamStatus: {
        module: 'ProgressEvents',
        context: 'failed to handle updateStreamStatus',
        handle: ({ streamId, status, previousStatus, substate }) =>
          this.setStreamStatus(streamId, status, previousStatus, substate),
      },
      setTaskState: {
        module: 'ProgressEvents',
        context: 'failed to handle setTaskState',
        handle: (data) => this.handleSetTaskState(data),
      },
      updateConversationProgress: {
        module: 'ProgressEvents',
        context: 'failed to handle updateConversationProgress',
        handle: (data) => this.handleUpdateConversationProgress(data),
      },
      updateRoundStage: {
        module: 'ProgressEvents',
        context: 'failed to handle updateRoundStage',
        handle: (data) => this.handleUpdateRoundStage(data),
      },
      updateActiveSubagents: {
        module: 'ProgressEvents',
        context: 'failed to handle updateActiveSubagents',
        handle: (data) =>
          this.updateActiveChildren(data.parentStreamId, {
            activeField: 'activeSubagents',
            countField: 'finishedSubagentCount',
            next: data.children,
          }),
      },
      updateActiveProcesses: {
        module: 'ProgressEvents',
        context: 'failed to handle updateActiveProcesses',
        handle: (data) =>
          this.updateActiveChildren(data.parentStreamId, {
            activeField: 'activeProcesses',
            countField: 'finishedProcessCount',
            next: data.processes,
          }),
      },
      updateProcessOutput: {
        module: 'ProgressEvents',
        context: 'failed to handle updateProcessOutput',
        handle: (data) => {
          // Always send — output accumulates in frontend state per-stream,
          // so it must not be dropped when the stream is inactive.
          if (this.webviewUpdater.isAvailable()) {
            this.webviewUpdater.updateProcessOutput(
              data.parentStreamId,
              data.executionId,
              data.stdout,
              data.stderr,
            );
          }
        },
      },
      inquiryThreadUpdated: {
        module: 'ProgressEvents',
        context: 'failed to handle inquiryThreadUpdated',
        handle: (thread) => {
          if (this.webviewUpdater.isAvailable()) {
            this.webviewUpdater.updateInquiryThread(thread);
          }
        },
      },
      updateStreamDescription: {
        module: 'ProgressEvents',
        context: 'failed to handle updateStreamDescription',
        handle: ({ streamId, description }) => {
          this.state.snapshots.setDescription(streamId, description);
          if (this.webviewUpdater.isAvailable()) {
            this.webviewUpdater.updateStreamDescription(streamId, description);
          }
        },
      },
      setParentStream: {
        module: 'ProgressEvents',
        context: 'failed to handle setParentStream',
        handle: ({ childStreamId, parentStreamId }) => {
          this.state.snapshots.setParentStream(childStreamId, parentStreamId);
          if (this.webviewUpdater.isAvailable()) {
            this.webviewUpdater.updateParentStream(
              childStreamId,
              parentStreamId ?? undefined,
            );
          }
        },
      },
      extensionDeactivating: {
        module: 'ProgressEvents',
        context: 'failed to handle extensionDeactivating',
        handle: () => this.markAllRunningTasksAsCancelled(),
      },
      // Output events — workflow tabs hold one run; ignore the storageKey dim.
      addOutputFiles: {
        module: 'ProgressEvents',
        context: 'failed to handle addOutputFiles',
        handle: (payload) => this.handleAddOutputFiles(payload),
      },
      updateMissingOutputs: {
        module: 'ProgressEvents',
        context: 'failed to handle updateMissingOutputs',
        handle: ({ streamId, filesByRound }) => {
          this.state.snapshots.updateMissingOutputs(streamId, filesByRound);
          this.sendIfActive(streamId, () => {
            const rounds = this.state.snapshots.getMissingOutputs(streamId);
            this.webviewUpdater.updateMissingOutputs(streamId, {
              rounds: rounds.size ? mapToRecord(rounds) : undefined,
            });
          });
        },
      },
      updateCompileFailures: {
        module: 'ProgressEvents',
        context: 'failed to handle updateCompileFailures',
        handle: ({ streamId, filesByRound }) => {
          this.state.snapshots.updateCompileFailures(streamId, filesByRound);
          this.sendIfActive(streamId, () => {
            const rounds = this.state.snapshots.getCompileFailures(streamId);
            this.webviewUpdater.updateCompileFailures(streamId, {
              rounds: rounds.size ? mapToRecord(rounds) : undefined,
              reset: true,
            });
          });
        },
      },
      clearMissingOutputs: {
        module: 'ProgressEvents',
        context: 'failed to handle clearMissingOutputs',
        handle: (payload) => {
          const targets: StreamTabId[] = payload.streamId
            ? [payload.streamId]
            : payload.streamConfig
              ? this.state.snapshots.findWorkflowStreamsMatching(
                  payload.streamConfig,
                )
              : [];
          for (const streamId of targets) {
            this.state.snapshots.clearMissingOutputs(streamId);
            this.sendIfActive(streamId, () =>
              this.webviewUpdater.updateMissingOutputs(streamId, {
                reset: true,
              }),
            );
          }
        },
      },
      // Usage events — workflow tabs collapse to a single accumulated value;
      // tool-use tabs keep per-run accumulation (resume produces multiple runs).
      updateStreamUsage: {
        module: 'ProgressEvents',
        context: 'failed to handle updateStreamUsage',
        handle: ({ streamId, usage, storageKey }) => {
          void Promise.resolve(
            this.state.snapshots.addUsage(streamId, storageKey, usage),
          ).then((accumulated) => {
            if (!accumulated) return;
            this.sendIfActive(streamId, () =>
              this.webviewUpdater.updateRunUsage(
                streamId,
                storageKey,
                accumulated,
              ),
            );
          });
        },
      },
      updateTodos: {
        module: 'ProgressEvents',
        context: 'failed to handle updateTodos',
        handle: ({ streamId, todos }) => {
          this.state.snapshots.setTodos(streamId, todos);
          this.sendIfActive(streamId, () =>
            this.webviewUpdater.updateTodos(streamId, todos),
          );
        },
      },
      // Plan events are rare and critical for the approval UX, so send them
      // whenever the webview is available rather than only for the active tab.
      updatePlan: {
        module: 'ProgressEvents',
        context: 'failed to handle updatePlan',
        handle: ({ streamId, plan }) => {
          this.state.snapshots.setPlan(streamId, plan);
          if (this.webviewUpdater.isAvailable()) {
            this.webviewUpdater.updatePlan(streamId, plan);
          }
        },
      },
      updateQueuedFollowUps: {
        module: 'ProgressEvents',
        context: 'failed to handle updateQueuedFollowUps',
        handle: ({ streamId }) => {
          this.sendIfActive(streamId, () => {
            const messages = this.state.followUps.getAll(streamId);
            this.webviewUpdater.updateQueuedFollowUps(streamId, messages);
          });
        },
      },
      showRetryRequest: {
        module: 'UIEvents',
        context: 'failed to show retry request',
        handle: this.uiCallbacks.showRetryRequest,
      },
      resolveRetryRequest: {
        module: 'UIEvents',
        context: 'failed to resolve retry request',
        handle: (payload) =>
          this.uiCallbacks.resolveRetryRequest(payload.streamId),
      },
      showToolEditPermission: {
        module: 'UIEvents',
        context: 'failed to show approval prompt',
        handle: this.uiCallbacks.showToolEditPermission,
      },
      resolveToolEditPermission: {
        module: 'UIEvents',
        context: 'failed to resolve approval prompt',
        handle: (payload) =>
          this.uiCallbacks.resolveToolEditPermission(payload.requestId),
      },
      updateToolEditApprovalBypassState: {
        module: 'UIEvents',
        context: 'failed to update approval bypass state',
        handle: (payload) =>
          this.uiCallbacks.updateToolEditApprovalBypassState(
            payload.streamId,
            payload.bypassActive,
          ),
      },
      updateSuperYoloBypassState: {
        module: 'UIEvents',
        context: 'failed to update super yolo bypass state',
        handle: (payload) =>
          this.uiCallbacks.updateSuperYoloBypassState(
            payload.streamId,
            payload.bypassActive,
          ),
      },
      showBashPermission: {
        module: 'UIEvents',
        context: 'failed to show bash approval prompt',
        handle: this.uiCallbacks.showBashPermission,
      },
      resolveBashPermission: {
        module: 'UIEvents',
        context: 'failed to resolve bash approval prompt',
        handle: (payload) =>
          this.uiCallbacks.resolveBashPermission(payload.requestId),
      },
      showAgentProposal: {
        module: 'UIEvents',
        context: 'failed to show agent proposal',
        handle: this.uiCallbacks.showAgentProposal,
      },
      resolveAgentProposal: {
        module: 'UIEvents',
        context: 'failed to resolve agent proposal',
        handle: (payload) =>
          this.uiCallbacks.resolveAgentProposal(payload.proposalId),
      },
      showPlanApproval: {
        module: 'UIEvents',
        context: 'failed to show plan approval',
        handle: this.uiCallbacks.showPlanApproval,
      },
      resolvePlanApproval: {
        module: 'UIEvents',
        context: 'failed to resolve plan approval',
        handle: (payload) =>
          this.uiCallbacks.resolvePlanApproval(payload.approvalId),
      },
      showExternalInquiry: {
        module: 'UIEvents',
        context: 'failed to show external inquiry',
        handle: this.uiCallbacks.showExternalInquiry,
      },
      resolveExternalInquiry: {
        module: 'UIEvents',
        context: 'failed to resolve external inquiry',
        handle: (payload) =>
          this.uiCallbacks.resolveExternalInquiry(payload.requestId),
      },
      showUserQuestion: {
        module: 'UIEvents',
        context: 'failed to show user question',
        handle: this.uiCallbacks.showUserQuestion,
      },
      resolveUserQuestion: {
        module: 'UIEvents',
        context: 'failed to resolve user question',
        handle: (payload) =>
          this.uiCallbacks.resolveUserQuestion(payload.requestId),
      },
    };
  }

  setupEventListeners(bus: ProgressEventBusLike): ProgressEventSubscription {
    const controller = new AbortController();
    const { signal } = controller;
    const localSubscription = this.createLocalSubscription();

    for (const event of Object.keys(
      this.eventRegistrations,
    ) as ProgressEvent[]) {
      bus.on(event, (payload) => this.handleProgressEvent(event, payload), {
        signal,
      });
    }

    return {
      dispose: () => {
        controller.abort();
        localSubscription.dispose();
      },
    };
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

  handleProgressEvent<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    const registration = this.eventRegistrations[event] as
      ProgressEventRegistration<K> | undefined;
    if (!registration) return;

    withEventErrorHandling(registration.module, registration.context, () =>
      registration.handle(payload),
    );
  }

  handleAddOutputFiles({
    streamId,
    filesByRound,
  }: ProgressEventPayloads['addOutputFiles']): void {
    this.state.snapshots.addOutputFiles(streamId, filesByRound);
    this.sendIfActive(streamId, () => {
      const rounds = this.state.snapshots.getOutputFiles(streamId);
      this.webviewUpdater.updateFiles(streamId, {
        rounds: rounds.size ? mapToRecord(rounds) : undefined,
      });
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

  private async handleSetActiveStream(
    payload: ProgressEventPayloads['setActiveStream'],
  ): Promise<void> {
    const { streamId, isRemote } = payload;
    if (!streamId) return;

    const wasKnownStream = this.state.streamLogs.has(streamId);
    const previousFilter = this.state.agentCategoryFilter;
    this.state.streamLogs.ensureStream(streamId);
    // Only pass defined hint fields — spreading {key: undefined} over existing
    // hints would clear previously-set values (isRemote).
    const hints = {
      ...(payload.agentCategory !== undefined && {
        agentCategory: payload.agentCategory,
      }),
      ...(isRemote !== undefined && { isRemote }),
    };
    if (Object.keys(hints).length > 0) {
      this.state.updateStreamHints(streamId, hints);
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
    if (!wasKnownStream || filterChanged) {
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

  private handleSetTaskState(
    data: ProgressEventPayloads['setTaskState'],
  ): void {
    const { streamId, executionId, taskState } = data;
    const isActiveStream = this.state.activeStream === streamId;
    const category = taskState.agentConfig.agentCategory;

    // Legacy compatibility payload. The snapshot store derives the current
    // config and run descriptor from this but no longer writes meta.taskState.
    this.state.snapshots.setTaskState(streamId, taskState, executionId);

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

  private handleUpdateConversationProgress(
    data: ProgressEventPayloads['updateConversationProgress'],
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

  private handleUpdateRoundStage(
    data: ProgressEventPayloads['updateRoundStage'],
  ): void {
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

  private updateActiveChildren(
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

  private markAllRunningTasksAsCancelled(): void {
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
      this.webviewUpdater.sendSyncStreamContent({
        stream: '',
        action: 'clear',
        todos: [],
        plan: null,
        queuedFollowUps: [],
      });
      return;
    }

    this.webviewBridge.syncStream(stream);

    const extras = this.buildStreamSyncExtras(stream);
    const { todos, plan } = this.state.snapshots.getWorkPlan(stream);
    const queuedFollowUps = this.state.followUps.getAll(stream);
    const agentCategory = this.getStreamCategory(stream);

    // Optionally include active-stream state (replaces syncActiveStreamState).
    let conversationProgress: ConversationProgress | undefined;
    let roundStage: StreamExecutionState['roundStage'] | undefined;
    let badges: StreamBadgeSnapshot | undefined;
    let parentStreamId: StreamTabId | undefined;
    if (includeActiveState) {
      const streamState = this.state.getStreamState(stream);
      if (streamState) {
        conversationProgress = streamState.conversationProgress;
        roundStage = streamState.roundStage;
        badges = this.toBadgeSnapshot(streamState);
      }
      parentStreamId = this.state.snapshots.getParentStreamId(stream);
    }

    // Always include toggle/goal state so buttons render correctly on tab switch.
    const streamControls = this.getStreamControls(stream);

    this.webviewUpdater.sendSyncStreamContent({
      stream,
      action: 'render',
      ...extras,
      todos,
      plan,
      queuedFollowUps,
      agentCategory,
      conversationProgress,
      roundStage: includeActiveState ? (roundStage ?? null) : undefined,
      badges,
      parentStreamId,
      ...streamControls,
    });
  }

  private buildStreamSyncExtras(stream: StreamTabId): LogContentExtras {
    // Workflow files/missing outputs are flat (one run per tab).
    const workflowFiles = mapToRecord(
      this.state.snapshots.getOutputFiles(stream),
    );
    const workflowMissingOutputs = mapToRecord(
      this.state.snapshots.getMissingOutputs(stream),
    );
    const workflowCompileFailures = mapToRecord(
      this.state.snapshots.getCompileFailures(stream),
    );

    // Per-run usage map — shared by workflow and tool-use. Frontend derives
    // sessionUsage as the sum so cumulative totals survive resume.
    const runUsage = mapToRecord(this.state.snapshots.getRunUsage(stream));

    const contextState = this.state.getContextState(stream);

    return {
      workflowFiles,
      workflowMissingOutputs,
      workflowCompileFailures,
      runUsage,
      contextState,
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
    // Keep memory bounded by stream status:
    //  - returning to in-flight (e.g., background resume) eagerly rehydrates
    //    previously-released entries so pending appends from the agent
    //    runtime land on the full on-disk log instead of clobbering it via
    //    an empty getOrCreate.
    //  - leaving the in-flight set drops heavy entries; disk stays
    //    authoritative and `setActiveStream` re-reads on demand.
    if (isInFlightStatus(status)) {
      void this.state.streamLogs.ensureLoaded(streamId);
    } else if (streamId !== this.state.activeStream) {
      this.state.streamLogs.releaseEntries(streamId);
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
    const config = this.state.snapshots.getRunConfig(streamId);
    return (
      config?.agentCategory ?? this.state.getStreamHints(streamId).agentCategory
    );
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
