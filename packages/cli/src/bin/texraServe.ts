// The headless entry of the TeXRA background service: `texra serve` alone,
// with none of the chat TUI. The VS Code extension and the desktop app ship
// this bundle and start it with their own runtime as Node
// (`ELECTRON_RUN_AS_NODE=1`); the CLI starts its full entry with `serve`.
import { Effect } from 'effect';

import { runCommandForExitCode } from '../commands/_helpers/exitCode';
import { serveCommand } from '../commands/service';
import { readCliArgv } from '../runtime/platform/cliContext';
import { runCliEntry } from '../runtime/platform/logSinks';

await Effect.runPromise(
  runCliEntry('TeXRA service', () =>
    runCommandForExitCode(serveCommand, readCliArgv()),
  ),
);
