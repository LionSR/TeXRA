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
import { canUpdateWebview, type EventHandlerContext } from './EventHandlerContext';

/**
 * Register output event handlers on the event bus.
 *
 * @param bus - Progress event bus
 * @param ctx - Event handler context with state and webview updater
 * @param signal - AbortController signal for cleanup
 */
export function registerOutputEventHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
): void {
  bus.on('addOutputFiles', handleAddOutputFiles(ctx), { signal });
  bus.on('updateMissingOutputs', handleUpdateMissingOutputs(ctx), { signal });
  bus.on('clearMissingOutputs', handleClearMissingOutputs(ctx), { signal });
}

/** Convert Map<number, T[]> to Record<number, T[]> for webview */
function toRoundRecord<T>(
  rounds?: Map<number, T[]>,
): Record<number, T[]> | undefined {
  return rounds?.size ? Object.fromEntries(rounds) : undefined;
}

function handleAddOutputFiles(ctx: EventHandlerContext) {
  return ({
    stream,
    storageKey,
    filesByRound,
  }: ProgressEventPayloads['addOutputFiles']): void => {
    withEventErrorHandling(
      'OutputEvents',
      'failed to handle addOutputFiles',
      async () => {
        await ctx.state.outputFiles.addFiles(stream, storageKey, filesByRound);
        if (!ctx.webviewUpdater.isAvailable()) return;

        const runFiles = ctx.state.outputFiles.getFiles(stream).get(storageKey);
        const rounds = toRoundRecord(runFiles);
        ctx.webviewUpdater.updateFiles(stream, {
          runId: storageKey,
          ...(rounds && { rounds }),
        });
      },
    );
  };
}

function handleUpdateMissingOutputs(ctx: EventHandlerContext) {
  return ({
    stream,
    storageKey,
    filesByRound,
  }: ProgressEventPayloads['updateMissingOutputs']): void => {
    withEventErrorHandling(
      'OutputEvents',
      'failed to handle updateMissingOutputs',
      async () => {
        await ctx.state.outputFiles.updateMissingOutputs(
          stream,
          storageKey,
          filesByRound,
        );
        if (!ctx.webviewUpdater.isAvailable()) return;

        const runMissing = ctx.state.outputFiles
          .getMissingOutputs(stream)
          .get(storageKey);
        const rounds = toRoundRecord(runMissing);
        ctx.webviewUpdater.updateMissingOutputs(stream, {
          runId: storageKey,
          ...(rounds && { rounds }),
        });
      },
    );
  };
}

function handleClearMissingOutputs(ctx: EventHandlerContext) {
  return ({
    stream,
  }: ProgressEventPayloads['clearMissingOutputs']): void => {
    withEventErrorHandling(
      'OutputEvents',
      'failed to handle clearMissingOutputs',
      async () => {
        await ctx.state.outputFiles.clearMissingOutputs(stream);
        if (canUpdateWebview(ctx, stream)) {
          ctx.webviewUpdater.updateMissingOutputs(stream, { reset: true });
        }
      },
    );
  };
}
