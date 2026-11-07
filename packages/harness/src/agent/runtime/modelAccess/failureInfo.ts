/**
 * What a failed model call means to the person and to the retry gate. llm
 * judges every vendor failure (`ModelError`'s kind, `retryable`, `scope`,
 * `retryAfterMs`, `quota`); model access fails with `RouteUnavailable`.
 * `providerErrorOf` words either; this module records that wording for the
 * run's retry request and reads the scope the gate cools.
 */
import { ModelError } from '@texra-ai/llm';

import type { RoutePolicy } from '@agent/runtime/ModelRetryGate';
import type { RouteUnavailable } from '@common/errors/agentErrors';
import { providerErrorOf } from '@common/errors/sdkError/providerErrorFormat';
import { type RetryErrorInfo, toRetryErrorInfo } from '@shared/schemas';

/** Why a model call failed: the vendor's verdict, or no route to send it on. */
export type CallFailure = ModelError | RouteUnavailable;

/**
 * The failure a run records for `error` on a binding of `provider`: its
 * words, and the text a model failure had streamed before it, which the
 * retry surface shows.
 */
export function failureInfo(
  error: CallFailure,
  provider: string,
): RetryErrorInfo {
  const partialText =
    error instanceof ModelError ? error.partialText : undefined;
  return {
    ...toRetryErrorInfo(providerErrorOf(error)),
    provider,
    ...(partialText ? { partialText } : {}),
  };
}

/**
 * The retry gate's two routes for one binding, narrowest first: `model` on
 * its `wire` route, which a failure llm scoped to the model cools, then the
 * wire route itself (provider, credential route, endpoint, key fingerprint),
 * which a failure scoped to the route cools.
 */
export function routePolicies(
  wire: readonly string[],
  model: string,
): readonly [RoutePolicy, RoutePolicy] {
  const wireKey = JSON.stringify(wire);
  return [
    { key: JSON.stringify([wireKey, model]), scope: 'model' },
    { key: wireKey, scope: 'route' },
  ];
}
