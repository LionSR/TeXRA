import { defineCommand } from 'citty';

import { toErrorMessage } from '@utils/errors/errorMessage';

import { CliUsageError } from '../runtime/cliContext';
import {
  generateCompletionScript,
  parseCompletionShell,
} from '../runtime/completion';
import { CliExitCode } from '../runtime/exitCodes';
import { writeTextStdout } from '../runtime/logSinks';

import { setExitCode } from './_helpers/exitCode';
import { GLOBAL_ARGS } from './_helpers/globalArgs';

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
      writeTextStdout(
        await generateCompletionScript(
          rootCommand,
          parseCompletionShell(ctx.args.shell),
        ),
      );
    } catch (error) {
      throw new CliUsageError(toErrorMessage(error));
    }
    setExitCode(CliExitCode.Success);
  },
});
