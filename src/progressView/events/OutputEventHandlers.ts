/**
 * Output file event handlers for progress view.
 *
 * Handles output events: addOutputFiles, updateMissingOutputs, clearMissingOutputs.
 */
import type { ProgressEventBusLike } from '@eventBus/ProgressEventBus';
import { createEventHandler, registerEventHandlers } from './errorHandling';
import {
  isWebviewAvailable,
  type EventHandlerContext,
} from './EventHandlerContext';

/** Convert Map to record if non-empty, otherwise undefined. */
function mapToRecordIfNonEmpty<K, V>(
  map: Map<K, V> | undefined,
): Record<string, V> | undefined {
  return map?.size ? (Object.fromEntries(map) as Record<string, V>) : undefined;
}

const handleAddOutputFiles = createEventHandler(
  'OutputEvents',
  'addOutputFiles',
  async (ctx, { stream, storageKey, filesByRound }) => {
    await ctx.state.outputFiles.addFiles(stream, storageKey, filesByRound);
    if (!isWebviewAvailable(ctx)) return;

    const runFiles = ctx.state.outputFiles.getFiles(stream).get(storageKey);
    const rounds = mapToRecordIfNonEmpty(runFiles);
    ctx.webviewUpdater.updateFiles(stream, { runId: storageKey, rounds });
  },
);

const handleUpdateMissingOutputs = createEventHandler(
  'OutputEvents',
  'updateMissingOutputs',
  async (ctx, { stream, storageKey, filesByRound }) => {
    await ctx.state.outputFiles.updateMissingOutputs(
      stream,
      storageKey,
      filesByRound,
    );
    if (!isWebviewAvailable(ctx)) return;

    const runMissing = ctx.state.outputFiles
      .getMissingOutputs(stream)
      .get(storageKey);
    const rounds = mapToRecordIfNonEmpty(runMissing);
    ctx.webviewUpdater.updateMissingOutputs(stream, {
      runId: storageKey,
      rounds,
    });
  },
);

const handleClearMissingOutputs = createEventHandler(
  'OutputEvents',
  'clearMissingOutputs',
  async (ctx, { stream }) => {
    await ctx.state.outputFiles.clearMissingOutputs(stream);
    // Broadcast to webview - frontend decides which run to display
    if (isWebviewAvailable(ctx)) {
      ctx.webviewUpdater.updateMissingOutputs(stream, { reset: true });
    }
  },
);

/**
 * Register output event handlers on the event bus.
 */
export function registerOutputEventHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
): void {
  registerEventHandlers(bus, ctx, signal, {
    addOutputFiles: handleAddOutputFiles,
    updateMissingOutputs: handleUpdateMissingOutputs,
    clearMissingOutputs: handleClearMissingOutputs,
  });
}
