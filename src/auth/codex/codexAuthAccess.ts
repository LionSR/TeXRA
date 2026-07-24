/**
 * Process-wide access to the Codex OAuth coordinator, backed by
 * `platform().secrets`. The model handler, availability gate, and login
 * commands all share one instance so its single-flight refresh state is honored
 * within a process.
 *
 * Stays `vscode`-free: reaches the keychain only through the platform port.
 */
import * as logger from '@logger/logUtils';
import { tryPlatform } from '@platform/platform';
import type { ChatGptSubscriptionStatus } from '@shared/schemas/modelAccess';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { CODEX_SESSION_SECRET_KEY } from './codexConstants';
import {
  CodexSessionCoordinator,
  type CodexSessionStorage,
  type CodexSessionStatus,
} from './CodexSessionCoordinator';
import { CodexAuthError } from './codexSessionTypes';
import {
  isCodexSubscriptionToolUseOnly,
  isPreferCodexSubscription,
} from './codexPreference';

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
  if (!tryPlatform()) return { signedIn: false };
  try {
    return await codexCoordinator().getStatus();
  } catch (error) {
    // Treat an unreadable session as signed-out, but surface the unexpected
    // failure (corrupted keychain entry, platform misconfig) for diagnosis.
    logger.warn(
      CHANNEL,
      `Failed to read ChatGPT session status: ${toErrorMessage(error)}`,
    );
    return { signedIn: false };
  }
}

/** Whether a Codex session is currently signed in (no network, no throw). */
export async function isCodexSignedIn(): Promise<boolean> {
  return (await getCodexStatus()).signedIn;
}

/**
 * Whether subscription routing should use the stored session. Expiring sessions
 * are refreshed by the coordinator; absent/dead sessions return false after its
 * re-auth path clears them. If a re-auth error leaves a session in storage, the
 * refresh was superseded and the error propagates rather than misrouting the
 * newer session. Retryable/config errors likewise propagate so callers do not
 * silently spend fallback quota or immediately retry the same refresh.
 */
export async function isCodexSessionRoutable(): Promise<boolean> {
  if (!tryPlatform()) return false;
  const coordinator = codexCoordinator();
  try {
    await coordinator.getFreshAccessToken();
    return true;
  } catch (error) {
    if (!(error instanceof CodexAuthError)) {
      throw new CodexAuthError(
        `Could not access ChatGPT session: ${toErrorMessage(error)}`,
        'transient',
        undefined,
        { cause: error },
      );
    }
    if (error.needsReauth) {
      let storedSession;
      try {
        storedSession = await coordinator.loadSession();
      } catch (readError) {
        throw new CodexAuthError(
          `Could not verify ChatGPT session: ${toErrorMessage(readError)}`,
          'transient',
          undefined,
          { cause: readError },
        );
      }
      if (storedSession) {
        throw new CodexAuthError(
          'ChatGPT session changed while refreshing.',
          'transient',
          error.status,
          { cause: error },
        );
      }
      return false;
    }
    throw error;
  }
}

/**
 * The ChatGPT auth status as the settings views consume it: the session status
 * plus the current subscription preference. One composer so the extension and
 * desktop hosts post the identical payload (the wire shape is validated by
 * `ChatGptAuthStatusSchema` at each host's boundary).
 */
export async function getChatGptAuthStatus(): Promise<ChatGptSubscriptionStatus> {
  return {
    ...(await getCodexStatus()),
    preferSubscription: isPreferCodexSubscription(),
    subscriptionToolUseOnly: isCodexSubscriptionToolUseOnly(),
  };
}
