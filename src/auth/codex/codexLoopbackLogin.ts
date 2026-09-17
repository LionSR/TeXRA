/**
 * Loopback (browser) sign-in program for Codex OAuth — the shared loopback
 * flow bound to the registered ChatGPT callback constants.
 */

import { defineLoopbackLogin } from '../oauth/loopbackLogin';
import {
  CODEX_CALLBACK_FALLBACK_PORT,
  CODEX_CALLBACK_PATH,
  CODEX_CALLBACK_PORT,
} from './codexConstants';
import { type CodexSession } from './codexSessionTypes';

export const loginWithLoopback = defineLoopbackLogin<CodexSession>({
  ports: [CODEX_CALLBACK_PORT, CODEX_CALLBACK_FALLBACK_PORT],
  callbackPath: CODEX_CALLBACK_PATH,
  displayName: 'ChatGPT',
});
