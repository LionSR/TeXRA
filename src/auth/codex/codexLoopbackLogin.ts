/**
 * Loopback (browser) sign-in program for Codex OAuth — thin wrapper around the shared
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
import type { Effect } from 'effect';

export interface CodexLoopbackLoginOptions {
  coordinator: LoopbackOAuthCoordinator<CodexSession>;
  openBrowser: (url: string) => void | Promise<void>;
}

export function loginWithLoopback(
  options: CodexLoopbackLoginOptions,
): Effect.Effect<CodexSession, unknown> {
  return loginWithOAuthLoopback({
    coordinator: options.coordinator,
    openBrowser: options.openBrowser,
    ports: [CODEX_CALLBACK_PORT, CODEX_CALLBACK_FALLBACK_PORT],
    callbackPath: CODEX_CALLBACK_PATH,
    displayName: 'ChatGPT',
  });
}
