/**
 * What the process knows of each subscription plan's quota: the one owner
 * of every read of it, for the runs (the `resources` tool) and the hosts'
 * usage meters alike. A coding plan (Kimi Code, the GLM Coding Plan) is
 * asked at its quota endpoint with its key, the answer kept 30 seconds and
 * one request shared by the readers that ask meanwhile. The ChatGPT plan
 * has no endpoint TeXRA asks: its replies state their quota windows in
 * their headers, which the model transport hands here as each reply
 * arrives ({@link PlanQuotasShape.observing}), so what is known is the last
 * reply's word and when it came. Grok's plan states nothing anywhere this
 * process reads.
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
  chatgptReplyUsage,
  fetchPlanUsage,
  type PlanUsage,
  type PlanUsageRequest,
  type PlanUsageWindow,
} from '@texra-ai/llm/node';

import { logFailure } from '@logger/effectLog';
import { Secrets } from '@platform/secrets';
import { Settings, type SettingsStores } from '@shared/config/settings';
import type { PlanQuotaFailure } from '@shared/model/planQuota';
import { GLM_REGION_SETTING } from '@shared/state/providerSettings';
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

/** How a plan's quota is learned: asked at its endpoint, read off its
 *  replies, or not at all. */
type QuotaSource =
  | {
      readonly endpoint: (
        stores: SettingsStores,
      ) => Effect.Effect<PlanUsageRequest, Error>;
    }
  | {
      readonly reply: (
        headers: Headers,
        receivedAt: number,
      ) => PlanUsage | null;
    }
  | null;

/** Each plan's source, so a plan added to llm does not compile until it
 *  says how its quota is learned. */
const QUOTA_SOURCES = {
  'chatgpt-subscription': { reply: chatgptReplyUsage },
  'xai-subscription': null,
  'kimi-code-subscription': {
    endpoint: () => Effect.succeed({ plan: 'kimiCode' }),
  },
  // The region decides which platform's endpoint is asked.
  'glm-coding-plan-subscription': {
    endpoint: (stores) =>
      Effect.map(Settings.get(stores, GLM_REGION_SETTING), (china) => ({
        plan: 'glm',
        region: china ? 'china' : 'international',
      })),
  },
} as const satisfies Record<PlanRoute, QuotaSource>;

/** One cached endpoint answer: the plan and the request that asks it. */
interface EndpointKey {
  readonly route: PlanRoute;
  readonly request: PlanUsageRequest;
}

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
  '@texra-ai/harness/PlanQuotas',
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
        const source: QuotaSource = QUOTA_SOURCES[route];
        if (source === null) return Effect.succeed({ state: 'unread' });
        if ('reply' in source) {
          const seen = observed.get(route);
          return Effect.succeed(
            seen === undefined
              ? { state: 'unobserved' }
              : { state: 'observed', ...seen },
          );
        }
        return source.endpoint(stores).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) =>
              failed(route, 'request_failed', Cause.squash(cause)),
            onSuccess: (request) => Cache.get(cache, { route, request }),
          }),
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
          const source: QuotaSource =
            plan === null ? null : QUOTA_SOURCES[plan];
          if (plan === null || source === null || !('reply' in source))
            return fetch;
          return async (input, init) => {
            const response = await fetch(input, init);
            const at = clock.currentTimeMillisUnsafe();
            const usage = source.reply(response.headers, at);
            if (usage !== null)
              observed.set(plan, { at, windows: usage.windows });
            return response;
          };
        },
      });
    }),
  );
}

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
  request,
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
        : fetchPlanUsage(request, value),
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
