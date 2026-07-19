/**
 * Network calls against OpenAI's auth endpoints for the Codex OAuth flow.
 *
 * Pure functions over `fetch` — no state, no storage. The coordinator drives
 * these and persists the result. Kept separate so the state machine
 * (refresh thresholds, single-flight) is unit-testable without the network.
 */
import { z } from 'zod';

import { toErrorMessage } from '@utils/errors/errorMessage';
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

const FORM_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
} as const;

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
} as const;

/** Classify an HTTP status from the token endpoint into a CodexAuthError kind. */
function tokenErrorKind(status: number): CodexAuthError['kind'] {
  // 400/401/403 → revoked or invalid grant; everything else (5xx, 429) transient.
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
    throw new CodexAuthError(
      `Network error contacting ${url}: ${toErrorMessage(cause)}`,
      'transient',
    );
  }
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
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    signal?.throwIfAborted();
    throw new CodexAuthError(
      `${networkErrorMessage}: ${toErrorMessage(cause)}`,
      networkErrorKind,
    );
  }
}

/** Throw a CodexAuthError for a non-ok HTTP response, appending any body text. */
async function throwHttpError(
  response: Response,
  label: string,
): Promise<never> {
  const detail = await response.text().catch(() => '');
  throw new CodexAuthError(
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
    throw new CodexAuthError(unexpectedMessage, 'transient');
  }
  return parsed.data;
}

async function parseTokenResponse(
  response: Response,
  context: string,
): Promise<CodexTokenResponse> {
  if (!response.ok) await throwHttpError(response, context);
  return parseJson(
    response,
    CodexTokenResponseSchema,
    `${context} returned an unexpected token response`,
  );
}

/** Exchange an authorization code (loopback or device) for tokens. */
export async function exchangeAuthorizationCode(params: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<CodexTokenResponse> {
  const response = await postForm(
    CODEX_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
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
): Promise<CodexTokenResponse> {
  const response = await postForm(
    CODEX_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CODEX_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  );
  return parseTokenResponse(response, 'Token refresh');
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
  if (!response.ok) await throwHttpError(response, 'Device code request');
  return parseJson(
    response,
    CodexDeviceUserCodeSchema,
    'Device code request returned an unexpected response',
  );
}

/** The display user code from a device-code response (field name varies). */
export function deviceUserCode(resp: CodexDeviceUserCode): string | undefined {
  return resp.user_code ?? resp.usercode ?? undefined;
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
  if (!response.ok) await throwHttpError(response, 'Device authorization');
  return parseJson(
    response,
    CodexDeviceTokenSchema,
    'Device authorization returned an unexpected response',
  );
}
