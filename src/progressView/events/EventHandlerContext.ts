/**
 * Shared context for domain-specific event handlers.
 *
 * Provides access to state, webview updater, and common utilities
 * without creating circular dependencies.
 *
 * ## Multi-Agent Architecture: "Backend broadcasts, Frontend decides"
 *
 * For run-scoped data (usage, outputs, todos, instructions), use `webviewUpdater.isAvailable()`
 * to broadcast updates to the frontend regardless of which run is "active". The frontend
 * decides what to display based on user focus.
 *
 * For stream-level operations (like clearing all content), also check `state.activeStream`
 * to ensure the stream is currently displayed.
 *
 * This design supports concurrent subagents - each run receives updates independently,
 * and the frontend can display multiple runs simultaneously in the future.
 */

import type { WebviewUpdater } from '@progressView/managers/WebviewUpdater';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

export interface EventHandlerContext {
  /** Progress view state manager */
  readonly state: ProgressViewState;
  /** Webview updater for sending messages to frontend */
  readonly webviewUpdater: WebviewUpdater;
}
