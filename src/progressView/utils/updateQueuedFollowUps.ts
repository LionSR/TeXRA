/**
 * Utility for updating the queued follow-ups display in the webview.
 */

import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

/**
 * Update the queued follow-ups display in the webview.
 * If the webview is not available, this is a no-op (the queue state
 * is maintained in ToolUseFollowUpQueue and will be sent on view init).
 */
export function updateQueuedFollowUpsUI(streamId: StreamTabId): void {
  const provider = ProgressViewProvider.getInstance();
  if (!provider) {
    return;
  }

  const messages = ToolUseFollowUpQueue.getAll(streamId);
  provider.webviewUpdater.updateQueuedFollowUps(streamId, messages);
}
