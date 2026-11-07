// Third-party imports
import { Effect } from 'effect';

// Local imports - settings wire contract and host services
import type { SettingsViewInboundMessage } from '@texra/shared/settingsView/settingsViewMessages';
import type { ProcessServices } from '@texra-ai/harness/host';

/** Settings commands are programs; only the native host entry executes them.
 *  Every command maps to one. */
export type SettingsViewInboundHandlerRegistry<R = ProcessServices> = {
  [K in SettingsViewInboundMessage['command']]: (
    message: Extract<SettingsViewInboundMessage, { command: K }>,
  ) => Effect.Effect<unknown, Error, R>;
};

/** Route a message already validated at its incoming transport boundary. */
export function settingsViewProgram<R>(
  message: SettingsViewInboundMessage,
  handlers: SettingsViewInboundHandlerRegistry<R>,
) {
  return Effect.suspend(() => {
    // cast: the discriminant selects exactly this handler's member of the union.
    const run = handlers[message.command] as (
      message: SettingsViewInboundMessage,
    ) => Effect.Effect<unknown, Error, R>;
    return run(message);
  });
}
