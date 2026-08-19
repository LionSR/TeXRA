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

/** A cell whose handler builds the given client, plus the construction spy. */
function clientCell<C>(client: C) {
  const getClient = vi.fn(async () => client);
  return { cell: clientHandlerCell<C>({ getClient }), getClient };
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
    const services = { modelCell: cell, extra: true };

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
    const { cell, getClient } = clientCell(client);

    await expect(cell.getClient()).resolves.toBe(client);
    await expect(cell.getClient()).resolves.toBe(client);

    expect(getClient).toHaveBeenCalledOnce();
  });

  it('shares one construction between concurrent readers', async () => {
    const client = { id: 'client' };
    const { cell, getClient } = clientCell(client);

    await expect(
      Promise.all([cell.getClient(), cell.getClient()]),
    ).resolves.toEqual([client, client]);
    expect(getClient).toHaveBeenCalledOnce();
  });

  it('rebuilds after a construction failure instead of caching the rejection', async () => {
    const client = { id: 'client' };
    const { cell, getClient } = clientCell(client);
    getClient
      .mockRejectedValueOnce(new Error('no credential'))
      .mockResolvedValueOnce(client);

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
      getCredentialRouteForClient: () => 'openrouter' as const,
    });

    await expect(cell.getClient()).resolves.toBe(first);
    expect(cell.route).toBe('openrouter');

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

  it('discards a build retired by a mid-flight swap', async () => {
    const oldClient = { id: 'old' };
    const newClient = { id: 'new' };
    let releaseOldBuild!: () => void;
    const oldHandler = {
      dispose: vi.fn(),
      getClient: vi.fn(
        () =>
          new Promise((resolve) => {
            releaseOldBuild = () => resolve(oldClient);
          }),
      ),
    } as unknown as RunModelHandler<{ id: string }>;
    const newHandler = {
      dispose: vi.fn(),
      getClient: vi.fn(async () => newClient),
    } as unknown as RunModelHandler<{ id: string }>;
    const cell = new ModelCell(oldHandler, 'deepseekT');

    // Build starts on the old handler, then an idle model switch lands
    // before it settles.
    const pending = cell.getClient();
    cell.swap(newHandler, 'sonnet46T');
    releaseOldBuild();
    // The stranded caller still gets the client its attempt asked for...
    await expect(pending).resolves.toBe(oldClient);
    // ...but the cell must not pair the retired handler's client with the
    // replacement: the next read builds from the live handler.
    await expect(cell.getClient()).resolves.toBe(newClient);
    expect(cell.handler).toBe(newHandler);
  });
});
