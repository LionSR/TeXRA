import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as codexAuth from '@texra-ai/llm/node';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settings';
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

/**
 * The stored ChatGPT session the service reads through `codexCoordinator`,
 * which is the only ChatGPT credential source now that the service builds its
 * own credential reads over the secret store it was handed.
 */
function stubCodexSession(
  overrides: {
    readonly loadSession?: () => Effect.Effect<unknown, unknown>;
    readonly getFreshSession?: () => Effect.Effect<unknown, unknown>;
    readonly refreshRejected?: () => Effect.Effect<void, unknown>;
  } = {},
): void {
  vi.spyOn(codexAuth, 'codexCoordinator').mockReturnValue({
    loadSession:
      overrides.loadSession ??
      (() => Effect.succeed({ accessToken: 'chatgpt-secret' })),
    getFreshSession:
      overrides.getFreshSession ??
      (() =>
        Effect.succeed({
          accessToken: 'chatgpt-secret',
          accountId: 'account-123',
        })),
    refreshRejected: overrides.refreshRejected ?? (() => Effect.void),
  } as never);
}

function makeService(
  options: {
    readonly secrets?: PlatformSecrets;
    readonly stores?: SettingsStores;
    readonly requestTimeoutMs?: number;
  } = {},
): SubscriptionUsageService {
  return new SubscriptionUsageService({
    secrets: options.secrets ?? new FakeSecrets(CODING_PLAN_KEYS),
    stores: options.stores ?? makeFakeSettingsStores().stores,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });
}

/**
 * The suite's one run edge: `getUsage` is a program, and the kernel's fake
 * host installs the process runtime (and its HTTP client) it settles on. The
 * fake `fetch` is provided as the same reference the adapters read, so nothing
 * has to be threaded through the service to reach the transport.
 */
function runUsage<A>(
  program: Effect.Effect<A, never, HttpClient.HttpClient>,
  http: UsageFetch,
): Promise<A> {
  return testRuntime().runPromise(
    Effect.provideService(
      program,
      FetchHttpClient.Fetch,
      http as unknown as typeof globalThis.fetch,
    ),
  );
}

describe('SubscriptionUsageService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([['chatgpt' as const, 401]])(
    'maps %s HTTP %s to invalid credentials without exposing details',
    async (provider, status) => {
      let accessToken = 'chatgpt-secret';
      stubCodexSession({
        getFreshSession: () => Effect.sync(() => ({ accessToken })),
        refreshRejected: () =>
          Effect.sync(() => {
            accessToken = 'chatgpt-refreshed';
          }),
      });
      const http = vi.fn<UsageFetch>(async () =>
        jsonResponse({ secret: 'must not escape' }, status),
      );

      const snapshot = await runUsage(makeService().getUsage(provider), http);
      expect(snapshot).toMatchObject({
        state: 'unavailable',
        reason: 'invalid_credentials',
      });
      expect(JSON.stringify(snapshot)).not.toContain('secret');
      // A ChatGPT 401 is retried once, on the refreshed token.
      if (provider === 'chatgpt') {
        expect(
          http.mock.calls.map(
            ([, init]) =>
              (init.headers as Record<string, string>).authorization,
          ),
        ).toStrictEqual(['Bearer chatgpt-secret', 'Bearer chatgpt-refreshed']);
      }
    },
  );

  it('normalizes malformed bodies and HTTP failures without exposing details', async () => {
    stubCodexSession();
    const malformed = vi.fn<UsageFetch>(async () =>
      jsonResponse({ rate_limit: { primary_window: { used_percent: 'bad' } } }),
    );
    await expect(
      runUsage(makeService().getUsage('chatgpt'), malformed),
    ).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'malformed_response',
    });

    const invalidJson = vi.fn<UsageFetch>(
      async () => new Response('{', { status: 200 }),
    );
    await expect(
      runUsage(makeService().getUsage('kimiCode'), invalidJson),
    ).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'malformed_response',
    });

    const failed = vi.fn<UsageFetch>(async () =>
      jsonResponse({ secret: 'must not escape' }, 500),
    );
    const snapshot = await runUsage(
      makeService().getUsage('glmCodingPlan'),
      failed,
    );
    expect(snapshot).toMatchObject({
      state: 'unavailable',
      reason: 'request_failed',
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
