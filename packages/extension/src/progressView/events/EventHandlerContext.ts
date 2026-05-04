/**
 * Shared context for domain-specific event handlers.
 *
 * Provides access to state, webview updater, and common utilities
 * without creating circular dependencies.
 *
 * ## Active-Stream Guard Pattern
 *
 * Event handlers always update backend state for ANY stream, but only send
 * webview messages for the active stream (`streamId === ctx.state.activeStream`).
 * Inactive streams get fully hydrated via syncStreamContent on tab switch.
 * This avoids wasted serialization + frontend state churn for non-visible streams.
 */

import type { WebviewUpdater } from '@progressView/managers/WebviewUpdater';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

export interface EventHandlerContext {
  /** Progress view state manager */
  readonly state: ProgressViewState;
  /** Webview updater for sending messages to frontend */
  readonly webviewUpdater: WebviewUpdater;
}
