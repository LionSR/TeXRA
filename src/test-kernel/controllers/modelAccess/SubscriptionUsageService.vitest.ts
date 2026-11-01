import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Secrets } from '@platform/secrets';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createDeferred } from '@test/support/asyncTestUtils';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
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
 * The suite's one run edge: `getUsage` is a program, and the kernel's fake
 * host installs the process runtime (and its HTTP client) it settles on. The
 * fake `fetch` is provided as the same reference the adapters read, and the
 * coding-plan keys as the process `Secrets`, so nothing has to be threaded
 * through the service to reach the transport or the keys.
 */
function runUsage<A>(
  program: Effect.Effect<A, never, HttpClient.HttpClient | Secrets>,
  http: UsageFetch,
): Promise<A> {
  return testRuntime().runPromise(
    program.pipe(
      Effect.provideService(
        FetchHttpClient.Fetch,
        http as unknown as typeof globalThis.fetch,
      ),
      Effect.provideService(Secrets, new FakeSecrets(CODING_PLAN_KEYS)),
    ),
  );
}

describe('SubscriptionUsageService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps HTTP 401 to invalid credentials without exposing details', async () => {
    const http = vi.fn<UsageFetch>(async () =>
      jsonResponse({ secret: 'must not escape' }, 401),
    );

    const snapshot = await runUsage(makeService().getUsage('kimiCode'), http);
    expect(snapshot).toMatchObject({
      state: 'unavailable',
      reason: 'invalid_credentials',
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  // Pins the return path of an invalidated fetch: the caller
  // already waiting on an invalidated fetch accepts one stale read, but the
  // stale result never enters the cache — later callers see new-account usage.
  it('keeps an invalidated in-flight snapshot out of the cache', async () => {
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

    const oldAccountRequest = runUsage(service.getUsage('kimiCode'), http);
    await firstRequest.promise;
    await runUsage(service.invalidate('kimiCode'), http);
    const newAccountRequest = runUsage(service.getUsage('kimiCode'), http);
    await secondRequest.promise;

    responses[0]?.(jsonResponse({ usage: { limit: 100, remaining: 90 } }));
    responses[1]?.(jsonResponse({ usage: { limit: 100, remaining: 20 } }));

    const [oldCallerSnapshot, newCallerSnapshot] = await Promise.all([
      oldAccountRequest,
      newAccountRequest,
    ]);
    expect(oldCallerSnapshot).toMatchObject({
      windows: [expect.objectContaining({ percentUsed: 10 })],
    });
    expect(newCallerSnapshot).toMatchObject({
      windows: [expect.objectContaining({ percentUsed: 80 })],
    });
    expect(await runUsage(service.getUsage('kimiCode'), http)).toBe(
      newCallerSnapshot,
    );
    expect(http).toHaveBeenCalledTimes(2);
  });
});
