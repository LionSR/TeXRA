// Local imports - CLI runtime
import type { CliContext } from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import { writeTextStderr } from '../runtime/logSinks';

export interface ChatResult {
  exitCode: number;
}

export async function runChat(context: CliContext): Promise<ChatResult> {
  if (context.mode === 'headless') {
    writeTextStderr(
      'texra chat requires an interactive terminal. Did you mean texra run?',
    );
    return { exitCode: CliExitCode.Usage };
  }

  writeTextStderr(
    'texra chat interactive follow-up TUI is not implemented yet. See issue #3836.',
  );
  return { exitCode: CliExitCode.Usage };
}
