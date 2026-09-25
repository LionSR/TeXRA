// Third-party imports
import { Effect } from 'effect';

// Local imports
import { ExternalOpenFailed, type ExternalOpener } from '@hosts/uiHosts';
import { nodePlatformServices } from '@platform/defaults/nodePlatform';

import { launchBrowser } from '../browser';

/**
 * The terminal's browser hand-off behind the host-neutral
 * {@link ExternalOpener}: the third implementation of the port, beside VS
 * Code's `env.openExternal` and Electron's `shell.openExternal`.
 *
 * `launchBrowser` is the foreign API this port adapts — `open`, `rundll32`,
 * or `xdg-open`, whichever the platform answers with. It reports a spawn
 * failure and a non-zero exit as the same "could not open a browser" fault,
 * which is what this port's one failure means, so its failure is worded
 * straight into {@link ExternalOpenFailed}. The port is served with nothing
 * in context, so this module-level adapter is where the Node spawner is
 * discharged, from the same layer value every process runtime merges.
 */
class CliExternalOpener implements ExternalOpener {
  openExternal(url: string): Effect.Effect<void, ExternalOpenFailed> {
    return launchBrowser(url).pipe(
      Effect.mapError(
        (cause) =>
          new ExternalOpenFailed({
            kind: 'url',
            target: url,
            // `launchBrowser` already words the platform's own refusal (a
            // missing `xdg-open`, a non-zero exit) without echoing the URL,
            // which matters: these are sign-in and provider-key URLs.
            message: cause.message,
            cause,
          }),
      ),
      Effect.provide(nodePlatformServices),
    );
  }
}

/** The process's one instance. The host holds no state — every member spawns
 *  the platform's opener at call time — so the surfaces that open a URL share
 *  this rather than each constructing a copy of the same empty object. */
export const cliExternalOpener = new CliExternalOpener();
