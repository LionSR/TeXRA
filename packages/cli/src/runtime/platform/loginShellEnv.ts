/**
 * The user's login-shell environment, read once by a process that must not
 * depend on how it was started. The background service is started by
 * whichever window comes first: a desktop app opened from the Dock has a
 * minimal PATH, so without this a VS Code user would inherit a service that
 * cannot find latexmk or git. The service asks the user's own login shell
 * instead, so every window gets the same environment.
 */
import { homedir, userInfo } from 'node:os';

import { Effect, Stream } from 'effect';
import * as ChildProcess from 'effect/process/ChildProcess';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import { ensureError, toErrorMessage } from '@texra-ai/harness/schemas';

/** What the shell prints before its environment, so profile noise ahead of
 *  it is skipped. */
const MARKER = '__TEXRA_LOGIN_ENVIRONMENT__';
/** A login shell that takes longer than this is not waited for. */
const TIMEOUT_MS = 10_000;

/**
 * The variables the user's login shell exports, read by running it as a
 * login shell with nothing but the home directory, user name and system
 * PATH. Fails with
 * the reason when the shell does not answer, so the caller can say why it
 * runs without them.
 */
export function loginShellEnvironment(): Effect.Effect<
  Readonly<Record<string, string>>,
  Error,
  ChildProcessSpawner
> {
  // `userInfo` throws for an account with no passwd entry: that is this
  // read's failure, not the caller's crash.
  return Effect.try({ try: () => userInfo(), catch: ensureError })
    .pipe(
      Effect.flatMap(({ shell, username }) =>
        ChildProcessSpawner.use((spawner) =>
          spawner.spawn(
            ChildProcess.make(
              shell || '/bin/sh',
              ['-ilc', `printf '${MARKER}'; env -0`],
              {
                // The system PATH, so a profile that runs a tool by name
                // before it sets PATH still finds it. `homedir` is $HOME when
                // it is set, else the account's passwd entry.
                env: {
                  HOME: homedir(),
                  USER: username,
                  LOGNAME: username,
                  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
                },
                extendEnv: false,
                stdin: 'ignore',
                stderr: 'ignore',
                // A session of its own: an interactive shell otherwise takes
                // the controlling terminal of a caller that has one (a
                // terminal chat), which then loses its raw mode. Detached,
                // the shell leads its own process group, which the spawner
                // kills with SIGKILL when the read times out or is
                // interrupted, so a child its profile left hanging stops
                // with it. An interactive shell ignores SIGTERM.
                detached: true,
                killSignal: 'SIGKILL',
              },
            ),
          ),
        ).pipe(
          Effect.flatMap((handle) =>
            Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                handle.exitCode.pipe(
                  Effect.map((code) => `exit ${code}`),
                  Effect.catch((error) => Effect.succeed(error.message)),
                ),
              ],
              { concurrency: 'unbounded' },
            ).pipe(
              // Once the shell has exited, unreferenced, the spawner leaves
              // its group alone when the scope closes: background jobs the
              // profile started survive a read that finished. A shell that
              // exited non-zero still has its group killed by the spawner.
              Effect.tap(() => handle.unref),
            ),
          ),
          Effect.flatMap(([stdout, status]) => {
            const at = stdout.indexOf(MARKER);
            return at < 0
              ? Effect.fail(
                  new Error(
                    `the login shell ${shell} printed no environment (${status})`,
                  ),
                )
              : Effect.succeed(stdout.slice(at + MARKER.length));
          }),
          Effect.scoped,
        ),
      ),
    )
    .pipe(
      Effect.timeoutOrElse({
        duration: TIMEOUT_MS,
        orElse: () =>
          Effect.fail(new Error(`it did not answer within ${TIMEOUT_MS} ms`)),
      }),
      Effect.map((printed) =>
        Object.fromEntries(
          printed.split('\0').flatMap((line) => {
            const eq = line.indexOf('=');
            return eq > 0
              ? [[line.slice(0, eq), line.slice(eq + 1)] as const]
              : [];
          }),
        ),
      ),
      Effect.mapError(
        (cause) =>
          new Error(
            `The login shell's environment was not read: ${toErrorMessage(cause)}`,
          ),
      ),
    );
}
