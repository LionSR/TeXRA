// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - auth
import { TierService } from '@auth/tier/TierService';

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

describe('TierService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not let stale anonymous tier fetches clear authenticated spend status', async () => {
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

    const service = new TierService('https://example.test');

    const anonymousConfig = service.getConfig();
    const authenticatedConfig = service.getConfig('token');

    expect(pending.map((request) => request.hasAuth)).toEqual([false, true]);

    pending[1].resolve(
      jsonResponse(
        tierConfig({
          spendingStatus: {
            currentSpend: 300,
            limit: 300,
            remaining: 0,
            percentUsed: 100,
          },
        }),
      ),
    );
    await authenticatedConfig;

    expect(service.getSpendingStatus()?.remaining).toBe(0);

    pending[0].resolve(jsonResponse(tierConfig()));
    await anonymousConfig;

    expect(service.getSpendingStatus()?.remaining).toBe(0);
  });
});
