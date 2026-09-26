import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@test/support/asyncTestUtils';

const mocks = vi.hoisted(() => ({
  flushNdjsonStdout: vi.fn<() => Effect.Effect<void>>(),
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
    mocks.flushNdjsonStdout.mockImplementation(() =>
      Effect.sync(() => {
        events.push('flush');
      }),
    );

    // No platform came up in this module instance, so the shutdown the
    // sequence runs first is a no-op; the flush and exit still follow.
    const { installCliShutdownSignalHandlers } =
      await import('@cli/runtime/initPlatform');
    installCliShutdownSignalHandlers();

    expect(handlers.has('SIGINT')).toBe(true);
    expect(handlers.has('SIGTERM')).toBe(true);

    await handlers.get('SIGINT')?.();
    expect(exitSpy).toHaveBeenLastCalledWith(130);
    expect(events).toEqual(['flush', 'exit:130']);

    events.length = 0;
    await handlers.get('SIGTERM')?.();
    expect(exitSpy).toHaveBeenLastCalledWith(143);
    expect(events).toEqual(['flush', 'exit:143']);
    expect(killSpy).not.toHaveBeenCalled();
  }, 30_000);

  it('defers SIGINT while a foreground command owns the terminal', async () => {
    vi.resetModules();
    vi.doMock('@cli/runtime/foregroundCommand', async (importOriginal) => ({
      ...(await importOriginal<
        typeof import('@cli/runtime/foregroundCommand')
      >()),
      terminalForegroundHeld: () => true,
    }));
    const handlers = captureSignalHandlers();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as typeof process.exit);
    mocks.flushNdjsonStdout.mockImplementation(() => Effect.void);

    const { installCliShutdownSignalHandlers } =
      await import('@cli/runtime/initPlatform');
    installCliShutdownSignalHandlers();
    const sigint = handlers.get('SIGINT');
    handlers.delete('SIGINT');

    await sigint?.();

    // The pager (or installer) gets the Ctrl-C; the CLI keeps running and
    // listens again, so the next SIGINT reaches it.
    expect(mocks.flushNdjsonStdout).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(handlers.get('SIGINT')).toBe(sigint);
    vi.doUnmock('@cli/runtime/foregroundCommand');
  });

  it('waits for persistent stderr writes before shutdown resolves', async () => {
    vi.resetModules();
    const order: string[] = [];
    const stderrCallbacks: Array<(error?: Error | null) => void> = [];
    const secondWriteCaptured = createDeferred();
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(((
      ...args: unknown[]
    ) => {
      const callback = args.find(
        (arg): arg is (error?: Error | null) => void =>
          typeof arg === 'function',
      );
      if (callback) {
        stderrCallbacks.push(callback);
        if (stderrCallbacks.length === 2) secondWriteCaptured.resolve();
      }
      return true;
    }) as typeof process.stderr.write);
    mocks.flushNdjsonStdout.mockImplementation(() =>
      Effect.sync(() => {
        order.push('ndjson');
      }),
    );
    const { runCliPlatformShutdownSequence } =
      await import('@cli/runtime/initPlatform');
    const { writeTextStderr } = await import('@cli/runtime/logSinks');
    // A diagnostic written as the process goes down, still in flight when
    // the sequence starts.
    writeTextStderr('shutdown diagnostic');

    let resolved = false;
    const shutdown = runCliPlatformShutdownSequence().then(() => {
      resolved = true;
    });
    await secondWriteCaptured.promise;

    expect(stderrWrite.mock.calls.map(([text]) => text)).toEqual([
      'shutdown diagnostic\n',
      '',
    ]);
    expect(order).toEqual([]);
    expect(resolved).toBe(false);

    stderrCallbacks[0]?.();
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(resolved).toBe(false);

    stderrCallbacks[1]?.();
    await shutdown;
    expect(order).toEqual(['ndjson']);
    expect(resolved).toBe(true);
  });

  it('runCliPlatformShutdownSequence still flushes NDJSON with no platform up', async () => {
    vi.resetModules();
    const order: string[] = [];
    mocks.flushNdjsonStdout.mockImplementation(() =>
      Effect.sync(() => {
        order.push('flush');
      }),
    );
    const { runCliPlatformShutdownSequence } =
      await import('@cli/runtime/initPlatform');

    await expect(runCliPlatformShutdownSequence()).resolves.toBeUndefined();
    expect(order).toEqual(['flush']);
  });
});
