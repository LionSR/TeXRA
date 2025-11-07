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
import { createErrorBoundary } from './errorHandling';
import type { ProgressEventBusLike } from './types';
import type { AgentLogger } from '@logger/AgentLogger';

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

type FilesByRound<T> = Map<number, T[]>;

interface ActiveStreamOutputUpdate {
  state: ProgressViewState;
  updater: WebviewUpdater;
  stream: string;
  updates: {
    files?: FilesByRound<OutputFileInfo> | undefined;
    missing?: FilesByRound<string> | undefined;
  };
}

const updateActiveStreamOutputs = ({
  state,
  updater,
  stream,
  updates,
}: ActiveStreamOutputUpdate): void => {
  if (state.activeStream !== stream || !updater.isAvailable()) {
    return;
  }

  if (updates.files !== undefined) {
    const payload = updates.files
      ? Object.fromEntries(updates.files.entries())
      : {};
    updater.updateFiles(stream, payload);
  }

  if (updates.missing !== undefined) {
    const payload = updates.missing
      ? Object.fromEntries(updates.missing.entries())
      : {};
    updater.updateMissingOutputs(stream, payload);
  }
};

const registerOutputFileListeners = (
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  updater: WebviewUpdater,
  withErrorBoundary: ReturnType<typeof createErrorBoundary>,
): vscode.Disposable[] => {
  const addFiles = bus.on('addOutputFiles', ({ stream, filesByRound }) => {
    withErrorBoundary('failed to handle addOutputFiles', async () => {
      await state.outputFiles.addFiles(stream, filesByRound);
      const files = state.outputFiles.getFiles(stream);
      updateActiveStreamOutputs({
        state,
        updater,
        stream,
        updates: { files },
      });
    });
  });

  const updateMissing = bus.on(
    'updateMissingOutputs',
    ({ stream, filesByRound }) => {
      withErrorBoundary('failed to handle updateMissingOutputs', async () => {
        await state.outputFiles.updateMissingOutputs(stream, filesByRound);
        const missing = state.outputFiles.getMissingOutputs(stream);
        updateActiveStreamOutputs({
          state,
          updater,
          stream,
          updates: { missing },
        });
      });
    },
  );

  const clearMissing = bus.on('clearMissingOutputs', (stream) => {
    withErrorBoundary('failed to handle clearMissingOutputs', async () => {
      await state.outputFiles.clearMissingOutputs(stream);
      updateActiveStreamOutputs({
        state,
        updater,
        stream,
        updates: { missing: new Map() },
      });
    });
  });

  const clearFiles = bus.on('clearOutputFiles', (stream) => {
    withErrorBoundary('failed to handle clearOutputFiles', async () => {
      await state.outputFiles.clearFiles(stream);
      updateActiveStreamOutputs({
        state,
        updater,
        stream,
        updates: { files: new Map() },
      });
    });
  });

  return [addFiles, updateMissing, clearMissing, clearFiles].map(
    (dispose) => new vscode.Disposable(dispose),
  );
};

const registerClearTaskOutput = (
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  withErrorBoundary: ReturnType<typeof createErrorBoundary>,
): vscode.Disposable => {
  return new vscode.Disposable(
    bus.on('clearTaskOutput', (streamTabId: StreamTabId) => {
      withErrorBoundary('failed to handle clearTaskOutput', () => {
        state.clearOutputState(streamTabId);
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
