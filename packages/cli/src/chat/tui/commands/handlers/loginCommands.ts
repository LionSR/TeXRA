import { Effect, FileSystem } from 'effect';

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
  githubSelectAccountWarning,
  hasLoginTransportConflict,
  LOGIN_TRANSPORT_CONFLICT_MESSAGE,
  parseChatLoginSlashArgs,
  parseCliLogoutTarget,
  type CliLoginSlashArgs,
  type CliLogoutTarget,
  type CliTexraLoginSlashArgs,
} from '@cli/runtime/loginOptions';
import {
  formatCliManualAuthUrlMessage,
  signInCliSupabase,
  signInCliSupabaseDeviceCode,
  signOutCliSupabase,
} from '@cli/runtime/supabaseAuth';
import { formatCliDeviceAuthMessage } from '@cli/runtime/supabaseAuthDeviceCode';
import type { SubscriptionProviderId } from '@controllers/modelAccess/subscriptionProviders';
import type { AgentDirectories } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { GlobalStorageFs } from '@platform/rootedFs';
import type { Secrets, PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  ACCOUNT_OUTCOME,
  CHATGPT_AUTH,
  GROK_AUTH,
  RESEARCHER_ACCESS_AUTH,
} from '@ui/copy/accountAuth';
import { collapseWhitespace } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  type SlashCommandOutput,
  transcriptSlashCommandOutput,
} from './slashContext';

const CHAT_LOGIN_USAGE = [
  'Usage: /login [texra [github | google]] [--no-browser] [--device] [--select-account] [--login-hint <account>]',
  '       /login chatgpt [--no-browser] [--device]',
  '       /login grok [--no-browser] [--device]',
].join('\n');
const CHAT_LOGOUT_USAGE = 'Usage: /logout chatgpt | grok | texra | all';

export function loginStartMessage(args: CliLoginSlashArgs): string {
  if (args.target === 'chatgpt') {
    if (args.device) return CHATGPT_AUTH.startingDevice;
    if (args.noBrowser) return CHATGPT_AUTH.startingNoBrowser;
    return CHATGPT_AUTH.startingBrowser;
  }
  if (args.target === 'grok') {
    if (args.device) return GROK_AUTH.startingDevice;
    if (args.noBrowser) return GROK_AUTH.startingNoBrowser;
    return GROK_AUTH.startingBrowser;
  }
  if (args.device) return RESEARCHER_ACCESS_AUTH.startingDevice;
  if (args.noBrowser)
    return RESEARCHER_ACCESS_AUTH.startingNoBrowser(args.provider);
  return RESEARCHER_ACCESS_AUTH.startingBrowser(args.provider);
}

/** Sign-in outcome copy shared by the subscription auth objects. */
interface SubscriptionAuthCopy {
  readonly signedInEnabled: (accountLabel: string) => string;
  readonly signedInOverrideDisabled: (
    accountLabel: string,
    target: string,
  ) => string;
}

const SUBSCRIPTION_AUTH_COPY: Record<
  SubscriptionProviderId,
  SubscriptionAuthCopy
> = { chatgpt: CHATGPT_AUTH, grok: GROK_AUTH };

/**
 * Subscription sign-in from the chat TUI, mirroring `signOutSubscription`
 * below: sign in with a copyable progress writer, flip the subscription
 * preference, then report the outcome in this surface's copy.
 */
const loginToSubscription = Effect.fn('loginToSubscription')(function* (
  stores: SettingsStores,
  providerId: SubscriptionProviderId,
  args: CliSubscriptionLoginTransportInit,
  output: SlashCommandOutput,
) {
  const account = yield* signInCliSubscription(providerId, args, {
    writeProgress: (message) =>
      output.writeProgress(message, { copyable: true }),
  });
  const update = yield* setCliSubscriptionPreference(stores, providerId, true);
  const auth = SUBSCRIPTION_AUTH_COPY[providerId];
  output.appendOutcome(
    update.effective
      ? auth.signedInEnabled(account.label)
      : auth.signedInOverrideDisabled(account.label, update.target),
  );
});

