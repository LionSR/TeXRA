/**
 * Network calls against OpenAI's auth endpoints for the Codex OAuth flow.
 *
 * Token grants: declarative {@link OAuthFormEndpoint} + shared pure functions,
 * Promise-facing for the coordinator.
 * Device-code: OpenAI custom JSON protocol (not RFC 8628), as Effect programs
 * the device-login flow runs on one fiber.
 */
// Third-party imports
import { Effect } from 'effect';

// Local imports
import { DeviceAuthorizationPending } from '../oauth/deviceAuthorization';
import {
  exchangeAuthorizationCode as exchangeFormAuthorizationCode,
  refreshOAuthTokens,
  type OAuthFormEndpoint,
} from '../oauth/formTokenClient';
import {
  OAuthHttpError,
  oauthHttpError,
  parseOAuthJson,
  postOAuth,
} from '../oauth/oauthRequest';
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

function postJson(url: string, body: unknown, networkErrorMessage: string) {
  return postOAuth({
    url,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    timeoutMs: REQUEST_TIMEOUT_MS,
    networkErrorMessage,
  });
}

/** Begin the device-code flow: request a user code to display. */
export const requestDeviceUserCode = Effect.fn(
  'codexOAuthClient.requestDeviceUserCode',
)(function* () {
  const response = yield* postJson(
    CODEX_DEVICE_USERCODE_URL,
    { client_id: CODEX_CLIENT_ID },
    'Network error requesting device code',
  );
  if (response.status === 404) {
    return yield* new OAuthHttpError({
      message:
        'Device-code login is not enabled for this account. Enable it under ChatGPT settings → Security (chatgpt.com/settings/security), then try again.',
      status: 404,
      kind: 'fatal',
    });
  }
  if (!response.ok) {
    return yield* oauthHttpError(response, 'Device code request');
  }
  return yield* parseOAuthJson(
    response,
    CodexDeviceUserCodeSchema,
    'Device code request returned an unexpected response',
  );
});

/**
 * Poll once for the device authorization result. Succeeds with the
 * authorization code + verifier, or fails with
 * {@link DeviceAuthorizationPending} while the user has not yet approved
 * (403/404). A network blip mid-poll is also pending so the loop keeps trying.
 */
export const pollDeviceToken = Effect.fn('codexOAuthClient.pollDeviceToken')(
  function* (params: { deviceAuthId: string; userCode: string }) {
    const response = yield* postJson(
      CODEX_DEVICE_TOKEN_URL,
      { device_auth_id: params.deviceAuthId, user_code: params.userCode },
      'Network error polling device authorization',
    ).pipe(
      Effect.catchTag('OAuthNetworkError', () =>
        Effect.fail(new DeviceAuthorizationPending({ slowDown: false })),
      ),
    );
    if (response.status === 403 || response.status === 404) {
      return yield* new DeviceAuthorizationPending({ slowDown: false });
    }
    if (!response.ok) {
      return yield* oauthHttpError(response, 'Device authorization');
    }
    return yield* parseOAuthJson(
      response,
      CodexDeviceTokenSchema,
      'Device authorization returned an unexpected response',
    );
  },
);
