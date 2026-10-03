/**
 * Network calls against xAI's auth endpoints for the Grok OAuth flow.
 *
 * The RFC 8628 device form posts; the token grants run over the policy's form
 * endpoint in the shared coordinator. Every export is an Effect program the
 * device-login flow runs on one fiber.
 */
// Third-party imports
import { Data, Effect } from 'effect';

// Local imports
import { ensureError, isObject } from '../support.js';

import {
  DeviceAuthorizationPending,
  DeviceAuthorizationTransient,
} from '../deviceAuthorization.js';
import {
  OAuthHttpError,
  oauthHttpError,
  oauthTokenErrorKind,
  parseOAuthJson,
  postOAuth,
} from '../oauthRequest.js';
import {
  XAI_CLIENT_ID,
  XAI_DEVICE_AUTHORIZATION_URL,
  XAI_DEVICE_CODE_GRANT_TYPE,
  XAI_SCOPE,
  XAI_TOKEN_URL,
} from './xaiConstants.js';
import {
  XaiDeviceCodeSchema,
  XaiTokenResponseSchema,
} from './xaiSessionTypes.js';

const REQUEST_TIMEOUT_MS = 30_000;

const FORM_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  Accept: 'application/json',
} as const;

/** The user refused the device authorization (terminal, re-auth required). */
export class DeviceAuthorizationDenied extends Data.TaggedError(
  'DeviceAuthorizationDenied',
)<{
  readonly message: string;
  readonly status: number;
}> {}

/** The server expired the device code before the user approved. */
export class DeviceCodeExpired extends Data.TaggedError('DeviceCodeExpired')<{
  readonly message: string;
  readonly status: number;
}> {}

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

/** Best-effort parse of an RFC 6749 error body; anything else is `{}`. */
const readErrorBody = Effect.fn('xaiOAuthClient.readErrorBody')(function* (
  text: string,
) {
  const raw = yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: ensureError,
  }).pipe(Effect.orElseSucceed((): unknown => ({})));
  const body: Record<string, unknown> = isObject(raw) ? raw : {};
  return body;
});

/**
 * Poll once for the device authorization result. Succeeds with tokens, or
 * fails with {@link DeviceAuthorizationPending} while the user has not yet
 * approved. A network blip mid-poll is {@link DeviceAuthorizationTransient},
 * which the shared poll retries a few times before failing with it.
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
      Effect.catchTag('OAuthNetworkError', (error) =>
        Effect.fail(new DeviceAuthorizationTransient({ error })),
      ),
    );

    if (response.ok) {
      return yield* parseOAuthJson(
        response,
        XaiTokenResponseSchema,
        'Device authorization returned an unexpected token response',
      );
    }

    const body = yield* readErrorBody(response.text);
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
