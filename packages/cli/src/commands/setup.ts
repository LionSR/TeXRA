import { Effect } from 'effect';

import { SETUP_AGENT_NAME } from '@shared/constants/agents';

import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '../runtime/terminalRequirements';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { withUsageSections } from './_helpers/dispatch';
import {
  INTERACTIVE_GLOBAL_ARGS,
  rejectHeadlessOnlyFlags,
} from './_helpers/globalArgs';
import { CliUsageError, type CliContext } from '../runtime/cliContext';

/**
 * The command's program builder. Exported for the test kernel — the command's
 * `run` is the only other caller.
 */
export function runSetup(context: CliContext) {
  // Refused in the builder, before the runtime installs (see
  // `defineCliCommand`).
  const terminalFailure = interactiveTerminalFailure(context);
  if (terminalFailure) {
    throw new CliUsageError(
      formatInteractiveTerminalFailure(terminalFailure, {
        headlessMessage:
          'texra setup requires an interactive terminal (TTY stdin and stdout). For scripting, set a provider API key env var (e.g. ANTHROPIC_API_KEY) or run `texra auth chatgpt login`.',
        dumbTerminalCommand: 'setup',
      }),
    );
  }

  // The setup agent owns the session: environment checks, workspace agents,
  // first task. Same chat startup path as `texra chat`, with the agent
  // pinned. A credential is the one step no agent can do for the user
  // (2026-06-11-agent-native-onboarding.md): without one the chat opens on
  // its "Connect a model" panel, and the first message waits for the
  // connection.
  return Effect.succeed({ chat: { agentOverride: SETUP_AGENT_NAME } });
}

export const setupCommand = withUsageSections(
  defineCliCommand({
    meta: {
      name: 'setup',
      description:
        'Guided setup with the setup agent: environment, agents, and your first task (ChatGPT or an API key first)',
    },
    args: {
      ...INTERACTIVE_GLOBAL_ARGS,
    },
    setup: (ctx) => rejectHeadlessOnlyFlags(ctx.rawArgs, 'setup'),
    run: runSetup,
  }),
  [
    {
      title: 'EXAMPLES',
      rows: [
        ['texra setup', 'agent-led setup: environment, agents, first task'],
        ['texra auth chatgpt login', 'sign in with a ChatGPT subscription'],
        [
          'texra auth chatgpt status',
          'show ChatGPT subscription sign-in status',
        ],
      ],
    },
  ],
);
