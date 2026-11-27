import { Effect } from 'effect';

import {
  type AppSignals,
  type Secrets,
  type SettingsStores,
} from '@texra-ai/worldline/plugins';

import {
  toErrorMessage,
  SUBSCRIPTION_AUTH_PROVIDERS,
} from '@texra-ai/worldline/schemas';
import {
  resolveLoginTransport,
  signInCliSubscription,
  signOutCliSubscription,
  subscriptionSignOutPreferenceMessage,
} from '@cli/runtime/models/subscriptionLogin';
import { loadCliModelAccessOverview } from '@cli/runtime/models/apiStatus';
import {
  LOGIN_TRANSPORT_CONFLICT_MESSAGE,
  parseChatLoginSlashArgs,
  type CliLoginSlashArgs,
  type LoginTransport,
  type CliLogoutTarget,
} from '@cli/runtime/models/loginOptions';
import {
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@texra/controllers/modelAccess/subscriptionProviders';
import { ACCOUNT_OUTCOME, SUBSCRIPTION_AUTH_COPY } from '@ui/copy/accountAuth';

import {
  type SlashCommandContext,
  type SlashCommandOutput,
  transcriptSlashCommandOutput,
} from './slashContext';
import type { SubscriptionAccounts } from '@texra-ai/llm/node';
import type { HttpClient } from 'effect/http';

const CHAT_LOGIN_USAGE = [
  'Usage: /login chatgpt [--no-browser] [--device]',
  '       /login grok [--no-browser] [--device]',
  '       /login status',
].join('\n');

export function loginStartMessage(args: CliLoginSlashArgs): string {
  const copy = SUBSCRIPTION_AUTH_COPY[args.target];
  switch (args.transport) {
    case 'device':
      return copy.startingDevice;
    case 'no-browser':
      return copy.startingNoBrowser;
    case 'auto':
      return copy.startingBrowser;
  }
}

/**
 * Subscription sign-in from the chat TUI, mirroring the sign-out in
 * `logoutLines` below: sign in with a copyable progress writer, which also
 * turns on the subscription preference, then report the outcome in this
 * surface's copy.
 */
const loginToSubscription = Effect.fn('loginToSubscription')(function* (
  stores: SettingsStores,
  providerId: SubscriptionProviderId,
  transport: LoginTransport,
  output: SlashCommandOutput,
) {
  const account = yield* signInCliSubscription(stores, providerId, transport, {
    writeProgress: output.writeProgress,
  });
  const { displayName, modelFamily } = subscriptionProvider(providerId);
  output.appendOutcome(
    ACCOUNT_OUTCOME.signedInEnabled(displayName, account.label, modelFamily),
  );
});

export const loginFromChat = Effect.fn('loginFromChat')(function* (
  input: string,
  context: SlashCommandContext,
  output: SlashCommandOutput = transcriptSlashCommandOutput,
) {
  const args = parseChatLoginSlashArgs(input);
  if (!args) {
    output.setNotice(CHAT_LOGIN_USAGE);
    return;
  }

  if (args === 'conflict') {
    output.setNotice(LOGIN_TRANSPORT_CONFLICT_MESSAGE);
    return;
  }

  const transport = resolveLoginTransport(context.cliContext, args.transport);
  output.writeProgress(loginStartMessage({ target: args.target, transport }));
  yield* loginToSubscription(context.stores, args.target, transport, output);
});

/**
 * The sign-out lines for one sign-out target. Every leg reports its failure
 * as a line instead of throwing, so one failed provider never hides the
 * others' outcomes — each failure becomes a line where its call finishes, on the typed
 * channel.
 */
const logoutLines = Effect.fn('loginCommands.logoutLines')(function* (
  target: CliLogoutTarget,
  stores: SettingsStores,
): Effect.fn.Return<
  readonly string[],
  never,
  Secrets | SubscriptionAccounts | HttpClient.HttpClient | AppSignals
> {
  const lines = yield* Effect.forEach(
    SUBSCRIPTION_AUTH_PROVIDERS.filter(
      (id) => target === 'all' || target === id,
    ),
    (providerId) => {
      const { label } = SUBSCRIPTION_AUTH_COPY[providerId];
      return signOutCliSubscription(stores, providerId).pipe(
        Effect.match({
          onFailure: (error) => [
            ACCOUNT_OUTCOME.signOutFailedWithReason(
              label,
              toErrorMessage(error),
            ),
          ],
          onSuccess: (update) => [
            ACCOUNT_OUTCOME.signedOut(label),
            subscriptionSignOutPreferenceMessage(providerId, update),
          ],
        }),
      );
    },
  );

  const overviewLines = yield* loadCliModelAccessOverview(stores).pipe(
    Effect.match({
      onFailure: (error) => [toErrorMessage(error)],
      onSuccess: (overview) => overview.lines,
    }),
  );
  return [...lines.flat(), ...overviewLines];
});

export const logoutFromChat = Effect.fn('logoutFromChat')(function* (
  target: CliLogoutTarget,
  stores: SettingsStores,
  output: SlashCommandOutput = transcriptSlashCommandOutput,
) {
  const lines = yield* logoutLines(target, stores);
  output.appendOutcome(lines.join('\n'));
});
