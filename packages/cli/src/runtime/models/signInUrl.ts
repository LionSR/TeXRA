/**
 * How a terminal shows a loopback sign-in URL, shared by every subscription
 * sign-in.
 */
import { Effect } from 'effect';
import { launchBrowser } from './browser';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { HostFailed } from '@texra/hosts/uiHosts';

/** The URL is a loopback address on the machine running texra. */
const REMOTE_CALLBACK_HINT =
  'Over SSH or in a container, forward the callback port to open it from your local browser.';

/**
 * Progress sink shared by every sign-in. `copyable` marks the instructions
 * (the URL, the device code) apart from status lines, so a sink that shows
 * only its latest message still keeps the instructions on screen.
 * `persistent` marks guidance (a hint, a failed launch) that must outlive the
 * next status line without being styled as text to copy.
 */
export type CliSignInProgress = (
  message: string,
  options?: { readonly copyable?: boolean; readonly persistent?: boolean },
) => void;

/**
 * Publish the loopback sign-in URL, then try the browser. The URL is always
 * shown: the launcher may open a browser signed in to a different account,
 * or stay open until the browser exits, and the printed URL is the manual
 * route for each. A launch that fails is reported as the app's `HostFailed`,
 * and the sign-in decides what follows (a one-time device code where the
 * provider has one). Print the URL once; later status lines must not re-emit
 * it (transcript sinks append).
 */
export function presentCliSignInUrl(options: {
  readonly writeProgress: CliSignInProgress;
  readonly displayName: string;
  readonly url: string;
  readonly noBrowser: boolean;
}): Effect.Effect<void, HostFailed, ChildProcessSpawner> {
  const { writeProgress, displayName, url, noBrowser } = options;
  return Effect.gen(function* () {
    writeProgress(`${displayName} sign-in URL:\n${url}`, { copyable: true });
    if (noBrowser) {
      writeProgress(REMOTE_CALLBACK_HINT, { persistent: true });
      return;
    }

    writeProgress('Browser launch in progress...');
    yield* launchBrowser(url).pipe(
      Effect.tapError(() =>
        Effect.sync(() =>
          writeProgress('Automatic browser launch failed.', {
            persistent: true,
          }),
        ),
      ),
    );
    writeProgress(
      'Browser opened. Wrong browser or account? Open the URL above in another browser.',
    );
  });
}
