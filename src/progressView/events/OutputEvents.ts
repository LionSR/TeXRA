// Type imports
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local file imports
import {
  createStatefulEventDisposable,
  type ProgressEventBusLike,
} from './types';
import type { BaseEventShared, StatefulEventModule } from './types';

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

/** Convert Map<number, T[]> to Record<number, T[]> for webview. */
const toRoundRecord = <T>(
  rounds?: Map<number, T[]>,
): Record<number, T[]> | undefined =>
  rounds && rounds.size > 0 ? Object.fromEntries(rounds.entries()) : undefined;

export function createOutputEvents(
  shared: OutputEventsShared,
): OutputEventsModule {
  const { withErrorBoundary } = shared;

  return {
    register(bus, state, updater) {
      return [
        createStatefulEventDisposable(
          bus,
          'addOutputFiles',
          state,
          updater,
          ({ stream, storageKey, filesByRound }) => {
            withErrorBoundary('failed to handle addOutputFiles', async () => {
              await state.outputFiles.addFiles(stream, storageKey, filesByRound);
              if (!updater.isAvailable()) return;
              const runFiles = state.outputFiles.getFiles(stream).get(storageKey);
              const rounds = toRoundRecord(runFiles);
              updater.updateFiles(
                stream,
                rounds ? { runId: storageKey, rounds } : { runId: storageKey },
              );
            });
          },
        ),
        createStatefulEventDisposable(
          bus,
          'updateMissingOutputs',
          state,
          updater,
          ({ stream, storageKey, filesByRound }) => {
            withErrorBoundary('failed to handle updateMissingOutputs', async () => {
              await state.outputFiles.updateMissingOutputs(
                stream,
                storageKey,
                filesByRound,
              );
              if (!updater.isAvailable()) return;
              const runMissing = state.outputFiles
                .getMissingOutputs(stream)
                .get(storageKey);
              const rounds = toRoundRecord(runMissing);
              updater.updateMissingOutputs(
                stream,
                rounds ? { runId: storageKey, rounds } : { runId: storageKey },
              );
            });
          },
        ),
        createStatefulEventDisposable(
          bus,
          'clearMissingOutputs',
          state,
          updater,
          (stream) => {
            withErrorBoundary('failed to handle clearMissingOutputs', async () => {
              await state.outputFiles.clearMissingOutputs(stream);
              if (state.activeStream === stream && updater.isAvailable()) {
                updater.updateMissingOutputs(stream, { reset: true });
              }
            });
          },
        ),
      ];
    },
  };
}
