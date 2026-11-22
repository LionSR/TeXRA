/**
 * What the process knows of each subscription plan's quota: the one owner
 * of every read of it, for the runs (the `resources` tool) and the hosts'
 * usage meters alike. Where a plan states its quota is llm's fact
 * (`PLAN_QUOTA_SOURCES`). A plan with a quota endpoint is asked there with
 * its key, on its region's platform, the answer kept 30 seconds and one
 * request shared by the readers that ask meanwhile. A plan whose replies
 * state their quota windows in their headers has them handed here as each
 * reply arrives ({@link PlanQuotasShape.observing}), so what is known is
 * the last reply's word and when it came.
 */
import { Cache, Cause, Clock, Context, Duration, Effect, Layer } from 'effect';
import { HttpClientError } from 'effect/http';
import type { HttpClient } from 'effect/http';
import {
  apiKey,
  isAuthFailureStatus,
  PLAN_ROUTES,
  type PlanRoute,
} from '@texra-ai/llm';
import {
  type EndpointPlanRoute,
  fetchPlanUsage,
  PLAN_QUOTA_SOURCES,
  type PlanUsageWindow,
  type ProviderRegion,
  replyPlanUsage,
  type ReplyPlanRoute,
} from '@texra-ai/llm/node';

import { logFailure } from '@logger/effectLog';
import { Secrets } from '@platform/secrets';
import { Settings, type SettingsStores } from '@shared/config/settings';
import type { PlanQuotaFailure } from '@shared/model/planQuota';
import { providerRegionSetting } from '@shared/state/providerSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'PlanQuotas';

/** How long an endpoint's answer serves before the next read asks again. */
const ENDPOINT_TTL = Duration.seconds(30);

/**
 * What is known of one plan's quota now. `at` is when it was learned, in
 * epoch milliseconds: an endpoint's answer when it came, a reply's when it
 * arrived, which may be long ago when no request was made since.
 */
export type PlanQuota =
  /** The plan's quota endpoint answered. */
  | {
      readonly state: 'read';
      readonly at: number;
      /** The plan's tier as the provider names it, when it says. */
      readonly planName?: string;
      readonly windows: readonly PlanUsageWindow[];
    }
  /** The plan's quota endpoint gave no windows. */
  | {
      readonly state: 'failed';
      readonly at: number;
      readonly reason: PlanQuotaFailure;
    }
  /** A reply on the plan stated its windows. */
  | {
      readonly state: 'observed';
      readonly at: number;
      readonly windows: readonly PlanUsageWindow[];
    }
  /** The plan's replies state its quota, and none has in this process. */
  | { readonly state: 'unobserved' }
  /** Nothing this process reads states the plan's quota. */
  | { readonly state: 'unread' };

/** One cached endpoint answer: the plan and the platform its key is for. */
interface EndpointKey {
  readonly route: EndpointPlanRoute;
  readonly region: ProviderRegion;
}

/** The platform `route`'s key belongs to: its provider's region toggle, or
 *  `international` for a provider with one platform. */
const planRegion = (
  route: EndpointPlanRoute,
  stores: SettingsStores,
): Effect.Effect<ProviderRegion, Error> => {
  const row = providerRegionSetting(PLAN_ROUTES[route].provider);
  return row === undefined
    ? Effect.succeed('international')
    : Effect.map(Settings.get(stores, row), (china) =>
        china ? 'china' : 'international',
      );
};

/** The process's plan quotas. */
export interface PlanQuotasShape {
  /** What is known of `route`'s quota now, asked of its endpoint with the
   *  key and settings `stores` hold when the cached answer has expired. A
   *  failure is the answer's `failed` state, logged here, never the
   *  read's. */
  readonly read: (
    route: PlanRoute,
    stores: SettingsStores,
  ) => Effect.Effect<PlanQuota, never, HttpClient.HttpClient | Secrets>;
  /** Drop `route`'s cached and in-flight answers (every plan's when
   *  omitted), so the next read asks: after its key or account changed, or
   *  a person's refresh. A reader already waiting still gets its answer,
   *  which is not cached. */
  readonly invalidate: (route?: PlanRoute) => Effect.Effect<void>;
  /** `fetch` for requests billed to `plan`: when the plan's replies state
   *  its quota, each reply's word is recorded as it arrives; otherwise
   *  `fetch` itself. */
  readonly observing: (
    plan: PlanRoute | null,
    fetch: typeof globalThis.fetch,
  ) => typeof globalThis.fetch;
}

