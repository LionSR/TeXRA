import { Effect } from 'effect';
import { setLogSink } from '@texra-ai/harness/node';
import { ensureError } from '@texra-ai/harness/schemas';

import { runCli } from '../commands/root';
import { formatCrashReportLine } from '../runtime/platform/cliContext';
import { CliExitCode } from '../runtime/platform/exitCodes';
import {
  cliErrorMessage,
  installCliPipeErrorHandlers,
  stderrDiagnosticSink,
  writeTextStderr,
} from '../runtime/platform/logSinks';

// This process owns its diagnostic sink from here: the harness's console
// fallback sends DEBUG and INFO to stdout, where under `--output-format
// ndjson` a line would break the stream. Until citty has parsed the argv,
// diagnostics go to stderr at the default level; `defineCliCommand` then
// installs the sink at the level the context decides (`--quiet`,
// `--verbose`) for the command's whole life.
setLogSink(stderrDiagnosticSink('Warn'), { trusted: true });

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
        // rethrown past it — see runtime/headless/executeCli.ts), so this case only
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
