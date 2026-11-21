import { layer } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { afterEach, expect, vi } from 'vitest';

import { PlanQuotas } from '@agent/runtime/modelAccess/planQuotas';
import { Secrets } from '@texra-ai/harness/plugins';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import type { HttpClient } from 'effect/http';

/** The request the endpoint reads make through `FetchHttpClient.Fetch`. */
type UsageFetch = (url: string | URL, init: RequestInit) => Promise<Response>;

/** The API keys the coding-plan reads take out of secret storage. */
const CODING_PLAN_KEYS = {
  'apiKey.kimiCode': 'kimiCode-secret',
  'apiKey.glm': 'glm-secret',
};

const stores = makeFakeSettingsStores().stores;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The suite's one run edge: a read is a program over the process's HTTP
 * client, which takes the fake `fetch` provided here as the reference it
 * consults per request, and the coding-plan keys as the process `Secrets`.
 */
function usage<A>(
  program: Effect.Effect<A, never, HttpClient.HttpClient | Secrets>,
  http: UsageFetch,
): Effect.Effect<A, never, HttpClient.HttpClient> {
  return program.pipe(
    Effect.provideService(
      FetchHttpClient.Fetch,
      // cast: the reads only call it; the fake has none of fetch's statics.
      http as unknown as typeof globalThis.fetch,
    ),
    Effect.provideService(Secrets, new FakeSecrets(CODING_PLAN_KEYS)),
  );
}

// Live clock: the in-flight requests run in real time. Each case builds its
// own quotas, so no answer one caches reaches another.
layer(FetchHttpClient.layer, { excludeTestServices: true })(
  'PlanQuotas',
  (it) => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.effect(
      'maps HTTP 401 to invalid credentials without exposing details',
      () =>
        Effect.gen(function* () {
          const http = vi.fn<UsageFetch>(async () =>
            jsonResponse({ secret: 'must not escape' }, 401),
          );
          const quotas = yield* PlanQuotas;
          const quota = yield* usage(
            quotas.read('kimi-code-subscription', stores),
            http,
          );
          expect(quota).toMatchObject({
            state: 'failed',
            reason: 'invalid_credentials',
          });
          expect(JSON.stringify(quota)).not.toContain('secret');
        }).pipe(Effect.provide(PlanQuotas.layer)),
    );

    // Pins the return path of an invalidated fetch: the caller
    // already waiting on an invalidated fetch accepts one stale read, but the
    // stale result never enters the cache — later callers see new-account usage.
    it.effect('keeps an invalidated in-flight answer out of the cache', () =>
      Effect.gen(function* () {
        const responses: Array<(response: Response) => void> = [];
        const firstRequest = Promise.withResolvers<void>();
        const secondRequest = Promise.withResolvers<void>();
        const http = vi.fn<UsageFetch>(
          () =>
            new Promise<Response>((resolve) => {
              (responses.length === 0 ? firstRequest : secondRequest).resolve();
              responses.push(resolve);
            }),
        );
        const quotas = yield* PlanQuotas;
        const read = quotas.read('kimi-code-subscription', stores);

        const oldAccountRequest = yield* Effect.forkChild(usage(read, http));
        yield* Effect.promise(() => firstRequest.promise);
        yield* quotas.invalidate('kimi-code-subscription');
        const newAccountRequest = yield* Effect.forkChild(usage(read, http));
        yield* Effect.promise(() => secondRequest.promise);

        responses[0]?.(jsonResponse({ usage: { limit: 100, remaining: 90 } }));
        responses[1]?.(jsonResponse({ usage: { limit: 100, remaining: 20 } }));

        const oldCallerQuota = yield* Fiber.join(oldAccountRequest);
        const newCallerQuota = yield* Fiber.join(newAccountRequest);
        expect(oldCallerQuota).toMatchObject({
          windows: [expect.objectContaining({ percentUsed: 10 })],
        });
        expect(newCallerQuota).toMatchObject({
          windows: [expect.objectContaining({ percentUsed: 80 })],
        });
        expect(yield* usage(read, http)).toBe(newCallerQuota);
        expect(http).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(PlanQuotas.layer)),
    );
  },
);
