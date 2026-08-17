/**
 * Process-wide access to the Codex OAuth coordinator, backed by
 * `platform().secrets`.
 */
import {
  createSecretBackedCoordinator,
  getSubscriptionSessionStatus,
  isSubscriptionSessionRoutable,
} from '../oauth/sessionAccess';
import { CODEX_SESSION_SECRET_KEY } from './codexConstants';
import {
  CodexSessionCoordinator,
  type CodexSessionStatus,
} from './CodexSessionCoordinator';
import { CodexAuthError } from './codexSessionTypes';

const CHANNEL = 'codexAuth';

const coordinatorAccess = createSecretBackedCoordinator({
  secretKey: CODEX_SESSION_SECRET_KEY,
  makeCoordinator: (storage) => new CodexSessionCoordinator({ storage }),
});

/**
 * The shared coordinator. Throws if the platform has not been initialized yet
 * (callers run after `initPlatform()`).
 */
export function codexCoordinator(): CodexSessionCoordinator {
  return coordinatorAccess.get();
}

/** Test seam: drop the cached coordinator. */
export function resetCodexCoordinator(): void {
  coordinatorAccess.reset();
}

/** Signed-in status. Call only after the host initializes the platform. */
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
