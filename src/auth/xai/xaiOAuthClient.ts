/**
 * Network calls against xAI's auth endpoints for the Grok OAuth flow.
 *
 * Token grants share a declarative {@link OAuthFormEndpoint} and the
 * Promise-facing helpers from `@auth/oauth` for the coordinator. The RFC 8628
 * device form posts are Effect programs the device-login flow runs on one
 * fiber.
 */
// Third-party imports
import { Data, Effect } from 'effect';

// Local imports
import { isObject } from '@utils/core';

import { DeviceAuthorizationPending } from '../oauth/deviceAuthorization';
import {
  exchangeAuthorizationCode as exchangeFormAuthorizationCode,
  oauthTokenErrorKind,
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
  type XaiTokenResponse,
} from './xaiSessionTypes';

const REQUEST_TIMEOUT_MS = 30_000;

const FORM_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  Accept: 'application/json',
} as const;

/** Declarative xAI form OAuth endpoint (token grants). */
const XAI_FORM_ENDPOINT: OAuthFormEndpoint<XaiTokenResponse> = {
  tokenUrl: XAI_TOKEN_URL,
  clientId: XAI_CLIENT_ID,
  ErrorType: XaiAuthError,
  tokenResponseSchema: XaiTokenResponseSchema,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
};

/** The user refused the device authorization (terminal, re-auth required). */
class DeviceAuthorizationDenied extends Data.TaggedError(
  'DeviceAuthorizationDenied',
)<{
  readonly message: string;
  readonly status: number;
}> {}

/** The server expired the device code before the user approved. */
class DeviceCodeExpired extends Data.TaggedError('DeviceCodeExpired')<{
  readonly message: string;
  readonly status: number;
}> {}

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

function postForm(url: string, body: URLSearchParams) {
  return postOAuth({
    url,
    headers: FORM_HEADERS,
    body,
    timeoutMs: REQUEST_TIMEOUT_MS,
    networkErrorMessage: `Network error contacting ${url}`,
  });
}

/** Begin the RFC 8628 device-code flow. */
export const requestDeviceCode = Effect.fn('xaiOAuthClient.requestDeviceCode')(
  function* () {
    const response = yield* postForm(
      XAI_DEVICE_AUTHORIZATION_URL,
      new URLSearchParams({
        client_id: XAI_CLIENT_ID,
        scope: XAI_SCOPE,
      }),
    );
    if (!response.ok) {
      return yield* oauthHttpError(response, 'Device code request');
    }
    return yield* parseOAuthJson(
      response,
      XaiDeviceCodeSchema,
      'Device code request returned an unexpected response',
    );
  },
);

/** Best-effort read of an RFC 6749 error body; anything else is `{}`. */
const readErrorBody = Effect.fn('xaiOAuthClient.readErrorBody')(function* (
  response: Response,
) {
  const raw = yield* Effect.tryPromise((): Promise<unknown> =>
    response.json(),
  ).pipe(Effect.orElseSucceed((): unknown => ({})));
  const body: Record<string, unknown> = isObject(raw) ? raw : {};
  return body;
});

/**
 * Poll once for the device authorization result. Succeeds with tokens, or
 * fails with {@link DeviceAuthorizationPending} while the user has not yet
 * approved (a network blip mid-poll is also pending so the loop keeps trying).
 * Terminal device errors are {@link DeviceAuthorizationDenied} and
 * {@link DeviceCodeExpired}.
 */
export const pollDeviceToken = Effect.fn('xaiOAuthClient.pollDeviceToken')(
  function* (deviceCode: string) {
    const response = yield* postForm(
      XAI_TOKEN_URL,
      new URLSearchParams({
        grant_type: XAI_DEVICE_CODE_GRANT_TYPE,
        client_id: XAI_CLIENT_ID,
        device_code: deviceCode,
      }),
    ).pipe(
      Effect.catchTag('OAuthNetworkError', () =>
        Effect.fail(new DeviceAuthorizationPending({ slowDown: false })),
      ),
    );

    if (response.ok) {
      return yield* parseOAuthJson(
        response,
        XaiTokenResponseSchema,
        'Device authorization returned an unexpected token response',
      );
    }

    const body = yield* readErrorBody(response);
    const oauthError = typeof body.error === 'string' ? body.error : undefined;
    const errorDescription =
      typeof body.error_description === 'string'
        ? body.error_description
        : undefined;
    if (oauthError === 'authorization_pending' || oauthError === 'slow_down') {
      return yield* new DeviceAuthorizationPending({
        slowDown: oauthError === 'slow_down',
      });
    }
    if (
      oauthError === 'access_denied' ||
      oauthError === 'authorization_denied'
    ) {
      return yield* new DeviceAuthorizationDenied({
        message: 'Grok device authorization was denied',
        status: response.status,
      });
    }
    if (oauthError === 'expired_token') {
      return yield* new DeviceCodeExpired({
        message: 'Grok device code expired — please sign in again',
        status: response.status,
      });
    }
    const detail = errorDescription ?? oauthError ?? '';
    return yield* new OAuthHttpError({
      message: `Device token exchange failed (HTTP ${response.status})${
        detail ? `: ${detail}` : ''
      }`,
      status: response.status,
      kind: oauthTokenErrorKind(response.status),
    });
  },
);
