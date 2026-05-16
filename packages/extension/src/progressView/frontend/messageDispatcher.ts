/**
 * Schema-driven message dispatcher for ProgressView.
 *
 * Routes typed backend messages to handlers via command lookup.
 * Handlers are organized into domain-specific slices under ./slices/.
 *
 * @example
 * // In ProgressApp.handleMessage:
 * dispatchMessage(raw, ctx);
 */

// Slice imports
import type {
  ProgressViewOutboundMessage,
  ProgressViewPlacement,
} from '@shared/schemas';
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

import type { FrontendEventHandlerContext } from './eventHandlers';
import type { PermissionState } from './components/PermissionCard';

// ============================================================
// Types
// ============================================================

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
 * Handler registry mapping command to typed handler.
 * TypeScript ensures handlers receive the correct message type.
 */
export type HandlerRegistry = {
  [K in ProgressViewOutboundMessage['command']]?: TypedHandler<
    Extract<ProgressViewOutboundMessage, { command: K }>
  >;
};

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
// Main dispatcher
// ============================================================

/**
 * Dispatch a typed backend message to its handler.
 *
 * The backend sends ProgressViewOutboundMessage objects via postMessage.
 * TypeScript enforces the shape at compile time, and postMessage uses structured
 * clone (lossless) — no Zod validation needed on the hot path.
 */
export function dispatchMessage(
  message: ProgressViewOutboundMessage,
  ctx: MessageHandlerContext,
): boolean {
  const handler = handlers[message.command] as
    | TypedHandler<typeof message>
    | undefined;

  if (handler) {
    handler(message, ctx);
    return true;
  }

  return false;
}
