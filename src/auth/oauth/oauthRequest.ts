/**
 * Effect-native POSTs against OAuth endpoints, for the device-code flows.
 *
 * One request is one fiber: headers and body are read under one
 * `Effect.timeoutOrElse`, and fiber interruption reaches `fetch` and the body
 * stream through the `AbortSignal` that `Effect.tryPromise` hands the request.
 * Expected transport failures are yieldable tagged errors carrying the
 * provider-facing message; the Promise edge of each flow re-mints them as that
 * provider's auth error.
 *
 * Token grants (code exchange, refresh) still go through the Promise-facing
 * `formTokenClient` because their callers are the Promise coordinators.
 */
import { Data, Duration, Effect } from 'effect';

import { toErrorMessage } from '@utils/errors/errorMessage';

import { oauthTokenErrorKind } from './formTokenClient';
import type { z } from 'zod';
import type { SubscriptionOAuthErrorKind } from './subscriptionOAuthError';

/**
 * The endpoint could not be reached, or did not answer (headers and body)
 * within the timeout.
 */
export class OAuthNetworkError extends Data.TaggedError('OAuthNetworkError')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The endpoint answered with a non-2xx status the flow does not recover from. */
export class OAuthHttpError extends Data.TaggedError('OAuthHttpError')<{
  readonly message: string;
  readonly status: number;
  readonly kind: SubscriptionOAuthErrorKind;
}> {}

/** A 2xx body that did not match the expected schema. */
export class OAuthUnexpectedResponse extends Data.TaggedError(
  'OAuthUnexpectedResponse',
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** A fully read response: status and the body text. */
interface OAuthResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
}

interface OAuthPostOptions {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: BodyInit;
  readonly timeoutMs: number;
  /** Prefix of the network-error message (e.g. `Network error contacting …`). */
  readonly networkErrorMessage: string;
}

/**
 * POST and read the whole response. Fails with {@link OAuthNetworkError} when
 * the request or its body cannot complete within the timeout; status handling
 * is the caller's.
 */
export const postOAuth = Effect.fn('oauthRequest.postOAuth')(function* (
  options: OAuthPostOptions,
) {
  return yield* Effect.tryPromise({
    // The body is read on the same signal so the deadline and interruption
    // bound a server that sends headers and then stalls.
    try: async (signal): Promise<OAuthResponse> => {
      const response = await fetch(options.url, {
        method: 'POST',
        headers: options.headers,
        body: options.body,
        signal,
      });
      return {
        status: response.status,
        ok: response.ok,
        text: await response.text(),
      };
    },
    catch: (cause) =>
      new OAuthNetworkError({
        message: `${options.networkErrorMessage}: ${toErrorMessage(cause)}`,
        cause,
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(options.timeoutMs),
      orElse: () =>
        Effect.fail(
          new OAuthNetworkError({
            // The wording `AbortSignal.timeout` produced, so the message the
            // provider error carries is unchanged.
            message: `${options.networkErrorMessage}: The operation was aborted due to timeout`,
            cause: undefined,
          }),
        ),
    }),
  );
});

/** Fail with {@link OAuthHttpError} describing a non-ok response. */
export const oauthHttpError = Effect.fn('oauthRequest.oauthHttpError')(
  function* (response: OAuthResponse, label: string) {
    const detail = response.text;
    return yield* new OAuthHttpError({
      message: `${label} failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
      status: response.status,
      kind: oauthTokenErrorKind(response.status),
    });
  },
);

/** Parse a successful JSON body through a schema. */
export const parseOAuthJson = Effect.fn('oauthRequest.parseOAuthJson')(
  function* <T>(
    response: OAuthResponse,
    schema: z.ZodType<T>,
    unexpectedMessage: string,
  ) {
    const raw = yield* Effect.try({
      try: (): unknown => JSON.parse(response.text),
      catch: (cause) =>
        new OAuthUnexpectedResponse({ message: unexpectedMessage, cause }),
    });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return yield* new OAuthUnexpectedResponse({
        message: unexpectedMessage,
        cause: parsed.error,
      });
    }
    return parsed.data;
  },
);
