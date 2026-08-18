import { defineCommand } from 'citty';

import { SETUP_AGENT_NAME } from '@shared/constants/agents';

import { hasCliRunCredential } from '../runtime/credentialStatus';
import { CliExitCode } from '../runtime/exitCodes';
import { initInteractiveCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '../runtime/terminalRequirements';

import { contextFromArgs } from './_helpers/context';
import { withUsageSections } from './_helpers/dispatch';
import { setExitCode } from './_helpers/exitCode';
import {
  INTERACTIVE_GLOBAL_ARGS,
  rejectHeadlessOnlyFlags,
} from './_helpers/globalArgs';
import { type CliContext } from '../runtime/cliContext';

/** Exported for the test kernel — the command's `run` is the only other caller. */
export async function runSetup(context: CliContext): Promise<number> {
  const terminalFailure = interactiveTerminalFailure(context);
  if (terminalFailure) {
    writeTextStderr(
      formatInteractiveTerminalFailure(terminalFailure, {
        headlessMessage:
          'texra setup requires an interactive terminal (TTY stdin and stdout). For scripting, set a provider API key env var (e.g. ANTHROPIC_API_KEY) or run `texra login`.',
        dumbTerminalCommand: 'setup',
      }),
    );
    return CliExitCode.Usage;
  }

  // Always ends in the chat TUI (setup agent) or returns cleanly before it —
  // either way the platform's own handler (still installed here) covers
  // signals until the TUI mounts and takes over (see
  // initInteractiveCliPlatform).
  await initInteractiveCliPlatform({ ...context, quietLogs: true });
  // State 0 first (docs/prds/2026-06-11-agent-native-onboarding.md): a credential is the
  // one step no agent can do for the user. With a credential already in place
  // the picker is skipped — credentials-only (re)configuration is
  // `texra login`'s job under the new vocabulary.
  if (!(await hasCliRunCredential())) {
    const { runCliOnboarding } = await import('../onboarding/runOnboarding');
    const result = await runCliOnboarding(context.stdoutColorEnabled);
    // Skipped or abandoned the picker: exit cleanly (the skip summary already
    // printed) — there is no credential for the setup agent to run on.
    if (!result.configured) return CliExitCode.Success;
  }
  // Credential present (pre-existing or just configured): the setup agent owns
  // the session — environment checks, agent roster, first task. Same chat
  // startup path as `texra chat`, with the agent pinned.
  const { runChat } = await import('../chat/tui/runChatTui');
  const result = await runChat(context, { agentOverride: SETUP_AGENT_NAME });
  return result.exitCode;
}

export const setupCommand = withUsageSections(
  defineCommand({
    meta: {
      name: 'setup',
      description:
        'Guided setup with the setup agent: environment, agent roster, and your first task (sign-in, ChatGPT, or API key first)',
    },
    args: {
      ...INTERACTIVE_GLOBAL_ARGS,
    },
    async run(ctx) {
      rejectHeadlessOnlyFlags(ctx.rawArgs, 'setup');
      const context = await contextFromArgs(ctx.args);
      setExitCode(await runSetup(context));
    },
  }),
  [
    {
      title: 'EXAMPLES',
      rows: [
        ['texra setup', 'agent-led setup: environment, roster, first task'],
        ['texra auth chatgpt login', 'sign in with a ChatGPT subscription'],
        ['texra login', 'sign in with Researcher Access (credentials only)'],
        ['texra auth status', 'show TeXRA sign-in status'],
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
