import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { installDesktopBeforeQuitWiring } from '@desktop/main/desktopWindowLifecycle';
import { createDeferred } from '@test/support/asyncTestUtils';

describe('desktop window lifecycle', () => {
  it('continues a closed-window quit through one shutdown sequence', async () => {
    let listener: ((event: { preventDefault(): void }) => void) | undefined;
    const app = {
      on: vi.fn((_event, handler) => {
        listener = handler;
      }),
      quit: vi.fn(),
    };
    const close = vi.fn();
    let window: { close(): void; isDestroyed(): boolean } | null = {
      close,
      isDestroyed: () => false,
    };
    const sequence: string[] = [];
    const shutdownRan = createDeferred();
    const ranShutdown = vi.fn(() => {
      sequence.push('shutdown');
      shutdownRan.resolve();
    });
    const shutdown = Effect.sync(ranShutdown);
    let continueQuit: (() => void) | undefined;
    const continueAfterWindowClose = vi.fn((continuation: () => void) => {
      continueQuit = continuation;
    });
    installDesktopBeforeQuitWiring({
      app,
      getMainWindow: () => window,
      shutdown,
      continueAfterWindowClose,
    });
    const first = { preventDefault: vi.fn() };
    listener?.(first);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(continueAfterWindowClose).toHaveBeenCalledOnce();
    expect(ranShutdown).not.toHaveBeenCalled();

    window = null;
    continueQuit?.();
    const second = { preventDefault: vi.fn() };
    listener?.(second);
    await shutdownRan.promise;
    expect(ranShutdown).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledTimes(2);
    expect(sequence).toEqual(['shutdown']);

    listener?.({ preventDefault: vi.fn() });
    expect(ranShutdown).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledTimes(2);
  });
});
