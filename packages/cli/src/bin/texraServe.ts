// The headless entry of the TeXRA background service: `texra serve` alone,
// with none of the chat TUI. The VS Code extension and the desktop app ship
// this bundle and start it with their own runtime as Node
// (`ELECTRON_RUN_AS_NODE=1`); the CLI starts its full entry with `serve`.
import { Effect } from 'effect';
import { Command } from 'effect/cli';

import {
  CLI_GLOBAL_FLAGS,
  runCliCommandLine,
} from '../commands/_helpers/cliCommand';
import { serveCommand } from '../commands/service';
import { readCliArgv } from '../runtime/platform/cliContext';
import { runCliEntry } from '../runtime/platform/logSinks';

await Effect.runPromise(
  runCliEntry(
    'TeXRA service',
    async () =>
      (
        await runCliCommandLine(
          // Hosts start this bundle as they start the full CLI, with
          // `serve` first, so it parses that one subcommand of `texra`.
          Command.make('texra').pipe(
            Command.withSubcommands([serveCommand]),
            Command.withGlobalFlags(CLI_GLOBAL_FLAGS),
          ),
          readCliArgv(),
        )
      ).exitCode,
  ),
);
