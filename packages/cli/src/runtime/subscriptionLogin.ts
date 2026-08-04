/**
 * Shared CLI helpers for subscription OAuth logins (ChatGPT, Grok, …).
 */
import type { ConfigTarget } from '@platform/interfaces';

import { tryOpenBrowser } from './browser';
import { isLikelyRemoteSession } from './remoteSession';
import { interactiveTerminalFailure } from './terminalRequirements';
import type { CliContext } from './cliContext';

export interface CliSubscriptionLoginTransportInit {
  readonly device: boolean;
  readonly noBrowser: boolean;
}

/**
 * Device-code is the right default when the browser callback is likely
 * unreachable: remote shells, non-text output, non-TTY/headless/dumb terminals,
 * or `--no-input`. An explicit `--no-browser` keeps the loopback flow but
 * prints the URL to paste.
 */
export function shouldUseSubscriptionDeviceCode(
  context: CliContext,
  init: CliSubscriptionLoginTransportInit,
): boolean {
  if (init.device) return true;
  if (init.noBrowser) return false;
  return (
    context.outputFormat !== 'text' ||
    interactiveTerminalFailure(context) !== undefined ||
    isLikelyRemoteSession()
  );
}

/**
 * Publish the loopback sign-in URL before awaiting the browser process.
 * Some launchers remain open until the browser exits; the sign-in panel must
 * not hide the only manual route behind that wait.
 */
export async function writeCliLoopbackSignInProgress(options: {
  readonly writeProgress: (message: string) => void;
  readonly displayName: string;
  readonly url: string;
  readonly noBrowser: boolean;
}): Promise<void> {
  const { writeProgress, displayName, url, noBrowser } = options;
  if (noBrowser) {
    writeProgress(`${displayName} sign-in URL:\n${url}`);
    return;
  }

  writeProgress(
    `${displayName} sign-in URL:\n${url}\nBrowser launch in progress...`,
  );
  if (await tryOpenBrowser(url)) {
    writeProgress(
      `${displayName} sign-in URL:\n${url}\nBrowser opened; the same URL works in another browser.`,
    );
    return;
  }
  writeProgress(
    `${displayName} sign-in URL:\n${url}\nAutomatic browser launch failed; the URL remains available above.`,
  );
}

export type CliSubscriptionSignOutResult =
  | {
      readonly preferenceUpdate: {
        readonly effective: boolean;
        readonly target: ConfigTarget;
      };
      readonly preferenceError?: undefined;
    }
  | {
      readonly preferenceUpdate?: undefined;
      readonly preferenceError: string;
    };

export function subscriptionSignOutPreferenceMessage(options: {
  readonly displayName: string;
  readonly disabledFor: string;
  readonly result: CliSubscriptionSignOutResult;
}): string {
  const { displayName, disabledFor, result } = options;
  const update = result.preferenceUpdate;
  if (!update) {
    return `${displayName} subscription preference could not be disabled: ${result.preferenceError}`;
  }
  return update.effective
    ? `${displayName} subscription preference is still enabled because a more specific setting overrides ${update.target} config.`
    : `${displayName} subscription disabled for ${disabledFor}.`;
}
