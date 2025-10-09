// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { WebviewUpdater } from '../managers';
import type { ProgressViewState } from '../state/ProgressViewState';

// Local imports - agent
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { OutputFileInfo } from '@agent/output/types';

// Local imports - events
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { isWorkflowTaskState } from '@logger/TaskState';

import type { AgentLogger } from '@logger/AgentLogger';
import type { ErrorBoundary, ProgressEventBusLike } from './types';
import { createErrorBoundary } from './errorHandling';

export interface OutputEventsModule {
  register(
    bus: ProgressEventBusLike,
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): vscode.Disposable[];
}

type FilesByRound<T> = { [key: number]: T[] };

interface OutputEventsShared {
  logger: AgentLogger;
}

const updateActiveStreamOutputs = (
  state: ProgressViewState,
  updater: WebviewUpdater,
  stream: string,
  updates: {
    files?: FilesByRound<OutputFileInfo> | undefined;
    missing?: FilesByRound<string> | undefined;
  },
): void => {
  if (state.activeStream !== stream || !updater.isAvailable()) {
    return;
  }

  if (updates.files !== undefined) {
    updater.updateFiles(stream, updates.files ?? {});
  }

  if (updates.missing !== undefined) {
    updater.updateMissingOutputs(stream, updates.missing ?? {});
  }
};

const registerOutputFileListeners = (
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  updater: WebviewUpdater,
  withErrorBoundary: ErrorBoundary,
): vscode.Disposable[] => {
  const addFiles = bus.on('addOutputFiles', ({ stream, filesByRound }) => {
    withErrorBoundary('failed to handle addOutputFiles', () => {
      state.outputFiles.addFiles(stream, filesByRound);
      const files = state.outputFiles.getFiles(stream);
      updateActiveStreamOutputs(state, updater, stream, { files });
    });
  });

  const updateMissing = bus.on(
    'updateMissingOutputs',
    ({ stream, filesByRound }) => {
      withErrorBoundary('failed to handle updateMissingOutputs', () => {
        state.outputFiles.updateMissingOutputs(stream, filesByRound);
        const missing = state.outputFiles.getMissingOutputs(stream);
        updateActiveStreamOutputs(state, updater, stream, { missing });
      });
    },
  );

  const clearMissing = bus.on('clearMissingOutputs', (stream) => {
    withErrorBoundary('failed to handle clearMissingOutputs', () => {
      state.outputFiles.clearMissingOutputs(stream);
      updateActiveStreamOutputs(state, updater, stream, { missing: {} });
    });
  });

  const clearFiles = bus.on('clearOutputFiles', (stream) => {
    withErrorBoundary('failed to handle clearOutputFiles', () => {
      state.outputFiles.clearFiles(stream);
      updateActiveStreamOutputs(state, updater, stream, { files: {} });
    });
  });

  return [addFiles, updateMissing, clearMissing, clearFiles].map(
    (dispose) => new vscode.Disposable(dispose),
  );
};

const registerClearTaskOutput = (
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  withErrorBoundary: ErrorBoundary,
): vscode.Disposable => {
  return new vscode.Disposable(
    bus.on('clearTaskOutput', (streamTabId: StreamTabId) => {
      withErrorBoundary('failed to handle clearTaskOutput', () => {
        const taskState = state.getTaskState(streamTabId);
        if (!taskState || !isWorkflowTaskState(taskState)) {
          return;
        }

        taskState.agentConfig.outputFiles = [];
        taskState.agentConfig.useMultipleOutputs = false;
        taskState.activeFiles.output = false;
        state.setTaskState(streamTabId, taskState);
      });
    }),
  );
};

export function createOutputEvents(
  shared: OutputEventsShared,
): OutputEventsModule {
  const withErrorBoundary = createErrorBoundary(shared.logger, 'OutputEvents');

  return {
    register(
      bus: ProgressEventBusLike,
      state: ProgressViewState,
      updater: WebviewUpdater,
    ): vscode.Disposable[] {
      const disposables = registerOutputFileListeners(
        bus,
        state,
        updater,
        withErrorBoundary,
      );
      disposables.push(registerClearTaskOutput(bus, state, withErrorBoundary));
      return disposables;
    },
  };
}
