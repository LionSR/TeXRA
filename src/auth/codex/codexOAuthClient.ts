/**
 * Network calls against OpenAI's auth endpoints for the Codex OAuth flow.
 *
 * Token grants: declarative {@link OAuthFormEndpoint} + shared pure functions.
 * Device-code: OpenAI custom JSON protocol (not RFC 8628).
 */
// Local imports
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  exchangeAuthorizationCode as exchangeFormAuthorizationCode,
  oauthRequestSignal,
  parseOAuthJson,
  refreshOAuthTokens,
  throwOAuthHttpError,
  type OAuthFormEndpoint,
} from '../oauth/formTokenClient';
import {
  CODEX_CLIENT_ID,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_DEVICE_USERCODE_URL,
  CODEX_TOKEN_URL,
} from './codexConstants';
import {
  CodexAuthError,
  CodexDeviceTokenSchema,
  CodexDeviceUserCodeSchema,
  CodexTokenResponseSchema,
  type CodexDeviceToken,
  type CodexDeviceUserCode,
  type CodexTokenResponse,
} from './codexSessionTypes';

const REQUEST_TIMEOUT_MS = 30_000;

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
} as const;

/** Declarative Codex token endpoint (code exchange + refresh). */
const CODEX_FORM_ENDPOINT: OAuthFormEndpoint<CodexTokenResponse> = {
  tokenUrl: CODEX_TOKEN_URL,
  clientId: CODEX_CLIENT_ID,
  ErrorType: CodexAuthError,
  tokenResponseSchema: CodexTokenResponseSchema,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
};

export function exchangeAuthorizationCode(params: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<CodexTokenResponse> {
  return exchangeFormAuthorizationCode(CODEX_FORM_ENDPOINT, params);
}

export function refreshTokens(
  refreshToken: string,
): Promise<CodexTokenResponse> {
  return refreshOAuthTokens(CODEX_FORM_ENDPOINT, refreshToken);
}

/** POST a JSON body, mapping a network failure to a CodexAuthError. */
async function postJson(
  url: string,
  body: unknown,
  networkErrorMessage: string,
  networkErrorKind: CodexAuthError['kind'],
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
      signal: oauthRequestSignal(REQUEST_TIMEOUT_MS, signal),
    });
  } catch (cause) {
    signal?.throwIfAborted();
    throw new CodexAuthError(
      `${networkErrorMessage}: ${toErrorMessage(cause)}`,
      networkErrorKind,
    );
  }
}

/** Begin the device-code flow: request a user code to display. */
export async function requestDeviceUserCode(
  signal?: AbortSignal,
): Promise<CodexDeviceUserCode> {
  const response = await postJson(
    CODEX_DEVICE_USERCODE_URL,
    { client_id: CODEX_CLIENT_ID },
    'Network error requesting device code',
    'transient',
    signal,
  );
  if (response.status === 404) {
    throw new CodexAuthError(
      'Device-code login is not enabled for this account. Enable it under ChatGPT settings → Security (chatgpt.com/settings/security), then try again.',
      'fatal',
      404,
    );
  }
  if (!response.ok) {
    await throwOAuthHttpError(
      CODEX_FORM_ENDPOINT,
      response,
      'Device code request',
    );
  }
  return parseOAuthJson(
    CODEX_FORM_ENDPOINT,
    response,
    CodexDeviceUserCodeSchema,
    'Device code request returned an unexpected response',
  );
}

/**
 * Poll once for the device authorization result. Resolves to the authorization
 * code + verifier on success, or throws a CodexAuthError('pending') while the
 * user has not yet approved (403/404).
 */
export async function pollDeviceToken(
  params: {
    deviceAuthId: string;
    userCode: string;
  },
  signal?: AbortSignal,
): Promise<CodexDeviceToken> {
  // A network blip mid-poll is reported as 'pending' so the loop keeps trying.
  const response = await postJson(
    CODEX_DEVICE_TOKEN_URL,
    { device_auth_id: params.deviceAuthId, user_code: params.userCode },
    'Network error polling device authorization',
    'pending',
    signal,
  );
  if (response.status === 403 || response.status === 404) {
    throw new CodexAuthError(
      'Authorization pending',
      'pending',
      response.status,
    );
  }
  if (!response.ok) {
    await throwOAuthHttpError(
      CODEX_FORM_ENDPOINT,
      response,
      'Device authorization',
    );
  }
  return parseOAuthJson(
    CODEX_FORM_ENDPOINT,
    response,
    CodexDeviceTokenSchema,
    'Device authorization returned an unexpected response',
  );
}
