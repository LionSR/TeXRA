/**
 * Loopback (browser) sign-in for Codex OAuth — thin wrapper around the shared
 * {@link loginWithOAuthLoopback}.
 */
import {
  loginWithOAuthLoopback,
  type LoopbackOAuthCoordinator,
} from '../oauth/loopbackLogin';
import {
  CODEX_CALLBACK_FALLBACK_PORT,
  CODEX_CALLBACK_PATH,
  CODEX_CALLBACK_PORT,
} from './codexConstants';
import { type CodexSession } from './codexSessionTypes';

export interface CodexLoopbackLoginOptions {
  coordinator: LoopbackOAuthCoordinator<CodexSession>;
  openBrowser: (url: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export async function loginWithLoopback(
  options: CodexLoopbackLoginOptions,
): Promise<CodexSession> {
  return loginWithOAuthLoopback({
    coordinator: options.coordinator,
    openBrowser: options.openBrowser,
    signal: options.signal,
    ports: [CODEX_CALLBACK_PORT, CODEX_CALLBACK_FALLBACK_PORT],
    callbackPath: CODEX_CALLBACK_PATH,
    displayName: 'ChatGPT',
  });
}
