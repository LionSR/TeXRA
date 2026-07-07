/**
 * Schema-driven message dispatcher for ProgressView.
 *
 * Validates and routes typed backend messages to handlers via
 * `dispatchProgressViewOutbound` — the shared `createDispatcher` mechanism
 * from `@shared/schemas`/`@shared/utils/dispatcher` that `settingsView`/
 * `webview` frontends already use, rather than a bespoke unvalidated lookup.
 * Handlers are organized into domain-specific slices under ./slices/.
 *
 * Slices keep their existing two-arg `(data, ctx) => void` shape instead of
 * the single-arg `(data) => void` shape `createDispatcher`'s `HandlerRegistry`
 * expects: most of `MessageHandlerContext`'s getters/setters close over
 * module-level state, but `savePrefs` closes over the live `ProgressApp`
 * instance's own `PersistedState`, so `ctx` is rebuilt per message rather
 * than fixed at module scope. `bindHandlers` below binds every slice handler
 * to the current `ctx` right before handing the registry to
 * `dispatchProgressViewOutbound`, so the slices/`HandlerRegistry` composition
 * itself is unchanged.
 *
 * @example
 * // In ProgressApp.handleMessage:
 * dispatchMessage(raw, this.createMessageHandlerContext(), onError);
 */

// Slice imports
import {
  dispatchProgressViewOutbound,
  type ProgressViewOutboundHandlerRegistry,
} from '@shared/schemas';
import { isUnsupported, type Unsupported } from '@shared/utils/dispatcher';
import { streamLifecycleHandlers } from './slices/streamLifecycleSlice';
import { logHandlers } from './slices/logSlice';
import { streamMetaHandlers } from './slices/streamMetaSlice';
import { taskHandlers } from './slices/taskSlice';
import { runTrackingHandlers } from './slices/runTrackingSlice';
import { permissionHandlers } from './slices/permissionSlice';
import { followUpHandlers } from './slices/followUpSlice';
import { inquiryHandlers } from './slices/inquirySlice';
import { syncHandlers } from './slices/syncSlice';
import { uiHandlers } from './slices/uiSlice';

import type {
  HandlerRegistry,
  MessageHandlerContext,
  TypedHandler,
} from './messageHandlerTypes';

// ============================================================
// Composed handler registry
// ============================================================

const handlers: HandlerRegistry = {
  ...streamLifecycleHandlers,
  ...logHandlers,
  ...streamMetaHandlers,
  ...taskHandlers,
  ...runTrackingHandlers,
  ...permissionHandlers,
  ...followUpHandlers,
  ...inquiryHandlers,
  ...syncHandlers,
  ...uiHandlers,
};

// ============================================================
// ctx binding (adapts the two-arg slice registry to createDispatcher's
// single-arg HandlerRegistry<TMessage>)
// ============================================================

/**
 * Binds every two-arg slice handler in `handlers` to `ctx`, producing the
 * single-arg registry `dispatchProgressViewOutbound` expects. `Unsupported`
 * markers pass through unchanged so the shared dispatcher's `isUnsupported`
 * check still recognizes them.
 *
 * Rebuilt on every dispatch rather than memoized: `ctx` is freshly
 * constructed per message by `ProgressApp` anyway (see
 * `createMessageHandlerContext`), and binding ~30 entries is negligible next
 * to the postMessage/structured-clone cost already on this path.
 */
function bindHandlers(
  ctx: MessageHandlerContext,
): ProgressViewOutboundHandlerRegistry {
  const bound: Record<string, unknown> = {};
  for (const [command, entry] of Object.entries(handlers) as Array<
    [string, TypedHandler<never> | Unsupported]
  >) {
    bound[command] = isUnsupported(entry)
      ? entry
      : (data: never) => entry(data, ctx);
  }
  return bound as ProgressViewOutboundHandlerRegistry;
}

// ============================================================
// Main dispatcher
// ============================================================

/**
 * Dispatch a raw backend message to its handler.
 *
 * The backend sends messages via postMessage; `raw` is validated against
 * `ProgressViewOutboundMessageSchema` before a handler runs — previously
 * this trusted TypeScript's compile-time cast alone, so a schema/handler
 * mismatch could throw deep inside a handler body instead of surfacing as a
 * parse error. A command whose registry entry is `unsupported(...)` (or,
 * defensively, genuinely missing) also routes through `onError` instead of
 * silently no-oping. Returns `true` if a real handler ran.
 */
export function dispatchMessage(
  raw: unknown,
  ctx: MessageHandlerContext,
  onError?: (error: unknown) => void,
): boolean {
  return dispatchProgressViewOutbound(raw, bindHandlers(ctx), onError);
}
