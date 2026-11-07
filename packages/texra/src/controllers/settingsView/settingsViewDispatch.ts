// Third-party imports
import { Effect, Predicate, Schema } from 'effect';

// Local imports - settings wire contract and host services
import type { SettingsViewInboundMessage } from '@texra/shared/settingsView/settingsViewMessages';
import type { ProcessServices } from '@texra-ai/harness/host';

/**
 * A command this host deliberately does not perform, with the reason the
 * user is told. A host declares it for the command instead of omitting the
 * key, so the registry type keeps every command decided on every host.
 */
interface Unsupported {
  readonly unsupported: string;
}

/** Declare a command unsupported on this host, with a user-facing reason. */
export function unsupported(reason: string): Unsupported {
  return { unsupported: reason };
}

/** A command answered by an {@link Unsupported} entry: the user is told
 *  why, rather than shown an error. */
export class UnsupportedCommandError extends Schema.TaggedError<UnsupportedCommandError>()(
  'UnsupportedCommandError',
  { command: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Command "${this.command}" is unsupported on this host: ${this.reason}`;
  }
}

/** Settings commands are programs; only the native host entry executes them.
 *  Every command maps to a program or an {@link Unsupported} entry. */
export type SettingsViewInboundHandlerRegistry<R = ProcessServices> = {
  [K in SettingsViewInboundMessage['command']]:
    | ((
        message: Extract<SettingsViewInboundMessage, { command: K }>,
      ) => Effect.Effect<unknown, Error, R>)
    | Unsupported;
};

/** Route a message already validated at its incoming transport boundary. */
export function settingsViewProgram<R>(
  message: SettingsViewInboundMessage,
  handlers: SettingsViewInboundHandlerRegistry<R>,
) {
  return Effect.suspend(() => {
    const handler = handlers[message.command];
    if (Predicate.hasProperty(handler, 'unsupported')) {
      return Effect.fail(
        new UnsupportedCommandError({
          command: message.command,
          reason: handler.unsupported,
        }),
      );
    }
    // cast: the discriminant selects exactly this handler's member of the union.
    const run = handler as (
      message: SettingsViewInboundMessage,
    ) => Effect.Effect<unknown, Error, R>;
    return run(message);
  });
}
