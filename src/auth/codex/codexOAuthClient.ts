/**
 * Network calls against OpenAI's auth endpoints for the Codex OAuth flow.
 *
 * Pure functions over `fetch` — no state, no storage. The coordinator drives
 * these and persists the result. Kept separate so the state machine
 * (refresh thresholds, single-flight) is unit-testable without the network.
 */
import {
  CODEX_CLIENT_ID,
  CODEX_DEVICE_REDIRECT_URI,
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
      `Network error contacting ${url}: ${(cause as Error).message}`,
      'transient',
    );
  }
}

async function parseTokenResponse(
  response: Response,
  context: string,
): Promise<CodexTokenResponse> {
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new CodexAuthError(
      `${context} failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
      tokenErrorKind(response.status),
      response.status,
    );
  }
  const raw: unknown = await response.json().catch(() => null);
  const parsed = CodexTokenResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CodexAuthError(
      `${context} returned an unexpected token response`,
      'transient',
    );
  }
  return parsed.data;
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
export async function requestDeviceUserCode(): Promise<CodexDeviceUserCode> {
  let response: Response;
  try {
    response = await fetch(CODEX_DEVICE_USERCODE_URL, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new CodexAuthError(
      `Network error requesting device code: ${(cause as Error).message}`,
      'transient',
    );
  }
  if (response.status === 404) {
    throw new CodexAuthError(
      'Device-code login is not enabled for this account. Enable it under ChatGPT settings → Security (chatgpt.com/settings/security), then try again.',
      'fatal',
      404,
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new CodexAuthError(
      `Device code request failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
      tokenErrorKind(response.status),
      response.status,
    );
  }
  const raw: unknown = await response.json().catch(() => null);
  const parsed = CodexDeviceUserCodeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CodexAuthError(
      'Device code request returned an unexpected response',
      'transient',
    );
  }
  return parsed.data;
}

/** The display user code from a device-code response (field name varies). */
export function deviceUserCode(resp: CodexDeviceUserCode): string | undefined {
  return resp.user_code ?? resp.usercode ?? undefined;
}

/** The poll interval (seconds) from a device-code response, defaulting to 5. */
export function deviceInterval(resp: CodexDeviceUserCode): number {
  const raw = resp.interval;
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 5;
}

/**
 * Poll once for the device authorization result. Resolves to the authorization
 * code + verifier on success, or throws a CodexAuthError('pending') while the
 * user has not yet approved (403/404).
 */
export async function pollDeviceToken(params: {
  deviceAuthId: string;
  userCode: string;
}): Promise<CodexDeviceToken> {
  let response: Response;
  try {
    response = await fetch(CODEX_DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        device_auth_id: params.deviceAuthId,
        user_code: params.userCode,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    // Network blip mid-poll: treat as pending so the loop keeps trying.
    throw new CodexAuthError(
      `Network error polling device authorization: ${(cause as Error).message}`,
      'pending',
    );
  }
  if (response.status === 403 || response.status === 404) {
    throw new CodexAuthError(
      'Authorization pending',
      'pending',
      response.status,
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new CodexAuthError(
      `Device authorization failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
      tokenErrorKind(response.status),
      response.status,
    );
  }
  const raw: unknown = await response.json().catch(() => null);
  const parsed = CodexDeviceTokenSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CodexAuthError(
      'Device authorization returned an unexpected response',
      'transient',
    );
  }
  return parsed.data;
}

/** Redirect URI used for the device-code authorization-code exchange. */
export const codexDeviceRedirectUri = CODEX_DEVICE_REDIRECT_URI;
