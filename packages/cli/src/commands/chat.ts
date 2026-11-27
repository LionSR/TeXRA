import { Effect, Option } from 'effect';

import { CliUsageError } from '../runtime/platform/cliContext';
import { assertExplicitModelKnown } from '../runtime/models/launchDefaults';
import { interactiveTerminalRejection } from '../runtime/terminal/terminalRequirements';
import { notifyCliUpdate } from '../runtime/platform/updateChecker';

import {
  cliCommand,
  SKILL_SOURCES_CONFIG,
  modelFlag,
  type CliCommandOptions,
} from './_helpers/cliCommand';

const chatConfig = {
  ...SKILL_SOURCES_CONFIG,
  model: modelFlag('Model for the session'),
};

/** The chat, which bare `texra` also starts on an interactive terminal. */
export const chatOptions: CliCommandOptions<typeof chatConfig, Error> = {
  description: 'Interactive tool-use chat session',
  config: chatConfig,
  // Every chat is a client of the one service, and shows a store moved
  // aside in its transcript.
  platform: { startsService: true, presentsStoreMovedAside: true },
  // The update check is the program; the session it hands the terminal to
  // is mounted once the check has finished. An unusable terminal is refused
  // here, in the builder, before the runtime is built.
  run: (context, input) => {
    const modelOverride = assertExplicitModelKnown(
      Option.getOrUndefined(input.model),
    );
    // `mode === 'headless'` already covers --print / CI / non-TTY stdin
    // (see cliContext.cliMode); stdout must also be a TTY for Ink to render,
    // and `TERM=dumb` strips the cursor controls Ink depends on.
    const terminalRejection = interactiveTerminalRejection(context, 'chat', {
      headlessMessage:
        'texra chat requires an interactive terminal (TTY stdin and stdout). For scripting or piped input, use `texra run`.',
      nonInteractiveFallback: '`texra run`',
    });
    if (terminalRejection)
      throw new CliUsageError({ message: terminalRejection });
    // An update that ran (or was cancelled) is the command's outcome: the
    // next `texra` runs the new version, so no chat mounts.
    return notifyCliUpdate(context).pipe(
      Effect.map(
        (code) =>
          code ?? {
            chat: { modelOverride },
          },
      ),
    );
  },
};

export const chatCommand = cliCommand('chat', chatOptions);
