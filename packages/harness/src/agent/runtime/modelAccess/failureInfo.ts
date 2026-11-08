/**
 * What a failed model call means to the person and to the retry gate. llm
 * judges every vendor failure (`ModelError`'s kind, `retryable`, `scope`,
 * `retryAfterMs`, `quota`); model access fails with `RouteUnavailable`.
 * A run records either as its verdict (`modelFailureOf`); this module reads
 * the route's own failure out of llm's and the scope the gate cools.
 */
import { ModelError } from '@texra-ai/llm';

import type { RoutePolicy } from '@agent/runtime/ModelRetryGate';
import { RouteUnavailable } from '@common/errors/agentErrors';

/** Why a model call failed: the vendor's verdict, or no route to send it on. */
export type CallFailure = ModelError | RouteUnavailable;

/**
 * A call's failure as its route words it: a subscription session that
 * failed inside a request (its token could not be read or renewed) comes
 * back through llm as an `authentication` failure caused by the route's
 * own {@link RouteUnavailable}, which says what to do; any other failure is
 * itself.
 */
export const routeFailureOf = (error: CallFailure): CallFailure =>
  error instanceof ModelError && error.cause instanceof RouteUnavailable
    ? error.cause
    : error;

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
