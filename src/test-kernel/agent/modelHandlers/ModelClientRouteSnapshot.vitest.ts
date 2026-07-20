import pDefer from 'p-defer';
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { withModelClient } from '@agent/core/flows/CycleServices';
import type { IModelHandler } from '@agent/types/IModelHandler';

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
});
