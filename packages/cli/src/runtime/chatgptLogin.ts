import {
  codexCoordinator,
  loginWithDeviceCode,
  loginWithLoopback,
  type CodexSession,
} from '@auth/codex';
import {
  setPreferCodexSubscription,
  type CodexSubscriptionPreferenceUpdate,
} from '@model/codex/codexPreference';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { tryOpenBrowser } from './browser';
import { isLikelyRemoteSession } from './remoteSession';
import { interactiveTerminalFailure } from './terminalRequirements';
import type { CliContext } from './cliContext';

export interface CliChatGptLoginInit {
  readonly device: boolean;
  readonly noBrowser: boolean;
}

export interface CliChatGptLoginOptions {
  readonly writeProgress: (message: string) => void;
  readonly signal?: AbortSignal;
}

export type CliChatGptSignOutResult =
  | {
      readonly preferenceUpdate: CodexSubscriptionPreferenceUpdate;
      readonly preferenceError?: undefined;
    }
  | {
      readonly preferenceUpdate?: undefined;
      readonly preferenceError: string;
    };

/**
 * Device-code is the right default when the browser callback is likely
 * unreachable: remote shells, non-text output, non-TTY/headless/dumb terminals,
 * or `--no-input`. An explicit `--no-browser` keeps the loopback flow but
 * prints the URL to paste.
 */
export function shouldUseChatGptDeviceCode(
  context: CliContext,
  init: CliChatGptLoginInit,
): boolean {
  if (init.device) return true;
  if (init.noBrowser) return false;
  return (
    context.outputFormat !== 'text' ||
    interactiveTerminalFailure(context) !== undefined ||
    isLikelyRemoteSession()
  );
}

export function chatGptAccountLabel(session: CodexSession): string {
  return session.email ?? session.accountId ?? 'your ChatGPT account';
}

export async function signInCliChatGpt(
  init: CliChatGptLoginInit,
  options: CliChatGptLoginOptions,
): Promise<CodexSession> {
  const coordinator = codexCoordinator();

  if (init.device) {
    return loginWithDeviceCode({
      coordinator,
      onPrompt: ({ userCode, verificationUrl }) => {
        options.writeProgress(
          `To sign in with ChatGPT:\n  1. Open ${verificationUrl}\n  2. Enter the one-time code: ${userCode}\nWaiting for approval... (Ctrl-C cancels)`,
        );
      },
      signal: options.signal,
    });
  }

  return loginWithLoopback({
    coordinator,
    openBrowser: async (url) => {
      if (init.noBrowser) {
        options.writeProgress(`ChatGPT sign-in URL:\n${url}`);
        return;
      }

      // Publish the usable URL before awaiting the browser process. Some
      // launchers remain open until the browser exits; the sign-in panel must
      // not hide the only manual route behind that wait.
      options.writeProgress(
        `ChatGPT sign-in URL:\n${url}\nBrowser launch in progress...`,
      );
      if (await tryOpenBrowser(url)) {
        options.writeProgress(
          `ChatGPT sign-in URL:\n${url}\nBrowser opened; the same URL works in another browser.`,
        );
        return;
      }
      options.writeProgress(
        `ChatGPT sign-in URL:\n${url}\nAutomatic browser launch failed; the URL remains available above.`,
      );
    },
    signal: options.signal,
  });
}

export function chatGptSignOutPreferenceMessage(
  result: CliChatGptSignOutResult,
): string {
  const update = result.preferenceUpdate;
  if (!update) {
    return `ChatGPT subscription preference could not be disabled: ${result.preferenceError}`;
  }
  return update.effective
    ? `ChatGPT subscription preference is still enabled because a more specific setting overrides ${update.target} config.`
    : 'ChatGPT subscription disabled for Codex models.';
}

export async function signOutCliChatGpt(): Promise<CliChatGptSignOutResult> {
  await codexCoordinator().signOut();
  try {
    return { preferenceUpdate: await setPreferCodexSubscription(false) };
  } catch (error: unknown) {
    return { preferenceError: toErrorMessage(error) };
  }
}
