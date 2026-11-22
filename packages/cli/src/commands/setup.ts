import { Effect } from 'effect';
import { Command } from 'effect/cli';

import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '../runtime/terminal/terminalRequirements';

import { cliCommand } from './_helpers/cliCommand';
import { CliUsageError, type CliContext } from '../runtime/platform/cliContext';

/** The command's program builder; the command's `run` is its only caller. */
function runSetup(context: CliContext) {
  // Refused before the runtime is built (see `cliCommand`).
  const terminalFailure = interactiveTerminalFailure(context);
  if (terminalFailure) {
    throw new CliUsageError({
      message: formatInteractiveTerminalFailure(terminalFailure, {
        headlessMessage:
          'texra setup requires an interactive terminal (TTY stdin and stdout). For scripting, set a provider API key env var (e.g. ANTHROPIC_API_KEY) or run `texra auth chatgpt login`.',
        dumbTerminalCommand: 'setup',
      }),
    });
  }

  // The setup conversation owns the session: environment checks and the
  // first task. Same chat startup path as `texra chat`, started with the
  // setup tools. A credential is the one step no agent can do for the user
  // without one the chat opens on its "Connect a model" panel, and the first
  // message waits for the connection.
  return Effect.succeed({ chat: { setup: true } });
}

export const setupCommand = cliCommand('setup', {
  description: 'Guided setup: check your environment and start your first task',
  config: {},
  // The same chat platform as `texra chat`.
  platform: { startsService: true, presentsStoreMovedAside: true },
  run: runSetup,
}).pipe(
  Command.withExamples([
    {
      command: 'texra setup',
      description: 'guided setup: environment checks, first task',
    },
    {
      command: 'texra auth chatgpt login',
      description: 'sign in with a ChatGPT subscription',
    },
    {
      command: 'texra auth chatgpt status',
      description: 'show ChatGPT subscription sign-in status',
    },
  ]),
);
