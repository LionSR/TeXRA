// Third-party imports
import { Effect } from 'effect';

// Local imports
import { ExternalOpenFailed, type ExternalOpener } from '@hosts/uiHosts';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { launchBrowser } from '../browser';

/**
 * The terminal's browser hand-off behind the host-neutral
 * {@link ExternalOpener}: the third implementation of the port, beside VS
 * Code's `env.openExternal` and Electron's `shell.openExternal`.
 *
 * `launchBrowser` is the foreign API this port adapts — `open`, `rundll32`,
 * or `xdg-open`, whichever the platform answers with. It reports a spawn
 * failure and a non-zero exit as the same "could not open a browser" fault,
 * which is what this port's one failure means, so its rejection is worded
 * straight into {@link ExternalOpenFailed}. Nothing waits on the browser
 * itself, so an interrupted fiber detaches from the launch exactly as the two
 * graphical hosts detach from theirs.
 */
export class CliExternalOpener implements ExternalOpener {
  openExternal(url: string): Effect.Effect<void, ExternalOpenFailed> {
    return Effect.tryPromise({
      try: () => launchBrowser(url),
      catch: (cause) =>
        new ExternalOpenFailed({
          kind: 'url',
          target: url,
          // `launchBrowser` already words the platform's own refusal (a
          // missing `xdg-open`, a non-zero exit) without echoing the URL,
          // which matters: these are sign-in and provider-key URLs.
          message: toErrorMessage(cause),
          cause,
        }),
    });
  }
}

/** The process's one instance. The host holds no state — every member spawns
 *  the platform's opener at call time — so the surfaces that open a URL share
 *  this rather than each constructing a copy of the same empty object. */
export const cliExternalOpener = new CliExternalOpener();
