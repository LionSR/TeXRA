/**
 * Handler context and registry types shared by the message dispatcher, the
 * frontend event handlers, and the per-domain handler slices.
 *
 * A leaf module: slices and the dispatcher both depend on these types, so
 * keeping them here (instead of in `messageDispatcher.ts`, which imports
 * every slice's handler table) keeps the slice ↔ dispatcher graph acyclic.
 */
import type {
  ProgressViewOutboundMessage,
  ProgressViewPlacement,
  StreamTabId,
} from '@shared/schemas';
import type { Unsupported } from '@shared/utils/dispatcher';

import type {
  ProgressState,
  StreamFilter,
  StreamLogs,
  StreamState,
} from './store';
import type { PermissionState } from './permissionState';

/**
 * Context passed to frontend event handlers providing access to state and refs.
 *
 * Note: Named "FrontendEventHandlerContext" to distinguish from the backend
 * EventHandlerContext in @controllers/progressView/backend/events has different
 * shape (state manager + webview updater vs getters/setters).
 */
export interface FrontendEventHandlerContext {
  getState(): ProgressState;
  setState(updater: (prev: ProgressState) => ProgressState): void;
  setStreamState(
    streamId: StreamTabId,
    updater: (prev: StreamState) => StreamState,
  ): void;
  setStreamLogs(
    streamId: StreamTabId,
    updater: (prev: StreamLogs) => StreamLogs,
  ): void;
  /** Persist filter preference to webview state. */
  savePrefs?(prefs: Partial<{ streamFilter: StreamFilter }>): void;
}

/**
 * Context passed to message handlers. Extends FrontendEventHandlerContext with
 * prompt state accessors needed for handling approval/retry messages.
 */
export interface MessageHandlerContext extends FrontendEventHandlerContext {
  getPermissions(): PermissionState[];
  setPermissions(permissions: PermissionState[]): void;
  setPlacement(placement: ProgressViewPlacement): void;
}

/**
 * Handler function type - receives typed message data (already validated).
 */
export type TypedHandler<T extends ProgressViewOutboundMessage> = (
  data: T,
  ctx: MessageHandlerContext,
) => void;

/**
 * Handler registry mapping command to typed handler. Exhaustive — every
 * ProgressView outbound command needs a real handler or `unsupported(...)`
 * (see `@shared/utils/dispatcher`), same contract `settingsView`/`webview`
 * use for their outbound registries. Omitting a command is a compile error
 * here, not a silent runtime no-op; `messageDispatcher.ts` spreads all
 * slices together and is the actual exhaustiveness checkpoint TypeScript
 * enforces (individual slices are typed as `satisfies Partial<HandlerRegistry>`
 * subsets).
 */
export type HandlerRegistry = {
  [K in ProgressViewOutboundMessage['command']]:
    | TypedHandler<Extract<ProgressViewOutboundMessage, { command: K }>>
    | Unsupported;
};
