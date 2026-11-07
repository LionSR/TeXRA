// The headless entry of the TeXRA background service: `texra serve` alone,
// with none of the chat TUI. The VS Code extension and the desktop app ship
// this bundle and start it with their own runtime as Node
// (`ELECTRON_RUN_AS_NODE=1`); the CLI starts its full entry with `serve`.
import { Effect } from 'effect';

import { setLogSink } from '@texra-ai/harness/node';
import { ensureError } from '@texra-ai/harness/schemas';

import { runCommandForExitCode } from '../commands/_helpers/exitCode';
import { serveCommand } from '../commands/service';
import { readCliArgv } from '../runtime/platform/cliContext';
import { CliExitCode } from '../runtime/platform/exitCodes';
import {
  cliErrorMessage,
  installCliPipeErrorHandlers,
  prePlatformDiagnosticSink,
  writeTextStderr,
} from '../runtime/platform/logSinks';

setLogSink(prePlatformDiagnosticSink, { trusted: true });

await Effect.runPromise(
  Effect.tryPromise({
    try: async () => {
      installCliPipeErrorHandlers();
      process.exitCode = await runCommandForExitCode(
        serveCommand,
        readCliArgv(),
      );
    },
    catch: ensureError,
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        writeTextStderr(`TeXRA service failed: ${cliErrorMessage(error)}`);
        process.exitCode = CliExitCode.AgentError;
      }),
    ),
  ),
);
