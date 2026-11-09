// Third-party imports
import type { Effect } from 'effect';

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
