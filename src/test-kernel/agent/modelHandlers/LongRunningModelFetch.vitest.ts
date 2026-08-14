// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { FormData as UndiciFormData, type Dispatcher } from 'undici';

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
import { longRunningModelFetch } from '@platform/defaults/longRunningModelTransport';

interface ComposedDispatcherStub {
  readonly baseDispatch: Dispatcher['dispatch'];
  composed?: Dispatcher;
}

function stubComposedDispatcher(): ComposedDispatcherStub {
  const stub: ComposedDispatcherStub = {
    baseDispatch: vi.fn(() => true) as unknown as Dispatcher['dispatch'],
  };
  transportMocks.getGlobalDispatcher.mockReturnValue({
    compose: vi.fn(
      (
        interceptor: (
          dispatch: Dispatcher['dispatch'],
        ) => Dispatcher['dispatch'],
      ) => {
        stub.composed = {
          dispatch: interceptor(stub.baseDispatch),
        } as Dispatcher;
        return stub.composed;
      },
    ),
  } as unknown as Dispatcher);
  return stub;
}

describe('long-running model transport', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('applies long timeouts through the host dispatcher for a native Request', async () => {
    const stub = stubComposedDispatcher();
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
      dispatcher: stub.composed,
    });
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(
      JSON.stringify({ prompt: 'hello' }),
    );
    expect(init?.duplex).toBeUndefined();
    stub.composed?.dispatch(
      { method: 'GET', origin: 'https://example.test', path: '/' },
      {} as never,
    );
    expect(stub.baseDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyTimeout: 30 * 60 * 1000,
        headersTimeout: 10 * 60 * 1000,
      }),
      expect.anything(),
    );
  });

  it('translates OpenAI multipart uploads for package Undici', async () => {
    transportMocks.getGlobalDispatcher.mockReturnValue({
      compose: vi.fn().mockReturnValue({}),
    } as unknown as Dispatcher);
    transportMocks.undiciFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: 'transcribed text' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new OpenAI({
      apiKey: 'test-key',
      fetch: longRunningModelFetch,
    });

    const result = await client.audio.transcriptions.create({
      file: new File(['audio'], 'recording.wav', { type: 'audio/wav' }),
      model: 'gpt-4o-transcribe',
    });

    expect(result.text).toBe('transcribed text');
    const [, init] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    expect(init?.body).toBeInstanceOf(UndiciFormData);
    expect(init?.duplex).toBeUndefined();
  });

  it('does not set duplex on a direct string body', async () => {
    stubComposedDispatcher();
    transportMocks.undiciFetch.mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );

    await expect(
      longRunningModelFetch('https://api.example/v1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"prompt":"hello"}',
      }),
    ).resolves.toBeInstanceOf(Response);

    const [, init] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    expect(init?.body).toBe('{"prompt":"hello"}');
    expect(init?.duplex).toBeUndefined();
  });

  it('does not set duplex on a direct ArrayBuffer body', async () => {
    stubComposedDispatcher();
    transportMocks.undiciFetch.mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );
    const body = new TextEncoder().encode('{"prompt":"hello"}').buffer;

    await expect(
      longRunningModelFetch('https://api.example/v1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    ).resolves.toBeInstanceOf(Response);

    const [, init] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    expect(init?.body).toBe(body);
    expect(init?.duplex).toBeUndefined();
  });

  it('sets duplex: half when a caller sends a stream body without it', async () => {
    stubComposedDispatcher();
    transportMocks.undiciFetch.mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":true}'));
        controller.close();
      },
    });

    await expect(
      longRunningModelFetch('https://api.example/v1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    ).resolves.toBeInstanceOf(Response);

    const [, init] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    expect(init?.body).toBe(body);
    expect(init?.duplex).toBe('half');
  });

  it('preserves an explicit duplex value on a streamed body', async () => {
    stubComposedDispatcher();
    transportMocks.undiciFetch.mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    await longRunningModelFetch('https://api.example/v1/chat', {
      method: 'POST',
      body,
      // Provider SDKs already set this; do not overwrite it.
      duplex: 'half',
    } as RequestInit);

    const [, init] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    expect(init?.duplex).toBe('half');
  });

  it('sets duplex: half for a stream-like body that is not a same-realm ReadableStream', async () => {
    stubComposedDispatcher();
    transportMocks.undiciFetch.mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );
    const body = {
      pipeTo: async () => undefined,
    };

    await expect(
      longRunningModelFetch('https://api.example/v1/chat', {
        method: 'POST',
        body: body as unknown as ReadableStream,
      }),
    ).resolves.toBeInstanceOf(Response);

    const [, init] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    expect(init?.body).toBe(body);
    expect(init?.duplex).toBe('half');
    expect(body instanceof ReadableStream).toBe(false);
  });
});
