import { defineCommand } from 'citty';

import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
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
import type { CliContext } from '../runtime/cliContext';

async function runSetup(context: CliContext): Promise<number> {
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

  await initCliPlatform({ ...context, quietLogs: true });
  const { runCliOnboarding } = await import('../onboarding/runOnboarding');
  await runCliOnboarding();
  return CliExitCode.Success;
}

export const setupCommand = withUsageSections(
  defineCommand({
    meta: {
      name: 'setup',
      description:
        'Set up TeXRA access: sign in for included relay, or add a provider API key',
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
        ['texra setup', 'choose sign-in or a provider API key'],
        ['texra login', 'sign in for included relay access'],
        ['texra auth status', 'show TeXRA sign-in status'],
      ],
    },
  ],
);
