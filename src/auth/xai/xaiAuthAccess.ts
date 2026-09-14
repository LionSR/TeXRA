/**
 * Process-wide access to the xAI Grok OAuth coordinator, over the secret store
 * its caller holds.
 */
import {
  createSecretBackedCoordinator,
  getSubscriptionSessionStatus,
  type SessionSecretStore,
} from '../oauth/sessionAccess';
import { XAI_SESSION_SECRET_KEY } from './xaiConstants';
import {
  XaiSessionCoordinator,
  type XaiSessionStatus,
} from './XaiSessionCoordinator';

const CHANNEL = 'xaiAuth';

const coordinatorAccess = createSecretBackedCoordinator({
  secretKey: XAI_SESSION_SECRET_KEY,
  makeCoordinator: (storage) => new XaiSessionCoordinator({ storage }),
});

/** The shared coordinator, over the caller's secret store. */
export function xaiCoordinator(
  secrets: SessionSecretStore,
): XaiSessionCoordinator {
  return coordinatorAccess.get(secrets);
}

/** Signed-in status, read from the caller's secret store. */
export async function getXaiStatus(
  secrets: SessionSecretStore,
): Promise<XaiSessionStatus> {
  return getSubscriptionSessionStatus(
    () => xaiCoordinator(secrets),
    CHANNEL,
    'Grok',
  );
}
