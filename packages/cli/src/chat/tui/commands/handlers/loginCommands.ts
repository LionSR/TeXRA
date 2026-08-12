import { xaiAccountLabel } from '@auth/xai';
import { codexAccountLabel } from '@auth/codex/codexSessionTypes';
import {
  refreshSubscriptionPreferenceViews,
  setCliCodexSubscription,
} from '@cli/chat/tui/state/codexSubscription';
import { setCliXaiSubscription } from '@cli/chat/tui/state/xaiSubscription';
import { sessionMeta } from '@cli/chat/tui/state/cliState';
import {
  chatGptSignOutPreferenceMessage,
  signInCliChatGpt,
  signOutCliChatGpt,
} from '@cli/runtime/chatgptLogin';
import {
  grokSignOutPreferenceMessage,
  signInCliGrok,
  signOutCliGrok,
} from '@cli/runtime/grokLogin';
import {
  shouldUseSubscriptionDeviceCode,
  type CliSubscriptionLoginOptions,
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
  relayTokenStillActiveNotice,
  signInCliSupabase,
  signInCliSupabaseDeviceCode,
  signOutCliSupabase,
} from '@cli/runtime/supabaseAuth';
import { formatCliDeviceAuthMessage } from '@cli/runtime/supabaseAuthDeviceCode';
import type { SubscriptionPreferenceUpdate } from '@model/subscriptionPreference';
import {
  CHATGPT_AUTH,
  GROK_AUTH,
  RESEARCHER_ACCESS_AUTH,
} from '@shared/copy/accountAuth';
import { RESEARCHER_ACCESS } from '@shared/copy/onboarding';
import { collapseWhitespace } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { setCliSessionApiMode } from './apiModeCommands';
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

/**
 * Shared subscription sign-in flow, mirroring `signOutSubscription` below:
 * sign in with a copyable progress writer, flip the subscription preference,
 * then report the outcome. Only the provider-specific pieces vary (the sign-in
 * fn, the preference setter, the account-label fn, and the auth copy), so a
 * future post-login step has one place to live instead of two.
 */
async function signInSubscription<TSession>(params: {
  init: CliSubscriptionLoginTransportInit;
  output: SlashCommandOutput;
  signal: AbortSignal;
  signIn: (
    init: CliSubscriptionLoginTransportInit,
    options: CliSubscriptionLoginOptions,
  ) => Promise<TSession>;
  setEnabled: () => Promise<SubscriptionPreferenceUpdate>;
  accountLabel: (session: TSession) => string;
  auth: SubscriptionAuthCopy;
}): Promise<void> {
  const { init, output, signal, signIn, setEnabled, accountLabel, auth } =
    params;
  const session = await signIn(init, {
    writeProgress: (message) =>
      output.writeProgress(message, { copyable: true }),
    signal,
  });
  const update = await setEnabled();
  output.appendOutcome(
    update.effective
      ? auth.signedInEnabled(accountLabel(session))
      : auth.signedInOverrideDisabled(accountLabel(session), update.target),
  );
}

async function loginToChatGptSubscription(
  args: Extract<CliLoginSlashArgs, { target: 'chatgpt' }>,
  output: SlashCommandOutput,
  signal: AbortSignal,
): Promise<void> {
  await signInSubscription({
    init: args,
    output,
    signal,
    signIn: signInCliChatGpt,
    setEnabled: () => setCliCodexSubscription(true),
    accountLabel: codexAccountLabel,
    auth: CHATGPT_AUTH,
  });
}

async function loginToGrokSubscription(
  args: Extract<CliLoginSlashArgs, { target: 'grok' }>,
  output: SlashCommandOutput,
  signal: AbortSignal,
): Promise<void> {
  await signInSubscription({
    init: args,
    output,
    signal,
    signIn: signInCliGrok,
    setEnabled: () => setCliXaiSubscription(true),
    accountLabel: xaiAccountLabel,
    auth: GROK_AUTH,
  });
}

async function loginToTexraIncludedAccess(
  args: CliTexraLoginSlashArgs,
  output: SlashCommandOutput,
  signal: AbortSignal,
): Promise<void> {
  const accountWarning = githubSelectAccountWarning(args);
  if (accountWarning) output.writeProgress(accountWarning);

  const session = args.device
    ? await signInCliSupabaseDeviceCode({
        onDeviceCode: (authorization) => {
          output.writeProgress(formatCliDeviceAuthMessage(authorization), {
            copyable: true,
          });
        },
        signal,
      })
    : await signInCliSupabase({
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
  setCliSessionApiMode('included');
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

    if (loginArgs.target === 'chatgpt') {
      await loginToChatGptSubscription(loginArgs, output, signal);
      return;
    }
    if (loginArgs.target === 'grok') {
      await loginToGrokSubscription(loginArgs, output, signal);
      return;
    }
    await loginToTexraIncludedAccess(loginArgs, output, signal);
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
  let texraSignedOut = false;

  if (target === 'texra' || target === 'all') {
    try {
      await signOutCliSupabase();
      texraSignedOut = true;
      lines.push(`Signed out of ${RESEARCHER_ACCESS.label}.`);
    } catch (error: unknown) {
      lines.push(
        `${RESEARCHER_ACCESS.label} sign-out failed: ${toErrorMessage(error)}`,
      );
    }
  }

  async function signOutSubscription<T>(
    label: string,
    signOut: () => Promise<T>,
    preferenceMessage: (update: T) => string,
  ): Promise<void> {
    try {
      const update = await signOut();
      refreshSubscriptionPreferenceViews();
      lines.push(`Signed out of ${label}.`);
      lines.push(preferenceMessage(update));
    } catch (error: unknown) {
      lines.push(`${label} sign-out failed: ${toErrorMessage(error)}`);
    }
  }

  if (target === 'chatgpt' || target === 'all') {
    await signOutSubscription(
      CHATGPT_AUTH.label,
      signOutCliChatGpt,
      chatGptSignOutPreferenceMessage,
    );
  }

  if (target === 'grok' || target === 'all') {
    await signOutSubscription(
      GROK_AUTH.label,
      signOutCliGrok,
      grokSignOutPreferenceMessage,
    );
  }

  if (texraSignedOut) {
    // Sign-out only clears the stored session; a configured TEXRA_RELAY_TOKEN
    // keeps authenticating relay calls, so report it — and keep the session
    // in included mode so the notice matches what actually happens.
    const relayNotice = relayTokenStillActiveNotice();
    const apiMode = relayNotice ? 'included' : 'personal';
    setCliSessionApiMode(apiMode);
    if (relayNotice) lines.push(relayNotice);
  }

  try {
    const overview = await loadCliModelAccessOverview({
      apiMode: sessionMeta.get().apiMode,
    });
    lines.push(...overview.lines);
  } catch (error: unknown) {
    lines.push(toErrorMessage(error));
  }

  output.appendOutcome(collapseWhitespace(lines.join(' · ')));
}
