import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    installCliShutdownSignalHandlers(false);

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
});
