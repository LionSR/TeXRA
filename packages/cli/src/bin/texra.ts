import { toErrorMessage } from '@common/errors/errorMessage';

import { runCli } from '../commands/root';
import { CliExitCode } from '../runtime/exitCodes';
import { writeTextStderr } from '../runtime/logSinks';

try {
  const result = await runCli();
  process.exitCode = result.exitCode;
} catch (error) {
  writeTextStderr(`TeXRA CLI failed: ${toErrorMessage(error)}`);
  process.exitCode = CliExitCode.AgentError;
}
