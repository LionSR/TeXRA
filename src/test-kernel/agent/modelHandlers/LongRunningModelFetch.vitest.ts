// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelProvider } from 'llm-zoo';
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
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import type { ResolvedClientCredential } from '@agent/types/ModelHandlerContracts';
import {
  longRunningGoogleInteractionsFetch,
  longRunningModelFetch,
} from '@platform/defaults/longRunningModelTransport';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import type { GoogleGenAI } from '@google/genai';

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

/** Compose the dispatcher and queue one 204 response — the boilerplate every
 * wire-shape assertion below needs before making its call. */
function stubOkResponse(): void {
  stubComposedDispatcher();
  transportMocks.undiciFetch.mockResolvedValueOnce(
    new Response(null, { status: 204 }),
  );
}

class GoogleTransportProbe extends ModelHandlerGoogleInteractions {
  protected override async resolveClientCredential(): Promise<ResolvedClientCredential> {
    return {
      apiKey: 'test-key',
      baseUrl: null,
      route: 'api-key',
    };
  }
}

async function createGoogleTransportClient(): Promise<GoogleGenAI> {
  const handler = new GoogleTransportProbe(
    buildTestModelConfig({
      name: 'google-transport-probe',
      label: 'Google transport probe',
      fullName: 'gemini-test',
      shortName: 'gemini-test',
      provider: ModelProvider.GOOGLE,
      contextWindow: 4096,
    }),
  );
  return handler.getClient();
}

function stubGoogleBody(
  path: string,
  options: { body?: string; signal?: AbortSignal } = {},
) {
  const input = new Request(
    `https://generativelanguage.googleapis.com/${path}`,
    options.signal ? { signal: options.signal } : undefined,
  );
  const addListener = vi.spyOn(input.signal, 'addEventListener');
  const removeListener = vi.spyOn(input.signal, 'removeEventListener');
  const sourceCancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (options.body === undefined) return;
        controller.enqueue(new TextEncoder().encode(options.body));
        controller.close();
      },
      cancel: sourceCancel,
    }),
  );
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  return { input, addListener, removeListener, sourceCancel };
}

