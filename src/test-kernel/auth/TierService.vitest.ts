// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - auth
import { TierService } from '@auth/serverKeys/TierService';

interface PendingFetch {
  readonly hasAuth: boolean;
  readonly resolve: (response: Response) => void;
}

function tierConfig(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    providers: ['openai'],
    tiers: {
      free: { models: [] },
      Max: { models: [] },
      Ultra: { models: '*' },
    },
    ...extra,
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function spendingStatus(
  currentSpend: number,
  remaining: number,
  percentUsed: number,
): Record<string, unknown> {
  return { currentSpend, limit: 300, remaining, percentUsed };
}

/** Stubs `fetch` to immediately resolve every call with `data` as JSON. */
function stubFetchResponse(data: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(jsonResponse(data))),
  );
}

/**
 * Stubs `fetch` so each call is captured (with its auth state) and resolves
 * only when the test resolves the matching {@link PendingFetch}.
 */
function stubPendingFetch() {
  const pending: PendingFetch[] = [];
  const fetchMock = vi.fn(
    (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((resolve) => {
        pending.push({
          hasAuth: Boolean(
            (init?.headers as Record<string, string> | undefined)
              ?.Authorization,
          ),
          resolve,
        });
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return { pending, fetchMock };
}

describe('TierService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not let stale anonymous tier fetches clear authenticated spend status', async () => {
    const { pending } = stubPendingFetch();

    const service = new TierService('https://example.test');

    const anonymousConfig = service.getConfig();
    const authenticatedConfig = service.getConfig('token');

    expect(pending.map((request) => request.hasAuth)).toEqual([false, true]);

    pending[1].resolve(
      jsonResponse(tierConfig({ spendingStatus: spendingStatus(300, 0, 100) })),
    );
    await authenticatedConfig;

    expect(service.getSpendingStatus()?.remaining).toBe(0);

    pending[0].resolve(jsonResponse(tierConfig()));
    await anonymousConfig;

    expect(service.getSpendingStatus()?.remaining).toBe(0);
  });

  it('dedupes concurrent fetches for the same auth state', async () => {
    const { pending, fetchMock } = stubPendingFetch();

    const service = new TierService('https://example.test');

    const first = service.getConfig('token');
    const second = service.getConfig('token');
    // Let the synchronous fetch initiation settle before asserting.
    await Promise.resolve();

    // Both callers share a single in-flight request for the same key.
    expect(pending).toHaveLength(1);

    pending[0].resolve(jsonResponse(tierConfig()));

    expect(await first).not.toBeNull();
    expect(await second).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prevents an in-flight auth fetch from repopulating snapshots after clearCache', async () => {
    const { pending } = stubPendingFetch();

    const service = new TierService('https://example.test');

    // Start an auth fetch that will remain in-flight.
    const authPromise = service.getConfig('token');
    // Let the synchronous fetch-initiation and cache-registration settle.
    await Promise.resolve();

    // Sign-out during the fetch — this must abort the signal and reset
    // snapshots so the late-arriving response can't repopulate them.
    service.clearCache();

    // Now resolve the in-flight request with spend data.
    pending[0].resolve(
      jsonResponse(tierConfig({ spendingStatus: spendingStatus(50, 250, 16) })),
    );
    await authPromise;

    // The response was aborted — snapshots must stay null.
    expect(service.getSpendingStatus()).toBeNull();
    expect(service.getConfigSync()).toBeNull();
  });

  it('clears the synchronous snapshots on clearCache', async () => {
    stubFetchResponse(
      tierConfig({ spendingStatus: spendingStatus(100, 200, 33) }),
    );

    const service = new TierService('https://example.test');

    await service.getConfig('token');
    expect(service.getConfigSync()).not.toBeNull();
    expect(service.getSpendingStatus()?.remaining).toBe(200);

    service.clearCache();

    expect(service.getConfigSync()).toBeNull();
    expect(service.getSpendingStatus()).toBeNull();
  });

  it('bypasses the cache when refreshing spending status', async () => {
    let remaining = 0;
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          tierConfig({
            spendingStatus: spendingStatus(
              300 - remaining,
              remaining,
              100 - remaining / 3,
            ),
          }),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new TierService('https://example.test');

    await service.getConfig('token');
    expect(service.getSpendingStatus()?.remaining).toBe(0);

    remaining = 300;
    await service.refreshSpendingStatus('token');

    expect(service.getSpendingStatus()?.remaining).toBe(300);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('parses and reports an authenticated spend-check failure', async () => {
    stubFetchResponse(
      tierConfig({
        spendingStatus: null,
        spendingStatusError: {
          spendCheckFailed: true,
          failureReason: 'usage query unavailable',
          limit: 300,
        },
      }),
    );
    const warn = vi.fn();
    const service = new TierService('https://example.test', { warn });

    expect(await service.getConfig('token')).not.toBeNull();

    expect(service.getSpendingStatus()).toBeNull();
    expect(service.getSpendingStatusError()).toEqual({
      spendCheckFailed: true,
      failureReason: 'usage query unavailable',
      limit: 300,
    });
    expect(warn).toHaveBeenCalledWith(
      'TierService',
      'Relay spend check failed',
      { data: { failureReason: 'usage query unavailable' } },
    );
  });
});
