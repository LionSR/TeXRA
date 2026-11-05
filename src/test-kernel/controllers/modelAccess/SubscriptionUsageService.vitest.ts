import { layer } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { afterEach, expect, vi } from 'vitest';

import { Secrets } from '@texra-ai/harness/host';
import { createDeferred } from '@test/support/asyncTestUtils';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { SessionGraph } from '@test/support/testKernel';
import { SubscriptionUsageService } from '@texra/controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import type { HttpClient } from 'effect/http';

/** The request the adapters make through `FetchHttpClient.Fetch`. */
type UsageFetch = (url: string | URL, init: RequestInit) => Promise<Response>;

/** The API keys the coding-plan adapters read out of secret storage. */
const CODING_PLAN_KEYS = {
  'apiKey.kimiCode': 'kimiCode-secret',
  'apiKey.glm': 'glm-secret',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeService(): SubscriptionUsageService {
  return new SubscriptionUsageService({
    stores: makeFakeSettingsStores().stores,
  });
}

/**
 * The suite's one run edge: `getUsage` is a program over the process
 * services, whose HTTP client reads the fake `fetch` provided here as the
 * reference the adapters consult per request, and the coding-plan keys as
 * the process `Secrets`, so nothing has to be threaded through the service
 * to reach the transport or the keys.
 */
function usage<A>(
  program: Effect.Effect<A, never, HttpClient.HttpClient | Secrets>,
  http: UsageFetch,
): Effect.Effect<A, never, HttpClient.HttpClient> {
  return program.pipe(
    Effect.provideService(
      FetchHttpClient.Fetch,
      // cast: the adapters only call it; the fake has none of fetch's statics.
      http as unknown as typeof globalThis.fetch,
    ),
    Effect.provideService(Secrets, new FakeSecrets(CODING_PLAN_KEYS)),
  );
}

// Live clock: the adapters' retries and the in-flight requests run in real
// time.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'SubscriptionUsageService',
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

          const snapshot = yield* usage(
            makeService().getUsage('kimiCode'),
            http,
          );
          expect(snapshot).toMatchObject({
            state: 'unavailable',
            reason: 'invalid_credentials',
          });
          expect(JSON.stringify(snapshot)).not.toContain('secret');
        }),
    );

    // Pins the return path of an invalidated fetch: the caller
    // already waiting on an invalidated fetch accepts one stale read, but the
    // stale result never enters the cache — later callers see new-account usage.
    it.effect('keeps an invalidated in-flight snapshot out of the cache', () =>
      Effect.gen(function* () {
        const responses: Array<(response: Response) => void> = [];
        const firstRequest = createDeferred<void>();
        const secondRequest = createDeferred<void>();
        const http = vi.fn<UsageFetch>(
          () =>
            new Promise<Response>((resolve) => {
              (responses.length === 0 ? firstRequest : secondRequest).resolve();
              responses.push(resolve);
            }),
        );
        const service = makeService();

        const oldAccountRequest = yield* Effect.forkChild(
          usage(service.getUsage('kimiCode'), http),
        );
        yield* Effect.promise(() => firstRequest.promise);
        yield* usage(service.invalidate('kimiCode'), http);
        const newAccountRequest = yield* Effect.forkChild(
          usage(service.getUsage('kimiCode'), http),
        );
        yield* Effect.promise(() => secondRequest.promise);

        responses[0]?.(jsonResponse({ usage: { limit: 100, remaining: 90 } }));
        responses[1]?.(jsonResponse({ usage: { limit: 100, remaining: 20 } }));

        const oldCallerSnapshot = yield* Fiber.join(oldAccountRequest);
        const newCallerSnapshot = yield* Fiber.join(newAccountRequest);
        expect(oldCallerSnapshot).toMatchObject({
          windows: [expect.objectContaining({ percentUsed: 10 })],
        });
        expect(newCallerSnapshot).toMatchObject({
          windows: [expect.objectContaining({ percentUsed: 80 })],
        });
        expect(yield* usage(service.getUsage('kimiCode'), http)).toBe(
          newCallerSnapshot,
        );
        expect(http).toHaveBeenCalledTimes(2);
      }),
    );
  },
);
