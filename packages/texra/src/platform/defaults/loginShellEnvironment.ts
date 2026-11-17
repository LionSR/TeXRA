/**
 * The user's login-shell environment, read once by a process that must not
 * depend on how it was started: the background service, which whichever
 * window comes first starts, and the desktop app, which the Dock or Finder
 * starts with a minimal PATH. Each asks the user's own login shell, so a
 * window and its service run with the same environment.
 */
import { homedir, userInfo } from 'node:os';
import { delimiter } from 'node:path';

import { Effect, Schema, Stream } from 'effect';
import * as ChildProcess from 'effect/process/ChildProcess';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import { toErrorMessage } from '@texra-ai/harness/schemas';

/** What the shell prints before its environment, so profile noise ahead of
 *  it is skipped. */
const MARKER = '__TEXRA_LOGIN_ENVIRONMENT__';
/** A login shell that takes longer than this is not waited for. */
const TIMEOUT_MS = 10_000;

/** The login shell's environment could not be read; the message says why. */
class LoginShellUnread extends Schema.TaggedError<LoginShellUnread>()(
  'LoginShellUnread',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * The variables the user's login shell exports, read by running it as a
 * login shell with nothing but the home directory, user name and system
 * PATH. Fails with
 * the reason when the shell does not answer, so the caller can say why it
 * runs without them.
 */
function loginShellEnvironment(): Effect.Effect<
  Readonly<Record<string, string>>,
  LoginShellUnread,
  ChildProcessSpawner
> {
  // `userInfo` throws for an account with no passwd entry: that is this
  // read's failure, not the caller's crash.
  return Effect.try({
    try: () => userInfo(),
    catch: (cause) =>
      new LoginShellUnread({ message: toErrorMessage(cause), cause }),
  }).pipe(
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
                new LoginShellUnread({
                  message: `the login shell ${shell} printed no environment (${status})`,
                }),
              )
            : Effect.succeed(stdout.slice(at + MARKER.length));
        }),
        Effect.scoped,
      ),
    ),
    Effect.timeoutOrElse({
      duration: TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new LoginShellUnread({
            message: `it did not answer within ${TIMEOUT_MS} ms`,
          }),
        ),
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
        new LoginShellUnread({
          message: `The login shell's environment was not read: ${toErrorMessage(cause)}`,
        }),
    ),
  );
}

/**
 * Add the login shell's variables to this process's environment, keeping
 * every variable the process already has (the home directory and the
 * `TEXRA_*` settings its starter passed), except PATH: a Dock-launched app
 * already has a minimal one, so the login shell's entries come first and
 * the process's own follow where the shell's lack them. Children this
 * process spawns inherit the result. Says once which PATH it runs with.
 */
export function adoptLoginShellEnvironment(): Effect.Effect<
  void,
  LoginShellUnread,
  ChildProcessSpawner
> {
  return loginShellEnvironment().pipe(
    Effect.flatMap((login) =>
      Effect.suspend(() => {
        for (const [name, value] of Object.entries(login))
          if (process.env[name] === undefined) process.env[name] = value;
        if (login.PATH !== undefined) {
          const entries = login.PATH.split(delimiter);
          const own = (process.env.PATH ?? '').split(delimiter);
          process.env.PATH = [
            ...entries,
            ...own.filter((entry) => entry && !entries.includes(entry)),
          ].join(delimiter);
        }
        return Effect.logInfo(
          `Using the login shell's environment (PATH=${process.env.PATH ?? ''})`,
        );
      }),
    ),
  );
}
