// Third-party imports
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class<T> {
    private listener: ((value: T) => void) | undefined;
    readonly event = (listener: (value: T) => void) => {
      this.listener = listener;
      return { dispose: vi.fn() };
    };
    fire(value: T): void {
      this.listener?.(value);
    }
  },
}));

// Local imports
import { SupabaseUriHandler } from '@frontend/auth/UriHandler';

describe('SupabaseUriHandler', () => {
  it('forwards desktop and web auth callbacks without rewriting their query', () => {
    const handler = new SupabaseUriHandler();
    const received: Array<{ path: string; query: string }> = [];
    handler.onDidReceiveCallback((uri) => received.push(uri));
    const query =
      'state=a%2Bb%2F%3D&code=one-time-code&app_nonce=0123456789abcdef0123456789abcdef';

    for (const path of ['/auth-callback', '/extension-auth-callback']) {
      handler.handleUri({ path, query } as never);
    }
    handler.handleUri({ path: '/unrelated', query } as never);

    expect(received).toStrictEqual([
      { path: '/auth-callback', query },
      { path: '/extension-auth-callback', query },
    ]);
  });
});
