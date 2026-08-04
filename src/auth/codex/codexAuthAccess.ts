/**
 * Process-wide access to the Codex OAuth coordinator, backed by
 * `platform().secrets`.
 */
import { tryPlatform } from '@platform/platform';

import {
  getSubscriptionSessionStatus,
  isSubscriptionSessionRoutable,
} from '../oauth/sessionAccess';
import { CODEX_SESSION_SECRET_KEY } from './codexConstants';
import {
  CodexSessionCoordinator,
  type CodexSessionStorage,
  type CodexSessionStatus,
} from './CodexSessionCoordinator';
import { CodexAuthError } from './codexSessionTypes';

const CHANNEL = 'codexAuth';

let singleton: CodexSessionCoordinator | null = null;

/**
 * The shared coordinator. Throws if the platform has not been initialized yet
 * (callers run after `initPlatform()`).
 */
export function codexCoordinator(): CodexSessionCoordinator {
  if (singleton) return singleton;
  const platform = tryPlatform();
  if (!platform) {
    throw new Error('Codex auth used before the platform was initialized.');
  }
  const storage: CodexSessionStorage = {
    get: () => platform.secrets.get(CODEX_SESSION_SECRET_KEY),
    store: (value) => platform.secrets.set(CODEX_SESSION_SECRET_KEY, value),
    delete: () => platform.secrets.delete(CODEX_SESSION_SECRET_KEY),
  };
  singleton = new CodexSessionCoordinator({ storage });
  return singleton;
}

/** Test seam: drop the cached coordinator. */
export function resetCodexCoordinator(): void {
  singleton = null;
}

/** Signed-in status, safe to call before platform init (returns signed-out). */
export async function getCodexStatus(): Promise<CodexSessionStatus> {
  return getSubscriptionSessionStatus(codexCoordinator, CHANNEL, 'ChatGPT');
}

/**
 * Whether subscription routing should use the stored session.
 */
export async function isCodexSessionRoutable(): Promise<boolean> {
  return isSubscriptionSessionRoutable(
    codexCoordinator,
    CodexAuthError,
    'ChatGPT',
  );
}
