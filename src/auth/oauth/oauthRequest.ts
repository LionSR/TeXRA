/**
 * Effect-native POSTs against OAuth endpoints, for the device-code flows.
 *
 * One request is one fiber: the request timeout is `Effect.timeoutOrElse`,
 * and fiber interruption reaches `fetch` through the `AbortSignal` that
 * `Effect.tryPromise` hands the request. Expected transport failures are
 * yieldable tagged errors carrying the provider-facing message; the Promise
 * edge of each flow re-mints them as that provider's auth error.
 *
 * Token grants (code exchange, refresh) still go through the Promise-facing
 * `formTokenClient` because their callers are the Promise coordinators.
 */
import { Data, Duration, Effect } from 'effect';

import { toErrorMessage } from '@utils/errors/errorMessage';

import { oauthTokenErrorKind } from './formTokenClient';
import type { z } from 'zod';
import type { SubscriptionOAuthErrorKind } from './subscriptionOAuthError';

/** The endpoint could not be reached, or did not answer within the timeout. */
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

interface OAuthPostOptions {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: BodyInit;
  readonly timeoutMs: number;
  /** Prefix of the network-error message (e.g. `Network error contacting …`). */
  readonly networkErrorMessage: string;
}

/**
 * POST and resolve the raw `Response`. Fails with {@link OAuthNetworkError}
 * when the request cannot complete; status handling is the caller's.
 */
export const postOAuth = Effect.fn('oauthRequest.postOAuth')(function* (
  options: OAuthPostOptions,
) {
  return yield* Effect.tryPromise({
    try: (signal) =>
      fetch(options.url, {
        method: 'POST',
        headers: options.headers,
        body: options.body,
        signal,
      }),
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
  function* (response: Response, label: string) {
    // Best effort: the body only enriches the message of an already-failed
    // request.
    const detail = yield* Effect.tryPromise(() => response.text()).pipe(
      Effect.orElseSucceed(() => ''),
    );
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
    response: Response,
    schema: z.ZodType<T>,
    unexpectedMessage: string,
  ) {
    const raw = yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
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
