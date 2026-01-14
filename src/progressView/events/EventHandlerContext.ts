/**
 * Shared context for domain-specific event handlers.
 *
 * Provides access to state, webview updater, and common utilities
 * without creating circular dependencies.
 */
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { WebviewUpdater } from '@progressView/managers';

/**
 * Context passed to domain event handlers.
 * Contains shared dependencies for handling progress events.
 */
export interface EventHandlerContext {
  /** Progress view state manager */
  readonly state: ProgressViewState;
  /** Webview updater for sending messages to frontend */
  readonly webviewUpdater: WebviewUpdater;
}

/**
 * Check if webview is available and the stream is active.
 * Common guard for event handlers that should only update the webview
 * when it's visible and showing the relevant stream.
 */
export function canUpdateWebview(
  ctx: EventHandlerContext,
  stream: StreamTabId,
): boolean {
  return (
    ctx.webviewUpdater.isAvailable() && stream === ctx.state.activeStream
  );
}
