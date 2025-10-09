// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { WebviewUpdater } from '../managers';
import { buildStreamInfos } from '../streamInfoUtils';
import type { ProgressViewState } from '../state/ProgressViewState';
import type { StreamTabInfo } from '../types';

// @ts-ignore - Import JavaScript module
import { STATUS } from '../modules/constants.js';

// Local imports - agent
import {
  AgentSessionKind,
  AgentType,
  resolveAgentSessionMetadata,
} from '@agent/core/AgentDataclass';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - events
import type {
  ProgressEventPayloads,
  ProgressEvent,
} from '@eventBus/ProgressEventBus';
import type {
  StreamStatusType,
  StreamStatusOrReadyType,
} from './ProgressEventHandler';
import type { AgentLogger } from '@logger/AgentLogger';

interface ProgressEventBusLike {
  on<K extends ProgressEvent>(
    event: K,
    listener: (payload: ProgressEventPayloads[K]) => void,
  ): () => void;
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
  activateStream(
    payload: ProgressEventPayloads['setActiveStream'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void;
}

export function createStreamStatusEvents(
  shared: StreamStatusEventShared,
): StreamStatusEventModule {
  const handleSetActiveStream = (
    payload: ProgressEventPayloads['setActiveStream'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    const { stream, agentType, agentSessionKind } = payload;

    if (!stream) {
      return;
    }

    state.streamTabs.ensureStream(stream);

    const metadata = resolveAgentSessionMetadata(
      agentType as AgentType | undefined,
      agentSessionKind as AgentSessionKind | undefined,
    );
    state.setSessionKindHint(stream, metadata.agentSessionKind);

    const currentFilter = state.agentTypeFilter;
    if (
      currentFilter !== 'all' &&
      currentFilter !== metadata.agentSessionKind
    ) {
      state.agentTypeFilter = metadata.agentSessionKind;
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
    const { streamTabId, executionId, taskState } = data;

    state.setTaskState(streamTabId, taskState);
    state.clearSessionKindHint(streamTabId);

    const normalizedState = state.getTaskState(streamTabId);

    if (!normalizedState) {
      shared.logger.warn(
        `Received setTaskState for ${streamTabId} but no state was stored`,
      );
    } else {
      const sessionKind = resolveAgentSessionMetadata(
        normalizedState.agentType,
        normalizedState.agentSessionKind,
      ).agentSessionKind;
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
      state.setExecutionId(streamTabId, executionId as ExecutionId);
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
      updater.updateStreams(
        infos,
        state.activeStream,
        state.agentTypeFilter,
      );
    }
  };

  return {
    register(
      bus: ProgressEventBusLike,
      state: ProgressViewState,
      updater: WebviewUpdater,
    ): vscode.Disposable[] {
      return [
        new vscode.Disposable((
          bus.on('setActiveStream', (payload) =>
            handleSetActiveStream(payload, state, updater),
          )
        )),
        new vscode.Disposable((
          bus.on('updateStreamStatus', (payload) =>
            shared.setStreamStatus(payload.stream, payload.status),
          )
        )),
        new vscode.Disposable((
          bus.on('setTaskState', (payload) =>
            handleSetTaskState(payload, state, updater),
          )
        )),
      ];
    },
    activateStream(
      payload: ProgressEventPayloads['setActiveStream'],
      state: ProgressViewState,
      updater: WebviewUpdater,
    ): void {
      handleSetActiveStream(payload, state, updater);
    },
  };
}
