/**
 * The PKCE (RFC 7636) authorization-code request of a subscription OAuth flow
 * (ChatGPT, Grok/xAI, …): a fresh verifier, its S256 challenge and a
 * CSRF state, on the authorize URL the provider's policy describes.
 */
import { hash, randomBytes } from 'node:crypto';

import type {
  SubscriptionAuthorizeRequest,
  SubscriptionOAuthPolicy,
} from './subscriptionCoordinator.js';

/** 32 random bytes, base64url (no padding). */
const randomToken = (): string => randomBytes(32).toString('base64url');

/**
 * The authorize request for a loopback bind on `port`, as `client` (the
 * policy's fixed client when absent), with its parameters beyond the code
 * flow's own. CSRF is covered by `state` on the loopback callback. The
 * `nonce` goes on the URL only when the policy checks the ID token against it.
 */
export function authorizeRequest(
  policy: Pick<
    SubscriptionOAuthPolicy<never>,
    'authorize' | 'acceptGrant' | 'tokenEndpoint'
  >,
  port: number,
  client: {
    readonly clientId: string;
    readonly registering: boolean;
    readonly params: Readonly<Record<string, string>>;
  } = {
    clientId: policy.tokenEndpoint.clientId,
    registering: false,
    params: {},
  },
): SubscriptionAuthorizeRequest {
  const { authorize } = policy;
  const verifier = randomToken();
  const state = randomToken();
  const nonce = randomToken();
  const redirectUri = authorize.redirectUri(port);
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: redirectUri,
    scope: authorize.scope,
    code_challenge: hash('sha256', verifier, 'base64url'),
    code_challenge_method: 'S256',
    ...authorize.params,
    ...client.params,
    ...(policy.acceptGrant === undefined ? {} : { nonce }),
    state,
  });
  return {
    url: `${authorize.url}?${query}`,
    verifier,
    state,
    nonce,
    redirectUri,
    clientId: client.clientId,
    registering: client.registering,
  };
}
