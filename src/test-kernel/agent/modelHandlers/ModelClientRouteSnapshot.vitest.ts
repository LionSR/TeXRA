// Third-party imports
import { ModelProvider } from 'llm-zoo';
import pDefer from 'p-defer';
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import type { ModelCell } from '@agent/runtime/ModelCell';
import type { IModelHandler } from '@agent/types/IModelHandler';
import type { ModelCredentialRoute } from '@agent/types/ModelHandlerContracts';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { testModelCell } from '../modelCellTestUtils';
import type { GoogleGenAI } from '@google/genai';

interface TestClient {
  readonly route: 'configured' | 'personal';
}

function cellFor(
  initial: TestClient,
  refreshClient: IModelHandler['refreshClient'],
): ModelCell<TestClient> {
  return testModelCell<TestClient>({
    getClient: vi.fn(async () => initial),
    refreshClient,
  });
}

class CredentialRouteProbe extends ModelHandlerGoogleInteractions {
  // Pin the endpoint so the key assertions exercise identity semantics
  // without dragging base-URL resolution (server-side key service) into a
  // unit test.
  override getRetryEndpoint(): string {
    return 'https://google.test/v1';
  }

  tag(
    client: GoogleGenAI,
    route: ModelCredentialRoute,
    credentialSecret: string,
  ): void {
    this.rememberClientCredentialRoute(client, route, credentialSecret);
  }
}

describe('model client route publication', () => {
  it('keeps the previous route visible until a personal candidate succeeds', async () => {
    const initial = { route: 'configured' } as const;
    const candidate = { route: 'personal' } as const;
    const construction = pDefer<TestClient>();
    const cell = cellFor(
      initial,
      vi.fn(() => construction.promise),
    );
    await cell.getClient();

    const rebind = cell.rebind('personal');
    await expect(cell.getClient()).resolves.toBe(initial);

    construction.resolve(candidate);
    await rebind;
    await expect(cell.getClient()).resolves.toBe(candidate);
  });

  it('leaves the previous route intact when candidate construction fails', async () => {
    const initial = { route: 'configured' } as const;
    const cell = cellFor(
      initial,
      vi.fn(async () => {
        throw new Error('candidate failed');
      }),
    );
    await cell.getClient();

    await expect(cell.rebind('personal')).rejects.toThrow('candidate failed');
    await expect(cell.getClient()).resolves.toBe(initial);
  });

  it('does not construct a candidate when cancellation already won', async () => {
    const initial = { route: 'configured' } as const;
    const refreshClient = vi.fn(async () => ({ route: 'personal' }) as const);
    const cell = cellFor(initial, refreshClient);
    await cell.getClient();
    const controller = new AbortController();
    controller.abort(new Error('cancelled before construction'));

    await expect(cell.rebind('personal', controller.signal)).rejects.toThrow(
      'cancelled before construction',
    );
    expect(refreshClient).not.toHaveBeenCalled();
    await expect(cell.getClient()).resolves.toBe(initial);
  });

  it('does not publish a candidate when cancellation wins after construction', async () => {
    const initial = { route: 'configured' } as const;
    const controller = new AbortController();
    const candidate = { route: 'personal' } as const;
    const cell = cellFor(
      initial,
      vi.fn(async () => {
        controller.abort(new Error('cancelled after construction'));
        return candidate;
      }),
    );
    await cell.getClient();

    await expect(cell.rebind('personal', controller.signal)).rejects.toThrow(
      'cancelled after construction',
    );
    await expect(cell.getClient()).resolves.toBe(initial);
  });

  it('reflects the current client route and rebinds after refresh swaps the client', async () => {
    const initial = { route: 'configured' } as const;
    const candidate = { route: 'personal' } as const;
    const routes = new Map<TestClient, ModelCredentialRoute>([
      [initial, 'openrouter'],
      [candidate, 'api-key'],
    ]);
    const cell = testModelCell<TestClient>({
      getClient: vi.fn(async () => initial),
      refreshClient: vi.fn(async () => candidate),
      getCredentialRouteForClient: vi.fn((client: TestClient) =>
        routes.get(client),
      ),
    });

    await cell.getClient();
    expect(cell.route).toBe('openrouter');

    await cell.rebind('personal');
    await expect(cell.getClient()).resolves.toBe(candidate);
    expect(cell.route).toBe('api-key');
  });

  it('publishes stable wire-route keys without retaining the secret', () => {
    const probe = new CredentialRouteProbe(
      buildTestModelConfig({ provider: ModelProvider.GOOGLE }),
    );
    const first = {} as GoogleGenAI;
    const sameCredential = {} as GoogleGenAI;
    const replacement = {} as GoogleGenAI;
    probe.tag(first, 'api-key', 'secret-a');
    probe.tag(sameCredential, 'api-key', 'secret-a');
    probe.tag(replacement, 'api-key', 'secret-b');

    expect(probe.getCredentialRouteForClient(first)).toBe('api-key');
    // Same credential ⇒ same wire route; a replaced key splits the route.
    expect(probe.getWireRouteKey(first)).toBe(
      probe.getWireRouteKey(sameCredential),
    );
    expect(probe.getWireRouteKey(first)).not.toBe(
      probe.getWireRouteKey(replacement),
    );
    expect(probe.getWireRouteKey(first)).not.toContain('secret-a');
    expect(
      probe.getCredentialRouteForClient({} as GoogleGenAI),
    ).toBeUndefined();
    expect(probe.getWireRouteKey({} as GoogleGenAI)).toContain(
      'unknown-credential',
    );
  });
});
