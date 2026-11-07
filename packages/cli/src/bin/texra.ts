import { Effect } from 'effect';
import { setLogSink } from '@texra-ai/harness/node';
import { ensureError } from '@texra-ai/harness/schemas';

import { runCli } from '../commands/root';
import { formatCrashReportLine } from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import {
  cliErrorMessage,
  installCliPipeErrorHandlers,
  prePlatformDiagnosticSink,
  writeTextStderr,
} from '../runtime/logSinks';

// This process owns its diagnostic sink from here, not from the platform
// that eventually installs its own: the harness's console fallback sends
// DEBUG and INFO to stdout, and a command's runtime logs while its layers
// build (`UsageLogService started …`) — before its platform comes up, or
// for a command with none at all. Under `--output-format ndjson` that line
// was the first thing on stdout and the stream was no longer parseable.
// Every pre-platform diagnostic goes to stderr instead; `--quiet` is not
// known until citty has parsed the argv, so `defineCliCommand` swaps in the
// silent sink for it, and the platform swaps in its own as before.
setLogSink(prePlatformDiagnosticSink, { trusted: true });

// The process entry: one run. Each command disposes the runtime it built
// (`defineCliCommand`), so nothing is left here to shut down.
await Effect.runPromise(
  Effect.tryPromise({
    try: async () => {
      installCliPipeErrorHandlers();
      const result = await runCli();
      process.exitCode = result.exitCode;
    },
    catch: ensureError,
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.sync(() => {
        writeTextStderr(`TeXRA CLI failed: ${cliErrorMessage(error)}`);
        // Usage errors are handled inside runCli (exit 2) and classified run
        // failures are consumed into an exit code at executeCliConfig (never
        // rethrown past it — see runtime/executeCli.ts), so this case only
        // fires on genuinely UNEXPECTED crashes; point the user at the
        // tracker. formatCrashReportLine keeps the report link off the usage
        // path even if a usage error is ever rethrown.
        const reportLine = formatCrashReportLine(error);
        if (reportLine) writeTextStderr(reportLine);
        process.exitCode = CliExitCode.AgentError;
      }),
    ),
  ),
);
