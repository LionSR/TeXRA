import { describe, expect, it, vi } from 'vitest';

import { ModelCell, type RunModelHandler } from '@agent/runtime/ModelCell';

function stubHandler(): RunModelHandler & {
  dispose: ReturnType<typeof vi.fn>;
} {
  return { dispose: vi.fn() } as unknown as RunModelHandler & {
    dispose: ReturnType<typeof vi.fn>;
  };
}

/** A cell over a handler stubbed with only the client members under test. */
function clientHandlerCell<C>(handler: object): ModelCell<C> {
  return new ModelCell(
    { dispose: vi.fn(), ...handler } as unknown as RunModelHandler<C>,
    'deepseekT',
  );
}

describe('ModelCell', () => {
  it('moves handler and model id together', () => {
    const first = stubHandler();
    const second = stubHandler();
    const cell = new ModelCell(first, 'deepseekT');

    expect(cell.handler).toBe(first);
    expect(cell.modelId).toBe('deepseekT');

    cell.swap(second, 'sonnet46T');

    expect(cell.handler).toBe(second);
    expect(cell.modelId).toBe('sonnet46T');
  });

  it('is seen live through a spread of the bag that carries it', () => {
    const launch = stubHandler();
    const next = stubHandler();
    const cell = new ModelCell(launch, 'deepseekT');
    // A run's services bag is built by spreading the launch context, which is
    // why a bare handler field had to be re-assigned on every copy.
    const services = { ...{ modelCell: cell }, extra: true };

    cell.swap(next, 'sonnet46T');

    expect(services.modelCell.handler).toBe(next);
    expect(services.modelCell.modelId).toBe('sonnet46T');
  });

  it('disposes every handler it has held exactly once', () => {
    const launch = stubHandler();
    const middle = stubHandler();
    const last = stubHandler();
    const cell = new ModelCell(launch, 'deepseekT');

    cell.swap(middle, 'sonnet46T');
    expect(launch.dispose).toHaveBeenCalledTimes(1);
    expect(middle.dispose).not.toHaveBeenCalled();

    cell.swap(last, 'gpt5T');
    expect(middle.dispose).toHaveBeenCalledTimes(1);

    cell.dispose();
    expect(last.dispose).toHaveBeenCalledTimes(1);
    expect(launch.dispose).toHaveBeenCalledTimes(1);
    expect(middle.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not dispose a handler swapped in over itself', () => {
    const handler = stubHandler();
    const cell = new ModelCell(handler, 'deepseekT');

    cell.swap(handler, 'deepseekT-alias');

    expect(handler.dispose).not.toHaveBeenCalled();
    expect(cell.modelId).toBe('deepseekT-alias');
  });

  it('builds the provider client once and reuses it', async () => {
    const client = { id: 'client' };
    const getClient = vi.fn(async () => client);
    const cell = clientHandlerCell({ getClient });

    await expect(cell.getClient()).resolves.toBe(client);
    await expect(cell.getClient()).resolves.toBe(client);

    expect(getClient).toHaveBeenCalledOnce();
  });

  it('shares one construction between concurrent readers', async () => {
    const client = { id: 'client' };
    const getClient = vi.fn(async () => client);
    const cell = clientHandlerCell({ getClient });

    await expect(
      Promise.all([cell.getClient(), cell.getClient()]),
    ).resolves.toEqual([client, client]);
    expect(getClient).toHaveBeenCalledOnce();
  });

  it('rebuilds after a construction failure instead of caching the rejection', async () => {
    const client = { id: 'client' };
    const getClient = vi
      .fn<() => Promise<typeof client>>()
      .mockRejectedValueOnce(new Error('no credential'))
      .mockResolvedValueOnce(client);
    const cell = clientHandlerCell({ getClient });

    await expect(cell.getClient()).rejects.toThrow('no credential');
    await expect(cell.getClient()).resolves.toBe(client);
  });

  it('builds the next handler its own client after a swap', async () => {
    const first = { id: 'first' };
    const second = { id: 'second' };
    const nextHandler = {
      dispose: vi.fn(),
      getClient: vi.fn(async () => second),
      getCredentialRouteForClient: () => 'api-key' as const,
    };
    const cell = clientHandlerCell({
      getClient: vi.fn(async () => first),
      getCredentialRouteForClient: () => 'relay' as const,
    });

    await expect(cell.getClient()).resolves.toBe(first);
    expect(cell.route).toBe('relay');

    cell.swap(nextHandler as unknown as RunModelHandler, 'sonnet46T');

    // The retired handler owns the client it built, so nothing survives the
    // swap: reading the route before the rebuild must not answer with the
    // retired client's route.
    expect(cell.route).toBeUndefined();
    await expect(cell.getClient()).resolves.toBe(second);
    expect(cell.route).toBe('api-key');
  });

  it('publishes a rebound client to the next reader', async () => {
    const initial = { id: 'initial' };
    const replacement = { id: 'replacement' };
    const refreshClient = vi.fn(async () => replacement);
    const cell = clientHandlerCell({
      getClient: vi.fn(async () => initial),
      refreshClient,
    });

    await expect(cell.getClient()).resolves.toBe(initial);

    await cell.rebind('personal');

    expect(refreshClient).toHaveBeenCalledWith('personal');
    await expect(cell.getClient()).resolves.toBe(replacement);
  });
});
