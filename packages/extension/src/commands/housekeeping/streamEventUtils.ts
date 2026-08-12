import { defaultSession } from '@agent/runtime';

/**
 * Clear the missing-outputs marker for the single workflow tab a pack/clean
 * operation addressed. Mutations are exactly addressed (#9590 rule A3): the
 * caller supplies the `StreamTabId` it acted on. Agent/model/config identity
 * is display data, not command authorization, so invocations without a stream
 * context (command palette, main-view file buttons) clear nothing and must
 * not call this.
 */
export function emitClearMissingOutputs(streamId: string): void {
  defaultSession().events.emit({
    scope: 'session',
    event: {
      type: 'clearMissingOutputs',
      payload: { streamId },
    },
  });
}
