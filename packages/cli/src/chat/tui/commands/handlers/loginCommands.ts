import { Cause, Exit } from 'effect';

import type { SupabaseSession } from '@auth/SupabaseSession';
import {
  refreshSubscriptionPreferenceViews,
  setCliSubscriptionPreference,
} from '@cli/chat/tui/state/subscriptionPreference';
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
import { effectRuntime } from '@platform/processRuntime';
import {
  ACCOUNT_OUTCOME,
  CHATGPT_AUTH,
  GROK_AUTH,
  RESEARCHER_ACCESS_AUTH,
} from '@shared/copy/accountAuth';
import { collapseWhitespace } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  abortableSlashCommand,
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
async function loginToSubscription(
  providerId: SubscriptionProviderId,
  args: CliSubscriptionLoginTransportInit,
  output: SlashCommandOutput,
  signal: AbortSignal,
): Promise<void> {
  const account = await signInCliSubscription(providerId, args, {
    writeProgress: (message) =>
      output.writeProgress(message, { copyable: true }),
    signal,
  });
  const update = await setCliSubscriptionPreference(providerId, true);
  const auth = SUBSCRIPTION_AUTH_COPY[providerId];
  output.appendOutcome(
    update.effective
      ? auth.signedInEnabled(account.label)
      : auth.signedInOverrideDisabled(account.label, update.target),
  );
}

async function loginToTexraAccount(
  args: CliTexraLoginSlashArgs,
  output: SlashCommandOutput,
  signal: AbortSignal,
): Promise<void> {
  const accountWarning = githubSelectAccountWarning(args);
  if (accountWarning) output.writeProgress(accountWarning);

  let session: SupabaseSession;
  if (args.device) {
    // The slash command's abort is the program's interruption, surfaced as
    // the abort reason the browser transport rejects with so the caller
    // treats both alike.
    const exit = await effectRuntime().runPromiseExit(
      signInCliSupabaseDeviceCode({
        onDeviceCode: (authorization) => {
          output.writeProgress(formatCliDeviceAuthMessage(authorization), {
            copyable: true,
          });
        },
      }),
      { signal },
    );
    if (Exit.isFailure(exit)) {
      throw signal.aborted ? signal.reason : Cause.squash(exit.cause);
    }
    session = exit.value;
  } else {
    session = await signInCliSupabase({
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
      signal,
    });
  }
  output.appendOutcome(RESEARCHER_ACCESS_AUTH.signedIn(session.account.label));
}

export function loginFromChat(
  input: string,
  context?: CliContext,
  output: SlashCommandOutput = transcriptSlashCommandOutput,
): Promise<void> & { readonly abort: () => void } {
  return abortableSlashCommand(async (signal) => {
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
      await loginToSubscription(loginArgs.target, loginArgs, output, signal);
      return;
    }
    await loginToTexraAccount(loginArgs, output, signal);
  });
}

export async function logoutFromChat(
  input: string,
  output: SlashCommandOutput = transcriptSlashCommandOutput,
): Promise<void> {
  const target = parseCliLogoutTarget(input);
  if (!target) {
    output.setNotice(CHAT_LOGOUT_USAGE);
    return;
  }

  const lines: string[] = [];

  if (target === 'texra' || target === 'all') {
    try {
      await signOutCliSupabase();
      lines.push(RESEARCHER_ACCESS_AUTH.signedOut);
    } catch (error: unknown) {
      lines.push(
        RESEARCHER_ACCESS_AUTH.signOutFailedWithReason(toErrorMessage(error)),
      );
    }
  }

  async function signOutSubscription(
    providerId: SubscriptionProviderId,
    label: string,
  ): Promise<void> {
    try {
      const update = await signOutCliSubscription(providerId);
      refreshSubscriptionPreferenceViews();
      lines.push(ACCOUNT_OUTCOME.signedOut(label));
      lines.push(subscriptionSignOutPreferenceMessage(providerId, update));
    } catch (error: unknown) {
      lines.push(
        ACCOUNT_OUTCOME.signOutFailedWithReason(label, toErrorMessage(error)),
      );
    }
  }

  if (target === 'chatgpt' || target === 'all') {
    await signOutSubscription('chatgpt', CHATGPT_AUTH.label);
  }

  if (target === 'grok' || target === 'all') {
    await signOutSubscription('grok', GROK_AUTH.label);
  }

  try {
    const overview = await loadCliModelAccessOverview();
    lines.push(...overview.lines);
  } catch (error: unknown) {
    lines.push(toErrorMessage(error));
  }

  output.appendOutcome(collapseWhitespace(lines.join(' · ')));
}
