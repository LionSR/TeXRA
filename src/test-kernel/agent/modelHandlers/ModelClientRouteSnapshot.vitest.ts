import { ModelProvider } from 'llm-zoo';
import pDefer from 'p-defer';
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { withModelClient } from '@agent/core/flows/CycleServices';
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/google/modelHandlerGoogleGenAI';
import type { IModelHandler } from '@agent/types/IModelHandler';
import type { ModelCredentialRoute } from '@agent/types/ModelHandlerContracts';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

// Third-party imports
import type { GoogleGenAI } from '@google/genai';

interface TestClient {
  readonly route: 'configured' | 'personal';
}

function handler(
  initial: TestClient,
  refreshClient: IModelHandler['refreshClient'],
): IModelHandler {
  return {
    getClient: vi.fn(async () => initial),
    refreshClient,
  } as unknown as IModelHandler;
}

class CredentialRouteProbe extends ModelHandlerGoogleGenAI {
  tag(client: GoogleGenAI, route: ModelCredentialRoute): void {
    this.rememberClientCredentialRoute(client, route);
  }
}

describe('model client route publication', () => {
  it('keeps the previous route visible until a personal candidate succeeds', async () => {
    const initial = { route: 'configured' } as const;
    const candidate = { route: 'personal' } as const;
    const construction = pDefer<TestClient>();
    const modelHandler = handler(
      initial,
      vi.fn(async () => await construction.promise),
    );
    const services = await withModelClient({}, modelHandler);

    const refresh = services.refreshClient?.('personal');
    expect(services.client).toBe(initial);

    construction.resolve(candidate);
    await refresh;
    expect(services.client).toBe(candidate);
  });

  it('leaves the previous route intact when candidate construction fails', async () => {
    const initial = { route: 'configured' } as const;
    const modelHandler = handler(
      initial,
      vi.fn(async () => {
        throw new Error('candidate failed');
      }),
    );
    const services = await withModelClient({}, modelHandler);

    await expect(services.refreshClient?.('personal')).rejects.toThrow(
      'candidate failed',
    );
    expect(services.client).toBe(initial);
  });

  it('does not construct a candidate when cancellation already won', async () => {
    const initial = { route: 'configured' } as const;
    const refreshClient = vi.fn(async () => ({ route: 'personal' }) as const);
    const services = await withModelClient({}, handler(initial, refreshClient));
    const controller = new AbortController();
    controller.abort(new Error('cancelled before construction'));

    await expect(
      services.refreshClient?.('personal', controller.signal),
    ).rejects.toThrow('cancelled before construction');
    expect(refreshClient).not.toHaveBeenCalled();
    expect(services.client).toBe(initial);
  });

  it('does not publish a candidate when cancellation wins after construction', async () => {
    const initial = { route: 'configured' } as const;
    const controller = new AbortController();
    const candidate = { route: 'personal' } as const;
    const modelHandler = handler(
      initial,
      vi.fn(async () => {
        controller.abort(new Error('cancelled after construction'));
        return candidate;
      }),
    );
    const services = await withModelClient({}, modelHandler);

    await expect(
      services.refreshClient?.('personal', controller.signal),
    ).rejects.toThrow('cancelled after construction');
    expect(services.client).toBe(initial);
  });

  it('reflects the current client route and rebinds after refresh swaps the client', async () => {
    const initial = { route: 'configured' } as const;
    const candidate = { route: 'personal' } as const;
    const routes = new Map<TestClient, ModelCredentialRoute>([
      [initial, 'relay'],
      [candidate, 'api-key'],
    ]);
    const modelHandler = {
      getClient: vi.fn(async () => initial),
      refreshClient: vi.fn(async () => candidate),
      getCredentialRouteForClient: vi.fn((client: TestClient) =>
        routes.get(client),
      ),
    } as unknown as IModelHandler;
    const services = await withModelClient({}, modelHandler);

    expect(services.clientCredentialRoute).toBe('relay');

    await services.refreshClient?.('personal');
    expect(services.client).toBe(candidate);
    expect(services.clientCredentialRoute).toBe('api-key');
  });

  it('returns the captured route for a tagged client and undefined for a foreign one', () => {
    const probe = new CredentialRouteProbe(
      buildTestModelConfig({ provider: ModelProvider.GOOGLE }),
    );
    const tagged = {} as GoogleGenAI;
    probe.tag(tagged, 'relay');

    expect(probe.getCredentialRouteForClient(tagged)).toBe('relay');
    expect(
      probe.getCredentialRouteForClient({} as GoogleGenAI),
    ).toBeUndefined();
  });
});
