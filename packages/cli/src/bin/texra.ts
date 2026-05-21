import { tryPlatform } from '@platform/platform';
import { toErrorMessage } from '@common/errors/errorMessage';

import { runCli } from '../commands/root';
import { CliExitCode } from '../runtime/exitCodes';
import {
  installCliPipeErrorHandlers,
  writeTextStderr,
} from '../runtime/logSinks';

try {
  installCliPipeErrorHandlers();
  const result = await runCli();
  process.exitCode = result.exitCode;
} catch (error) {
  writeTextStderr(`TeXRA CLI failed: ${toErrorMessage(error)}`);
  process.exitCode = CliExitCode.AgentError;
} finally {
  await tryPlatform()?.lifecycle.runShutdown();
}
