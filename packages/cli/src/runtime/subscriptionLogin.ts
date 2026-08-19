/**
 * CLI half of a subscription OAuth login (ChatGPT, Grok, …): which transport
 * this terminal can use, and how a terminal renders each prompt. The flow
 * itself and every provider binding come from the shared
 * `SUBSCRIPTION_PROVIDERS` catalog.
 */
import {
  subscriptionProvider,
  type SubscriptionAccount,
  type SubscriptionProviderId,
  type SubscriptionSignInPresenter,
} from '@controllers/modelAccess/subscriptionProviders';
import type { ConfigTarget } from '@platform/interfaces';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { tryOpenBrowser } from './browser';
import { isLikelyRemoteSession } from './remoteSession';
import { interactiveTerminalFailure } from './terminalRequirements';
import type { CliContext } from './cliContext';

export interface CliSubscriptionLoginTransportInit {
  readonly device: boolean;
  readonly noBrowser: boolean;
}

/** Progress sink + cancellation signal shared by every provider login. */
export interface CliSubscriptionLoginOptions {
  readonly writeProgress: (message: string) => void;
  readonly signal?: AbortSignal;
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
 * not hide the only manual route behind that wait. Print the URL once — later
 * status lines must not re-emit it (progress sinks append, not replace).
 */
async function writeCliLoopbackSignInProgress(options: {
  readonly writeProgress: (message: string) => void;
  readonly displayName: string;
  readonly url: string;
  readonly noBrowser: boolean;
}): Promise<void> {
  const { writeProgress, displayName, url, noBrowser } = options;
  writeProgress(`${displayName} sign-in URL:\n${url}`);
  if (noBrowser) return;

  writeProgress('Browser launch in progress...');
  if (await tryOpenBrowser(url)) {
    writeProgress('Browser opened; the same URL works in another browser.');
    return;
  }
  writeProgress('Automatic browser launch failed; open the sign-in URL above.');
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

/**
 * One subscription sign-in for every OAuth provider: device-code when the
 * terminal asked for it, loopback + browser otherwise. Everything
 * provider-specific is a catalog row; this file owns only the terminal
 * rendering of the two prompts.
 */
export async function signInCliSubscription(
  providerId: SubscriptionProviderId,
  init: CliSubscriptionLoginTransportInit,
  options: CliSubscriptionLoginOptions,
): Promise<SubscriptionAccount> {
  const provider = subscriptionProvider(providerId);
  const { displayName } = provider;
  const present: SubscriptionSignInPresenter = {
    presentDeviceCode: ({
      userCode,
      verificationUrl,
      verificationUrlComplete,
    }) => {
      const openUrl = verificationUrlComplete ?? verificationUrl;
      options.writeProgress(
        `To sign in with ${displayName}:\n  1. Open ${openUrl}\n  2. Enter the one-time code: ${userCode}\nWaiting for approval... (Ctrl-C cancels)`,
      );
    },
    presentSignInUrl: (url) =>
      writeCliLoopbackSignInProgress({
        writeProgress: options.writeProgress,
        displayName,
        url,
        noBrowser: init.noBrowser,
      }),
  };

  return provider.signIn({
    transport: init.device ? 'device' : 'loopback',
    present,
    signal: options.signal,
  });
}

/**
 * Sign out of a subscription provider and disable its preference, converting
 * a preference-write failure into a reported (not thrown) `preferenceError`.
 */
export async function signOutCliSubscription(
  providerId: SubscriptionProviderId,
): Promise<CliSubscriptionSignOutResult> {
  const provider = subscriptionProvider(providerId);
  await provider.signOut();
  try {
    return { preferenceUpdate: await provider.setPreferSubscription(false) };
  } catch (error: unknown) {
    return { preferenceError: toErrorMessage(error) };
  }
}

/** The preference half of a sign-out report. */
export function subscriptionSignOutPreferenceMessage(
  providerId: SubscriptionProviderId,
  result: CliSubscriptionSignOutResult,
): string {
  const { displayName, modelFamily } = subscriptionProvider(providerId);
  const update = result.preferenceUpdate;
  if (!update) {
    return `${displayName} subscription preference could not be disabled: ${result.preferenceError}`;
  }
  return update.effective
    ? `${displayName} subscription preference is still enabled because a more specific setting overrides ${update.target} config.`
    : `${displayName} subscription disabled for ${modelFamily}.`;
}

/**
 * Full sign-out outcome text, so the auth command and the launcher account
 * action report the same lines.
 */
export function subscriptionSignOutOutcomeMessage(
  providerId: SubscriptionProviderId,
  result: CliSubscriptionSignOutResult,
): string {
  const { displayName } = subscriptionProvider(providerId);
  return `Signed out of ${displayName}.\n${subscriptionSignOutPreferenceMessage(providerId, result)}`;
}
