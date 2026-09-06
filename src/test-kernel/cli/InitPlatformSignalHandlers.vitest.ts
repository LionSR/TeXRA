import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LifecycleHost } from '@platform/interfaces';

const mocks = vi.hoisted(() => ({
  flushNdjsonStdout: vi.fn<() => Promise<void>>(),
}));

vi.mock('@cli/runtime/logSinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/logSinks')>()),
  flushNdjsonStdout: mocks.flushNdjsonStdout,
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
  let shutdownRan = false;
  return {
    onShutdown: vi.fn(() => ({ dispose: vi.fn() })),
    runShutdown: () => {
      shutdownRan = true;
      return runShutdown();
    },
    get shutdownRan() {
      return shutdownRan;
    },
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

    // The install-order disposers are released LIFO, so SIGTERM first.
    expect(removed).toEqual([
      ['SIGTERM', handlers.get('SIGTERM')],
      ['SIGINT', handlers.get('SIGINT')],
    ]);

    // A second handoff (e.g. a stray second call) is a no-op, not a crash or
    // a spurious removeListener call for listeners already handed off.
    removed.length = 0;
    handOffCliShutdownSignalHandlers();
    expect(removed).toEqual([]);
  });

  it('waits for persistent stderr writes before shutdown resolves', async () => {
    vi.resetModules();
    const order: string[] = [];
    const stderrCallbacks: Array<(error?: Error | null) => void> = [];
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(((
      ...args: unknown[]
    ) => {
      const callback = args.find(
        (arg): arg is (error?: Error | null) => void =>
          typeof arg === 'function',
      );
      if (callback) stderrCallbacks.push(callback);
      return true;
    }) as typeof process.stderr.write);
    mocks.flushNdjsonStdout.mockImplementation(async () => {
      order.push('ndjson');
    });
    const { runCliPlatformShutdownSequence } =
      await import('@cli/runtime/initPlatform');
    const { writeTextStderr } = await import('@cli/runtime/logSinks');
    const runShutdown = vi.fn(async () => {
      order.push('shutdown');
      writeTextStderr('lifecycle diagnostic');
    });

    let resolved = false;
    const shutdown = runCliPlatformShutdownSequence(
      fakeLifecycle(runShutdown),
    ).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(stderrCallbacks).toHaveLength(2));

    expect(stderrWrite.mock.calls.map(([text]) => text)).toEqual([
      'lifecycle diagnostic\n',
      '',
    ]);
    expect(order).toEqual(['shutdown']);
    expect(resolved).toBe(false);

    stderrCallbacks[0]?.();
    await Promise.resolve();
    expect(order).toEqual(['shutdown']);
    expect(resolved).toBe(false);

    stderrCallbacks[1]?.();
    await shutdown;
    expect(order).toEqual(['shutdown', 'ndjson']);
    expect(resolved).toBe(true);
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
