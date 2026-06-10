import { defineCommand } from 'citty';

import { CliUsageError } from '../runtime/cliContext';

import { resolveDeepestSubCommand } from './_helpers/dispatch/commandTree';
import { showUsage } from './_helpers/dispatch/usage';
import {
  detectUnknownCliCommand,
  formatUnknownCliCommand,
} from './_helpers/dispatch/unknownCommand';

export const helpCommand = defineCommand({
  meta: { name: 'help', description: 'Show TeXRA CLI commands' },
  async run(ctx) {
    const { rootCommand } = await import('./root');
    if (ctx.rawArgs.length === 0) {
      await showUsage(rootCommand);
      return;
    }

    const unknownCommand = await detectUnknownCliCommand(
      rootCommand,
      ctx.rawArgs,
    );
    if (unknownCommand) {
      throw new CliUsageError(formatUnknownCliCommand(unknownCommand));
    }

    const resolved = await resolveDeepestSubCommand(rootCommand, ctx.rawArgs);
    await showUsage(resolved.command, resolved.parent, resolved);
  },
});
