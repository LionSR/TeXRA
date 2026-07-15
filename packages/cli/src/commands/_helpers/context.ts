import { buildCliContext, type CliContext } from '@cli/runtime/cliContext';
import { pickGlobalArgs, type ParsedGlobalArgs } from '@cli/runtime/globalArgs';
import { writeTextStderr } from '@cli/runtime/logSinks';

import { collectStringFlagValues } from './globalArgs';

export async function contextFromArgs(
  args: ParsedGlobalArgs,
  rawArgs: readonly string[] = [],
): Promise<CliContext> {
  const skillSourcePaths =
    rawArgs.length > 0
      ? collectStringFlagValues(rawArgs, 'source', 's')
      : undefined;
  const context = await buildCliContext({
    globalArgs: pickGlobalArgs(args, { skillSourcePaths }),
  });
  if (!context.quietLogs) {
    for (const warning of context.configWarnings) {
      writeTextStderr(`WARN ${warning}`);
    }
  }
  return context;
}