const loginToTexraAccount = Effect.fn('loginToTexraAccount')(function* (
  runtime: ProcessRuntime,
  args: CliTexraLoginSlashArgs,
  output: SlashCommandOutput,
) {
  const accountWarning = githubSelectAccountWarning(args);
  if (accountWarning) output.writeProgress(accountWarning);

  const session = args.device
    ? yield* signInCliSupabaseDeviceCode({
        onDeviceCode: (authorization) => {
          output.writeProgress(formatCliDeviceAuthMessage(authorization), {
            copyable: true,
          });
        },
      })
    : yield* signInCliSupabase(runtime, {
        provider: args.provider,
        openBrowser: !args.noBrowser,
        selectAccount: args.selectAccount,
        loginHint: args.loginHint,
        manualBrowserHint: '/login --no-browser',
        onAuthUrl: (url) => {
          if (args.noBrowser) {
            output.writeProgress(formatCliManualAuthUrlMessage(url), {
              copyable: true,
            });
          }
        },
      });
  output.appendOutcome(RESEARCHER_ACCESS_AUTH.signedIn(session.account.label));
});

export const loginFromChat = Effect.fn('loginFromChat')(function* (
  input: string,
  stores: SettingsStores,
  runtime: ProcessRuntime,
  context?: CliContext,
  output: SlashCommandOutput = transcriptSlashCommandOutput,
) {
  const args = parseChatLoginSlashArgs(input);
  if (!args) {
    output.setNotice(CHAT_LOGIN_USAGE);
    return;
  }

  // Match the CLI `login` guard: reject `--device` + `--no-browser` from the
  // user's parsed flags before subscription paths can auto-resolve `device`.
  if (hasLoginTransportConflict(args)) {
    output.setNotice(LOGIN_TRANSPORT_CONFLICT_MESSAGE);
    return;
  }

  let loginArgs = args;
  if (context && (args.target === 'chatgpt' || args.target === 'grok')) {
    loginArgs = {
      ...args,
      device: shouldUseSubscriptionDeviceCode(context, args),
    };
  }
  output.writeProgress(loginStartMessage(loginArgs));

  if (loginArgs.target === 'chatgpt' || loginArgs.target === 'grok') {
    yield* loginToSubscription(stores, loginArgs.target, loginArgs, output);
    return;
  }
  yield* loginToTexraAccount(runtime, loginArgs, output);
});

/**
 * The sign-out lines for one `/logout` target. Every leg reports its failure
 * as a line instead of throwing, so one failed provider never hides the
 * others' outcomes — the fold happens where each call settles, on the typed
 * channel.
 */
const logoutLines = (
  target: CliLogoutTarget,
  stores: SettingsStores,
  secrets: PlatformSecrets,
): Effect.Effect<
  readonly string[],
  never,
  Secrets | GlobalStorageFs | FileSystem.FileSystem | AgentDirectories
> =>
  Effect.gen(function* () {
    const lines: string[] = [];

    if (target === 'texra' || target === 'all') {
      lines.push(
        yield* signOutCliSupabase().pipe(
          Effect.match({
            onFailure: (error) =>
              RESEARCHER_ACCESS_AUTH.signOutFailedWithReason(
                toErrorMessage(error),
              ),
            onSuccess: () => RESEARCHER_ACCESS_AUTH.signedOut,
          }),
        ),
      );
    }

    const signOutSubscription = (
      providerId: SubscriptionProviderId,
      label: string,
    ): Effect.Effect<void, never, Secrets> =>
      signOutCliSubscription(stores, providerId).pipe(
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

    if (target === 'chatgpt' || target === 'all') {
      yield* signOutSubscription('chatgpt', CHATGPT_AUTH.label);
    }

    if (target === 'grok' || target === 'all') {
      yield* signOutSubscription('grok', GROK_AUTH.label);
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
  input: string,
  stores: SettingsStores,
  secrets: PlatformSecrets,
  output: SlashCommandOutput = transcriptSlashCommandOutput,
) {
  const target = parseCliLogoutTarget(input);
  if (!target) {
    output.setNotice(CHAT_LOGOUT_USAGE);
    return;
  }

  const lines = yield* logoutLines(target, stores, secrets);
  output.appendOutcome(collapseWhitespace(lines.join(' · ')));
});
