import { buildCliContext, type CliContext } from '../../runtime/cliContext';
import {
  pickGlobalArgs,
  type ParsedGlobalArgs,
} from '../../runtime/globalArgs';
import { writeTextStderr } from '../../runtime/logSinks';

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
