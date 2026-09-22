// Third-party imports
import { Effect } from 'effect';

// Local imports - settings wire contract and host services
import type { ProcessServices } from '@platform/processRuntime';
import type { SettingsViewInboundMessage } from '@shared/settingsView/settingsViewMessages';
import {
  isUnsupported,
  UnsupportedCommandError,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';

/** Settings commands are programs; only the native host entry executes them. */
export type SettingsViewInboundHandlerRegistry<R = ProcessServices> =
  HandlerRegistry<SettingsViewInboundMessage, Effect.Effect<unknown, Error, R>>;

/** Route a message already validated at its incoming transport boundary. */
export function settingsViewProgram<R>(
  message: SettingsViewInboundMessage,
  handlers: SettingsViewInboundHandlerRegistry<R>,
) {
  return Effect.suspend(() => {
    const handler = handlers[message.command];
    if (isUnsupported(handler)) {
      return Effect.fail(
        new UnsupportedCommandError(message.command, handler.unsupported),
      );
    }
    // The discriminant selects exactly this handler's member of the union.
    return (
      handler as (
        message: SettingsViewInboundMessage,
      ) => ReturnType<Exclude<typeof handler, { unsupported: string }>>
    )(message);
  });
}
