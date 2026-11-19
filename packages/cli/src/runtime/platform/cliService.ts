/**
 * The CLI's binding of the service link (`linkService`,
 * `@texra/controllers/server/client`): the service is started from this
 * build's own entry, and what the link waits on or could not reach is said
 * on stderr. `texra serve` itself is `serve` (`@texra/controllers/server`).
 */
import { Effect } from 'effect';

import { SERVICE_SUBCOMMAND } from '@texra/controllers/server/discovery';
import {
  linkService,
  ServiceUnavailable,
  spawnService,
} from '@texra/controllers/server/client';

import { readCliEntrypointPath } from './cliContext';
import { writeTextStderr } from './logSinks';

/**
 * The storage root's service for the caller's scope, started from this
 * build's entry when none answers if `startsService` (a command that runs
 * or lists tasks). A service that should answer and does not is said here,
 * once, on stderr: every command then works in process, and the ones that
 * fall back without a word of their own (history, a headless run) would
 * otherwise hide the cause behind a store another process holds. Where no
 * service is possible, or none runs and the command starts none, the
 * failure is the link's own and nothing is said.
 */
export const linkCliService = (storageRoot: string, startsService: boolean) =>
  linkService(
    spawnService(storageRoot, process.execPath, [
      ...process.execArgv,
      readCliEntrypointPath(),
      SERVICE_SUBCOMMAND,
    ]),
    {
      startsService,
      // The wait lasts as long as the older build's tasks, so the command
      // says what it waits for and how to stop waiting.
      waiting: (waitingFor) =>
        Effect.sync(() =>
          writeTextStderr(
            `${waitingFor} To stop waiting, run \`texra service stop\`: its running tasks stop and can be resumed.`,
          ),
        ),
    },
  ).pipe(
    Effect.catchIf(
      (error) => error.failure.kind !== 'none',
      (error) => {
        const reason = `The TeXRA service could not be reached: ${error.reason}`;
        writeTextStderr(reason);
        return Effect.fail(
          new ServiceUnavailable({ reason, failure: error.failure }),
        );
      },
    ),
  );
