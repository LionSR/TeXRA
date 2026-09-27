import { Data, Effect } from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import { envVar } from '@utils/system/envFlags';
import type { PlatformError } from 'effect/PlatformError';

/** The OS browser launcher could not open the URL. The message never
 *  carries the URL, which can be a sign-in link. */
class BrowserLaunchFailed extends Data.TaggedError('BrowserLaunchFailed')<{
  readonly message: string;
}> {}

interface BrowserLaunchCommand {
  readonly command: string;
  readonly args: string[];
}

function resolveBrowserLaunch(
  url: string,
  wsl: boolean,
  platform: NodeJS.Platform = process.platform,
): BrowserLaunchCommand {
  // WSL usually has no `xdg-open`, and the browser the person uses is the
  // Windows one: interop runs the same launcher `win32` uses.
  if (platform === 'linux' && wsl) {
    return {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    };
  }
  switch (platform) {
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
 * Exported for `CliExternalOpener`, which words the failure as the
 * host-neutral `ExternalOpenFailed` the {@link ExternalOpener} port carries;
 * the sign-in callers keep their own manual-URL wording.
 *
 * The launcher stays in our process group: in its own group, the scope's
 * release after `xdg-open` exits 0 would signal that group, which can hold
 * the browser it just forked.
 */
export const launchBrowser = Effect.fn('launchBrowser')(function* (
  url: string,
): Effect.fn.Return<void, BrowserLaunchFailed, ChildProcessSpawner> {
  const wsl =
    (yield* envVar('WSL_DISTRO_NAME')) !== undefined ||
    (yield* envVar('WSL_INTEROP')) !== undefined;
  const launch = resolveBrowserLaunch(url, wsl);
  const spawner = yield* ChildProcessSpawner;
  // Never the `PlatformError` message: it embeds the argv, and the argv is
  // the URL.
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
      Effect.mapError(
        (error: PlatformError) =>
          new BrowserLaunchFailed({
            message: `Could not open the browser automatically: ${launch.command} could not start (${error.reason._tag})`,
          }),
      ),
    );
  if (code !== 0) {
    return yield* new BrowserLaunchFailed({
      message: `Could not open the browser automatically: ${launch.command} exited with code ${code}`,
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
    Effect.catch((error: BrowserLaunchFailed) =>
      Effect.logDebug(error.message).pipe(Effect.as(false)),
    ),
  );
