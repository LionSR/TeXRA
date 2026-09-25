import { Effect } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { RESEARCHER_ACCESS_AUTH } from '@ui/copy/accountAuth';

import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
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
          'texra setup requires an interactive terminal (TTY stdin and stdout). For scripting, set a provider API key env var (e.g. ANTHROPIC_API_KEY) or run `texra login`.',
        dumbTerminalCommand: 'setup',
      }),
    );
  }

  // Always ends in the chat TUI (setup agent) or returns cleanly before it —
  // either way the platform's own handler covers signals until the TUI mounts
  // and takes over. This entry never passes `installSignalHandlers: false`,
  // so that handler stays live through the whole window below (see
  // `initCliPlatform`).
  //
  // State 0 first (.agents/docs/archived/feature/2026-06-11-agent-native-onboarding.md): a credential is the
  // one step no agent can do for the user. With a credential already in place
  // the picker is skipped — credentials-only (re)configuration is
  // `texra login`'s job under the new vocabulary.
  return Effect.gen(function* () {
    const services = yield* initCliPlatform({ ...context, quietLogs: true });
    if (
      !(yield* hasUsableSetupCredential(services, services.secrets).pipe(
        withLogChannel('Setup Credentials'),
      ))
    ) {
      const { runCliOnboarding } = yield* Effect.promise(
        () => import('../onboarding/runOnboarding'),
      );
      // Skipped or abandoned the picker: exit cleanly (the skip summary
      // already printed) — there is no credential for the setup agent to run
      // on.
      if (
        !(yield* runCliOnboarding(services, context.stdoutColorEnabled))
          .configured
      ) {
        return CliExitCode.Success;
      }
    }
    // Credential present (pre-existing or just configured): the setup agent
    // owns the session — environment checks, agent roster, first task. Same
    // chat startup path as `texra chat`, with the agent pinned.
    return { chat: { agentOverride: SETUP_AGENT_NAME } };
  });
}

export const setupCommand = withUsageSections(
  defineCliCommand({
    meta: {
      name: 'setup',
      description:
        'Guided setup with the setup agent: environment, agent roster, and your first task (sign-in, ChatGPT, or API key first)',
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
        ['texra setup', 'agent-led setup: environment, roster, first task'],
        ['texra auth chatgpt login', 'sign in with a ChatGPT subscription'],
        ['texra login', RESEARCHER_ACCESS_AUTH.credentialsOnlyExample],
        ['texra auth status', RESEARCHER_ACCESS_AUTH.statusExample],
      ],
    },
    {
      title: 'NOTES',
      rows: [
        [
          'texra setup',
          "previously only the credential picker — that's `texra login` now",
        ],
      ],
    },
  ],
);
