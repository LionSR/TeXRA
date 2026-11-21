import { Effect } from 'effect';
import * as ChildProcess from 'effect/process/ChildProcess';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { PlatformError } from 'effect/PlatformError';

import { runsInWsl } from '@texra-ai/harness/node';
import { externalOpenFailed, type HostFailed } from '@texra/hosts/uiHosts';

/**
 * Why the launcher did not open the URL: it could not start, or it exited
 * with a failure code. Facts only, never its argv, which is the URL (a
 * sign-in link can carry a code).
 */
type LaunchFault = { readonly command: string } & (
  | { readonly start: PlatformError['reason']['_tag'] }
  | { readonly exitCode: number }
);

/** The app's failure for a browser open, worded from the fault alone so
 *  the cause cannot carry the URL. */
function launchFailed(url: string, fault: LaunchFault): HostFailed {
  const what =
    'exitCode' in fault
      ? `exited with code ${fault.exitCode}`
      : `could not start (${fault.start})`;
  return externalOpenFailed(
    url,
    fault.command,
    `${fault.command} ${what}`,
    fault,
  );
}

interface BrowserLaunchCommand {
  readonly command: string;
  readonly args: string[];
}

function resolveBrowserLaunch(url: string, wsl: boolean): BrowserLaunchCommand {
  // WSL usually has no `xdg-open`, and the browser the person uses is the
  // Windows one: interop runs the same launcher `win32` uses.
  if (process.platform === 'linux' && wsl) {
    return {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    };
  }
  switch (process.platform) {
    case 'darwin':
      return {
        command: 'open',
        args: [url],
      };
    case 'win32':
      // Avoid `cmd /c start` so percent-encoded OAuth and compare URLs are not
      // reparsed as cmd environment-variable expansions.
      return {
        command: 'rundll32',
        args: ['url.dll,FileProtocolHandler', url],
      };
    default:
      return {
        command: 'xdg-open',
        args: [url],
      };
  }
}

/**
 * Hand one URL to the OS browser, or fail with what the launch faulted with.
 *
 * The launcher stays in our process group: in its own group, the scope's
 * release after `xdg-open` exits 0 would signal that group, which can hold
 * the browser it just forked.
 */
export const launchBrowser = Effect.fn('launchBrowser')(function* (
  url: string,
): Effect.fn.Return<void, HostFailed, ChildProcessSpawner> {
  const launch = resolveBrowserLaunch(url, runsInWsl());
  const spawner = yield* ChildProcessSpawner;
  // Never the `PlatformError` itself: its message embeds the argv, and the
  // argv is the URL.
  const code = yield* spawner
    .exitCode(
      ChildProcess.make(launch.command, launch.args, {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        detached: false,
        forceKillAfter: '5 seconds',
      }),
    )
    .pipe(
      Effect.mapError((error: PlatformError) =>
        launchFailed(url, {
          command: launch.command,
          start: error.reason._tag,
        }),
      ),
    );
  if (code !== 0) {
    return yield* launchFailed(url, {
      command: launch.command,
      exitCode: code,
    });
  }
});

/** Open `url`, answering false (logged) when no browser could be launched;
 *  every caller then prints the URL for the person to open. */
export const tryOpenBrowser = (
  url: string,
): Effect.Effect<boolean, never, ChildProcessSpawner> =>
  launchBrowser(url).pipe(
    Effect.as(true),
    Effect.catch((error: HostFailed) =>
      Effect.logDebug(error.message).pipe(Effect.as(false)),
    ),
  );
