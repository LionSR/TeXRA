/**
 * Shared CLI helpers for subscription OAuth logins (ChatGPT, Grok, …).
 */
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

/** Progress sink + cancellation signal shared by every provider login wrapper. */
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
 * The device-code prompt every subscription provider renders. Codex never
 * sets `verificationUrlComplete` (its prompt type has no such field), so the
 * `?? verificationUrl` fallback is a no-op for it and a prefill-URL win for
 * providers that supply one (xAI).
 */
interface CliSubscriptionDevicePrompt {
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly verificationUrlComplete?: string;
}

/**
 * One subscription sign-in flow for every OAuth provider: device-code when
 * requested, loopback+browser otherwise. The transports stay provider-owned
 * (injected by the caller from `@auth/<provider>`) so host mocks of those
 * modules keep intercepting them.
 */
export async function signInCliSubscription<Coordinator, Session>(options: {
  readonly coordinator: Coordinator;
  readonly displayName: string;
  readonly init: CliSubscriptionLoginTransportInit;
  readonly writeProgress: (message: string) => void;
  readonly signal?: AbortSignal;
  readonly loginWithDeviceCode: (transport: {
    readonly coordinator: Coordinator;
    readonly onPrompt: (prompt: CliSubscriptionDevicePrompt) => void;
    readonly signal?: AbortSignal;
  }) => Promise<Session>;
  readonly loginWithLoopback: (transport: {
    readonly coordinator: Coordinator;
    readonly openBrowser: (url: string) => void | Promise<void>;
    readonly signal?: AbortSignal;
  }) => Promise<Session>;
}): Promise<Session> {
  const { coordinator, displayName, init, writeProgress, signal } = options;

  if (init.device) {
    return options.loginWithDeviceCode({
      coordinator,
      onPrompt: ({ userCode, verificationUrl, verificationUrlComplete }) => {
        const openUrl = verificationUrlComplete ?? verificationUrl;
        writeProgress(
          `To sign in with ${displayName}:\n  1. Open ${openUrl}\n  2. Enter the one-time code: ${userCode}\nWaiting for approval... (Ctrl-C cancels)`,
        );
      },
      signal,
    });
  }

  return options.loginWithLoopback({
    coordinator,
    openBrowser: (url) =>
      writeCliLoopbackSignInProgress({
        writeProgress,
        displayName,
        url,
        noBrowser: init.noBrowser,
      }),
    signal,
  });
}

/**
 * Sign out of a subscription provider and disable its preference, converting
 * a preference-write failure into a reported (not thrown) `preferenceError`.
 */
export async function signOutCliSubscription(options: {
  readonly coordinator: { readonly signOut: () => Promise<void> };
  readonly disablePreference: () => Promise<{
    readonly effective: boolean;
    readonly target: ConfigTarget;
  }>;
}): Promise<CliSubscriptionSignOutResult> {
  await options.coordinator.signOut();
  try {
    return { preferenceUpdate: await options.disablePreference() };
  } catch (error: unknown) {
    return { preferenceError: toErrorMessage(error) };
  }
}

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
