/**
 * What a failed model call means to the person and to the retry gate. llm
 * judges every vendor failure (`ModelError`'s kind, `retryable`, `scope`,
 * `retryAfterMs`, `quota`); model access fails with `RouteUnavailable`.
 * `providerErrorOf` words either; this module records that wording for the
 * run's retry request and reads the scope the gate cools.
 */
import { StatusCodes } from 'http-status-codes';
import { ModelError } from '@texra-ai/llm';

import type { RoutePolicy } from '@agent/runtime/ModelRetryGate';
import type { RouteUnavailable } from '@common/errors/agentErrors';
import { providerErrorOf } from '@common/errors/sdkError/providerErrorFormat';
import { type RetryErrorInfo, toRetryErrorInfo } from '@shared/schemas';

/** Why a model call failed: the vendor's verdict, or no route to send it on. */
export type CallFailure = ModelError | RouteUnavailable;

/**
 * The failure a run records for `error` on a binding of `provider`.
 * `partialText` is the tail of the text the attempt had streamed, which the
 * retry surface shows; an `unsent` failure (a rebind or renewal that failed)
 * is never offered again, so the user reads why.
 */
export function failureInfo(
  error: CallFailure,
  provider: string,
  options: { readonly partialText?: string; readonly unsent?: boolean } = {},
): RetryErrorInfo {
  const info = toRetryErrorInfo(providerErrorOf(error));
  return {
    ...info,
    provider,
    userRetryable: options.unsent !== true && info.userRetryable,
    ...(options.partialText ? { partialText: options.partialText } : {}),
  };
}

/** Which route a 429 cools: the model's, where the provider scoped it, else the wire's. */
const modelScoped = (error: Error): boolean =>
  error instanceof ModelError &&
  error.status === StatusCodes.TOO_MANY_REQUESTS &&
  error.scope === 'model';

/**
 * The retry gate's two routes for one binding, narrowest first: `model` on
 * its `wire` route, then the wire route itself (provider, credential route,
 * endpoint, key fingerprint), which a failure llm scoped to the route cools.
 */
export function routePolicies(
  wire: readonly string[],
  model: string,
): readonly [RoutePolicy, RoutePolicy] {
  const wireKey = JSON.stringify(wire);
  const after = (error: Error) => ({
    retryAfterMs: error instanceof ModelError ? error.retryAfterMs : undefined,
  });
  return [
    {
      key: JSON.stringify([wireKey, model]),
      classifyFailure: (error) =>
        modelScoped(error) ? after(error) : undefined,
    },
    {
      key: wireKey,
      classifyFailure: (error) =>
        error instanceof ModelError && error.scope === 'route'
          ? after(error)
          : undefined,
      isReachableFailure: modelScoped,
    },
  ];
}
