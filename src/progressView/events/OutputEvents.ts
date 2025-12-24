// Type imports
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local file imports
import type { ErrorBoundaryFn } from './errorHandling';
import type { BaseEventShared, StatefulEventModule } from './types';
import { toDisposables, type ProgressEventBusLike } from './types';

/**
 * OutputEvents module interface.
 * Uses StatefulEventModule pattern for state/updater access.
 */
export type OutputEventsModule = StatefulEventModule;

/**
 * Shared context for OutputEvents module.
 * Uses BaseEventShared which provides withErrorBoundary.
 */
type OutputEventsShared = BaseEventShared;

const toRoundRecord = <T>(
  rounds?: Map<number, T[]>,
): Record<number, T[]> | undefined =>
  rounds && rounds.size > 0 ? Object.fromEntries(rounds.entries()) : undefined;

const sendRunFileUpdate = (
  state: ProgressViewState,
  updater: WebviewUpdater,
  stream: string,
  runId: string,
): void => {
  if (!updater.isAvailable()) return;
  const runFiles = state.outputFiles.getFiles(stream).get(runId);
  const rounds = toRoundRecord(runFiles);
  updater.updateFiles(stream, rounds ? { runId, rounds } : { runId });
};

const sendRunMissingUpdate = (
  state: ProgressViewState,
  updater: WebviewUpdater,
  stream: string,
  runId: string,
): void => {
  if (!updater.isAvailable()) return;
  const runMissing = state.outputFiles.getMissingOutputs(stream).get(runId);
  const rounds = toRoundRecord(runMissing);
  updater.updateMissingOutputs(stream, rounds ? { runId, rounds } : { runId });
};

const resetMissingSurface = (
  state: ProgressViewState,
  updater: WebviewUpdater,
  stream: string,
): void => {
  if (state.activeStream === stream && updater.isAvailable()) {
    updater.updateMissingOutputs(stream, { reset: true });
  }
};

const registerOutputFileListeners = (
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  updater: WebviewUpdater,
  withErrorBoundary: ErrorBoundaryFn,
): (() => void)[] => [
  bus.on('addOutputFiles', ({ stream, storageKey, filesByRound }) => {
    withErrorBoundary('failed to handle addOutputFiles', async () => {
      await state.outputFiles.addFiles(stream, storageKey, filesByRound);
      sendRunFileUpdate(state, updater, stream, storageKey);
    });
  }),
  bus.on('updateMissingOutputs', ({ stream, storageKey, filesByRound }) => {
    withErrorBoundary('failed to handle updateMissingOutputs', async () => {
      await state.outputFiles.updateMissingOutputs(
        stream,
        storageKey,
        filesByRound,
      );
      sendRunMissingUpdate(state, updater, stream, storageKey);
    });
  }),
  bus.on('clearMissingOutputs', (stream) => {
    withErrorBoundary('failed to handle clearMissingOutputs', async () => {
      await state.outputFiles.clearMissingOutputs(stream);
      resetMissingSurface(state, updater, stream);
    });
  }),
];

export function createOutputEvents(
  shared: OutputEventsShared,
): OutputEventsModule {
  const { withErrorBoundary } = shared;

  return {
    register(bus, state, updater) {
      return toDisposables(
        registerOutputFileListeners(bus, state, updater, withErrorBoundary),
      );
    },
  };
}
