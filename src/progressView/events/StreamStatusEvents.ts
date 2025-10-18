// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { WebviewUpdater } from '../managers';
import { buildStreamInfos } from '../streamInfoUtils';
import type { ProgressViewState } from '../state/ProgressViewState';
import type { StreamTabInfo } from '../types';

import { STATUS } from '../modules/constants.js';

// Local imports - agent
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - events
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { createErrorBoundary } from './errorHandling';
import type {
  ProgressEventBusLike,
  StreamStatusType,
  StreamStatusOrReadyType,
} from './types';
import type { AgentLogger } from '@logger/AgentLogger';

// Thresholds for determining when to show instruction toggle
const INSTRUCTION_TOGGLE_LINE_THRESHOLD = 6;
const INSTRUCTION_TOGGLE_CHAR_THRESHOLD = 600;

/**
 * Compute instruction metadata based on content length.
 * Determines whether to show a toggle for long instructions.
 * @param text - The instruction text to analyze
 * @returns Metadata object with showToggle hint, or undefined if no metadata needed
 */
export function computeInstructionMetadata(
  text: string,
): { showToggle: true } | undefined {
  const lineCount = text.split(/\r?\n/).length;
  if (
    lineCount > INSTRUCTION_TOGGLE_LINE_THRESHOLD ||
    text.length > INSTRUCTION_TOGGLE_CHAR_THRESHOLD
  ) {
    return { showToggle: true };
  }
  return undefined;
}

export interface StreamStatusEventShared {
  logger: AgentLogger;
  streamStatus: Map<string, StreamStatusType>;
  setStreamStatus(stream: string, status: StreamStatusOrReadyType): void;
  sendInstructionUpdate(stream: StreamTabId | ''): void;
  updateLogContentForStream(
    stream: string,
    options?: { updateInstruction?: boolean },
  ): void;
}

export interface StreamStatusEventModule {
  register(
    bus: ProgressEventBusLike,
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): vscode.Disposable[];
}

export function createStreamStatusEvents(
  shared: StreamStatusEventShared,
): StreamStatusEventModule {
  const withErrorBoundary = createErrorBoundary(
    shared.logger,
    'StreamStatusEvents',
  );

  const handleSetActiveStream = (
    payload: ProgressEventPayloads['setActiveStream'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    const { stream, session } = payload;

    if (!stream) {
      return;
    }

    state.streamTabs.ensureStream(stream);

    if (session) {
      state.setSessionKindHint(stream, session.agentCategory);
    }

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

    const status: StreamStatusOrReadyType =
      shared.streamStatus.get(stream) ?? STATUS.RUNNING;
    shared.setStreamStatus(stream, status);

    if (updater.isAvailable()) {
      shared.updateLogContentForStream(stream, { updateInstruction: false });
      shared.sendInstructionUpdate(stream);
    }
  };

  const handleSetTaskState = (
    data: ProgressEventPayloads['setTaskState'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    const { streamTabId, executionId, taskState, taskGroupId } = data;

    state.setTaskState(streamTabId, taskState);
    state.clearSessionKindHint(streamTabId);

    const normalizedState = state.getTaskState(streamTabId);

    if (!normalizedState) {
      shared.logger.warn(
        `Received setTaskState for ${streamTabId} but no state was stored`,
      );
    } else {
      const sessionKind = normalizedState.session.agentCategory;
      const currentFilter = state.agentTypeFilter;
      const activeStream = state.activeStream;

      if (
        activeStream &&
        activeStream === streamTabId &&
        currentFilter !== 'all' &&
        currentFilter !== sessionKind
      ) {
        shared.logger.debug(
          `Adjusting agent filter from ${currentFilter} to ${sessionKind} for stream ${streamTabId}`,
        );
        state.agentTypeFilter = sessionKind;
      }
    }

    if (executionId) {
      state.setExecutionId(streamTabId, executionId);
    }

    const trimmedInstruction = taskState.agentConfig?.instruction?.trim() ?? '';
    const candidateGroupId =
      taskGroupId ?? state.getLatestTaskGroupId(streamTabId);

    if (taskGroupId) {
      state.setLatestTaskGroupId(streamTabId, taskGroupId);
    }

    if (candidateGroupId) {
      const instructionMetadata = trimmedInstruction
        ? {
            text: trimmedInstruction,
            executionId,
            updatedAt: Date.now(),
            metadata: computeInstructionMetadata(trimmedInstruction),
          }
        : undefined;

      state.taskGroups.updateGroup(streamTabId, candidateGroupId, {
        instruction: instructionMetadata,
      });
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
              shared.setStreamStatus(payload.stream, payload.status),
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
