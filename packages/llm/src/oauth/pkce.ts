/**
 * The PKCE (RFC 7636) authorization-code request of a subscription OAuth flow
 * (ChatGPT/Codex, Grok/xAI, …): a fresh verifier, its S256 challenge and a
 * CSRF state, on the authorize URL the provider's policy describes.
 */
import { hash, randomBytes } from 'node:crypto';

import type {
  SubscriptionAuthorizeRequest,
  SubscriptionOAuthPolicy,
} from './SubscriptionOAuthCoordinator.js';

/** 32 random bytes, base64url (no padding). */
const randomToken = (): string => randomBytes(32).toString('base64url');

/**
 * The authorize request for a loopback bind on `port`. CSRF is covered by
 * `state` on the loopback callback; no OIDC `nonce` is sent, since nothing
 * verifies one against the `id_token`.
 */
export function authorizeRequest(
  {
    authorize,
    tokenEndpoint,
  }: Pick<SubscriptionOAuthPolicy<never>, 'authorize' | 'tokenEndpoint'>,
  port: number,
): SubscriptionAuthorizeRequest {
  const verifier = randomToken();
  const state = randomToken();
  const redirectUri = authorize.redirectUri(port);
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: tokenEndpoint.clientId,
    redirect_uri: redirectUri,
    scope: authorize.scope,
    code_challenge: hash('sha256', verifier, 'base64url'),
    code_challenge_method: 'S256',
    ...authorize.params,
    state,
  });
  return { url: `${authorize.url}?${query}`, verifier, state, redirectUri };
}
