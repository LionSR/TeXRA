// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import type { WebviewUpdater } from '@progressView/managers';
import type { StreamTabInfo } from '@progressView/types';
import { buildStreamInfos } from '@progressView/streamInfoUtils';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type {
  ProgressEventPayloads,
  StreamStatus,
} from '@eventBus/ProgressEventBus';

// Local imports
import type {
  BaseEventShared,
  ProgressEventBusLike,
  StatefulEventModule,
} from './types';

/**
 * Shared context for StreamStatusEvents module.
 * Extends BaseEventShared with stream status management callbacks.
 * Also requires logging callbacks for warn/debug messages.
 */
export interface StreamStatusEventShared extends BaseEventShared {
  /** Get status for a specific stream from StreamStatusService */
  getStreamStatus(stream: string): StreamStatus;
  /** Get all stream statuses from StreamStatusService */
  getAllStreamStatuses(): Map<StreamTabId, StreamStatus>;
  /** Notify webview of status change (status already updated in service) */
  notifyStreamStatus(stream: string, status: StreamStatus): void;
  sendInstructionUpdate(stream: StreamTabId | '', runId?: string | null): void;
  refreshStreamSurface(
    stream: string,
    options?: { updateInstruction?: boolean; forceRebuild?: boolean },
  ): void;
  warnLog(message: string): void;
  debugLog(message: string): void;
}

/**
 * StreamStatusEvents module interface.
 * Uses StatefulEventModule pattern for state/updater access.
 */
export type StreamStatusEventModule = StatefulEventModule;

export function createStreamStatusEvents(
  shared: StreamStatusEventShared,
): StreamStatusEventModule {
  const { withErrorBoundary, warnLog, debugLog } = shared;

  const handleSetActiveStream = async (
    payload: ProgressEventPayloads['setActiveStream'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): Promise<void> => {
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

    const currentStatus = shared.getStreamStatus(stream);
    const status: StreamStatus =
      currentStatus !== STREAM_STATUS.READY
        ? currentStatus
        : STREAM_STATUS.RUNNING;

    if (updater.isAvailable()) {
      // ORDERING REQUIREMENTS:
      // 1. ensureStream (line 70) must be awaited BEFORE this block to ensure
      //    backend state.streamTabs.has(stream) returns true in notifyStreamStatus.
      // 2. updateAll sends UPDATE_STREAMS which creates the frontend tab.
      // 3. notifyStreamStatus sends UPDATE_STREAM_STATUS to update the existing tab.
      // Frontend processes messages FIFO, so tab exists before status update.
      updater.updateAll(state, shared.getAllStreamStatuses());
    }

    shared.notifyStreamStatus(stream, status);

    if (updater.isAvailable()) {
      // Only force rebuild when actually switching streams
      shared.refreshStreamSurface(stream, {
        updateInstruction: false,
        forceRebuild: isStreamSwitch,
      });
      shared.sendInstructionUpdate(stream);
    }
  };

  const handleSetTaskState = (
    data: ProgressEventPayloads['setTaskState'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    const { streamTabId, executionId, taskState } = data;

    state.setTaskState(streamTabId, taskState);
    // Note: setTaskState already clears stream hints

    const normalizedState = state.getTaskState(streamTabId);

    if (!normalizedState) {
      warnLog(
        `Received setTaskState for ${streamTabId} but no state was stored`,
      );
    } else {
      const sessionKind = normalizedState.agentConfig.session.agentCategory;
      const currentFilter = state.agentTypeFilter;
      const activeStream = state.activeStream;

      if (
        activeStream &&
        activeStream === streamTabId &&
        currentFilter !== 'all' &&
        currentFilter !== sessionKind
      ) {
        debugLog(
          `Adjusting agent filter from ${currentFilter} to ${sessionKind} for stream ${streamTabId}`,
        );
        state.agentTypeFilter = sessionKind;
      }
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
        shared.getAllStreamStatuses(),
        state.agentTypeFilter,
      );
      updater.updateStreams(infos, state.activeStream, state.agentTypeFilter);
    }
  };

  return {
    register(
      bus: ProgressEventBusLike,
      state: ProgressViewState,
      updater: WebviewUpdater,
    ): vscode.Disposable[] {
      return [
        new vscode.Disposable(
          bus.on('setActiveStream', (payload) =>
            withErrorBoundary('failed to handle setActiveStream', () =>
              handleSetActiveStream(payload, state, updater),
            ),
          ),
        ),
        new vscode.Disposable(
          bus.on('updateStreamStatus', (payload) =>
            withErrorBoundary('failed to handle updateStreamStatus', () =>
              shared.notifyStreamStatus(payload.stream, payload.status),
            ),
          ),
        ),
        new vscode.Disposable(
          bus.on('setTaskState', (payload) =>
            withErrorBoundary('failed to handle setTaskState', () =>
              handleSetTaskState(payload, state, updater),
            ),
          ),
        ),
      ];
    },
  };
}
