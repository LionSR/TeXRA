// The inbound window-message dispatcher. The route table is typed over the
// outbound union (`DesktopOutboundMessageSchema`), so a main-process push added
// there without its renderer end fails to compile.

import { Predicate, Result, Schema } from 'effect';
import { DesktopOutboundMessageSchema } from '../shared/desktopOutboundMessages';

type Push = typeof DesktopOutboundMessageSchema.Type;

type PushByCommand = { [P in Push as P['command']]: P };

/** One handler per main-process push, keyed by its command. */
type DesktopPushRoutes = {
  [C in keyof PushByCommand]: (message: PushByCommand[C]) => void;
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
  // Generic over the command so the route and its message stay correlated.
  const run = <C extends keyof PushByCommand>(
    command: C,
    message: PushByCommand[C],
  ): void => routes[command](message);
  return (data) => {
    if (
      !Predicate.hasProperty(data, 'command') ||
      !Predicate.isString(data.command)
    )
      return;
    if (!data.command.startsWith('desktop:')) return;
    const parsed = Schema.decodeUnknownResult(DesktopOutboundMessageSchema)(
      data,
    );
    if (!Result.isSuccess(parsed)) {
      console.warn(`Dropped a malformed ${data.command} push`, parsed.failure);
      return;
    }
    run(parsed.success.command, parsed.success);
  };
}
