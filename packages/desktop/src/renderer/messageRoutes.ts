// The renderer's window messages, both ways. The inbound dispatcher's route
// table is typed over the outbound union (`DesktopOutboundMessageSchema`), so
// a main-process push added there without its renderer end fails to compile;
// every request to the main process goes through `postToMain`, typed over the
// schemas its routes decode.

import { Predicate, Result, Schema } from 'effect';
import { hostBridge } from '@texra/shared/hostBridge';
import type { DESKTOP_LOCAL_COMMANDS } from '../shared/desktopCommandSurface';
import type {
  DESKTOP_LOG_COMMANDS,
  DesktopFollowLogMessageSchema,
} from '../shared/desktopLogMessages';
import { DesktopOutboundMessageSchema } from '../shared/desktopOutboundMessages';
import type {
  DESKTOP_PROJECT_COMMANDS,
  DesktopCloseProjectMessageSchema,
  DesktopOpenRecentProjectMessageSchema,
  DesktopSelectProjectMessageSchema,
} from '../shared/desktopProjectMessages';
import type { DesktopSettlePromptMessageSchema } from '../shared/desktopPromptMessages';
import type { DesktopWorkspaceInboundMessageSchema } from '../shared/desktopWorkspaceMessages';

/** A request the main process routes, by the schema its route decodes; a
 *  command whose route reads no field carries only its name. */
type DesktopRequest =
  | typeof DesktopSelectProjectMessageSchema.Encoded
  | typeof DesktopCloseProjectMessageSchema.Encoded
  | typeof DesktopOpenRecentProjectMessageSchema.Encoded
  | typeof DesktopFollowLogMessageSchema.Encoded
  | typeof DesktopSettlePromptMessageSchema.Encoded
  | typeof DesktopWorkspaceInboundMessageSchema.Encoded
  | {
      readonly command:
        | typeof DESKTOP_PROJECT_COMMANDS.REQUEST_PROJECTS
        | typeof DESKTOP_LOG_COMMANDS.REQUEST_LOG
        | typeof DESKTOP_LOG_COMMANDS.COPY_LOG
        | typeof DESKTOP_LOG_COMMANDS.EXPORT_LOG
        | (typeof DESKTOP_LOCAL_COMMANDS)[keyof typeof DESKTOP_LOCAL_COMMANDS];
    };

/** Ask the main process for something, checked here, at the send, against
 *  what its route decodes. */
export function postToMain(message: DesktopRequest): void {
  hostBridge.postMessage(message);
}

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
