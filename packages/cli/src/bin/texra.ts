import { tryPlatform } from '@platform/platform';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { runCli } from '../commands/root';
import { formatCrashReportLine, readCliBugsUrl } from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import {
  flushNdjsonStdout,
  installCliPipeErrorHandlers,
  writeTextStderr,
} from '../runtime/logSinks';

try {
  installCliPipeErrorHandlers();
  const result = await runCli();
  process.exitCode = result.exitCode;
} catch (error) {
  writeTextStderr(`TeXRA CLI failed: ${toErrorMessage(error)}`);
  // Usage errors are handled inside runCli (exit 2) and classified run
  // failures are consumed into an exit code at executeCliRequest (never
  // rethrown past it — see runtime/runExecution.ts), so this catch only
  // fires on genuinely UNEXPECTED crashes; point the user at the tracker.
  // formatCrashReportLine keeps the report link off the usage path even if a
  // usage error is ever rethrown.
  const reportLine = formatCrashReportLine(error, await readCliBugsUrl());
  if (reportLine) writeTextStderr(reportLine);
  process.exitCode = CliExitCode.AgentError;
} finally {
  try {
    await tryPlatform()?.lifecycle.runShutdown();
  } finally {
    await flushNdjsonStdout();
  }
}
