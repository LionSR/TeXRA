/**
 * Shared webview storage singleton for the progress view.
 *
 * All components in the progress view frontend MUST use this shared instance
 * rather than calling `createWebviewStorage(hostBridge)` independently. Multiple
 * independent instances each maintain their own cache, so writes from one
 * instance can silently overwrite changes made by another.
 */
import { hostBridge } from '@shared/hostBridge';
import { createWebviewStorage } from '@shared/state/PersistedState';

export const webviewStorage = createWebviewStorage(hostBridge);

/**
 * Key format for LogList's per-stream toggle-state entries. Single owner so
 * the creator (LogList) and the deleters (stream lifecycle handlers) can't
 * drift apart.
 */
export function logListStateKey(streamId: string): string {
  return `logListState:${streamId}`;
}
