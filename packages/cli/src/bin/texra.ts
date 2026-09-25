import { Effect } from 'effect';
import { installedProcessRuntime } from '@agent/runtime';
import { setLogSink } from '@logger/logSink';
import { Lifecycle } from '@platform/interfaces';
import { withProcessServices } from '@platform/processRuntime';
import { ensureError } from '@utils/errors/errorMessage';

import { runCli } from '../commands/root';
import { formatCrashReportLine, readCliBugsUrl } from '../runtime/cliContext';
import { disposeCliProcessRuntime } from '../runtime/cliProcessRuntime';
import { CliExitCode } from '../runtime/exitCodes';
import {
  cliErrorMessage,
  flushNdjsonStdout,
  installCliPipeErrorHandlers,
  prePlatformDiagnosticSink,
  writeTextStderr,
} from '../runtime/logSinks';

// This process owns its diagnostic sink from here, not from the init that
// eventually installs the platform's: `@logger/logSink`'s console fallback
// sends DEBUG and INFO to stdout, and the process runtime logs while its
// layers build (`UsageLogService started …`) — which happens before
// `initCliPlatform`, and for the two platform-less entries before a platform
// that never comes up. Under `--output-format ndjson` that line was the
// first thing on stdout and the stream was no longer parseable. Every
// pre-platform diagnostic goes to stderr instead; `--quiet` is not known
// until citty has parsed the argv, so `defineCliCommand` swaps in the silent
// sink for it, and `initCliPlatform` swaps in the platform's as before.
setLogSink(prePlatformDiagnosticSink, { trusted: true });

// The process entry: one run, with the process lifecycle's shutdown drain,
// the process runtime's disposal and the final NDJSON flush as its
// finalizers, in that order — the drain is a program now, so this entry is
// where it is run. The lifecycle is the installed runtime's own `Lifecycle`,
// read before the drain runs. A platform's shutdown disposes the runtime as
// its last step; a command that refused its arguments before bringing a
// platform up registered no such step, and its runtime's global-root change
// poll would hold the event loop open forever, so the entry disposes whatever
// runtime is still installed (a no-op after a platform shutdown).
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
      Effect.promise(async () => {
        writeTextStderr(`TeXRA CLI failed: ${cliErrorMessage(error)}`);
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
      Effect.suspend(() => {
        const runtime = installedProcessRuntime();
        return runtime
          ? Effect.flatMap(
              withProcessServices(runtime, Effect.service(Lifecycle)),
              (lifecycle) => lifecycle.runShutdown,
            )
          : Effect.void;
      }).pipe(
        Effect.ensuring(disposeCliProcessRuntime),
        Effect.ensuring(flushNdjsonStdout()),
      ),
    ),
  ),
);
