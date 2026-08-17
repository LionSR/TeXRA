/**
 * Process-wide access to the xAI Grok OAuth coordinator, backed by
 * `platform().secrets`.
 */
import {
  createSecretBackedCoordinator,
  getSubscriptionSessionStatus,
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

/**
 * The shared coordinator. Throws if the platform has not been initialized yet
 * (callers run after `initPlatform()`).
 */
export function xaiCoordinator(): XaiSessionCoordinator {
  return coordinatorAccess.get();
}

/** Signed-in status. Call only after the host initializes the platform. */
export async function getXaiStatus(): Promise<XaiSessionStatus> {
  return getSubscriptionSessionStatus(xaiCoordinator, CHANNEL, 'Grok');
}
