import { loadCliApiStatusLines } from '@cli/runtime/apiStatus';
import {
  githubSelectAccountWarning,
  parseChatLoginSlashArgs,
  type CliLoginSlashArgs,
} from '@cli/runtime/loginOptions';
import {
  formatCliManualAuthUrlMessage,
  relayTokenStillActiveNotice,
  signInCliSupabase,
  signInCliSupabaseDeviceCode,
  signOutCliSupabase,
} from '@cli/runtime/supabaseAuth';
import { formatCliDeviceAuthMessage } from '@cli/runtime/supabaseAuthDeviceCode';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import { toErrorMessage } from '@common/errors/errorMessage';

import { setCliSessionApiMode } from './apiModeCommands';

export const CHAT_LOGIN_USAGE =
  'Usage: /login [github | google] [--no-browser] [--device] [--select-account] [--login-hint <account>]';

function loginStartMessage(args: CliLoginSlashArgs): string {
  if (args.device) return 'Starting TeXRA device-code sign-in.';
  if (args.noBrowser) return `Starting TeXRA ${args.provider} sign-in.`;
  return `Opening browser for TeXRA ${args.provider} sign-in...`;
}

export async function loginFromChat(input: string): Promise<void> {
  const args = parseChatLoginSlashArgs(input);
  if (!args) {
    appendLocalAssistantTranscript(CHAT_LOGIN_USAGE);
    return;
  }

  const accountWarning = githubSelectAccountWarning(args);
  if (accountWarning) appendLocalAssistantTranscript(accountWarning);
  appendLocalAssistantTranscript(loginStartMessage(args));

  try {
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
              appendLocalAssistantTranscript(
                formatCliManualAuthUrlMessage(url),
              );
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
  } catch (error: unknown) {
    appendLocalAssistantTranscript(toErrorMessage(error));
  }
}

export async function logoutFromChat(): Promise<void> {
  try {
    await signOutCliSupabase();
    // Sign-out only clears the stored session; a configured TEXRA_RELAY_TOKEN
    // keeps authenticating relay calls, so report it — and keep the session
    // in included mode so the notice matches what actually happens.
    const relayNotice = relayTokenStillActiveNotice();
    const apiMode = relayNotice ? 'included' : 'personal';
    setCliSessionApiMode(apiMode);
    appendLocalAssistantTranscript(
      [
        'Signed out.',
        ...(relayNotice ? [relayNotice] : []),
        ...(await loadCliApiStatusLines({ apiMode })),
      ].join('\n'),
    );
  } catch (error: unknown) {
    appendLocalAssistantTranscript(toErrorMessage(error));
  }
}
