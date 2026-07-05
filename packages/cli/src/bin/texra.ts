import { tryPlatform } from '@platform/platform';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { runCli } from '../commands/root';
import { formatCrashReportLine, readCliBugsUrl } from '../runtime/cliContext';
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
  // Usage errors are handled inside runCli (exit 2) and never reach here; this
  // catch only fires on UNEXPECTED crashes, so point the user at the tracker.
  // formatCrashReportLine keeps the report link off the usage path even if a
  // usage error is ever rethrown.
  const reportLine = formatCrashReportLine(error, await readCliBugsUrl());
  if (reportLine) writeTextStderr(reportLine);
  process.exitCode = CliExitCode.AgentError;
} finally {
  await tryPlatform()?.lifecycle.runShutdown();
}
