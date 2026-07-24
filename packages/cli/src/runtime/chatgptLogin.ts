import {
  codexCoordinator,
  loginWithDeviceCode,
  loginWithLoopback,
  setPreferCodexSubscription,
  type CodexSession,
  type CodexSubscriptionPreferenceUpdate,
} from '@auth/codex';
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
      // Publish the actionable URL before browser launch. Process launch can
      // stall on some desktops, and the terminal must not remain on a generic
      // "opening browser" message with no path forward.
      options.writeProgress(`ChatGPT sign-in URL:\n${url}`);
      if (init.noBrowser) return;
      if (await tryOpenBrowser(url)) {
        return;
      }
      options.writeProgress(
        `Browser launch unavailable. ChatGPT sign-in URL:\n${url}`,
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
