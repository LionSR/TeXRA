/**
 * Output file event handlers for progress view.
 *
 * Handles output events: addOutputFiles, updateMissingOutputs, clearMissingOutputs.
 */
import type {
  ProgressEventBusLike,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import { withEventErrorHandling } from './errorHandling';
import type { EventHandlerContext } from './EventHandlerContext';

/** Convert Map to record if non-empty, otherwise undefined. */
function mapToRecordIfNonEmpty<K, V>(
  map: Map<K, V> | undefined,
): Record<string, V> | undefined {
  return map?.size ? (Object.fromEntries(map) as Record<string, V>) : undefined;
}

/**
 * Register output event handlers on the event bus.
 */
export function registerOutputEventHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
): void {
  bus.on('addOutputFiles', (payload) => handleAddOutputFiles(ctx, payload), {
    signal,
  });
  bus.on(
    'updateMissingOutputs',
    (payload) => handleUpdateMissingOutputs(ctx, payload),
    { signal },
  );
  bus.on(
    'clearMissingOutputs',
    (payload) => handleClearMissingOutputs(ctx, payload),
    { signal },
  );
}

function handleAddOutputFiles(
  ctx: EventHandlerContext,
  {
    streamId,
    storageKey,
    filesByRound,
  }: ProgressEventPayloads['addOutputFiles'],
): void {
  withEventErrorHandling(
    'OutputEvents',
    'failed to handle addOutputFiles',
    async () => {
      await ctx.state.outputFiles.addFiles(streamId, storageKey, filesByRound);
      if (!ctx.webviewUpdater.isAvailable()) return;

      const runFiles = ctx.state.outputFiles.getFiles(streamId).get(storageKey);
      const rounds = mapToRecordIfNonEmpty(runFiles);
      ctx.webviewUpdater.updateFiles(streamId, { runId: storageKey, rounds });
    },
  );
}

function handleUpdateMissingOutputs(
  ctx: EventHandlerContext,
  {
    streamId,
    storageKey,
    filesByRound,
  }: ProgressEventPayloads['updateMissingOutputs'],
): void {
  withEventErrorHandling(
    'OutputEvents',
    'failed to handle updateMissingOutputs',
    async () => {
      await ctx.state.outputFiles.updateMissingOutputs(
        streamId,
        storageKey,
        filesByRound,
      );
      if (!ctx.webviewUpdater.isAvailable()) return;

      const runMissing = ctx.state.outputFiles
        .getMissingOutputs(streamId)
        .get(storageKey);
      const rounds = mapToRecordIfNonEmpty(runMissing);
      ctx.webviewUpdater.updateMissingOutputs(streamId, {
        runId: storageKey,
        rounds,
      });
    },
  );
}

function handleClearMissingOutputs(
  ctx: EventHandlerContext,
  { streamId }: ProgressEventPayloads['clearMissingOutputs'],
): void {
  withEventErrorHandling(
    'OutputEvents',
    'failed to handle clearMissingOutputs',
    async () => {
      await ctx.state.outputFiles.clearMissingOutputs(streamId);
      // Broadcast to webview - frontend decides which run to display
      if (ctx.webviewUpdater.isAvailable()) {
        ctx.webviewUpdater.updateMissingOutputs(streamId, { reset: true });
      }
    },
  );
}
