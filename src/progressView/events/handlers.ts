// Third-party imports
import type { OutputFileInfo } from '@agent/output/types';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import type { TaskGroup } from '@logger/LogTypes';
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Internal imports
import type { WebviewUpdater } from '@progressView/managers';
import { buildStreamInfos } from '@progressView/streamInfoUtils';
import type { StreamTabInfo } from '@progressView/types';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type {
  ProgressEventPayloads,
  StreamStatus,
} from '@eventBus/ProgressEventBus';

// Local imports
import { withEventErrorHandling } from './errorHandling';
import { sendIfActive } from './types';

// ============================================================================
// Log Event Handlers
// ============================================================================

export const handleAddLogMessage = (
  data: ProgressEventPayloads['addLogMessage'],
  state: ProgressViewState,
  updater: WebviewUpdater,
): void => {
  withEventErrorHandling(
    'LogEvents',
    'failed to handle addLogMessage',
    async () => {
      const { stream, logMessage } = data;
      const isNew = await state.streamTabs.addMessage(stream, logMessage);
      if (isNew && updater.isAvailable()) {
        updater.appendLogMessage(stream, logMessage);
      }
    },
  );
};

export const handleUpdateLogMessage = (
  data: ProgressEventPayloads['updateLogMessage'],
  state: ProgressViewState,
  updater: WebviewUpdater,
): void => {
  withEventErrorHandling(
    'LogEvents',
    'failed to handle updateLogMessage',
    async () => {
      const { stream, logMessage } = data;

      if (!state.streamTabs.has(stream)) {
        return;
      }

      const messages = state.streamTabs.getMessages(stream);
      const existing = messages.find((m) => m.id === logMessage.id);
      if (!existing) return;

      if (
        existing.messageType === MESSAGE_TYPES.INTERNAL ||
        logMessage.messageType === MESSAGE_TYPES.INTERNAL
      ) {
        return;
      }

      // Update fields if provided
      if (logMessage.text !== undefined) existing.text = logMessage.text;
      if (logMessage.messageType !== undefined)
        existing.messageType = logMessage.messageType;
      if (logMessage.level) existing.level = logMessage.level;
      if (logMessage.timestamp !== undefined)
        existing.timestamp = logMessage.timestamp;
      if (logMessage.verbose !== undefined)
        existing.verbose = logMessage.verbose;
      if (logMessage.data !== undefined) existing.data = logMessage.data;

      await state.streamTabs.save();

      sendIfActive(stream, state, updater, () => {
        updater.updateLogMessage(stream, existing);
      });
    },
  );
};

// ============================================================================
// Output Event Handlers
// ============================================================================

/** Convert Map<number, T[]> to Record<number, T[]> for webview. */
const toRoundRecord = <T>(
  rounds?: Map<number, T[]>,
): Record<number, T[]> | undefined =>
  rounds && rounds.size > 0 ? Object.fromEntries(rounds.entries()) : undefined;

export const handleAddOutputFiles = (
  data: ProgressEventPayloads['addOutputFiles'],
  state: ProgressViewState,
  updater: WebviewUpdater,
): void => {
  withEventErrorHandling(
    'OutputEvents',
    'failed to handle addOutputFiles',
    async () => {
      const { stream, storageKey, filesByRound } = data;
      await state.outputFiles.addFiles(stream, storageKey, filesByRound);
      if (!updater.isAvailable()) return;
      const runFiles = state.outputFiles.getFiles(stream).get(storageKey);
      const rounds = toRoundRecord(runFiles);
      updater.updateFiles(
        stream,
        rounds ? { runId: storageKey, rounds } : { runId: storageKey },
      );
    },
  );
};

export const handleUpdateMissingOutputs = (
  data: ProgressEventPayloads['updateMissingOutputs'],
  state: ProgressViewState,
  updater: WebviewUpdater,
): void => {
  withEventErrorHandling(
    'OutputEvents',
    'failed to handle updateMissingOutputs',
    async () => {
      const { stream, storageKey, filesByRound } = data;
      await state.outputFiles.updateMissingOutputs(
        stream,
        storageKey,
        filesByRound,
      );
      if (!updater.isAvailable()) return;
      const runMissing = state.outputFiles
        .getMissingOutputs(stream)
        .get(storageKey);
      const rounds = toRoundRecord(runMissing);
      updater.updateMissingOutputs(
        stream,
        rounds ? { runId: storageKey, rounds } : { runId: storageKey },
      );
    },
  );
};

export const handleClearMissingOutputs = (
  data: ProgressEventPayloads['clearMissingOutputs'],
  state: ProgressViewState,
  updater: WebviewUpdater,
): void => {
  withEventErrorHandling(
    'OutputEvents',
    'failed to handle clearMissingOutputs',
    async () => {
      const { stream } = data;
      await state.outputFiles.clearMissingOutputs(stream);
      sendIfActive(stream, state, updater, () => {
        updater.updateMissingOutputs(stream, { reset: true });
      });
    },
  );
};

