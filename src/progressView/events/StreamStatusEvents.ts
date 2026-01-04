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
import {
  createStatefulEventDisposable,
  type ProgressEventBusLike,
  type StatefulEventModule,
} from './types';
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'StreamStatusEvents';

/**
 * Callbacks for stream status event handling.
 */
export interface StreamStatusEventShared {
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

export type StreamStatusEventModule = StatefulEventModule;

export function createStreamStatusEvents(
  shared: StreamStatusEventShared,
): StreamStatusEventModule {
  const { debugLog } = shared;

  const handleSetActiveStream = (
    payload: ProgressEventPayloads['setActiveStream'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    withEventErrorHandling(
      MODULE,
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

  const handleSetTaskState = (
    data: ProgressEventPayloads['setTaskState'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    withEventErrorHandling(MODULE, 'failed to handle setTaskState', () => {
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
        debugLog(
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
    });
  };

  return {
    register(bus, state, updater) {
      return [
        createStatefulEventDisposable(
          bus,
          'setActiveStream',
          state,
          updater,
          handleSetActiveStream,
        ),
        createStatefulEventDisposable(
          bus,
          'updateStreamStatus',
          state,
          updater,
          (payload) => {
            withEventErrorHandling(
              MODULE,
              'failed to handle updateStreamStatus',
              () => shared.setStreamStatus(payload.stream, payload.status),
            );
          },
        ),
        createStatefulEventDisposable(
          bus,
          'setTaskState',
          state,
          updater,
          handleSetTaskState,
        ),
      ];
    },
  };
}
