/**
 * Access to the xAI Grok OAuth coordinator, over the secret store its caller
 * holds: one coordinator per store instance, so distinct stores never share
 * session state.
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
import type { Effect } from 'effect';

const CHANNEL = 'xaiAuth';

const coordinatorFor = createSecretBackedCoordinator({
  secretKey: XAI_SESSION_SECRET_KEY,
  makeCoordinator: (storage) => new XaiSessionCoordinator({ storage }),
});

/** The coordinator for the caller's secret store. */
export function xaiCoordinator(
  secrets: SessionSecretStore,
): XaiSessionCoordinator {
  return coordinatorFor(secrets);
}

/** Signed-in status, read from the caller's secret store. */
export function getXaiStatus(
  secrets: SessionSecretStore,
): Effect.Effect<XaiSessionStatus> {
  return getSubscriptionSessionStatus(
    () => xaiCoordinator(secrets),
    CHANNEL,
    'Grok',
  );
}
