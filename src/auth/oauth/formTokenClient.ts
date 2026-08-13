/**
 * Shared OAuth2 form-encoded token operations (authorization_code + refresh).
 *
 * Declarative: providers declare an {@link OAuthFormEndpoint} and call pure
 * functions. No factory-built client objects. Device flows stay provider-
 * specific (OpenAI custom JSON vs RFC 8628).
 */
// Third-party imports
import { z } from 'zod';

// Local imports
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { ProviderAuthErrorCtor } from './providerAuthBridge';
import type { SubscriptionOAuthErrorKind } from './subscriptionOAuthError';
import type { SubscriptionTokenResponse } from './SubscriptionOAuthCoordinator';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const DEFAULT_FORM_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  Accept: 'application/json',
} as const;

export function oauthTokenErrorKind(
  status: number,
): SubscriptionOAuthErrorKind {
  return status === 400 || status === 401 || status === 403
    ? 'fatal'
    : 'transient';
}

/**
 * Provider-declared form OAuth endpoint. Data only — no methods.
 * Used for token grants and (when form-encoded) device authorization.
 */
export interface OAuthFormEndpoint<
  TTokens extends SubscriptionTokenResponse = SubscriptionTokenResponse,
> {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly ErrorType: ProviderAuthErrorCtor;
  readonly tokenResponseSchema: z.ZodType<TTokens>;
  readonly requestTimeoutMs?: number;
  readonly formHeaders?: Readonly<Record<string, string>>;
}

/** Combine an optional caller signal with a request timeout. */
export function oauthRequestSignal(
  timeoutMs: number,
  signal?: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Form-urlencoded POST. Throws the provider error type on network failure. */
export async function postOAuthForm(
  endpoint: Pick<
    OAuthFormEndpoint,
    'ErrorType' | 'requestTimeoutMs' | 'formHeaders'
  >,
  url: string,
  body: URLSearchParams,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { ...DEFAULT_FORM_HEADERS, ...endpoint.formHeaders },
      body,
      signal: oauthRequestSignal(
        endpoint.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        signal,
      ),
    });
  } catch (cause) {
    signal?.throwIfAborted();
    throw new endpoint.ErrorType(
      `Network error contacting ${url}: ${toErrorMessage(cause)}`,
      'transient',
    );
  }
}

/** Throw a provider error for a non-ok HTTP response. */
export async function throwOAuthHttpError(
  endpoint: Pick<OAuthFormEndpoint, 'ErrorType'>,
  response: Response,
  label: string,
): Promise<never> {
  const detail = await response.text().catch(() => '');
  throw new endpoint.ErrorType(
    `${label} failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
    oauthTokenErrorKind(response.status),
    response.status,
  );
}

/** Parse a successful JSON body through a schema, or throw transient. */
export async function parseOAuthJson<T>(
  endpoint: Pick<OAuthFormEndpoint, 'ErrorType'>,
  response: Response,
  schema: z.ZodType<T>,
  unexpectedMessage: string,
): Promise<T> {
  const raw: unknown = await response.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new endpoint.ErrorType(unexpectedMessage, 'transient');
  }
  return parsed.data;
}

/** Parse a token-endpoint response (requires ok status). */
async function parseOAuthTokenResponse<T>(
  endpoint: Pick<OAuthFormEndpoint, 'ErrorType'>,
  response: Response,
  schema: z.ZodType<T>,
  context: string,
): Promise<T> {
  if (!response.ok) await throwOAuthHttpError(endpoint, response, context);
  return parseOAuthJson(
    endpoint,
    response,
    schema,
    `${context} returned an unexpected token response`,
  );
}

/** Exchange an authorization code for tokens (PKCE loopback / device). */
export async function exchangeAuthorizationCode<
  TTokens extends SubscriptionTokenResponse,
>(
  endpoint: OAuthFormEndpoint<TTokens>,
  params: {
    code: string;
    verifier: string;
    redirectUri: string;
  },
): Promise<TTokens> {
  const response = await postOAuthForm(
    endpoint,
    endpoint.tokenUrl,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: endpoint.clientId,
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    }),
  );
  return parseOAuthTokenResponse(
    endpoint,
    response,
    endpoint.tokenResponseSchema,
    'Authorization code exchange',
  );
}

/** Refresh tokens with a refresh_token grant. */
export async function refreshOAuthTokens<
  TTokens extends SubscriptionTokenResponse,
>(
  endpoint: OAuthFormEndpoint<TTokens>,
  refreshToken: string,
): Promise<TTokens> {
  const response = await postOAuthForm(
    endpoint,
    endpoint.tokenUrl,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: endpoint.clientId,
      refresh_token: refreshToken,
    }),
  );
  return parseOAuthTokenResponse(
    endpoint,
    response,
    endpoint.tokenResponseSchema,
    'Token refresh',
  );
}
