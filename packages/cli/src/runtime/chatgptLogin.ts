import {
  codexCoordinator,
  loginWithDeviceCode,
  loginWithLoopback,
  type CodexSession,
} from '@auth/codex';

import { tryOpenBrowser } from './browser';
import { interactiveTerminalFailure } from './terminalRequirements';
import type { CliContext } from './cliContext';

export interface CliChatGptLoginInit {
  readonly device: boolean;
  readonly noBrowser: boolean;
}

export interface CliChatGptLoginOptions {
  readonly writeProgress: (message: string) => void;
}

/**
 * Device-code is the right default when there's no interactive browser to reach:
 * non-text output, a non-TTY/headless/dumb terminal, or `--no-input`. An
 * explicit `--no-browser` keeps the loopback flow but prints the URL to paste.
 */
export function shouldUseChatGptDeviceCode(
  context: CliContext,
  init: CliChatGptLoginInit,
): boolean {
  if (init.device) return true;
  if (init.noBrowser) return false;
  return (
    context.outputFormat !== 'text' ||
    interactiveTerminalFailure(context) !== undefined
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
    });
  }

  return loginWithLoopback({
    coordinator,
    openBrowser: async (url) => {
      if (!init.noBrowser) {
        options.writeProgress(
          'Opening your browser to sign in with ChatGPT...',
        );
        const opened = await tryOpenBrowser(url);
        if (opened) return;
      }
      options.writeProgress(`Open this URL to sign in with ChatGPT:\n${url}`);
    },
  });
}
