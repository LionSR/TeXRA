// The inbound window-message dispatcher. The route table is typed over the
// outbound union (`DesktopOutboundMessageSchema`), so a main-process push added
// there without its renderer end fails to compile.

import { Result, Schema } from 'effect';
import { DesktopOutboundMessageSchema } from '../shared/desktopOutboundMessages';

type Push = typeof DesktopOutboundMessageSchema.Type;

/** One handler per main-process push, keyed by its command. */
export type DesktopPushRoutes = {
  [P in Push as P['command']]: (message: P) => void;
};

/**
 * Dispatches a `desktop:` window message to its route. Other commands are not
 * the shell's (the settings view's camelCase pushes share the window). A
 * claimed push that fails its schema is the host's defect: warned, and nothing
 * runs.
 */
export function createMessageRoutes(
  routes: DesktopPushRoutes,
): (data: unknown) => void {
  return (data) => {
    if (typeof data !== 'object' || data === null) return;
    if (!('command' in data) || typeof data.command !== 'string') return;
    if (!data.command.startsWith('desktop:')) return;
    const parsed = Schema.decodeUnknownResult(DesktopOutboundMessageSchema)(
      data,
    );
    if (!Result.isSuccess(parsed)) {
      console.warn(`Dropped a malformed ${data.command} push`, parsed.failure);
      return;
    }
    const route = routes[parsed.success.command] as (message: Push) => void;
    route(parsed.success);
  };
}
