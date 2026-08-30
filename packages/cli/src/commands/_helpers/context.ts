import { buildCliContext, type CliContext } from '@cli/runtime/cliContext';
import { pickGlobalArgs, type ParsedGlobalArgs } from '@cli/runtime/globalArgs';
import { writeTextStderr } from '@cli/runtime/logSinks';

import { collectStringFlagValues } from './globalArgs';

export async function contextFromArgs(
  args: ParsedGlobalArgs,
  rawArgs: readonly string[] = [],
): Promise<CliContext> {
  const context = await buildCliContext({
    // Raw argv is the only reader that survives repeated `--source/-s`:
    // citty's parsed args keep the last value only.
    globalArgs: pickGlobalArgs(args, {
      skillSourcePaths: collectStringFlagValues(rawArgs, 'source', 's'),
    }),
  });
  if (!context.quietLogs) {
    for (const warning of context.configWarnings) {
      writeTextStderr(`WARN ${warning}`);
    }
  }
  return context;
}
