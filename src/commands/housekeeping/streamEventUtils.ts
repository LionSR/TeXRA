import { bus } from '@eventBus/ProgressEventBus';
import { getStreamTabId } from '@/logger/streamUtils';

/**
 * Emit clearMissingOutputs event to update the progress view.
 * Used after pack/clean operations to clear missing output indicators.
 */
export function emitClearMissingOutputs(
  agent: string,
  model: string,
  inputFile: string,
  useMultipleOutputs: boolean,
  streamId?: string,
): void {
  bus.emit('clearMissingOutputs', {
    stream:
      streamId ||
      getStreamTabId(agent, model, inputFile, { useMultipleOutputs }),
  });
}
