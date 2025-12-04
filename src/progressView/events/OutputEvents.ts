// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { AgentLogger } from '@logger/AgentLogger';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local file imports
import { createErrorBoundary } from './errorHandling';

// Type imports
import type { ProgressEventBusLike } from './types';

export interface OutputEventsModule {
  register(
    bus: ProgressEventBusLike,
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): vscode.Disposable[];
}

interface OutputEventsShared {
  logger: AgentLogger;
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
  if (!updater.isAvailable()) {
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
  if (!updater.isAvailable()) {
    return;
  }

  const runMissing = state.outputFiles.getMissingOutputs(stream).get(runId);
  const rounds = toRoundRecord(runMissing);
  const payload = rounds ? { runId, rounds } : { runId };
  updater.updateMissingOutputs(stream, payload);
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
    ({ stream, storageKey, filesByRound }) => {
      withErrorBoundary('failed to handle addOutputFiles', async () => {
        // storageKey is THE single source of truth - no fallbacks
        await state.outputFiles.addFiles(stream, storageKey, filesByRound);
        sendRunFileUpdate(state, updater, stream, storageKey);
      });
    },
  );

  const updateMissing = bus.on(
    'updateMissingOutputs',
    ({ stream, storageKey, filesByRound }) => {
      withErrorBoundary('failed to handle updateMissingOutputs', async () => {
        // storageKey is THE single source of truth - no fallbacks
        await state.outputFiles.updateMissingOutputs(
          stream,
          storageKey,
          filesByRound,
        );
        sendRunMissingUpdate(state, updater, stream, storageKey);
      });
    },
  );

  const clearMissing = bus.on('clearMissingOutputs', (stream) => {
    withErrorBoundary('failed to handle clearMissingOutputs', async () => {
      await state.outputFiles.clearMissingOutputs(stream);
      resetMissingSurface(state, updater, stream);
    });
  });

  return [addFiles, updateMissing, clearMissing].map(
    (dispose) => new vscode.Disposable(dispose),
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
      return registerOutputFileListeners(
        bus,
        state,
        updater,
        withErrorBoundary,
      );
    },
  };
}