/** The process's plan quotas ({@link PlanQuotasShape}). */
export class PlanQuotas extends Context.Service<PlanQuotas, PlanQuotasShape>()(
  '@texra-ai/worldline/PlanQuotas',
) {
  static readonly layer: Layer.Layer<PlanQuotas> = Layer.effect(
    PlanQuotas,
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const observed = new Map<
        PlanRoute,
        { readonly at: number; readonly windows: readonly PlanUsageWindow[] }
      >();
      const cache = yield* Cache.makeWith(
        (key: EndpointKey) => askEndpoint(key),
        {
          capacity: 16,
          timeToLive: () => ENDPOINT_TTL,
          requireServicesAt: 'lookup',
        },
      );
      const read: PlanQuotasShape['read'] = (route, stores) => {
        if (isEndpointPlan(route))
          return planRegion(route, stores).pipe(
            Effect.matchCauseEffect({
              onFailure: (cause) =>
                failed(route, 'request_failed', Cause.squash(cause)),
              onSuccess: (region) => Cache.get(cache, { route, region }),
            }),
          );
        if (PLAN_QUOTA_SOURCES[route] === null)
          return Effect.succeed({ state: 'unread' });
        const seen = observed.get(route);
        return Effect.succeed(
          seen === undefined
            ? { state: 'unobserved' }
            : { state: 'observed', ...seen },
        );
      };
      return PlanQuotas.of({
        read,
        invalidate: Effect.fn('PlanQuotas.invalidate')(function* (route) {
          for (const key of [...(yield* Cache.keys(cache))])
            if (route === undefined || key.route === route)
              yield* Cache.invalidate(cache, key);
        }),
        observing: (plan, fetch) => {
          if (plan === null || !isReplyPlan(plan)) return fetch;
          return async (input, init) => {
            const response = await fetch(input, init);
            const at = clock.currentTimeMillisUnsafe();
            const usage = replyPlanUsage(plan, response.headers, at);
            if (usage !== null)
              observed.set(plan, { at, windows: usage.windows });
            return response;
          };
        },
      });
    }),
  );
}

const isEndpointPlan = (route: PlanRoute): route is EndpointPlanRoute =>
  PLAN_QUOTA_SOURCES[route] === 'endpoint';

const isReplyPlan = (route: PlanRoute): route is ReplyPlanRoute =>
  PLAN_QUOTA_SOURCES[route] === 'reply';

/** A failed endpoint read's answer, its cause logged once here. An
 *  `HttpClientError` carries its request, the plan's key in its headers, so
 *  only its reason is logged. */
const failed = (route: PlanRoute, reason: PlanQuotaFailure, error: unknown) =>
  Effect.gen(function* () {
    const http = HttpClientError.isHttpClientError(error)
      ? error.reason
      : undefined;
    yield* logFailure(
      CHANNEL,
      `The ${route} quota read failed: ${http === undefined ? toErrorMessage(error) : http._tag}`,
    )(
      http === undefined
        ? error
        : {
            reason: http._tag,
            status:
              http._tag === 'StatusCodeError'
                ? http.response.status
                : undefined,
          },
    );
    return {
      state: 'failed',
      at: yield* Clock.currentTimeMillis,
      reason,
    } satisfies PlanQuota;
  });

/** Ask a coding plan's endpoint with the key `Secrets` holds. */
const askEndpoint = ({
  route,
  region,
}: EndpointKey): Effect.Effect<
  PlanQuota,
  never,
  HttpClient.HttpClient | Secrets
> =>
  Effect.flatMap(Secrets, (secrets) =>
    apiKey(secrets, PLAN_ROUTES[route].provider),
  ).pipe(
    Effect.flatMap(({ value }) =>
      value === undefined
        ? Effect.succeed(null)
        : fetchPlanUsage(route, region, value),
    ),
    Effect.flatMap(
      Effect.fnUntraced(function* (usage) {
        const at = yield* Clock.currentTimeMillis;
        if (usage === null)
          return {
            state: 'failed',
            at,
            reason: 'missing_credentials',
          } satisfies PlanQuota;
        if (usage.windows.length === 0)
          return yield* failed(
            route,
            'malformed_response',
            new Error('The answer named no usage window.'),
          );
        return {
          state: 'read',
          at,
          ...(usage.planName !== undefined && { planName: usage.planName }),
          windows: usage.windows,
        } satisfies PlanQuota;
      }),
    ),
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      const http = HttpClientError.isHttpClientError(error)
        ? error.reason
        : undefined;
      return failed(
        route,
        isAuthFailureStatus(
          http?._tag === 'StatusCodeError' ? http.response.status : undefined,
        )
          ? 'invalid_credentials'
          : http?._tag === 'DecodeError' && http.cause instanceof SyntaxError
            ? 'malformed_response'
            : 'request_failed',
        error,
      );
    }),
  );
