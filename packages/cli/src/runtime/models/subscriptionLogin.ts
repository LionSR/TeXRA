/**
 * CLI half of a subscription OAuth login (ChatGPT, Grok, …): which transport
 * this terminal can use, and how a terminal renders each prompt. The flow
 * itself and every provider binding come from the shared
 * `SUBSCRIPTION_PROVIDERS` catalog.
 */
import { Effect } from 'effect';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import { ensureError } from '@texra-ai/harness/schemas';
import {
  subscriptionProvider,
  type SubscriptionProviderId,
  type SubscriptionSignInPresenter,
  type SubscriptionSignOutResult,
} from '@texra/controllers/modelAccess/subscriptionProviders';
import { ACCOUNT_OUTCOME } from '@ui/copy/accountAuth';

import { presentCliSignInUrl, type CliSignInProgress } from './signInUrl';
import { interactiveTerminalFailure } from '../terminal/terminalRequirements';
import { cliEnvValue, type CliContext } from '../platform/cliContext';
import type { SettingsStores } from '@texra-ai/harness/plugins';

export interface CliSubscriptionLoginTransportInit {
  readonly device: boolean;
  readonly noBrowser: boolean;
}

/** Progress sink shared by every provider login. */
export interface CliSubscriptionLoginOptions {
  readonly writeProgress: CliSignInProgress;
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
    // An SSH session (one of these set) probably cannot open a local
    // browser or receive a loopback callback.
    ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'].some((name) =>
      Boolean(cliEnvValue(name)),
    )
  );
}

/** A sign-out whose preference write failed carries the reason. */
type CliSubscriptionSignOutResult = SubscriptionSignOutResult;

/**
 * One subscription sign-in program for every OAuth provider: device-code when
 * the terminal asked for it, loopback + browser otherwise. Everything
 * provider-specific is a catalog row; this file owns only the terminal
 * rendering of the two prompts. The command action or slash handler runs it,
 * where its cancellation signal (if any) becomes fiber interruption.
 */
export const signInCliSubscription = Effect.fn(
  'subscriptionLogin.signInCliSubscription',
)(function* (
  stores: SettingsStores,
  providerId: SubscriptionProviderId,
  init: CliSubscriptionLoginTransportInit,
  options: CliSubscriptionLoginOptions,
) {
  const provider = subscriptionProvider(providerId);
  const { displayName } = provider;
  // The presenter port runs with nothing in context, so the spawner this
  // program holds is handed to the browser launch.
  const spawner = yield* ChildProcessSpawner;
  const present: SubscriptionSignInPresenter = {
    presentDeviceCode: ({
      userCode,
      verificationUrl,
      verificationUrlComplete,
    }) =>
      Effect.sync(() => {
        const openUrl = verificationUrlComplete ?? verificationUrl;
        options.writeProgress(
          `To sign in with ${displayName}:\n  1. Open ${openUrl}\n  2. Enter the one-time code: ${userCode}\nWaiting for approval... (Ctrl-C cancels)`,
          { copyable: true },
        );
      }),
    // A device request reaches the browser flow only for a provider without
    // a device code (ChatGPT); the shell that asked for one cannot open a
    // browser, so the URL is printed.
    presentSignInUrl: (url) =>
      presentCliSignInUrl({
        writeProgress: options.writeProgress,
        displayName,
        url,
        noBrowser: init.noBrowser || init.device,
      }).pipe(Effect.provideService(ChildProcessSpawner, spawner)),
  };

  return yield* provider.signIn({
    // `auto` tries the browser callback and drops to a device code when its
    // ports are taken or no browser is reachable, so the user is never left
    // with a bare bind error and no link.
    transport: init.device ? 'device' : 'auto',
    present,
    stores,
  });
});

/**
 * Sign out of a subscription provider; the app's sign-out also turns its
 * preference off and reports a failed write in the result. The command
 * action or slash handler runs the program at its Promise edge.
 */
export const signOutCliSubscription = Effect.fn(
  'subscriptionLogin.signOutCliSubscription',
)(function* (stores: SettingsStores, providerId: SubscriptionProviderId) {
  return yield* subscriptionProvider(providerId)
    .signOut(stores)
    .pipe(Effect.mapError(ensureError));
});

/** The preference half of a sign-out report. */
export function subscriptionSignOutPreferenceMessage(
  providerId: SubscriptionProviderId,
  result: CliSubscriptionSignOutResult,
): string {
  const { displayName, modelFamily } = subscriptionProvider(providerId);
  return result.preferenceError === undefined
    ? `${displayName} subscription disabled for ${modelFamily}.`
    : `${displayName} subscription could not be disabled: ${result.preferenceError}`;
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
  return `${ACCOUNT_OUTCOME.signedOut(displayName)}\n${subscriptionSignOutPreferenceMessage(providerId, result)}`;
}
