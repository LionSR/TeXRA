/**
 * The user's login-shell environment, read once by a process that must not
 * depend on how it was started. The background service is started by
 * whichever window comes first: a desktop app opened from the Dock has a
 * minimal PATH, so without this a VS Code user would inherit a service that
 * cannot find latexmk or git. The service asks the user's own login shell
 * instead, so every window gets the same environment.
 */
import { spawn } from 'node:child_process';
import { homedir, userInfo } from 'node:os';

import { Effect } from 'effect';

import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

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
export function loginShellEnvironment(
  home: string,
): Effect.Effect<Readonly<Record<string, string>>, Error> {
  // `userInfo` throws for an account with no passwd entry: that is this
  // read's failure, not the caller's crash.
  return Effect.try({ try: () => userInfo(), catch: ensureError })
    .pipe(
      Effect.flatMap(({ shell, username }) =>
        Effect.callback<string, Error>((resume) => {
          const child = spawn(
            shell || '/bin/sh',
            ['-ilc', `printf '${MARKER}'; env -0`],
            {
              // The system PATH, so a profile that runs a tool by name before
              // it sets PATH still finds it.
              env: {
                HOME: home,
                USER: username,
                LOGNAME: username,
                PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
              },
              stdio: ['ignore', 'pipe', 'ignore'],
              // A session of its own: an interactive shell otherwise takes the
              // controlling terminal of a caller that has one (a terminal chat),
              // which then loses its raw mode.
              detached: true,
            },
          );
          let stdout = '';
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk: string) => (stdout += chunk));
          child.once('error', (error) => resume(Effect.fail(error)));
          child.once('close', (code) => {
            const at = stdout.indexOf(MARKER);
            resume(
              at < 0
                ? Effect.fail(
                    new Error(
                      `the login shell ${shell} printed no environment (exit ${code})`,
                    ),
                  )
                : Effect.succeed(stdout.slice(at + MARKER.length)),
            );
          });
          // Detached, the shell leads its own process group: a child its
          // profile left hanging stops with it. The group is gone once
          // everything in it exited, and then only the shell is signalled.
          return Effect.sync(() => {
            const { pid } = child;
            try {
              // Without a pid the shell never started, and `-0` would
              // signal this process's own group.
              if (pid !== undefined) process.kill(-pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          });
        }),
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

/**
 * Add the login shell's variables to this process's environment, keeping
 * every variable the process already has (the home directory and the
 * `TEXRA_*` settings its starter passed). Children this process spawns
 * inherit the result. Says once which PATH it runs with.
 */
export function adoptLoginShellEnvironment(): Effect.Effect<void, Error> {
  return loginShellEnvironment(process.env.HOME ?? homedir()).pipe(
    Effect.flatMap((login) =>
      Effect.suspend(() => {
        for (const [name, value] of Object.entries(login))
          if (process.env[name] === undefined) process.env[name] = value;
        return Effect.logInfo(
          `Using the login shell's environment (PATH=${process.env.PATH ?? ''})`,
        );
      }),
    ),
  );
}
