/**
 * Loopback (browser) sign-in program for Codex OAuth — the shared loopback
 * flow bound to the registered ChatGPT callback constants.
 */

import { defineLoopbackLogin } from '../loopbackLogin.js';
import {
  CODEX_CALLBACK_FALLBACK_PORT,
  CODEX_CALLBACK_PATH,
  CODEX_CALLBACK_PORT,
} from './codexConstants.js';
import { type CodexSession } from './codexSessionTypes.js';

export const codexLoginWithLoopback = defineLoopbackLogin<CodexSession>({
  ports: [CODEX_CALLBACK_PORT, CODEX_CALLBACK_FALLBACK_PORT],
  callbackPath: CODEX_CALLBACK_PATH,
  displayName: 'ChatGPT',
});
