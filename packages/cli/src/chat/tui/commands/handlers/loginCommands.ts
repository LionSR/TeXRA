import {
  refreshCodexPreferenceViews,
  setCliCodexSubscription,
} from '@cli/chat/tui/state/codexSubscription';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import { loadCliApiStatusLines } from '@cli/runtime/apiStatus';
import {
  refreshKimiCodePreferenceViews,
  setCliKimiCodeSubscription,
} from '@cli/chat/tui/state/kimiCodeSubscription';
import {
  chatGptAccountLabel,
  chatGptSignOutPreferenceMessage,
  shouldUseChatGptDeviceCode,
  signInCliChatGpt,
  signOutCliChatGpt,
} from '@cli/runtime/chatgptLogin';
import {
  kimiCodeSignOutPreferenceMessage,
  signInCliKimiCode,
  signOutCliKimiCode,
} from '@cli/runtime/kimiCodeLogin';
import { type CliContext } from '@cli/runtime/cliContext';
import {
  githubSelectAccountWarning,
  hasLoginTransportConflict,
  LOGIN_TRANSPORT_CONFLICT_MESSAGE,
  parseChatLoginSlashArgs,
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
import { toErrorMessage } from '@utils/errors/errorMessage';

import { setCliSessionApiMode } from './apiModeCommands';

const CHAT_LOGIN_USAGE = [
  'Usage: /login [texra [github | google]] [--no-browser] [--device] [--select-account] [--login-hint <account>]',
  '       /login chatgpt [--no-browser] [--device]',
  '       /login kimi',
].join('\n');

function loginStartMessage(args: CliLoginSlashArgs): string {
  if (args.target === 'kimi') {
    return 'Starting Kimi Code device-code sign-in.';
  }
  if (args.target === 'chatgpt') {
    if (args.device) return 'Starting ChatGPT device-code sign-in.';
    if (args.noBrowser) return 'Starting ChatGPT sign-in.';
    return 'Opening browser for ChatGPT sign-in...';
  }
  if (args.device) return 'Starting TeXRA device-code sign-in.';
  if (args.noBrowser) return `Starting TeXRA ${args.provider} sign-in.`;
  return `Opening browser for TeXRA ${args.provider} sign-in...`;
}

async function loginToChatGptSubscription(
  args: Extract<CliLoginSlashArgs, { target: 'chatgpt' }>,
): Promise<void> {
  const session = await signInCliChatGpt(args, {
    writeProgress: appendLocalAssistantTranscript,
  });
  const update = await setCliCodexSubscription(true);

  appendLocalAssistantTranscript(
    [
      `Signed in with ChatGPT as ${chatGptAccountLabel(session)}.`,
      update.effective
        ? 'ChatGPT subscription enabled for Codex models.'
        : `ChatGPT subscription preference is still disabled because a more specific setting overrides ${update.target} config.`,
    ].join('\n'),
  );
}

async function loginToKimiCodeSubscription(): Promise<void> {
  await signInCliKimiCode({
    writeProgress: appendLocalAssistantTranscript,
  });
  const update = await setCliKimiCodeSubscription(true);

  appendLocalAssistantTranscript(
    [
      'Signed in with Kimi Code.',
      update.effective
        ? 'Kimi Code subscription enabled for Kimi models.'
        : `Kimi Code subscription preference is still disabled because a more specific setting overrides ${update.target} config.`,
    ].join('\n'),
  );
}

async function loginToTexraIncludedAccess(
  args: CliTexraLoginSlashArgs,
): Promise<void> {
  const accountWarning = githubSelectAccountWarning(args);
  if (accountWarning) appendLocalAssistantTranscript(accountWarning);

  const session = args.device
    ? await signInCliSupabaseDeviceCode({
        onDeviceCode: (authorization) => {
          appendLocalAssistantTranscript(
            formatCliDeviceAuthMessage(authorization),
          );
        },
      })
    : await signInCliSupabase({
        provider: args.provider,
        openBrowser: !args.noBrowser,
        selectAccount: args.selectAccount,
        loginHint: args.loginHint,
        manualBrowserHint: '/login --no-browser',
        onAuthUrl: (url) => {
          if (args.noBrowser) {
            appendLocalAssistantTranscript(formatCliManualAuthUrlMessage(url));
          }
        },
      });
  setCliSessionApiMode('included');
  appendLocalAssistantTranscript(
    [
      `Signed in as ${session.account.label}.`,
      ...(await loadCliApiStatusLines({ apiMode: 'included' })),
    ].join('\n'),
  );
}

export async function loginFromChat(
  input: string,
  context?: CliContext,
): Promise<void> {
  const args = parseChatLoginSlashArgs(input);
  if (!args) {
    appendLocalAssistantTranscript(CHAT_LOGIN_USAGE);
    return;
  }

  // Match the CLI `login` guard: reject `--device` + `--no-browser` from the
  // user's parsed flags before the ChatGPT path can auto-resolve `device`.
  // The Kimi Code target carries no transport flags (device-code only).
  if (args.target !== 'kimi' && hasLoginTransportConflict(args)) {
    appendLocalAssistantTranscript(LOGIN_TRANSPORT_CONFLICT_MESSAGE);
    return;
  }

  const loginArgs =
    args.target === 'chatgpt' && context
      ? { ...args, device: shouldUseChatGptDeviceCode(context, args) }
      : args;
  appendLocalAssistantTranscript(loginStartMessage(loginArgs));

  try {
    if (loginArgs.target === 'kimi') {
      await loginToKimiCodeSubscription();
      return;
    }
    if (loginArgs.target === 'chatgpt') {
      await loginToChatGptSubscription(loginArgs);
      return;
    }
    await loginToTexraIncludedAccess(loginArgs);
  } catch (error: unknown) {
    appendLocalAssistantTranscript(toErrorMessage(error));
  }
}

export async function logoutFromChat(): Promise<void> {
  const lines: string[] = [];
  let texraSignedOut = false;

  try {
    await signOutCliSupabase();
    texraSignedOut = true;
  } catch (error: unknown) {
    lines.push(`TeXRA sign-out failed: ${toErrorMessage(error)}`);
  }

  try {
    const chatGptUpdate = await signOutCliChatGpt();
    refreshCodexPreferenceViews();
    lines.push(chatGptSignOutPreferenceMessage(chatGptUpdate));
  } catch (error: unknown) {
    lines.push(`ChatGPT sign-out failed: ${toErrorMessage(error)}`);
  }

  try {
    const kimiCodeUpdate = await signOutCliKimiCode();
    refreshKimiCodePreferenceViews();
    lines.push(kimiCodeSignOutPreferenceMessage(kimiCodeUpdate));
  } catch (error: unknown) {
    lines.push(`Kimi Code sign-out failed: ${toErrorMessage(error)}`);
  }

  if (texraSignedOut) {
    // Sign-out only clears the stored session; a configured TEXRA_RELAY_TOKEN
    // keeps authenticating relay calls, so report it — and keep the session
    // in included mode so the notice matches what actually happens.
    const relayNotice = relayTokenStillActiveNotice();
    const apiMode = relayNotice ? 'included' : 'personal';
    setCliSessionApiMode(apiMode);
    lines.unshift('Signed out.');
    if (relayNotice) lines.push(relayNotice);
    try {
      lines.push(...(await loadCliApiStatusLines({ apiMode })));
    } catch (error: unknown) {
      lines.push(toErrorMessage(error));
    }
  }

  appendLocalAssistantTranscript(lines.join('\n'));
}
