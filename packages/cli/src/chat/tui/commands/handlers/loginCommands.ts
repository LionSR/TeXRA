import { Effect } from 'effect';

import { bumpCodexPreferenceVersion } from '@cli/chat/tui/state/cliState';
import { setCliSubscriptionPreference } from '@cli/chat/tui/state/subscriptionPreference';
import {
  shouldUseSubscriptionDeviceCode,
  signInCliSubscription,
  signOutCliSubscription,
  subscriptionSignOutPreferenceMessage,
  type CliSubscriptionLoginTransportInit,
} from '@cli/runtime/subscriptionLogin';
import { loadCliModelAccessOverview } from '@cli/runtime/apiStatus';
import { type CliContext } from '@cli/runtime/cliContext';
import {
  hasLoginTransportConflict,
  LOGIN_TRANSPORT_CONFLICT_MESSAGE,
  parseChatLoginSlashArgs,
  type CliLoginSlashArgs,
  type CliLogoutTarget,
} from '@cli/runtime/loginOptions';
import type { AgentCatalogServices } from '@platform/processRuntime';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { SUBSCRIPTION_AUTH_PROVIDERS } from '@shared/model/subscriptionAuth';
import {
  ACCOUNT_OUTCOME,
  SUBSCRIPTION_AUTH_COPY,
} from '@shared/model/accountAuth';
import type { SubscriptionProviderId } from '@texra/controllers/modelAccess/subscriptionProviders';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  type SlashCommandOutput,
  transcriptSlashCommandOutput,
} from './slashContext';
import type { Secrets, PlatformSecrets } from '@texra-ai/harness';

const CHAT_LOGIN_USAGE = [
  'Usage: /login chatgpt [--no-browser] [--device]',
  '       /login grok [--no-browser] [--device]',
  '       /login status',
].join('\n');

export function loginStartMessage(args: CliLoginSlashArgs): string {
  const copy = SUBSCRIPTION_AUTH_COPY[args.target];
  if (args.device) return copy.startingDevice;
  if (args.noBrowser) return copy.startingNoBrowser;
  return copy.startingBrowser;
}

/**
 * Subscription sign-in from the chat TUI, mirroring the sign-out in
 * `logoutLines` below: sign in with a copyable progress writer, flip the subscription
 * preference, then report the outcome in this surface's copy.
 */
const loginToSubscription = Effect.fn('loginToSubscription')(function* (
  stores: SettingsStores,
  providerId: SubscriptionProviderId,
  args: CliSubscriptionLoginTransportInit,
  output: SlashCommandOutput,
) {
  const account = yield* signInCliSubscription(providerId, args, {
    writeProgress: output.writeProgress,
  });
  yield* setCliSubscriptionPreference(stores, providerId, true);
  output.appendOutcome(
    SUBSCRIPTION_AUTH_COPY[providerId].signedInEnabled(account.label),
  );
});

export const loginFromChat = Effect.fn('loginFromChat')(function* (
  input: string,
  stores: SettingsStores,
  context?: CliContext,
  output: SlashCommandOutput = transcriptSlashCommandOutput,
) {
  const args = parseChatLoginSlashArgs(input);
  if (!args) {
    output.setNotice(CHAT_LOGIN_USAGE);
    return;
  }

  // Reject `--device` + `--no-browser` from the user's parsed flags before
  // the subscription path can auto-resolve `device`.
  if (hasLoginTransportConflict(args)) {
    output.setNotice(LOGIN_TRANSPORT_CONFLICT_MESSAGE);
    return;
  }

  const loginArgs = context
    ? { ...args, device: shouldUseSubscriptionDeviceCode(context, args) }
    : args;
  output.writeProgress(loginStartMessage(loginArgs));
  yield* loginToSubscription(stores, loginArgs.target, loginArgs, output);
});

/**
 * The sign-out lines for one sign-out target. Every leg reports its failure
 * as a line instead of throwing, so one failed provider never hides the
 * others' outcomes — the fold happens where each call settles, on the typed
 * channel.
 */
const logoutLines = (
  target: CliLogoutTarget,
  stores: SettingsStores,
  secrets: PlatformSecrets,
): Effect.Effect<readonly string[], never, Secrets | AgentCatalogServices> =>
  Effect.gen(function* () {
    const lines: string[] = [];

    for (const providerId of SUBSCRIPTION_AUTH_PROVIDERS) {
      if (target !== providerId && target !== 'all') continue;
      const { label } = SUBSCRIPTION_AUTH_COPY[providerId];
      yield* signOutCliSubscription(stores, providerId).pipe(
        Effect.match({
          onFailure: (error) => {
            lines.push(
              ACCOUNT_OUTCOME.signOutFailedWithReason(
                label,
                toErrorMessage(error),
              ),
            );
          },
          onSuccess: (update) => {
            bumpCodexPreferenceVersion();
            lines.push(ACCOUNT_OUTCOME.signedOut(label));
            lines.push(
              subscriptionSignOutPreferenceMessage(providerId, update),
            );
          },
        }),
      );
    }

    const overviewLines = yield* loadCliModelAccessOverview(
      stores,
      secrets,
    ).pipe(
      Effect.match({
        onFailure: (error) => [toErrorMessage(error)],
        onSuccess: (overview) => overview.lines,
      }),
    );
    lines.push(...overviewLines);
    return lines;
  });

export const logoutFromChat = Effect.fn('logoutFromChat')(function* (
  target: CliLogoutTarget,
  stores: SettingsStores,
  secrets: PlatformSecrets,
  output: SlashCommandOutput = transcriptSlashCommandOutput,
) {
  const lines = yield* logoutLines(target, stores, secrets);
  output.appendOutcome(lines.join('\n'));
});
