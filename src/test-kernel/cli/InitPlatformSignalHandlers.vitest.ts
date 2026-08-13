import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LifecycleHost } from '@platform/interfaces';

const mocks = vi.hoisted(() => ({
  flushNdjsonStdout: vi.fn<() => Promise<void>>(),
}));

vi.mock('@cli/runtime/logSinks', () => ({
  flushNdjsonStdout: mocks.flushNdjsonStdout,
  writeTextStderr: vi.fn(),
}));

/** Captures the SIGINT/SIGTERM listeners the runtime installs via `process.once`. */
function captureSignalHandlers(): Map<string, (...args: unknown[]) => void> {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  vi.spyOn(process, 'once').mockImplementation(((
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ) => {
    if (event === 'SIGINT' || event === 'SIGTERM') {
      handlers.set(event, listener);
    }
    return process;
  }) as typeof process.once);
  return handlers;
}

function fakeLifecycle(runShutdown: () => Promise<void>): LifecycleHost {
  return {
    onShutdown: vi.fn(() => ({ dispose: vi.fn() })),
    runShutdown,
  };
}

describe('CLI platform signal handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.flushNdjsonStdout.mockReset();
  });

  it('exits with signal codes after shutdown instead of re-emitting signals', async () => {
    vi.resetModules();
    const handlers = captureSignalHandlers();
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

    const { installCliShutdownSignalHandlers } =
      await import('@cli/runtime/initPlatform');
    installCliShutdownSignalHandlers(fakeLifecycle(runShutdown));

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

  it('handOffCliShutdownSignalHandlers removes exactly the listeners it installed', async () => {
    vi.resetModules();
    const handlers = captureSignalHandlers();
    const removed: Array<[string | symbol, unknown]> = [];
    vi.spyOn(process, 'removeListener').mockImplementation(((
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      removed.push([event, listener]);
      return process;
    }) as typeof process.removeListener);

    const {
      installCliShutdownSignalHandlers,
      handOffCliShutdownSignalHandlers,
    } = await import('@cli/runtime/initPlatform');
    installCliShutdownSignalHandlers(
      fakeLifecycle(vi.fn(async () => undefined)),
    );
    expect(handlers.size).toBe(2);

    handOffCliShutdownSignalHandlers();

    expect(removed).toEqual([
      ['SIGINT', handlers.get('SIGINT')],
      ['SIGTERM', handlers.get('SIGTERM')],
    ]);

    // A second handoff (e.g. a stray second call) is a no-op, not a crash or
    // a spurious removeListener call for listeners already handed off.
    removed.length = 0;
    handOffCliShutdownSignalHandlers();
    expect(removed).toEqual([]);
  });

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
    await runCliPlatformShutdownSequence(fakeLifecycle(runShutdown));
    expect(order).toEqual(['shutdown', 'flush']);

    // Best-effort: a lifecycle shutdown failure must not skip the flush, and
    // an undefined lifecycle (tryPlatform() returning nothing) must not throw.
    order.length = 0;
    const failingRunShutdown = vi.fn(async () => {
      order.push('shutdown');
      throw new Error('shutdown failed');
    });
    await expect(
      runCliPlatformShutdownSequence(fakeLifecycle(failingRunShutdown)),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['shutdown', 'flush']);

    order.length = 0;
    await expect(
      runCliPlatformShutdownSequence(undefined),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['flush']);
  });
});
