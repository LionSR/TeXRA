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

  it('routes classic streamGenerateContent through the timeout-aware transport', async () => {
    const baseDispatch = vi.fn(() => true);
    let timeoutDispatcher: Dispatcher | undefined;
    transportMocks.getGlobalDispatcher.mockReturnValue({
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
    } as unknown as Dispatcher);
    const priorFetch = vi.fn();
    globalThis.fetch = priorFetch as typeof fetch;
    const response = new Response(null, { status: 200 });
    transportMocks.undiciFetch.mockResolvedValueOnce(response);

    installLongRunningModelFetch();
    const result = await globalThis.fetch(
      'https://relay.example/custom/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse',
      { method: 'POST', body: '{}' },
    );

    expect(result).toBe(response);
    expect(priorFetch).not.toHaveBeenCalled();
    expect(transportMocks.undiciFetch).toHaveBeenCalledOnce();
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

  it('delegates unrelated requests without changing their inputs or response', async () => {
    const response = new Response('delegated');
    const priorFetch = vi.fn().mockResolvedValueOnce(response);
    globalThis.fetch = priorFetch as typeof fetch;
    const request = new Request('https://example.test/upload');
    const form = new FormData();
    form.append('file', new Blob(['contents']), 'paper.tex');
    const init: RequestInit = { method: 'POST', body: form };

    installLongRunningModelFetch();
    const result = await globalThis.fetch(request, init);

    expect(priorFetch).toHaveBeenCalledOnce();
    expect(priorFetch).toHaveBeenCalledWith(request, init);
    expect(result).toBe(response);
    expect(transportMocks.undiciFetch).not.toHaveBeenCalled();
  });

  it('does not stack routing wrappers when installed repeatedly', async () => {
    const response = new Response(null, { status: 204 });
    const priorFetch = vi.fn().mockResolvedValue(response);
    globalThis.fetch = priorFetch as typeof fetch;

    installLongRunningModelFetch();
    const firstInstalledFetch = globalThis.fetch;
    installLongRunningModelFetch();

    expect(globalThis.fetch).toBe(firstInstalledFetch);
    await globalThis.fetch('https://example.test/status');
    expect(priorFetch).toHaveBeenCalledOnce();
  });

  it('wraps a newly installed host fetch without delegating to its old wrapper', async () => {
    const firstHostFetch = vi.fn();
    globalThis.fetch = firstHostFetch as typeof fetch;
    installLongRunningModelFetch();
    const oldRoutingFetch = globalThis.fetch;
    const response = new Response('new owner');
    const replacementHostFetch = vi.fn().mockResolvedValueOnce(response);
    globalThis.fetch = replacementHostFetch as typeof fetch;

    installLongRunningModelFetch();
    const result = await globalThis.fetch('https://example.test/replaced');

    expect(globalThis.fetch).not.toBe(oldRoutingFetch);
    expect(replacementHostFetch).toHaveBeenCalledOnce();
    expect(firstHostFetch).not.toHaveBeenCalled();
    expect(result).toBe(response);
  });
});
