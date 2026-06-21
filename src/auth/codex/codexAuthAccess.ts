/**
 * Process-wide access to the Codex OAuth coordinator, backed by
 * `platform().secrets`. The model handler, availability gate, and login
 * commands all share one instance so its single-flight refresh state is honored
 * within a process.
 *
 * Stays `vscode`-free: reaches the keychain only through the platform port.
 */
import { tryPlatform } from '@platform/platform';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';

import { createCodexAuthCoordinator } from './CodexAuthCoordinator';
import {
  type CodexSessionCoordinator,
  type CodexSessionStatus,
} from './CodexSessionCoordinator';
import { isPreferCodexSubscription } from './codexPreference';

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
  singleton = createCodexAuthCoordinator({ secrets: platform.secrets });
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
 * The ChatGPT auth status as the settings views consume it: the session status
 * plus the current subscription preference. One composer so the extension and
 * desktop hosts post the identical payload (the wire shape is validated by
 * `ChatGptAuthStatusSchema` at each host's boundary).
 */
export async function getChatGptAuthStatus(): Promise<
  CodexSessionStatus & { preferSubscription: boolean }
> {
  return {
    ...(await getCodexStatus()),
    preferSubscription: isPreferCodexSubscription(),
  };
}