// ============================================================================
// Usage Event Handlers
// ============================================================================

export const handleUpdateStreamUsage = (
  data: ProgressEventPayloads['updateStreamUsage'],
  state: ProgressViewState,
  updater: WebviewUpdater,
): void => {
  withEventErrorHandling(
    'UsageEvents',
    'failed to handle updateStreamUsage',
    async () => {
      const { stream, usage, storageKey } = data;
      const normalizedUsage: TokenUsageStats = {
        inputTokens: Number(usage.inputTokens ?? 0),
        outputTokens: Number(usage.outputTokens ?? 0),
        cost: Number(usage.cost ?? 0),
      };

      await state.usageStats.setRunUsage(stream, storageKey, normalizedUsage);

      sendIfActive(stream, state, updater, () => {
        updater.updateRunUsage(stream, storageKey, normalizedUsage);
      });
    },
  );
};

// ============================================================================
// Todo Event Handlers
// ============================================================================

export const handleUpdateTodos = (
  data: ProgressEventPayloads['updateTodos'],
  state: ProgressViewState,
  updater: WebviewUpdater,
): void => {
  withEventErrorHandling('TodoEvents', 'failed to handle updateTodos', () => {
    const { stream, todos } = data;
    state.setTodos(stream, todos);
    sendIfActive(stream, state, updater, () => {
      updater.updateTodos(stream, todos);
    });
  });
};

// ============================================================================
// Stream Status Event Handlers
// ============================================================================

export interface StreamStatusHandlerShared {
  streamStatus: Map<string, StreamStatus>;
  setStreamStatus(stream: string, status: StreamStatus): void;
  sendInstructionUpdate(stream: StreamTabId | '', runId?: string | null): void;
  refreshStreamSurface(
    stream: string,
    options?: { updateInstruction?: boolean; forceRebuild?: boolean },
  ): string | null;
  debugLog(message: string): void;
  replayPendingTaskGroups(stream: string, updater: WebviewUpdater): void;
}

export const handleSetActiveStream = (
  payload: ProgressEventPayloads['setActiveStream'],
  state: ProgressViewState,
  updater: WebviewUpdater,
  shared: StreamStatusHandlerShared,
): void => {
  withEventErrorHandling(
    'StreamStatusEvents',
    'failed to handle setActiveStream',
    async () => {
      const { stream, session, isRemote, hasMultipleOutputs } = payload;

      if (!stream) {
        return;
      }

      // Track if this is actually switching to a different stream
      const previousStream = state.activeStream;
      const isStreamSwitch = previousStream !== stream;

      await state.streamTabs.ensureStream(stream);

      // Store hints so the UI can show indicators before the full TaskState is set
      state.updateStreamHints(stream, {
        sessionCategory: session?.agentCategory,
        isRemote,
        hasMultipleOutputs,
      });

      const currentFilter = state.agentTypeFilter;
      const targetCategory = session?.agentCategory;
      if (
        targetCategory &&
        currentFilter !== 'all' &&
        currentFilter !== targetCategory
      ) {
        state.agentTypeFilter = targetCategory;
      }

      state.activeStream = stream;

      // Replay any task groups that were buffered before this stream became active.
      // Must be called AFTER setting state.activeStream so subsequent events see it.
      if (updater.isAvailable()) {
        shared.replayPendingTaskGroups(stream, updater);
      }

      const status: StreamStatus =
        shared.streamStatus.get(stream) ?? STREAM_STATUS.RUNNING;

      if (updater.isAvailable()) {
        // ORDERING REQUIREMENTS:
        // 1. ensureStream (line 70) must be awaited BEFORE this block to ensure
        //    backend state.streamTabs.has(stream) returns true in setStreamStatus.
        // 2. updateAll sends UPDATE_STREAMS which creates the frontend tab.
        // 3. setStreamStatus sends UPDATE_STREAM_STATUS to update the existing tab.
        // Frontend processes messages FIFO, so tab exists before status update.
        // If setStreamStatus is called before stream is in backend state, it will
        // trigger another full updateAll, which is inefficient but safe.
        updater.updateAll(state, shared.streamStatus);
      }

      shared.setStreamStatus(stream, status);

      if (updater.isAvailable()) {
        // Only force rebuild when actually switching streams.
        // Use the returned runId to avoid duplicate resolveRunId call.
        const activeRunId = shared.refreshStreamSurface(stream, {
          updateInstruction: false,
          forceRebuild: isStreamSwitch,
        });
        shared.sendInstructionUpdate(stream, activeRunId);
      }
    },
  );
};

export const handleUpdateStreamStatus = (
  payload: ProgressEventPayloads['updateStreamStatus'],
  shared: StreamStatusHandlerShared,
): void => {
  withEventErrorHandling(
    'StreamStatusEvents',
    'failed to handle updateStreamStatus',
    () => shared.setStreamStatus(payload.stream, payload.status),
  );
};

