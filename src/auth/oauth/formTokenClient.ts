/**
 * Shared OAuth2 form-encoded token operations (authorization_code + refresh).
 *
 * Declarative: providers declare an {@link OAuthFormEndpoint} and call the
 * two programs. No factory-built client objects. Device flows stay provider-
 * specific (OpenAI custom JSON vs RFC 8628) and run their own programs over
 * `oauthRequest.ts`.
 */
// Third-party imports
import { Effect } from 'effect';

// Local imports
import { oauthHttpError, parseOAuthJson, postOAuth } from './oauthRequest';
import type { z } from 'zod';
import type { SubscriptionTokenResponse } from './SubscriptionOAuthCoordinator';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const DEFAULT_FORM_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  Accept: 'application/json',
} as const;

/**
 * Provider-declared form OAuth endpoint. Data only — no methods.
 * Used for token grants (code exchange + refresh).
 */
export interface OAuthFormEndpoint<
  TTokens extends SubscriptionTokenResponse = SubscriptionTokenResponse,
> {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly tokenResponseSchema: z.ZodType<TTokens>;
  readonly requestTimeoutMs?: number;
}

/** One token grant: form POST, ok-status check, schema parse. */
const tokenGrant = Effect.fn('formTokenClient.tokenGrant')(function* <
  TTokens extends SubscriptionTokenResponse,
>(endpoint: OAuthFormEndpoint<TTokens>, body: URLSearchParams, label: string) {
  const response = yield* postOAuth({
    url: endpoint.tokenUrl,
    headers: DEFAULT_FORM_HEADERS,
    body,
    timeoutMs: endpoint.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    networkErrorMessage: `Network error contacting ${endpoint.tokenUrl}`,
  });
  if (!response.ok) return yield* oauthHttpError(response, label);
  return yield* parseOAuthJson(
    response,
    endpoint.tokenResponseSchema,
    `${label} returned an unexpected token response`,
  );
});

/** Exchange an authorization code for tokens (PKCE loopback / device). */
export const exchangeAuthorizationCode = Effect.fn(
  'formTokenClient.exchangeAuthorizationCode',
)(function* <TTokens extends SubscriptionTokenResponse>(
  endpoint: OAuthFormEndpoint<TTokens>,
  params: {
    code: string;
    verifier: string;
    redirectUri: string;
  },
) {
  return yield* tokenGrant(
    endpoint,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: endpoint.clientId,
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    }),
    'Authorization code exchange',
  );
});

/** Refresh tokens with a refresh_token grant. */
export const refreshOAuthTokens = Effect.fn(
  'formTokenClient.refreshOAuthTokens',
)(function* <TTokens extends SubscriptionTokenResponse>(
  endpoint: OAuthFormEndpoint<TTokens>,
  refreshToken: string,
) {
  return yield* tokenGrant(
    endpoint,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: endpoint.clientId,
      refresh_token: refreshToken,
    }),
    'Token refresh',
  );
});
