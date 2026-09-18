import { Effect } from 'effect';
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

// The process entry: one run, with the platform's shutdown drain and the
// final NDJSON flush as its finalizers, in that order — the drain is a
// program now, so this entry is where it is run.
await Effect.runPromise(
  Effect.tryPromise({
    try: async () => {
      installCliPipeErrorHandlers();
      const result = await runCli();
      process.exitCode = result.exitCode;
    },
    catch: (error: unknown) => error,
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.promise(async () => {
        writeTextStderr(`TeXRA CLI failed: ${toErrorMessage(error)}`);
        // Usage errors are handled inside runCli (exit 2) and classified run
        // failures are consumed into an exit code at executeCliRequest (never
        // rethrown past it — see runtime/executeCli.ts), so this arm only
        // fires on genuinely UNEXPECTED crashes; point the user at the
        // tracker. formatCrashReportLine keeps the report link off the usage
        // path even if a usage error is ever rethrown.
        const reportLine = formatCrashReportLine(error, await readCliBugsUrl());
        if (reportLine) writeTextStderr(reportLine);
        process.exitCode = CliExitCode.AgentError;
      }),
    ),
    Effect.ensuring(
      Effect.suspend(
        () => tryPlatform()?.lifecycle.runShutdown ?? Effect.void,
      ).pipe(Effect.ensuring(Effect.promise(() => flushNdjsonStdout()))),
    ),
  ),
);
