/**
 * Shared types for the progress event bus.
 *
 * These types are used by both the event bus and UI components.
 * They are defined here to break the circular dependency between
 * @eventBus and @progressView.
 */

// Type imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';

/**
 * Prompt data for tool edit approval requests.
 * Emitted via 'showToolEditApprovalPrompt' event.
 */
export interface ToolEditApprovalPrompt {
  requestId: string;
  path: string;
  relativePath: string;
  sourceTool: string;
  allowBypass: boolean;
  streamId: StreamTabId | '';
  addedLines: number;
  removedLines: number;
}

/**
 * Prompt data for manual retry requests.
 * Emitted via 'showRetryRequest' event.
 */
export interface RetryRequestPrompt {
  streamId: StreamTabId;
  operation: string;
  model?: string;
  errorMessage?: string;
}
