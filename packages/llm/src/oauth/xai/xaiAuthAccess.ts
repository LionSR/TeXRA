/**
 * Access to the xAI Grok OAuth coordinator, over the secret store its caller
 * holds: one coordinator per store instance, so distinct stores never share
 * session state.
 */

import {
  createSecretBackedCoordinator,
  getSubscriptionSessionStatus,
} from '../sessionAccess.js';
import {
  SubscriptionOAuthCoordinator,
  type SubscriptionSessionStatus,
} from '../SubscriptionOAuthCoordinator.js';
import { XAI_SESSION_SECRET_KEY } from './xaiConstants.js';
import { XAI_POLICY } from './xaiSessionPolicy.js';
import type { CredentialStore } from '../../providers/credentials.js';
import type { XaiSession } from './xaiSessionTypes.js';
import type { Effect } from 'effect';

const CHANNEL = 'xaiAuth';

/** The coordinator for the caller's secret store. */
export const xaiCoordinator: (
  secrets: CredentialStore,
) => SubscriptionOAuthCoordinator<XaiSession> = createSecretBackedCoordinator({
  secretKey: XAI_SESSION_SECRET_KEY,
  makeCoordinator: (storage) =>
    new SubscriptionOAuthCoordinator({ storage, policy: XAI_POLICY }),
});

/** Signed-in status, read from the caller's secret store. */
export function getXaiStatus(
  secrets: CredentialStore,
): Effect.Effect<SubscriptionSessionStatus> {
  return getSubscriptionSessionStatus(
    () => xaiCoordinator(secrets),
    CHANNEL,
    'Grok',
  );
}
