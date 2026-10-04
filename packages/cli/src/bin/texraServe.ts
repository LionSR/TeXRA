// The headless entry of the TeXRA background service: `texra serve` alone,
// with none of the chat TUI. The VS Code extension and the desktop app ship
// this bundle and start it with their own runtime as Node
// (`ELECTRON_RUN_AS_NODE=1`); the CLI starts its full entry with `serve`.
import { runCommand } from 'citty';
import { Effect } from 'effect';

import { setLogSink } from '@logger/logSink';
import { ensureError } from '@utils/errors/errorMessage';

import { getExitCode, setExitCode } from '../commands/_helpers/exitCode';
import { serveCommand } from '../commands/service';
import { readCliArgv } from '../runtime/cliContext';
import { disposeCliProcessRuntime } from '../runtime/cliProcessRuntime';
import { CliExitCode } from '../runtime/exitCodes';
import { cliPlatformShutdown } from '../runtime/initPlatform';
import {
  cliErrorMessage,
  installCliPipeErrorHandlers,
  prePlatformDiagnosticSink,
  writeTextStderr,
} from '../runtime/logSinks';

setLogSink(prePlatformDiagnosticSink, { trusted: true });

await Effect.runPromise(
  Effect.tryPromise({
    try: async () => {
      installCliPipeErrorHandlers();
      setExitCode(CliExitCode.Success);
      await runCommand(serveCommand, { rawArgs: readCliArgv() });
      process.exitCode = getExitCode();
    },
    catch: ensureError,
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        writeTextStderr(`TeXRA service failed: ${cliErrorMessage(error)}`);
        process.exitCode = CliExitCode.AgentError;
      }),
    ),
    Effect.ensuring(
      cliPlatformShutdown.pipe(Effect.ensuring(disposeCliProcessRuntime)),
    ),
  ),
);
