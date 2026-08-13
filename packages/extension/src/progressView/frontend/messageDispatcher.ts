/**
 * Schema-driven message dispatcher for ProgressView.
 *
 * Validates and routes typed backend messages to handlers via
 * `dispatchProgressViewOutbound` — the shared `createDispatcher` mechanism
 * from `@shared/schemas`/`@shared/utils/dispatcher` that `settingsView`/
 * `webview` frontends already use, rather than a bespoke unvalidated lookup.
 * Handlers are organized into domain-specific slices under ./slices/; each
 * slice reads and writes the module-level `progressState` singletons
 * directly, so the composed registry is fixed at module scope.
 */

// Slice imports
import {
  dispatchProgressViewOutbound,
  type ProgressViewOutboundHandlerRegistry,
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

/**
 * Composed handler registry. `ProgressViewOutboundHandlerRegistry` is
 * exhaustive — every ProgressView outbound command needs a real handler or
 * `unsupported(...)` (see `@shared/utils/dispatcher`), same contract
 * `settingsView`/`webview` use for their outbound registries. Omitting a
 * command is a compile error here, not a silent runtime no-op; individual
 * slices are typed as `satisfies Partial<...>` subsets and this spread is
 * the actual exhaustiveness checkpoint TypeScript enforces.
 */
const handlers: ProgressViewOutboundHandlerRegistry = {
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

/**
 * Dispatch a raw backend message to its handler.
 *
 * The backend sends messages via postMessage; `raw` is validated against
 * `ProgressViewOutboundMessageSchema` before a handler runs — a schema/
 * handler mismatch surfaces as a parse error instead of throwing deep
 * inside a handler body. A command whose registry entry is `unsupported(...)`
 * (or, defensively, genuinely missing) also routes through `onError` instead
 * of silently no-oping. Returns `true` if a real handler ran.
 */
export function dispatchMessage(
  raw: unknown,
  onError?: (error: unknown) => void,
): boolean {
  return dispatchProgressViewOutbound(raw, handlers, onError);
}
