/**
 * Network calls against xAI's auth endpoints for the Grok OAuth flow.
 *
 * Pure functions over `fetch` — no state, no storage. The coordinator drives
 * these and persists the result.
 */
import { z } from 'zod';

import { toErrorMessage } from '@utils/errors/errorMessage';

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

const FORM_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  Accept: 'application/json',
} as const;

/** Classify an HTTP status from the token endpoint into an XaiAuthError kind. */
function tokenErrorKind(status: number): XaiAuthError['kind'] {
  return status === 400 || status === 401 || status === 403
    ? 'fatal'
    : 'transient';
}

async function postForm(url: string, body: URLSearchParams): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: FORM_HEADERS,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new XaiAuthError(
      `Network error contacting ${url}: ${toErrorMessage(cause)}`,
      'transient',
    );
  }
}

/** Throw an XaiAuthError for a non-ok HTTP response, appending any body text. */
async function throwHttpError(
  response: Response,
  label: string,
): Promise<never> {
  const detail = await response.text().catch(() => '');
  throw new XaiAuthError(
    `${label} failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
    tokenErrorKind(response.status),
    response.status,
  );
}

/** Parse a successful JSON response through a schema, or throw 'transient'. */
async function parseJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  unexpectedMessage: string,
): Promise<T> {
  const raw: unknown = await response.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new XaiAuthError(unexpectedMessage, 'transient');
  }
  return parsed.data;
}

async function parseTokenResponse(
  response: Response,
  context: string,
): Promise<XaiTokenResponse> {
  if (!response.ok) await throwHttpError(response, context);
  return parseJson(
    response,
    XaiTokenResponseSchema,
    `${context} returned an unexpected token response`,
  );
}

/** Exchange an authorization code (loopback) for tokens. */
export async function exchangeAuthorizationCode(params: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<XaiTokenResponse> {
  const response = await postForm(
    XAI_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: XAI_CLIENT_ID,
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    }),
  );
  return parseTokenResponse(response, 'Authorization code exchange');
}

/** Refresh tokens with a refresh_token grant. */
export async function refreshTokens(
  refreshToken: string,
): Promise<XaiTokenResponse> {
  const response = await postForm(
    XAI_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: XAI_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  );
  return parseTokenResponse(response, 'Token refresh');
}

/** Begin the RFC 8628 device-code flow. */
export async function requestDeviceCode(
  signal?: AbortSignal,
): Promise<XaiDeviceCode> {
  let response: Response;
  try {
    response = await fetch(XAI_DEVICE_AUTHORIZATION_URL, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: new URLSearchParams({
        client_id: XAI_CLIENT_ID,
        scope: XAI_SCOPE,
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    signal?.throwIfAborted();
    throw new XaiAuthError(
      `Network error requesting device code: ${toErrorMessage(cause)}`,
      'transient',
    );
  }
  if (!response.ok) await throwHttpError(response, 'Device code request');
  return parseJson(
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
    response = await fetch(XAI_TOKEN_URL, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: new URLSearchParams({
        grant_type: XAI_DEVICE_CODE_GRANT_TYPE,
        client_id: XAI_CLIENT_ID,
        device_code: deviceCode,
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    signal?.throwIfAborted();
    // Network blip mid-poll: report pending so the loop keeps trying.
    throw new XaiAuthError(
      `Network error polling device authorization: ${toErrorMessage(cause)}`,
      'pending',
    );
  }

  if (response.ok) {
    return parseJson(
      response,
      XaiTokenResponseSchema,
      'Device authorization returned an unexpected token response',
    );
  }

  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    error_description?: string;
  };
  const error = body.error;
  if (error === 'authorization_pending' || error === 'slow_down') {
    throw new XaiAuthError(
      error === 'slow_down' ? 'slow_down' : 'Authorization pending',
      'pending',
      response.status,
    );
  }
  if (error === 'access_denied' || error === 'authorization_denied') {
    throw new XaiAuthError(
      'Grok device authorization was denied',
      'fatal',
      response.status,
    );
  }
  if (error === 'expired_token') {
    throw new XaiAuthError(
      'Grok device code expired — please sign in again',
      'expired',
      response.status,
    );
  }
  const detail = body.error_description ?? error ?? '';
  throw new XaiAuthError(
    `Device token exchange failed (HTTP ${response.status})${
      detail ? `: ${detail}` : ''
    }`,
    tokenErrorKind(response.status),
    response.status,
  );
}
