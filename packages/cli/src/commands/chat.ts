import { Effect } from 'effect';

import { CliUsageError } from '../runtime/cliContext';
import { assertExplicitModelKnown } from '../runtime/runModel';
import {
  defaultShortcutModifierLabel,
  metaChordLabel,
} from '../runtime/shortcutLabels';
import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '../runtime/terminalRequirements';
import { notifyCliUpdate } from '../runtime/updateChecker';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { withUsageSections } from './_helpers/dispatch';
import {
  INTERACTIVE_AGENT_GLOBAL_ARGS,
  optString,
  rejectHeadlessOnlyFlags,
} from './_helpers/globalArgs';

const shortcutModifierLabel = defaultShortcutModifierLabel();
const alternateShortcutModifierLabel =
  shortcutModifierLabel === 'Esc' ? 'Alt' : 'Esc';
const focusShortcut = metaChordLabel(shortcutModifierLabel, '1..9');
const alternateFocusShortcut = metaChordLabel(
  alternateShortcutModifierLabel,
  '1..9',
);

export const chatCommand = withUsageSections(
  defineCliCommand({
    meta: { name: 'chat', description: 'Interactive tool-use chat session' },
    args: {
      ...INTERACTIVE_AGENT_GLOBAL_ARGS,
      agent: { type: 'string', description: 'Tool-use agent for the session' },
      model: {
        type: 'string',
        alias: 'm',
        description: 'Model for the session',
      },
    },
    setup: (ctx) => rejectHeadlessOnlyFlags(ctx.rawArgs, 'chat'),
    // The update check is the program; the session it hands the terminal to
    // is `defineCliCommand`'s to mount once the check has settled. An unusable
    // terminal is refused here, in the builder, before the runtime installs.
    run: (context, ctx) => {
      const modelOverride = assertExplicitModelKnown(optString(ctx.args.model));
      // `mode === 'headless'` already covers --print / CI / non-TTY stdin
      // (see cliContext.cliMode); stdout must also be a TTY for Ink to render,
      // and `TERM=dumb` strips the cursor controls Ink depends on (Ink would
      // mount and emit garbled output instead of a usable session).
      const terminalFailure = interactiveTerminalFailure(context);
      if (terminalFailure) {
        // Headless precedence: in CI (headless + TERM=dumb often co-occur) the
        // actionable advice is "use `texra run`", not "fix your TERM".
        throw new CliUsageError(
          formatInteractiveTerminalFailure(terminalFailure, {
            headlessMessage:
              'texra chat requires an interactive terminal (TTY stdin and stdout). For scripting or piped input, use `texra run`.',
            dumbTerminalCommand: 'chat',
            dumbTerminalOptions: { nonInteractiveFallback: '`texra run`' },
          }),
        );
      }
      return notifyCliUpdate(context).pipe(
        Effect.as({
          chat: { agentOverride: optString(ctx.args.agent), modelOverride },
        }),
      );
    },
  }),
  [
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
        ['Tab', 'select a visible child session or process'],
        [
          focusShortcut,
          `focus a visible run by number (${alternateFocusShortcut} when configured)`,
        ],
        ['approvals', 'answer tool prompts when --approval-policy=ask'],
        ['Ctrl-C', 'stop the running task or exit from the TUI'],
      ],
    },
  ],
);
