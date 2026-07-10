import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LifecycleHost } from '@platform/interfaces';

const mocks = vi.hoisted(() => ({
  flushNdjsonStdout: vi.fn<() => Promise<void>>(),
}));

vi.mock('@cli/runtime/logSinks', () => ({
  flushNdjsonStdout: mocks.flushNdjsonStdout,
  writeTextStderr: vi.fn(),
}));

describe('CLI platform signal handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.flushNdjsonStdout.mockReset();
  });

  it('exits with signal codes after shutdown instead of re-emitting signals', async () => {
    vi.resetModules();
    const handlers = new Map<string, () => unknown>();
    vi.spyOn(process, 'once').mockImplementation(((
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === 'SIGINT' || event === 'SIGTERM') {
        handlers.set(event, () => listener());
      }
      return process;
    }) as typeof process.once);
    const events: string[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code) => {
      events.push(`exit:${code}`);
      return undefined as never;
    }) as typeof process.exit);
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    const runShutdown = vi.fn(async () => {
      events.push('shutdown');
    });
    mocks.flushNdjsonStdout.mockImplementation(async () => {
      events.push('flush');
    });
    const lifecycle: LifecycleHost = {
      onShutdown: vi.fn(() => ({ dispose: vi.fn() })),
      runShutdown,
    };

    const { installCliShutdownSignalHandlers } =
      await import('@cli/runtime/initPlatform');
    installCliShutdownSignalHandlers(lifecycle);

    expect(handlers.has('SIGINT')).toBe(true);
    expect(handlers.has('SIGTERM')).toBe(true);

    await handlers.get('SIGINT')?.();
    expect(exitSpy).toHaveBeenLastCalledWith(130);
    expect(runShutdown).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['shutdown', 'flush', 'exit:130']);

    events.length = 0;
    await handlers.get('SIGTERM')?.();
    expect(exitSpy).toHaveBeenLastCalledWith(143);
    expect(runShutdown).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['shutdown', 'flush', 'exit:143']);
    expect(killSpy).not.toHaveBeenCalled();
  }, 30_000);

  it('runCliPlatformShutdownSequence runs lifecycle shutdown then the NDJSON flush, best-effort', async () => {
    vi.resetModules();
    const order: string[] = [];
    mocks.flushNdjsonStdout.mockImplementation(async () => {
      order.push('flush');
    });
    const { runCliPlatformShutdownSequence } =
      await import('@cli/runtime/initPlatform');

    const runShutdown = vi.fn(async () => {
      order.push('shutdown');
    });
    await runCliPlatformShutdownSequence({
      onShutdown: vi.fn(() => ({ dispose: vi.fn() })),
      runShutdown,
    });
    expect(order).toEqual(['shutdown', 'flush']);

    // Best-effort: a lifecycle shutdown failure must not skip the flush, and
    // an undefined lifecycle (tryPlatform() returning nothing) must not throw.
    order.length = 0;
    const failingRunShutdown = vi.fn(async () => {
      order.push('shutdown');
      throw new Error('shutdown failed');
    });
    await expect(
      runCliPlatformShutdownSequence({
        onShutdown: vi.fn(() => ({ dispose: vi.fn() })),
        runShutdown: failingRunShutdown,
      }),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['shutdown', 'flush']);

    order.length = 0;
    await expect(
      runCliPlatformShutdownSequence(undefined),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['flush']);
  });
});
