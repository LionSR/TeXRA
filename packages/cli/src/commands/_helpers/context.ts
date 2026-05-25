import { buildCliContext, type CliContext } from '@cli/runtime/cliContext';
import { pickGlobalArgs, type ParsedGlobalArgs } from '@cli/runtime/globalArgs';
import { writeTextStderr } from '@cli/runtime/logSinks';

export async function contextFromArgs(
  args: ParsedGlobalArgs,
): Promise<CliContext> {
  const context = await buildCliContext({ globalArgs: pickGlobalArgs(args) });
  if (context.quietLogs !== true) {
    for (const warning of context.configWarnings ?? []) {
      writeTextStderr(`WARN ${warning}`);
    }
  }
  return context;
}