describe('long-running model transport', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  it('enforces header and body-inactivity deadlines at the pinned Google SDK fetch boundary', async () => {
    vi.useFakeTimers();
    const client = await createGoogleTransportClient();
    const requests: Request[] = [];
    let resolveLongHeaders: ((response: Response) => void) | undefined;
    let longBody: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const request = input as Request;
      requests.push(request);
      if (requests.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(request.signal.reason),
            { once: true },
          );
        });
      }
      if (requests.length === 2) {
        return new Promise<Response>((resolve) => {
          resolveLongHeaders = resolve;
        });
      }
      if (requests.length === 3) {
        return Promise.resolve(
          new Response(new ReadableStream<Uint8Array>(), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        );
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const params = {
      model: 'gemini-test',
      input: [
        {
          type: 'user_input' as const,
          content: [{ type: 'text' as const, text: 'hello' }],
        },
      ],
      stream: false as const,
    };
    const options = { maxRetries: 0 };

    const missingHeaders = client.interactions.create(params, options);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const headerRejection = expect(missingHeaders).rejects.toThrow();
    expect(requests[0]).toBeInstanceOf(Request);
    expect(fetchMock.mock.calls[0]).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(requests[0].signal.reason).toMatchObject({ name: 'TimeoutError' });
    await headerRejection;

    const longUnary = client.interactions.create(params, options);
    let longUnarySettled = false;
    void longUnary.then(
      () => {
        longUnarySettled = true;
      },
      () => {
        longUnarySettled = true;
      },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        longBody = controller;
      },
    });
    resolveLongHeaders?.(
      new Response(body, {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    longBody?.enqueue(new TextEncoder().encode('{"id":'));
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    longBody?.enqueue(new TextEncoder().encode('"int_long",'));
    expect(longUnarySettled).toBe(false);
    expect(requests[1].signal.aborted).toBe(false);

    longBody?.enqueue(
      new TextEncoder().encode('"status":"completed","outputs":[]}'),
    );
    longBody?.close();
    await expect(longUnary).resolves.toMatchObject({
      id: 'int_long',
      status: 'completed',
    });

    const inactiveBody = client.interactions.create(params, options);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const inactivityRejection = expect(inactiveBody).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(requests[2].signal.reason).toMatchObject({ name: 'TimeoutError' });
    await inactivityRejection;

    const callerAbort = new AbortController();
    const dispatcherMarker = {};
    const userCancelled = client.interactions.create(params, {
      maxRetries: 0,
      fetchOptions: {
        signal: callerAbort.signal,
        dispatcher: dispatcherMarker,
      } as RequestInit,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const finalRequest = requests[3] as Request & { dispatcher?: unknown };
    expect(finalRequest).toBeInstanceOf(Request);
    expect(fetchMock.mock.calls[3]).toHaveLength(1);
    expect(finalRequest.dispatcher).toBeUndefined();

    const userCancellationRejection = expect(userCancelled).rejects.toThrow();
    const reason = new DOMException('cancelled by user', 'AbortError');
    callerAbort.abort(reason);
    expect(finalRequest.signal.aborted).toBe(true);
    expect(finalRequest.signal.reason).toBe(reason);
    await userCancellationRejection;
  });

  it('cleans up after normal source stream consumption', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const { input, addListener, removeListener, sourceCancel } = stubGoogleBody(
      'success',
      { body: '{"ok":true}', signal: caller.signal },
    );

    const response = await longRunningGoogleInteractionsFetch(input);
    await expect(response.json()).resolves.toEqual({ ok: true });

    expect(addListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledOnce();
    expect(sourceCancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up its timer and caller abort listener after fetch failure', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const input = new Request(
      'https://generativelanguage.googleapis.com/fetch-failure',
      { signal: caller.signal },
    );
    const addListener = vi.spyOn(input.signal, 'addEventListener');
    const removeListener = vi.spyOn(input.signal, 'removeEventListener');
    const failure = new Error('fetch failed');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));

    await expect(longRunningGoogleInteractionsFetch(input)).rejects.toBe(
      failure,
    );

    expect(addListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the source reader and cleans up after a body timeout', async () => {
    vi.useFakeTimers();
    const { input, removeListener, sourceCancel } =
      stubGoogleBody('body-timeout');

    const response = await longRunningGoogleInteractionsFetch(input);
    const body = response.text();
    const rejection = expect(body).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await rejection;
    await vi.waitFor(() => expect(sourceCancel).toHaveBeenCalledOnce());

    expect(removeListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the source reader and cleans up when the caller aborts during the body', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const { input, removeListener, sourceCancel } = stubGoogleBody(
      'abort-body',
      {
        signal: caller.signal,
      },
    );

    const response = await longRunningGoogleInteractionsFetch(input);
    const body = response.text();
    const rejection = expect(body).rejects.toMatchObject({
      name: 'AbortError',
    });
    const reason = new DOMException('caller cancelled', 'AbortError');
    caller.abort(reason);
    await rejection;
    await vi.waitFor(() => expect(sourceCancel).toHaveBeenCalledWith(reason));

    expect(removeListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the source reader and cleans up when the consumer cancels the stream', async () => {
    vi.useFakeTimers();
    const { input, removeListener, sourceCancel } =
      stubGoogleBody('cancel-stream');

    const response = await longRunningGoogleInteractionsFetch(input);
    const reason = new Error('consumer stopped');
    await response.body?.cancel(reason);

    expect(sourceCancel).toHaveBeenCalledWith(reason);
    expect(removeListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('routes every Google Interactions request through the long-running HTTP seam', async () => {
    vi.useFakeTimers();
    const client = await createGoogleTransportClient();
    const interactions = client.interactions as unknown as {
      getClient(apiVersion?: string): {
        _httpClient: { request(request: Request): Promise<Response> };
      };
    };
    const installedGetClient = interactions.getClient.bind(interactions);
    const routeClients: Array<{
      apiVersion: string | undefined;
      request: ReturnType<typeof vi.fn>;
    }> = [];
    interactions.getClient = (apiVersion?: string) => {
      const sdk = installedGetClient(apiVersion);
      expect(sdk._httpClient.request).toBe(longRunningGoogleInteractionsFetch);
      const request = vi.spyOn(sdk._httpClient, 'request');
      routeClients.push({ apiVersion, request });
      return sdk;
    };

    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const request = input as Request;
        requests.push(request);
        if (requests.length === 1) {
          return new Response(
            'data: {"event_type":"interaction.completed","interaction":{"id":"streamed","status":"completed","outputs":[]}}\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        const responses = [
          { id: 'created', status: 'completed' },
          { id: 'retrieved', status: 'completed' },
          { id: 'cancelled', status: 'cancelled' },
        ];
        return new Response(
          JSON.stringify({ ...responses[requests.length - 2], outputs: [] }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const stream = await client.interactions.create(
      { model: 'gemini-test', input: [], stream: true },
      { maxRetries: 0 },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    await expect(
      client.interactions.create(
        {
          model: 'gemini-test',
          input: [],
          stream: false,
          api_version: 'v1alpha',
        },
        { maxRetries: 0 },
      ),
    ).resolves.toMatchObject({ id: 'created', status: 'completed' });
    await expect(
      client.interactions.get('retrieved', {}, { maxRetries: 0 }),
    ).resolves.toMatchObject({ id: 'retrieved', status: 'completed' });
    await expect(
      client.interactions.cancel('cancelled', {}, { maxRetries: 0 }),
    ).resolves.toMatchObject({ id: 'cancelled', status: 'cancelled' });

    expect(events).toEqual([
      expect.objectContaining({ event_type: 'interaction.completed' }),
    ]);
    expect(routeClients.map(({ apiVersion }) => apiVersion)).toEqual([
      undefined,
      'v1alpha',
      undefined,
      undefined,
    ]);
    expect(
      routeClients.map(({ request }) => request.mock.calls.length),
    ).toEqual([1, 1, 1, 1]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/v1beta/interactions',
      '/v1alpha/interactions',
      '/v1beta/interactions/retrieved',
      '/v1beta/interactions/cancelled/cancel',
    ]);
    expect(vi.getTimerCount()).toBe(0);
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
    stubOkResponse();

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
    stubOkResponse();
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
    stubOkResponse();
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
    stubOkResponse();
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
    stubOkResponse();
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

  // A Request built in a worker thread fails `instanceof Request`; these
  // duck-typed stand-ins share no brand with the global and so exercise the
  // same structural path (#10298's stream scenario, one check up).
  function foreignRequest(overrides: Record<string, unknown>): Request {
    return {
      url: 'https://openrouter.example/v1/chat',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      redirect: 'follow',
      signal: new AbortController().signal,
      body: null,
      arrayBuffer: vi.fn(),
      ...overrides,
    } as unknown as Request;
  }

  it('rebuilds a cross-realm Request from primitives instead of forwarding it', async () => {
    stubOkResponse();
    const request = foreignRequest({});
    expect(request instanceof Request).toBe(false);

    await expect(longRunningModelFetch(request)).resolves.toBeInstanceOf(
      Response,
    );

    const [input, init] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    expect(input).toBe('https://openrouter.example/v1/chat');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'follow',
    });
    expect(init?.body).toBeUndefined();
    expect(request.arrayBuffer).not.toHaveBeenCalled();
  });

  it('reads a cross-realm Request body through its own arrayBuffer', async () => {
    stubOkResponse();
    const bytes = new TextEncoder().encode('{"prompt":"hello"}').buffer;
    const request = foreignRequest({
      // The foreign stream itself cannot cross realms; its bytes can.
      body: { pipeTo: async () => undefined },
      arrayBuffer: vi.fn().mockResolvedValue(bytes),
    });

    await longRunningModelFetch(request);

    const [, init] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    expect(request.arrayBuffer).toHaveBeenCalledOnce();
    expect(init?.body).toBe(bytes);
    expect(init?.duplex).toBeUndefined();
  });

  it('lets init fields win over a cross-realm Request', async () => {
    stubOkResponse();
    const request = foreignRequest({ method: 'GET' });

    await longRunningModelFetch(request, {
      method: 'PUT',
      headers: new Headers({ 'x-override': 'yes' }),
      body: '{"prompt":"override"}',
    });

    const [, init] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    expect(init).toMatchObject({
      method: 'PUT',
      headers: { 'x-override': 'yes' },
      body: '{"prompt":"override"}',
    });
    expect(request.arrayBuffer).not.toHaveBeenCalled();
  });

  it('forwards the duplex hint when an init stream body overrides a Request', async () => {
    stubOkResponse();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    await longRunningModelFetch(foreignRequest({ method: 'GET' }), {
      method: 'POST',
      body,
    });

    const [, init] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    expect(init?.body).toBe(body);
    expect(init?.duplex).toBe('half');
  });

  it('passes array-form init headers through untransformed', async () => {
    stubOkResponse();
    const headers: [string, string][] = [
      ['content-type', 'application/json'],
      ['x-tuple', 'yes'],
    ];

    await longRunningModelFetch(foreignRequest({}), { headers });

    const [, init] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    // The tuple form is legal HeadersInit; flattening must not mistake the
    // array's own index/value entries() for a Headers iterator.
    expect(init?.headers).toBe(headers);
  });

  it('keeps the input body when the init body is null', async () => {
    stubOkResponse();
    const bytes = new TextEncoder().encode('{"prompt":"kept"}').buffer;
    const request = foreignRequest({
      body: { pipeTo: async () => undefined },
      arrayBuffer: vi.fn().mockResolvedValue(bytes),
    });

    // Fetch retains the input Request's body for a null init body; only a
    // non-null body overrides.
    await longRunningModelFetch(request, { body: null });

    const [, init] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    expect(request.arrayBuffer).toHaveBeenCalledOnce();
    expect(init?.body).toBe(bytes);
  });

  it('detaches on a null signal but inherits an omitted one', async () => {
    stubComposedDispatcher();
    transportMocks.undiciFetch.mockResolvedValue(
      new Response(null, {
        status: 204,
      }),
    );
    const controller = new AbortController();
    controller.abort();
    const request = foreignRequest({ signal: controller.signal });

    await longRunningModelFetch(request, { signal: null });
    await longRunningModelFetch(request);

    const [, detachedInit] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    const [, inheritedInit] = transportMocks.undiciFetch.mock.calls[1] ?? [];
    expect(detachedInit?.signal).toBeNull();
    expect(inheritedInit?.signal).toBe(request.signal);
  });

  it('replaces the input headers wholesale when init supplies headers', async () => {
    stubOkResponse();
    const request = foreignRequest({
      headers: new Headers({ 'x-input': 'dropped', 'x-also-input': 'gone' }),
    });

    // `new Request(input, init)` empties the copied header list before filling
    // it from init.headers — the rebuild keeps that parity rather than
    // merging per key.
    await longRunningModelFetch(request, { headers: { 'x-init': 'only' } });

    const [, init] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    expect(init?.headers).toStrictEqual({ 'x-init': 'only' });
  });
});
