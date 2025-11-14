// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { AgentLogger } from '@logger/AgentLogger';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import { createErrorBoundary } from './errorHandling';

// Type imports
import type { ProgressEventBusLike, StreamStatusType } from './types';

export interface OutputEventsModule {
  register(
    bus: ProgressEventBusLike,
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): vscode.Disposable[];
}

interface OutputEventsShared {
  logger: AgentLogger;
  refreshStreamSurface: (
    stream: string,
    options?: { updateInstruction?: boolean },
  ) => void;
  getAllStreamStatuses: () => Map<string, StreamStatusType>;
}

const updateActiveStreamOutputs = (
  state: ProgressViewState,
  updater: WebviewUpdater,
  stream: string,
): void => {
  if (state.activeStream !== stream || !updater.isAvailable()) {
    return;
  }

  const filesByRun = state.outputFiles.getFiles(stream);
  const filesPayload = Object.fromEntries(
    Array.from(filesByRun.entries(), ([runId, rounds]) => [
      runId,
      Object.fromEntries(rounds.entries()),
    ]),
  );
  updater.updateFiles(stream, filesPayload);

  const missingByRun = state.outputFiles.getMissingOutputs(stream);
  const missingPayload = Object.fromEntries(
    Array.from(missingByRun.entries(), ([runId, rounds]) => [
      runId,
      Object.fromEntries(rounds.entries()),
    ]),
  );
  updater.updateMissingOutputs(stream, missingPayload);
};

const registerOutputFileListeners = (
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  updater: WebviewUpdater,
  withErrorBoundary: ReturnType<typeof createErrorBoundary>,
): vscode.Disposable[] => {
  const addFiles = bus.on(
    'addOutputFiles',
    ({ stream, groupId, executionId, filesByRound }) => {
      withErrorBoundary('failed to handle addOutputFiles', async () => {
        await state.outputFiles.addFiles(
          stream,
          groupId ?? null,
          filesByRound,
          {
            executionId,
          },
        );
        updateActiveStreamOutputs(state, updater, stream);
      });
    },
  );

  const updateMissing = bus.on(
    'updateMissingOutputs',
    ({ stream, groupId, executionId, filesByRound }) => {
      withErrorBoundary('failed to handle updateMissingOutputs', async () => {
        await state.outputFiles.updateMissingOutputs(
          stream,
          groupId ?? null,
          filesByRound,
          { executionId },
        );
        updateActiveStreamOutputs(state, updater, stream);
      });
    },
  );

  const clearMissing = bus.on('clearMissingOutputs', (stream) => {
    withErrorBoundary('failed to handle clearMissingOutputs', async () => {
      await state.outputFiles.clearMissingOutputs(stream);
      updateActiveStreamOutputs(state, updater, stream);
    });
  });

  const clearFiles = bus.on('clearOutputFiles', (stream) => {
    withErrorBoundary('failed to handle clearOutputFiles', async () => {
      await state.outputFiles.clearFiles(stream);
      updateActiveStreamOutputs(state, updater, stream);
    });
  });

  return [addFiles, updateMissing, clearMissing, clearFiles].map(
    (dispose) => new vscode.Disposable(dispose),
  );
};

const registerClearTaskOutput = (
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  updater: WebviewUpdater,
  shared: OutputEventsShared,
  withErrorBoundary: ReturnType<typeof createErrorBoundary>,
): vscode.Disposable => {
  return new vscode.Disposable(
    bus.on('clearTaskOutput', (streamTabId: StreamTabId) => {
      withErrorBoundary('failed to handle clearTaskOutput', () => {
        const cleared = state.clearOutputState(streamTabId);
        if (cleared) {
          const activeStream = updater.updateAll(
            state,
            shared.getAllStreamStatuses(),
          );
          shared.refreshStreamSurface(activeStream);
        }
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
      disposables.push(
        registerClearTaskOutput(bus, state, updater, shared, withErrorBoundary),
      );
      return disposables;
    },
  };
}
