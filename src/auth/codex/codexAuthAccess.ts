/**
 * Process-wide access to the Codex OAuth coordinator, backed by
 * `platform().secrets`. The model handler, availability gate, and login
 * commands all share one instance so its single-flight refresh state is honored
 * within a process.
 *
 * Stays `vscode`-free: reaches the keychain only through the platform port.
 */
import { tryPlatform } from '@platform/platform';

import { createCodexAuthCoordinator } from './CodexAuthCoordinator';
import {
  type CodexSessionCoordinator,
  type CodexSessionStatus,
} from './CodexSessionCoordinator';

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
  } catch {
    return { signedIn: false };
  }
}

/** Whether a Codex session is currently signed in (no network, no throw). */
export async function isCodexSignedIn(): Promise<boolean> {
  return (await getCodexStatus()).signedIn;
}
