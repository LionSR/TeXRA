import { defineCommand } from 'citty';

import { CliUsageError } from '../runtime/cliContext';

import {
  resolveDeepestSubCommand,
  showUsage,
  detectUnknownCliCommand,
  formatUnknownCliCommand,
} from './_helpers/dispatch';

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
