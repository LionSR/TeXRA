/**
 * How a terminal shows a loopback sign-in URL, shared by the TeXRA-account
 * sign-in and every subscription sign-in.
 */
import { Effect } from 'effect';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import { tryOpenBrowser } from './browser';

/**
 * Progress sink shared by every sign-in. `copyable` marks the instructions
 * (the URL, the device code) apart from status lines, so a sink that shows
 * only its latest message still keeps the instructions on screen.
 */
export type CliSignInProgress = (
  message: string,
  options?: { readonly copyable?: boolean },
) => void;

/**
 * Publish the loopback sign-in URL, then try the browser. The URL is always
 * shown: the launcher may open a browser signed in to a different account,
 * open nothing (WSL, containers), or stay open until the browser exits, and
 * the printed URL is the manual route for each. A failed launch is a status
 * line, not a failure — the callback is still waiting for that URL. Print
 * the URL once; later status lines must not re-emit it (transcript sinks
 * append).
 */
export function presentCliSignInUrl(options: {
  readonly writeProgress: CliSignInProgress;
  readonly displayName: string;
  readonly url: string;
  readonly noBrowser: boolean;
}): Effect.Effect<void, never, ChildProcessSpawner> {
  const { writeProgress, displayName, url, noBrowser } = options;
  return Effect.gen(function* () {
    writeProgress(`${displayName} sign-in URL:\n${url}`, { copyable: true });
    if (noBrowser) return;

    writeProgress('Browser launch in progress...');
    // Infallible by construction: `tryOpenBrowser` answers false rather than
    // failing, so the launch outcome is a value, not a failure.
    if (yield* tryOpenBrowser(url)) {
      writeProgress(
        'Browser opened. Wrong browser or account? Open the URL above in another browser.',
      );
      return;
    }
    writeProgress(
      'Automatic browser launch failed; open the sign-in URL above.',
    );
  });
}
