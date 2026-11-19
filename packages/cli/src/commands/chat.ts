import { Effect, Option } from 'effect';
import { Command, Flag } from 'effect/cli';

import { CliUsageError } from '../runtime/platform/cliContext';
import { assertExplicitModelKnown } from '../runtime/models/runModel';
import {
  defaultShortcutModifierLabel,
  focusChordLabel,
} from '../runtime/terminal/shortcutLabels';
import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '../runtime/terminal/terminalRequirements';
import { notifyCliUpdate } from '../runtime/platform/updateChecker';

import { cliCommand, type CliCommandOptions } from './_helpers/cliCommand';
import { UsageSections } from './_helpers/cliHelp';

const shortcutModifierLabel = defaultShortcutModifierLabel();
const alternateShortcutModifierLabel =
  shortcutModifierLabel === 'Esc' ? 'Alt' : 'Esc';
const focusShortcut = focusChordLabel(shortcutModifierLabel);
const alternateFocusShortcut = focusChordLabel(alternateShortcutModifierLabel);

const chatConfig = {
  agent: Flag.String('agent').pipe(
    Flag.withDescription('Agent for the session'),
    Flag.optional,
  ),
  model: Flag.String('model').pipe(
    Flag.withAlias('m'),
    Flag.withDescription('Model for the session'),
    Flag.optional,
  ),
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
    const terminalFailure = interactiveTerminalFailure(context);
    if (terminalFailure) {
      // Headless precedence: in CI (headless + TERM=dumb often co-occur) the
      // actionable advice is "use `texra run`", not "fix your TERM".
      throw new CliUsageError({
        message: formatInteractiveTerminalFailure(terminalFailure, {
          headlessMessage:
            'texra chat requires an interactive terminal (TTY stdin and stdout). For scripting or piped input, use `texra run`.',
          dumbTerminalCommand: 'chat',
          dumbTerminalOptions: { nonInteractiveFallback: '`texra run`' },
        }),
      });
    }
    // An update that ran (or was cancelled) is the command's outcome: the
    // next `texra` runs the new version, so no chat mounts.
    return notifyCliUpdate(context).pipe(
      Effect.map(
        (code) =>
          code ?? {
            chat: {
              agentOverride: Option.getOrUndefined(input.agent),
              modelOverride,
            },
          },
      ),
    );
  },
};

export const chatCommand = cliCommand('chat', chatOptions).pipe(
  Command.annotate(UsageSections, [
    {
      title: 'INTERACTIVE CONTROLS',
      rows: [
        ['/help', 'show slash commands inside chat'],
        ['/status', 'show session state'],
        ['/approval', 'set approval policy and session auto-approvals'],
        ['/login', 'manage ChatGPT and Grok sign-ins'],
        [
          'Ctrl-T',
          "open the focused run's full output in a scrollable reader (PgUp/PgDn pages)",
        ],
        ['Ctrl-O', "list the calls of the focused run's script"],
        ['Tab', 'select a visible child session or process'],
        [
          focusShortcut,
          `focus a visible run by number (${alternateFocusShortcut} when configured)`,
        ],
        ['approvals', 'answer tool prompts when --approval-policy=ask'],
        ['Ctrl-C', 'stop the running task or exit from the TUI'],
      ],
    },
  ]),
);
