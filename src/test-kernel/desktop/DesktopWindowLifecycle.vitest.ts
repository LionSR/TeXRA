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
    const shutdownRan = createDeferred();
    const ranShutdown = vi.fn(() => {
      shutdownRan.resolve();
    });
    const shutdown = Effect.sync(ranShutdown);
    let continueQuit: (() => void) | undefined;
    installDesktopBeforeQuitWiring({
      app,
      getMainWindow: () => window,
      shutdown,
      continueAfterWindowClose: (continuation) => {
        continueQuit = continuation;
      },
    });
    listener?.({ preventDefault: vi.fn() });
    expect(close).toHaveBeenCalledOnce();
    expect(ranShutdown).not.toHaveBeenCalled();

    window = null;
    continueQuit?.();
    listener?.({ preventDefault: vi.fn() });
    await shutdownRan.promise;
    expect(app.quit).toHaveBeenCalledTimes(2);

    listener?.({ preventDefault: vi.fn() });
    expect(ranShutdown).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledTimes(2);
  });
});
