/**
 * The CLI's side of the TeXRA service: the detached start a client asks for
 * when no service answers, and the link every command that runs or lists
 * tasks holds. `texra serve` itself is `serve` (`@texra/controllers/server`).
 */
import { Effect, Result, type Scope } from 'effect';

import { type GlobalValues } from '@texra-ai/harness/host';
import { SERVICE_SUBCOMMAND } from '@texra/controllers/server/discovery';
import { envFlag } from '@texra-ai/harness/node';
import {
  isOlder,
  linkService,
  probeRecordedService,
  ServiceUnavailable,
  spawnService,
  type ServiceLink,
  WINDOWS_UNSUPPORTED,
} from '@texra/controllers/server/client';

import { readCliEntrypointPath } from './cliContext';
import { writeTextStderr } from './logSinks';

/** `TEXRA_NO_SERVICE=1`: this process uses no background service, so a
 *  chat runs here, as where the service cannot run. */
const NO_SERVICE = 'TEXRA_NO_SERVICE';

/** Start this build's service on `storageRoot`, detached. */
const spawnOwnService = (storageRoot: string) =>
  spawnService(storageRoot, process.execPath, [
    ...process.execArgv,
    readCliEntrypointPath(),
    SERVICE_SUBCOMMAND,
  ]);

/** What the link's starter says instead of starting a service. */
const NONE_RUNNING = 'no TeXRA service is running';

/** The storage root's service as a CLI process holds it: linked for the
 *  process's life, or why it holds none. */
export type CliServiceLink = ServiceLink | { readonly none: string };

/** Whether `link` holds a service. */
export const isLinked = (link: CliServiceLink): link is ServiceLink =>
  'client' in link;

/**
 * The one door to the storage root's service: linked for the caller's
 * scope, started when none answers if `start` (a command that runs or
 * lists tasks), else linked only when one runs. An older build's service
 * holds the projects it serves, and a project store is held by one
 * process, so this build cannot open one beside it: the command retires
 * that service and links to the one it starts in its place, whatever
 * `start` says. Answers why it holds none where none is possible
 * (`TEXRA_NO_SERVICE`, Windows), none runs and `start` is off, or the
 * service could not be reached or started (a newer build's refuses this
 * one): the caller says it, and works in process.
 */
export const linkCliService = Effect.fn('linkCliService')(function* (
  storageRoot: string,
  start: boolean,
): Effect.fn.Return<CliServiceLink, never, Scope.Scope | GlobalValues> {
  if (yield* envFlag(NO_SERVICE)) return { none: `${NO_SERVICE} is set` };
  if (process.platform === 'win32') return { none: WINDOWS_UNSUPPORTED };
  // A service that should answer and does not is said here, once, on
  // stderr: every command then works in process, and the ones that fall
  // back without a word of their own (history, a headless run) would
  // otherwise hide the cause behind a store another process holds.
  const reach = (reason: string) => {
    const none = `The TeXRA service could not be reached: ${reason}`;
    writeTextStderr(none);
    return { none };
  };
  const probed = yield* Effect.result(probeRecordedService);
  if (Result.isFailure(probed)) return reach(probed.failure.reason);
  const info = probed.success;
  if (info === null && !start) return { none: NONE_RUNNING };
  const linked = yield* Effect.result(
    linkService(
      start || (info !== null && isOlder(info))
        ? spawnOwnService(storageRoot)
        : {
            storageRoot,
            start: Effect.fail(
              new ServiceUnavailable({ reason: NONE_RUNNING }),
            ),
          },
      // The wait lasts as long as the older build's tasks, so the command
      // says what it waits for and how to stop waiting.
      (waitingFor) =>
        Effect.sync(() =>
          writeTextStderr(
            `${waitingFor} To stop waiting, run \`texra service stop\`: its running tasks stop and can be resumed.`,
          ),
        ),
    ),
  );
  return Result.isFailure(linked)
    ? reach(linked.failure.reason)
    : linked.success;
});
