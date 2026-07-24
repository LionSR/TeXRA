// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  undiciFetch: vi.fn(),
  getGlobalDispatcher: vi.fn(),
}));

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: transportMocks.undiciFetch,
    getGlobalDispatcher: transportMocks.getGlobalDispatcher,
  };
});

// Local imports
import {
  installLongRunningModelFetch,
  longRunningModelFetch,
} from '@platform/defaults/longRunningModelTransport';

// Type imports
import type { Dispatcher } from 'undici';

const nativeFetch = globalThis.fetch;

describe('long-running model transport', () => {
  afterEach(() => {
    globalThis.fetch = nativeFetch;
    vi.clearAllMocks();
  });

  it('applies long timeouts through the host dispatcher for a native Request', async () => {
    const baseDispatch = vi.fn(() => true);
    let timeoutDispatcher: Dispatcher | undefined;
    const dispatcher = {
      compose: vi.fn(
        (
          interceptor: (
            dispatch: Dispatcher['dispatch'],
          ) => Dispatcher['dispatch'],
        ) => {
          timeoutDispatcher = {
            dispatch: interceptor(baseDispatch as Dispatcher['dispatch']),
          } as Dispatcher;
          return timeoutDispatcher;
        },
      ),
    } as unknown as Dispatcher;
    transportMocks.getGlobalDispatcher.mockReturnValue(dispatcher);
    const response = new Response(null, { status: 204 });
    transportMocks.undiciFetch.mockResolvedValueOnce(response);
    const request = new Request('https://openrouter.example/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test': 'value' },
      body: JSON.stringify({ prompt: 'hello' }),
    });

    await expect(longRunningModelFetch(request)).resolves.toBe(response);

    const [input, init] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    expect(input).toBe('https://openrouter.example/v1/chat');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test': 'value' },
      dispatcher: timeoutDispatcher,
    });
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(
      JSON.stringify({ prompt: 'hello' }),
    );
    timeoutDispatcher?.dispatch(
      { method: 'GET', origin: 'https://example.test', path: '/' },
      {} as never,
    );
    expect(baseDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyTimeout: 30 * 60 * 1000,
        headersTimeout: 10 * 60 * 1000,
      }),
      expect.anything(),
    );
  });

  it('installs the timeout-aware fetch for SDKs without an injection seam', () => {
    installLongRunningModelFetch();

    expect(globalThis.fetch).toBe(longRunningModelFetch);
  });
});
