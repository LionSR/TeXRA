// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local file imports
import { sendIfActive, type ProgressEventBusLike } from './types';
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'OutputEvents';

/** Convert Map<number, T[]> to Record<number, T[]> for webview. */
const toRoundRecord = <T>(
  rounds?: Map<number, T[]>,
): Record<number, T[]> | undefined =>
  rounds && rounds.size > 0 ? Object.fromEntries(rounds.entries()) : undefined;

/**
 * Register output event handlers.
 */
export function registerOutputEvents(
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  updater: WebviewUpdater,
): vscode.Disposable[] {
  return [
    new vscode.Disposable(
      bus.on('addOutputFiles', ({ stream, storageKey, filesByRound }) => {
        withEventErrorHandling(
          MODULE,
          'failed to handle addOutputFiles',
          async () => {
            await state.outputFiles.addFiles(stream, storageKey, filesByRound);
            if (!updater.isAvailable()) return;
            const runFiles = state.outputFiles.getFiles(stream).get(storageKey);
            const rounds = toRoundRecord(runFiles);
            updater.updateFiles(
              stream,
              rounds ? { runId: storageKey, rounds } : { runId: storageKey },
            );
          },
        );
      }),
    ),
    new vscode.Disposable(
      bus.on(
        'updateMissingOutputs',
        ({ stream, storageKey, filesByRound }) => {
          withEventErrorHandling(
            MODULE,
            'failed to handle updateMissingOutputs',
            async () => {
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
            },
          );
        },
      ),
    ),
    new vscode.Disposable(
      bus.on('clearMissingOutputs', ({ stream }) => {
        withEventErrorHandling(
          MODULE,
          'failed to handle clearMissingOutputs',
          async () => {
            await state.outputFiles.clearMissingOutputs(stream);
            sendIfActive(stream, state, updater, () => {
              updater.updateMissingOutputs(stream, { reset: true });
            });
          },
        );
      }),
    ),
  ];
}
