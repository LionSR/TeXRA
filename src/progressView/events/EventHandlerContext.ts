/**
 * Shared context for domain-specific event handlers.
 *
 * Provides access to state, webview updater, and common utilities
 * without creating circular dependencies.
 *
 * ## Multi-Agent Architecture: "Backend broadcasts, Frontend decides"
 *
 * For run-scoped data (usage, outputs, todos, instructions), use `isWebviewAvailable()`
 * to broadcast updates to the frontend regardless of which run is "active". The frontend
 * decides what to display based on user focus.
 *
 * For stream-level operations (like clearing all content), use `canUpdateWebview()`
 * which checks both webview availability AND active stream.
 *
 * This design supports concurrent subagents - each run receives updates independently,
 * and the frontend can display multiple runs simultaneously in the future.
 */

// Local imports - progress view
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local imports - shared schemas
import type { StreamTabId } from '@shared/schemas';

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
 *
 * Use for run-scoped data that should always be broadcast:
 * - Usage statistics (per-run)
 * - Output files (per-run)
 * - Missing outputs (per-run)
 * - Todos (per-run)
 * - Log messages (append - messages persist across stream switches)
 *
 * This enables multi-agent support where concurrent runs can all update
 * the webview, and the frontend decides what to display.
 */
export function isWebviewAvailable(ctx: EventHandlerContext): boolean {
  return ctx.webviewUpdater.isAvailable();
}

/**
 * Check if the stream is the currently active stream.
 * Use to determine if immediate UI updates should occur.
 */
function isActiveStream(
  ctx: EventHandlerContext,
  stream: StreamTabId,
): boolean {
  return stream === ctx.state.activeStream;
}

/**
 * Check if webview is available and the stream is active.
 *
 * Use for stream-level operations that affect the entire display:
 * - Log message updates (modifying existing messages in current view)
 * - Stream metadata changes
 *
 * NOT for run-scoped data - use isWebviewAvailable() instead to support
 * multi-agent scenarios where concurrent runs should all receive updates.
 */
export function canUpdateWebview(
  ctx: EventHandlerContext,
  stream: StreamTabId,
): boolean {
  return isWebviewAvailable(ctx) && isActiveStream(ctx, stream);
}
