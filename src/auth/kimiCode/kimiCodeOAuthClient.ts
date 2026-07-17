/**
 * Network calls against Kimi Code's OAuth endpoints for the device-code flow.
 *
 * Pure functions over `fetch` — no state, no storage. The coordinator drives
 * these and persists the result. Kept separate so the state machine is unit-
 * testable without the network.
 */
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  KIMI_CODE_CLIENT_ID,
  KIMI_CODE_DEVICE_AUTHORIZATION_URL,
  KIMI_CODE_TOKEN_URL,
} from './kimiCodeConstants';
import { kimiCodeClientHeaders } from './kimiCodeDeviceIdentity';
import {
  KimiCodeAuthError,
  KimiCodeDeviceUserCodeSchema,
  KimiCodeTokenResponseSchema,
  type KimiCodeDeviceUserCode,
  type KimiCodeTokenResponse,
} from './kimiCodeSessionTypes';

const REQUEST_TIMEOUT_MS = 30_000;

const FORM_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  Accept: 'application/json',
} as const;

/** Classify an HTTP status from the token endpoint into a KimiCodeAuthError kind. */
function tokenErrorKind(status: number): KimiCodeAuthError['kind'] {
  // 400/401/403 → revoked or invalid grant; everything else (5xx, 429) transient.
  return status === 400 || status === 401 || status === 403 ? 'fatal' : 'transient';
}

async function postForm(
  url: string,
  body: URLSearchParams,
): Promise<{ status: number; data: Record<string, unknown> }> {
  let response: Response;
  try {
    // The backend requires X-Msh-* device headers on all token requests.
    response = await fetch(url, {
      method: 'POST',
      headers: { ...FORM_HEADERS, ...(await kimiCodeClientHeaders()) },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new KimiCodeAuthError(
      `Network error contacting ${url}: ${toErrorMessage(cause)}`,
      'transient',
    );
  }

  let data: Record<string, unknown> = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === 'object') {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return { status: response.status, data };
}

function errorDetail(data: Record<string, unknown>): string | undefined {
  if (typeof data.error_description === 'string' && data.error_description.length > 0) {
    return data.error_description;
  }
  if (typeof data.message === 'string' && data.message.length > 0) {
    return data.message;
  }
  if (typeof data.error === 'string' && data.error.length > 0) {
    return data.error;
  }
  return undefined;
}

/** Parse a successful JSON response through a schema, or throw 'transient'. */
function parseJson<T>(
  value: unknown,
  schema: import('zod').ZodType<T>,
  unexpectedMessage: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new KimiCodeAuthError(unexpectedMessage, 'transient');
  }
  return parsed.data;
}

/** Begin the device-code flow: request a user code to display. */
export async function requestDeviceUserCode(): Promise<KimiCodeDeviceUserCode> {
  const { status, data } = await postForm(
    KIMI_CODE_DEVICE_AUTHORIZATION_URL,
    new URLSearchParams({ client_id: KIMI_CODE_CLIENT_ID }),
  );

  if (status !== 200) {
    throw new KimiCodeAuthError(
      `Device authorization failed (HTTP ${status})${errorDetail(data) ? `: ${errorDetail(data)}` : ''}`,
      tokenErrorKind(status),
      status,
    );
  }

  return parseJson(
    data,
    KimiCodeDeviceUserCodeSchema,
    'Device authorization returned an unexpected response',
  );
}

/** Result of a single device-token poll. */
export type KimiCodePollResult =
  | { kind: 'success'; token: KimiCodeTokenResponse }
  | { kind: 'pending'; errorCode: string; description?: string }
  | { kind: 'expired' }
  | { kind: 'denied'; description?: string };

/** Poll once for the device authorization result. */
export async function pollDeviceToken(deviceCode: string): Promise<KimiCodePollResult> {
  const { status, data } = await postForm(
    KIMI_CODE_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: KIMI_CODE_CLIENT_ID,
      device_code: deviceCode,
    }),
  );

  if (status === 200 && typeof data.access_token === 'string') {
    return {
      kind: 'success',
      token: parseJson(
        data,
        KimiCodeTokenResponseSchema,
        'Token endpoint returned an unexpected response',
      ),
    };
  }

  if (status >= 500) {
    throw new KimiCodeAuthError(
      `Device token polling server error (HTTP ${status})${errorDetail(data) ? `: ${errorDetail(data)}` : ''}`,
      'transient',
      status,
    );
  }

  const errorCode = typeof data.error === 'string' ? data.error : 'unknown_error';
  const description = errorDetail(data);

  switch (errorCode) {
    case 'authorization_pending':
    case 'slow_down':
      return { kind: 'pending', errorCode, description };
    case 'expired_token':
      return { kind: 'expired' };
    case 'access_denied':
      return { kind: 'denied', description };
    default:
      throw new KimiCodeAuthError(
        `Device token polling failed (HTTP ${status})${description ? `: ${description}` : ` (${errorCode})`}`,
        tokenErrorKind(status),
        status,
      );
  }
}

/** Refresh tokens with a refresh_token grant. */
export async function refreshTokens(
  refreshToken: string,
): Promise<KimiCodeTokenResponse> {
  const { status, data } = await postForm(
    KIMI_CODE_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: KIMI_CODE_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  );

  if (status === 200 && typeof data.access_token === 'string') {
    return parseJson(
      data,
      KimiCodeTokenResponseSchema,
      'Token refresh returned an unexpected response',
    );
  }

  throw new KimiCodeAuthError(
    `Token refresh failed (HTTP ${status})${errorDetail(data) ? `: ${errorDetail(data)}` : ''}`,
    tokenErrorKind(status),
    status,
  );
}
