/**
 * Network calls against xAI's auth endpoints for the Grok OAuth flow.
 *
 * The RFC 8628 device form posts; the token grants run over the policy's form
 * endpoint in the shared coordinator. Every export is an Effect program the
 * device-login flow runs on one fiber.
 */
// Third-party imports
import { Data, Effect } from 'effect';
import { z } from 'zod';

// Local imports
import {
  DeviceAuthorizationPending,
  DeviceAuthorizationTransient,
} from '../deviceAuthorization.js';
import {
  OAuthHttpError,
  oauthHttpError,
  oauthTokenErrorKind,
  parseOAuthJson,
  postOAuthForm,
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

/** Begin the RFC 8628 device-code flow. */
export const requestDeviceCode = Effect.fn('xaiOAuthClient.requestDeviceCode')(
  function* () {
    const response = yield* postOAuthForm(
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

/** An RFC 6749 error body; a field of another shape reads as absent. */
const DeviceErrorBodySchema = z.object({
  error: z.string().optional().catch(undefined),
  error_description: z.string().optional().catch(undefined),
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
    const response = yield* postOAuthForm(
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

    // Best effort: a body that is not an error object carries no code.
    const { error: oauthError, error_description: errorDescription } =
      yield* parseOAuthJson(response, DeviceErrorBodySchema, '').pipe(
        Effect.orElseSucceed(() => ({
          error: undefined,
          error_description: undefined,
        })),
      );
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
