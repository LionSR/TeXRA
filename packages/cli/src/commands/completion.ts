import { defineCommand } from 'citty';

import { toErrorMessage } from '@texra-ai/harness/schemas';

import { CliUsageError } from '../runtime/cliContext';
import { bashCompletion } from '../runtime/completionBash';
import {
  collectCommands,
  parseCompletionShell,
  type CliCompletionShell,
  type CompletionCommand,
} from '../runtime/completionCommandTree';
import { fishCompletion } from '../runtime/completionFish';
import { zshCompletion } from '../runtime/completionZsh';
import { CliExitCode } from '../runtime/exitCodes';
import { writeTextStdout } from '../runtime/logSinks';

import { setExitCode } from './_helpers/exitCode';
import { GLOBAL_ARGS } from './_helpers/globalArgs';

const COMPLETION_SCRIPT: Record<
  CliCompletionShell,
  (commands: readonly CompletionCommand[]) => string
> = { bash: bashCompletion, zsh: zshCompletion, fish: fishCompletion };

export const completionCommand = defineCommand({
  meta: { name: 'completion', description: 'Print shell completion script' },
  args: {
    ...GLOBAL_ARGS,
    shell: {
      type: 'positional',
      required: true,
      description: 'Shell name: bash, zsh, or fish',
    },
  },
  async run(ctx) {
    const { rootCommand } = await import('./root');
    try {
      const shell = parseCompletionShell(ctx.args.shell);
      writeTextStdout(
        COMPLETION_SCRIPT[shell](await collectCommands(rootCommand)),
      );
    } catch (error) {
      throw new CliUsageError({ message: toErrorMessage(error) });
    }
    setExitCode(CliExitCode.Success);
  },
});
