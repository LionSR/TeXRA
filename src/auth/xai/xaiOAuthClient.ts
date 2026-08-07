/**
 * Network calls against xAI's auth endpoints for the Grok OAuth flow.
 *
 * Token grants + RFC 8628 device form posts share a declarative
 * {@link OAuthFormEndpoint} and pure helpers from `@auth/oauth`.
 */
// Local imports
import { isObject } from '@utils/core';

import {
  exchangeAuthorizationCode as exchangeFormAuthorizationCode,
  oauthTokenErrorKind,
  parseOAuthJson,
  postOAuthForm,
  refreshOAuthTokens,
  throwOAuthHttpError,
  type OAuthFormEndpoint,
} from '../oauth/formTokenClient';
import {
  XAI_CLIENT_ID,
  XAI_DEVICE_AUTHORIZATION_URL,
  XAI_DEVICE_CODE_GRANT_TYPE,
  XAI_SCOPE,
  XAI_TOKEN_URL,
} from './xaiConstants';
import {
  XaiAuthError,
  XaiDeviceCodeSchema,
  XaiTokenResponseSchema,
  type XaiDeviceCode,
  type XaiTokenResponse,
} from './xaiSessionTypes';

const REQUEST_TIMEOUT_MS = 30_000;

/** Declarative xAI form OAuth endpoint (token + device form posts). */
const XAI_FORM_ENDPOINT: OAuthFormEndpoint<XaiTokenResponse> = {
  tokenUrl: XAI_TOKEN_URL,
  clientId: XAI_CLIENT_ID,
  ErrorType: XaiAuthError,
  tokenResponseSchema: XaiTokenResponseSchema,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
};

export function exchangeAuthorizationCode(params: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<XaiTokenResponse> {
  return exchangeFormAuthorizationCode(XAI_FORM_ENDPOINT, params);
}

export function refreshTokens(refreshToken: string): Promise<XaiTokenResponse> {
  return refreshOAuthTokens(XAI_FORM_ENDPOINT, refreshToken);
}

/** Begin the RFC 8628 device-code flow. */
export async function requestDeviceCode(
  signal?: AbortSignal,
): Promise<XaiDeviceCode> {
  const response = await postOAuthForm(
    XAI_FORM_ENDPOINT,
    XAI_DEVICE_AUTHORIZATION_URL,
    new URLSearchParams({
      client_id: XAI_CLIENT_ID,
      scope: XAI_SCOPE,
    }),
    signal,
  );
  if (!response.ok) {
    await throwOAuthHttpError(
      XAI_FORM_ENDPOINT,
      response,
      'Device code request',
    );
  }
  return parseOAuthJson(
    XAI_FORM_ENDPOINT,
    response,
    XaiDeviceCodeSchema,
    'Device code request returned an unexpected response',
  );
}

/**
 * Poll once for the device authorization result. Resolves to tokens on success,
 * or throws XaiAuthError('pending') while the user has not yet approved.
 * Terminal device errors (access_denied, expired_token) are fatal.
 */
export async function pollDeviceToken(
  deviceCode: string,
  signal?: AbortSignal,
): Promise<XaiTokenResponse> {
  let response: Response;
  try {
    response = await postOAuthForm(
      XAI_FORM_ENDPOINT,
      XAI_TOKEN_URL,
      new URLSearchParams({
        grant_type: XAI_DEVICE_CODE_GRANT_TYPE,
        client_id: XAI_CLIENT_ID,
        device_code: deviceCode,
      }),
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    // Network blip mid-poll: report pending so the loop keeps trying.
    if (error instanceof XaiAuthError && error.kind === 'transient') {
      throw new XaiAuthError(error.message, 'pending', error.status, {
        cause: error,
      });
    }
    throw error;
  }

  if (response.ok) {
    return parseOAuthJson(
      XAI_FORM_ENDPOINT,
      response,
      XaiTokenResponseSchema,
      'Device authorization returned an unexpected token response',
    );
  }

  const bodyRaw: unknown = await response.json().catch(() => ({}));
  const body: Record<string, unknown> = isObject(bodyRaw) ? bodyRaw : {};
  const oauthError = typeof body.error === 'string' ? body.error : undefined;
  const errorDescription =
    typeof body.error_description === 'string'
      ? body.error_description
      : undefined;
  if (oauthError === 'authorization_pending' || oauthError === 'slow_down') {
    throw new XaiAuthError(
      oauthError === 'slow_down' ? 'slow_down' : 'Authorization pending',
      'pending',
      response.status,
    );
  }
  if (oauthError === 'access_denied' || oauthError === 'authorization_denied') {
    throw new XaiAuthError(
      'Grok device authorization was denied',
      'fatal',
      response.status,
    );
  }
  if (oauthError === 'expired_token') {
    throw new XaiAuthError(
      'Grok device code expired — please sign in again',
      'expired',
      response.status,
    );
  }
  const detail = errorDescription ?? oauthError ?? '';
  throw new XaiAuthError(
    `Device token exchange failed (HTTP ${response.status})${
      detail ? `: ${detail}` : ''
    }`,
    oauthTokenErrorKind(response.status),
    response.status,
  );
}
