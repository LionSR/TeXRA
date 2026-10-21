/**
 * Access to the xAI Grok OAuth coordinator, over the secret store its caller
 * holds: one coordinator per store instance, so distinct stores never share
 * session state.
 */

import { Effect } from 'effect';
import { createSecretBackedCoordinator } from '../sessionAccess.js';
import { SubscriptionOAuthCoordinator } from '../SubscriptionOAuthCoordinator.js';
import { defineLoopbackLogin } from '../loopbackLogin.js';
import {
  XAI_CALLBACK_PATH,
  XAI_CALLBACK_PORT,
  XAI_SESSION_SECRET_KEY,
} from './xaiConstants.js';
import { XAI_POLICY } from './xaiSessionPolicy.js';
import type {
  SubscriptionCoordinator,
  SubscriptionSessionStatus,
} from '../subscriptionCoordinator.js';
import type {
  CredentialStore,
  SecretsFailed,
} from '../../providers/credentials.js';
import type { SubscriptionOAuthError } from '../subscriptionOAuthError.js';
import type { XaiSession } from './xaiSessionTypes.js';

/** The coordinator for the caller's secret store. */
export const xaiCoordinator: (
  secrets: CredentialStore,
) => SubscriptionCoordinator<XaiSession> = createSecretBackedCoordinator({
  secretKey: XAI_SESSION_SECRET_KEY,
  makeCoordinator: (storage) =>
    new SubscriptionOAuthCoordinator({ storage, policy: XAI_POLICY }),
});

/** Signed-in status, read from the caller's secret store. A store that
 *  cannot be read, or a stored session that does not parse, fails. */
export function getXaiStatus(
  secrets: CredentialStore,
): Effect.Effect<
  SubscriptionSessionStatus,
  SecretsFailed | SubscriptionOAuthError
> {
  return Effect.suspend(() => xaiCoordinator(secrets).getStatus());
}

/** The browser sign-in, bound to the registered Grok callback. */
export const xaiLoginWithLoopback = defineLoopbackLogin<XaiSession>({
  ports: [XAI_CALLBACK_PORT],
  callbackPath: XAI_CALLBACK_PATH,
  displayName: 'Grok',
});
