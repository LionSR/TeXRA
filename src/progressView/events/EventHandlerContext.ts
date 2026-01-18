/**
 * Shared context for domain-specific event handlers.
 *
 * Provides access to state, webview updater, and common utilities
 * without creating circular dependencies.
 */
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

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
 * Check if webview is available (regardless of active stream).
 * Use for events that should always be sent when webview is visible.
 */
export function isWebviewAvailable(ctx: EventHandlerContext): boolean {
  return ctx.webviewUpdater.isAvailable();
}

/**
 * Check if the stream is the currently active stream.
 * Use to determine if immediate UI updates should occur.
 */
export function isActiveStream(
  ctx: EventHandlerContext,
  stream: StreamTabId,
): boolean {
  return stream === ctx.state.activeStream;
}

/**
 * Check if webview is available and the stream is active.
 * Common guard for event handlers that should only update the webview
 * when it's visible and showing the relevant stream.
 *
 * For multi-agent scenarios, consider using isWebviewAvailable() and
 * isActiveStream() separately to handle non-active stream updates.
 */
export function canUpdateWebview(
  ctx: EventHandlerContext,
  stream: StreamTabId,
): boolean {
  return isWebviewAvailable(ctx) && isActiveStream(ctx, stream);
}

/**
 * Determine update strategy for a stream event.
 * Returns 'immediate' for active stream, 'buffer' for background streams,
 * or 'skip' if webview is unavailable.
 *
 * This enables proper multi-agent support by distinguishing between:
 * - Active stream: immediate webview updates
 * - Background streams: buffer for later replay
 */
export function getUpdateStrategy(
  ctx: EventHandlerContext,
  stream: StreamTabId,
): 'immediate' | 'buffer' | 'skip' {
  if (!isWebviewAvailable(ctx)) return 'skip';
  return isActiveStream(ctx, stream) ? 'immediate' : 'buffer';
}
