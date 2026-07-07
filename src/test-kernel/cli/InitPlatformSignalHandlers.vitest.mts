import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LifecycleHost } from '@platform/interfaces';

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('CLI platform signal handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits with signal codes after shutdown instead of re-emitting signals', async () => {
    vi.resetModules();
    const handlers = new Map<string, () => void>();
    vi.spyOn(process, 'once').mockImplementation(((
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === 'SIGINT' || event === 'SIGTERM') {
        handlers.set(event, () => listener());
      }
      return process;
    }) as typeof process.once);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as typeof process.exit);
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    const runShutdown = vi.fn().mockResolvedValue(undefined);
    const lifecycle: LifecycleHost = {
      onShutdown: vi.fn(() => ({ dispose: vi.fn() })),
      runShutdown,
    };

    const { installCliShutdownSignalHandlers } =
      await import('@cli/runtime/initPlatform');
    installCliShutdownSignalHandlers(lifecycle);

    expect(handlers.has('SIGINT')).toBe(true);
    expect(handlers.has('SIGTERM')).toBe(true);

    handlers.get('SIGINT')?.();
    await flushPromises();
    expect(runShutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenLastCalledWith(130);

    handlers.get('SIGTERM')?.();
    await flushPromises();
    expect(runShutdown).toHaveBeenCalledTimes(2);
    expect(exitSpy).toHaveBeenLastCalledWith(143);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
