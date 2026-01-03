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
  streamStatus: Map<string, StreamStatus>;
  /** Updates status map only. Use for complex flows that handle their own UI updates. */
  setStreamStatus(stream: string, status: StreamStatus): void;
  /** Updates status map AND sends UI update. Use for standalone status changes. */
  updateStreamStatusWithUI(stream: string, status: StreamStatus): void;
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

    const status: StreamStatus =
      shared.streamStatus.get(stream) ?? STREAM_STATUS.RUNNING;

    // Update status map (no UI side effects)
    shared.setStreamStatus(stream, status);

    if (updater.isAvailable()) {
      // Update tab list, then content
      updater.updateAll(state, shared.streamStatus);
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
        shared.streamStatus,
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
              shared.updateStreamStatusWithUI(payload.stream, payload.status),
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
