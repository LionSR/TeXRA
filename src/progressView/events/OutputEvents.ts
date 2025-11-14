// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { AgentLogger } from '@logger/AgentLogger';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import { normalizeRunId } from '@progressView/constants/runIds';
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

const toRoundRecord = <T>(
  rounds?: Map<number, T[]>,
): Record<number, T[]> | undefined => {
  if (!rounds || rounds.size === 0) {
    return undefined;
  }

  return Object.fromEntries(rounds.entries());
};

const sendRunFileUpdate = (
  state: ProgressViewState,
  updater: WebviewUpdater,
  stream: string,
  runId: string,
): void => {
  if (state.activeStream !== stream || !updater.isAvailable()) {
    return;
  }

  const runFiles = state.outputFiles.getFiles(stream).get(runId);
  const rounds = toRoundRecord(runFiles);
  const payload = rounds ? { runId, rounds } : { runId };
  updater.updateFiles(stream, payload);
};

const sendRunMissingUpdate = (
  state: ProgressViewState,
  updater: WebviewUpdater,
  stream: string,
  runId: string,
): void => {
  if (state.activeStream !== stream || !updater.isAvailable()) {
    return;
  }

  const runMissing = state.outputFiles.getMissingOutputs(stream).get(runId);
  const rounds = toRoundRecord(runMissing);
  const payload = rounds ? { runId, rounds } : { runId };
  updater.updateMissingOutputs(stream, payload);
};

const resetFileSurface = (
  state: ProgressViewState,
  updater: WebviewUpdater,
  stream: string,
): void => {
  if (state.activeStream !== stream || !updater.isAvailable()) {
    return;
  }

  updater.updateFiles(stream, { reset: true });
};

const resetMissingSurface = (
  state: ProgressViewState,
  updater: WebviewUpdater,
  stream: string,
): void => {
  if (state.activeStream !== stream || !updater.isAvailable()) {
    return;
  }

  updater.updateMissingOutputs(stream, { reset: true });
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
        const runId = normalizeRunId(executionId ?? groupId);
        sendRunFileUpdate(state, updater, stream, runId);
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
        const runId = normalizeRunId(executionId ?? groupId);
        sendRunMissingUpdate(state, updater, stream, runId);
      });
    },
  );

  const clearMissing = bus.on('clearMissingOutputs', (stream) => {
    withErrorBoundary('failed to handle clearMissingOutputs', async () => {
      await state.outputFiles.clearMissingOutputs(stream);
      resetMissingSurface(state, updater, stream);
    });
  });

  const clearFiles = bus.on('clearOutputFiles', (stream) => {
    withErrorBoundary('failed to handle clearOutputFiles', async () => {
      await state.outputFiles.clearFiles(stream);
      resetFileSurface(state, updater, stream);
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
