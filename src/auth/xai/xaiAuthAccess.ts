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
import {
  SubscriptionOAuthCoordinator,
  type SubscriptionSessionStatus,
} from '../oauth/SubscriptionOAuthCoordinator';
import { XAI_SESSION_SECRET_KEY } from './xaiConstants';
import { XAI_POLICY } from './xaiSessionPolicy';
import type { XaiSession } from './xaiSessionTypes';
import type { Effect } from 'effect';

const CHANNEL = 'xaiAuth';

const coordinatorFor = createSecretBackedCoordinator({
  secretKey: XAI_SESSION_SECRET_KEY,
  makeCoordinator: (storage) =>
    new SubscriptionOAuthCoordinator({ storage, policy: XAI_POLICY }),
});

/** The coordinator for the caller's secret store. */
export function xaiCoordinator(
  secrets: SessionSecretStore,
): SubscriptionOAuthCoordinator<XaiSession> {
  return coordinatorFor(secrets);
}

/** Signed-in status, read from the caller's secret store. */
export function getXaiStatus(
  secrets: SessionSecretStore,
): Effect.Effect<SubscriptionSessionStatus> {
  return getSubscriptionSessionStatus(
    () => xaiCoordinator(secrets),
    CHANNEL,
    'Grok',
  );
}
