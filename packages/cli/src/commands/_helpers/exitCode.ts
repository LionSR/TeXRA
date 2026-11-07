import { runCommand, type ArgsDef, type CommandDef } from 'citty';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';

// citty's `runCommand` drops a subcommand's return value and passes no
// `data` down to it, so a command's exit code reaches the process entry
// through this slot. One CLI invocation per process.
let pendingExitCode: number = CliExitCode.Success;

export function setExitCode(code: number): void {
  pendingExitCode = code;
}

/** Run `command` and answer the code it set, success if it set none. */
export async function runCommandForExitCode<A extends ArgsDef>(
  command: CommandDef<A>,
  rawArgs: string[],
): Promise<number> {
  pendingExitCode = CliExitCode.Success;
  await runCommand(command, { rawArgs });
  return pendingExitCode;
}
