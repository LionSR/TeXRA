/**
 * The user's login-shell environment, read once by a process that must not
 * depend on how it was started. The background service is started by
 * whichever window comes first: a desktop app opened from the Dock has a
 * minimal PATH, so without this a VS Code user would inherit a service that
 * cannot find latexmk or git. The service asks the user's own login shell
 * instead, so every window gets the same environment.
 */
import { spawnSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';

import { Effect } from 'effect';

import { toErrorMessage } from '@utils/errors/errorMessage';

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
function loginShellEnvironment(
  home: string,
): Effect.Effect<Readonly<Record<string, string>>, Error> {
  return Effect.try({
    try: () => {
      const { shell, username } = userInfo();
      const result = spawnSync(
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
          timeout: TIMEOUT_MS,
          encoding: 'utf8',
        },
      );
      if (result.error) throw result.error;
      const at = result.stdout.indexOf(MARKER);
      if (at < 0)
        throw new Error(
          `the login shell ${shell} printed no environment (exit ${result.status})`,
        );
      const entries = result.stdout
        .slice(at + MARKER.length)
        .split('\0')
        .flatMap((line) => {
          const eq = line.indexOf('=');
          return eq > 0
            ? [[line.slice(0, eq), line.slice(eq + 1)] as const]
            : [];
        });
      return Object.fromEntries(entries);
    },
    catch: (cause) =>
      new Error(
        `The login shell's environment was not read: ${toErrorMessage(cause)}`,
      ),
  });
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
