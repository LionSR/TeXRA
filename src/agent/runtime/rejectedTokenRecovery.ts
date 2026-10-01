/**
 * A subscription access token the provider rejects before its stored expiry
 * (revoked, or expired server-side) is refreshed once per invocation and the
 * attempt rebound on the new session. A refresh or rebind that fails takes
 * the stale 401's place as the invocation's failure, so the user reads the
 * "sign in again" instruction rather than "token is expired". That failure
 * is terminal: it rarely carries a status, so classification alone would
 * auto-retry it, and the retry would resend the rejected token and bring the
 * stale 401 back.
 */
import { StatusCodes } from 'http-status-codes';
import { Effect, type Result } from 'effect';

import { attachProviderError } from '@common/errors/sdkError/errorMetadata';
import type { PlatformSecrets } from '@platform/secrets';
import { toRetryErrorInfo } from '@shared/schemas';
import type { RunState } from '@shared/session/runStateFold';

import { refreshRejectedSubscription } from './modelRoutes';
import { classifyModelFailure, type ModelFailure } from './run/modelFailure';
import type { BoundModel } from './run/modelBinding';
import type { HttpClient } from 'effect/http';

/**
 * One invocation's recovery. `null` means the retry carries a refreshed
 * token; otherwise the failure to report: the one handed in when it is not
 * a subscription 401 or the refresh was already spent, else the refresh's
 * or the rebind's own failure.
 */
export function rejectedTokenRecovery<R>(
  run: { readonly stores: { readonly secrets: PlatformSecrets } },
  current: Effect.Effect<RunState>,
  rebind: (
    selection: 'configured',
    failed: BoundModel,
    declinedRoutes: RunState['declinedRoutes'],
  ) => Effect.Effect<Result.Result<unknown, Error>, never, R>,
) {
  let spent = false;
  return (
    failure: ModelFailure,
    bound: BoundModel,
  ): Effect.Effect<ModelFailure | null, never, R | HttpClient.HttpClient> => {
    const route = bound.usageRoute;
    if (
      spent ||
      failure.formatted.statusCode !== StatusCodes.UNAUTHORIZED ||
      (route !== 'chatgpt-subscription' && route !== 'xai-subscription')
    )
      return Effect.succeed(failure);
    spent = true;
    return refreshRejectedSubscription(route, run.stores.secrets).pipe(
      Effect.andThen(current),
      Effect.flatMap(({ declinedRoutes }) =>
        Effect.flatMap(
          rebind('configured', bound, declinedRoutes),
          Effect.fromResult,
        ),
      ),
      Effect.as(null),
      Effect.catch((error: Error) => {
        const failed = classifyModelFailure(error, bound);
        const formatted = { ...failed.formatted, userRetryable: false };
        attachProviderError(failed.error, formatted);
        return Effect.succeed({
          ...failed,
          formatted,
          info: toRetryErrorInfo(formatted),
          autoRetryable: false,
        });
      }),
    );
  };
}