export const handleSetTaskState = (
  data: ProgressEventPayloads['setTaskState'],
  state: ProgressViewState,
  updater: WebviewUpdater,
  shared: StreamStatusHandlerShared,
): void => {
  withEventErrorHandling(
    'StreamStatusEvents',
    'failed to handle setTaskState',
    () => {
      const { streamTabId, executionId, taskState } = data;

      state.setTaskState(streamTabId, taskState);
      // Note: setTaskState already clears stream hints

      // Use taskState directly - no need to re-fetch what we just stored
      const sessionKind = taskState.agentConfig.session.agentCategory;
      const currentFilter = state.agentTypeFilter;
      const activeStream = state.activeStream;

      if (
        activeStream &&
        activeStream === streamTabId &&
        currentFilter !== 'all' &&
        currentFilter !== sessionKind
      ) {
        shared.debugLog(
          `Adjusting agent filter from ${currentFilter} to ${sessionKind} for stream ${streamTabId}`,
        );
        state.agentTypeFilter = sessionKind;
      }

      if (executionId) {
        state.setExecutionId(streamTabId, executionId);
      }

      if (state.activeStream === streamTabId) {
        shared.sendInstructionUpdate(streamTabId);
      }

      if (updater.isAvailable()) {
        const infos: StreamTabInfo[] = buildStreamInfos(
          state,
          shared.streamStatus,
          state.agentTypeFilter,
        );
        updater.updateStreams(infos, state.activeStream, state.agentTypeFilter);
      }
    },
  );
};

// ============================================================================
// Task Group Event Handlers
// ============================================================================

export interface TaskGroupHandlerShared {
  initializeStreamForTaskGroup(stream: string): Promise<void>;
  debugLog(message: string): void;
  bufferTaskGroupForReplay(stream: string, group: TaskGroup): void;
}

export const handleAddTaskGroup = (
  data: ProgressEventPayloads['addTaskGroup'],
  state: ProgressViewState,
  updater: WebviewUpdater,
  shared: TaskGroupHandlerShared,
): void => {
  shared.debugLog(
    `addTaskGroup: id=${data.id}, name=${data.name}, parentGroupId=${data.parentGroupId ?? 'none'}, stream=${data.stream}`,
  );

  withEventErrorHandling(
    'TaskGroupEvents',
    'failed to handle addTaskGroup',
    async () => {
      const { stream, ...group } = data;
      const { id, parentGroupId } = group;

      const hasStream = state.streamTabs.has(stream);

      // Add group to state BEFORE initializeStreamForTaskGroup, so that
      // refreshStreamSurface (called inside) includes this group in UPDATE_LOGS.
      // addGroup synchronously adds to in-memory state; save is async.
      const addGroupPromise = state.taskGroups.addGroup(stream, id, group);

      if (!parentGroupId) {
        state.setActiveRunId(stream, id);
      }

      if (!hasStream) {
        shared.debugLog(`Creating stream from addTaskGroup: ${stream}`);
        // Initialize stream after group is in state. This sends UPDATE_LOGS
        // with forceRebuild: true, which will include the new group.
        await shared.initializeStreamForTaskGroup(stream);
      }

      // Send ADD_TASK_GROUP to frontend only if this stream is currently active.
      // If the stream isn't active yet (addTaskGroup arrived before setActiveStream),
      // buffer the group for replay when setActiveStream is processed.
      // This fixes the race condition where Init groups are dropped by the frontend
      // because state.activeStream isn't set when the ADD_TASK_GROUP message arrives.
      if (updater.isAvailable()) {
        if (stream === state.activeStream) {
          updater.addTaskGroup(stream, group);
        } else {
          shared.debugLog(
            `Buffering task group ${id} for stream ${stream} (activeStream=${state.activeStream})`,
          );
          shared.bufferTaskGroupForReplay(stream, group);
        }
      }

      // Ensure group persistence completes
      await addGroupPromise;
    },
  );
};

export const handleUpdateTaskGroup = (
  data: ProgressEventPayloads['updateTaskGroup'],
  state: ProgressViewState,
  updater: WebviewUpdater,
  shared: TaskGroupHandlerShared,
): void => {
  shared.debugLog(
    `updateTaskGroup: id=${data.id}, status=${data.status}, stream=${data.stream}`,
  );

  withEventErrorHandling(
    'TaskGroupEvents',
    'failed to handle updateTaskGroup',
    async () => {
      // Pass event data directly - no transformation needed
      await state.taskGroups.updateGroup(data);

      const shouldSendToWebview =
        updater.isAvailable() && data.stream === state.activeStream;
      shared.debugLog(
        `updateTaskGroup: shouldSendToWebview=${shouldSendToWebview}, activeStream=${state.activeStream}`,
      );

      if (shouldSendToWebview) {
        updater.updateTaskGroup(data);
      }
    },
  );
};
