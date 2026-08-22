// Node imports
import { EventEmitter } from 'node:events';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketError } from 'openai/resources/responses/internal-base';

// Local imports
import { OpenAIResponseWebSocketTransport } from '@agent/modelHandlers/openai/OpenAIResponseWebSocketTransport';
import type { ResponseStreamProcessor } from '@agent/modelHandlers/openai/ResponseStreamProcessor';
import { detectSdkErrorMetadata } from '@common/errors/sdkError/errorMetadata';
import { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
import { spiedTrace } from '@test/support/spiedTrace';

// Third-party type imports
import type OpenAI from 'openai';

const WS_OPEN = 1;

const { createdSockets, socketControl } = vi.hoisted(() => ({
  createdSockets: [] as InstanceType<typeof FakeResponsesWS>[],
  socketControl: { nextReadyState: 1 },
}));

class FakeSocket extends EventEmitter {
  readyState = socketControl.nextReadyState;
  platformSocket = { terminate: vi.fn(), ping: vi.fn() };
  close = vi.fn();
}

// Mirrors the surface OpenAIResponseWebSocketTransport touches on the real
// `ResponsesWS`: a top-level emitter for connection-scoped events
// (`error`, `event`, `response.*`) plus a nested `.socket` for handshake and
// raw-connection state. Constructed already OPEN so `getOrCreateWebSocket`
// resolves synchronously without needing to wait for an `'open'` event.
class FakeResponsesWS extends EventEmitter {
  socket = new FakeSocket();
  send = vi.fn();
  close = vi.fn();

  constructor() {
    super();
    this.socket.on('error', (cause: Error) => {
      const error = new WebSocketError(cause.message, null);
      error.cause = cause;
      this.emit('error', error);
    });
  }
}

vi.mock('openai/resources/responses/ws', () => ({
  ResponsesWS: class {
    constructor() {
      const ws = new FakeResponsesWS();
      createdSockets.push(ws);
      return ws;
    }
  },
}));

interface TransportInternals {
  wsConnection: FakeResponsesWS | null;
  getOrCreateWebSocket(
    client: OpenAI,
    signal?: AbortSignal,
  ): Promise<FakeResponsesWS>;
  executeViaWebSocket(
    ws: FakeResponsesWS,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

function internals(
  transport: OpenAIResponseWebSocketTransport,
): TransportInternals {
  return transport as unknown as TransportInternals;
}

function createTransport(): OpenAIResponseWebSocketTransport {
  const processor = {
    abort: vi.fn(),
    process: vi.fn(),
  } as unknown as ResponseStreamProcessor;
  return new OpenAIResponseWebSocketTransport({
    logger: spiedTrace(),
    createStreamProcessor: vi.fn(() => processor),
  });
}

const fakeClient = {} as unknown as OpenAI;

async function connectTransport(): Promise<{
  transport: OpenAIResponseWebSocketTransport;
  ws: FakeResponsesWS;
}> {
  const transport = createTransport();
  const ws = await internals(transport).getOrCreateWebSocket(fakeClient);
  return { transport, ws };
}

describe('OpenAIResponseWebSocketTransport idle connection errors', () => {
  beforeEach(() => {
    createdSockets.length = 0;
    socketControl.nextReadyState = WS_OPEN;
  });

  it('handles a forwarded 401 handshake error as non-retryable authentication', async () => {
    socketControl.nextReadyState = 0;
    const transport = createTransport();
    const connection = internals(transport).getOrCreateWebSocket(fakeClient);
    const ws = createdSockets[0]!;
    const error = new Error('Unexpected server response: 401');

    // The SDK's raw-socket listener runs first and forwards the failure to the
    // top-level emitter. The transport must already guard that emitter so this
    // raw event still reaches its handshake listener instead of escaping.
    expect(() => ws.socket.emit('error', error)).not.toThrow();

    await expect(connection).rejects.toBe(error);
    expect(detectSdkErrorMetadata(error)).toMatchObject({
      kind: 'authentication',
      statusCode: 401,
    });
    expect(normalizeProviderError(error)).toMatchObject({
      statusCode: 401,
      userRetryable: false,
    });
    expect(ws.close).toHaveBeenCalledOnce();
  });

  it('falls back to the canonical response status when structured data is out of range', async () => {
    socketControl.nextReadyState = 0;
    const transport = createTransport();
    const connection = internals(transport).getOrCreateWebSocket(fakeClient);
    const ws = createdSockets[0]!;
    const error = Object.assign(new Error('Unexpected server response: 401'), {
      code: 1006,
    });

    ws.socket.emit('error', error);

    await expect(connection).rejects.toBe(error);
    expect(detectSdkErrorMetadata(error)).toMatchObject({
      kind: 'authentication',
      statusCode: 401,
    });
  });

  it('rejects when only the top-level emitter reports a handshake error', async () => {
    socketControl.nextReadyState = 0;
    const transport = createTransport();
    const connection = internals(transport).getOrCreateWebSocket(fakeClient);
    const ws = createdSockets[0]!;
    const error = new WebSocketError('handshake failed', null);

    ws.emit('error', error);

    await expect(connection).rejects.toBe(error);
    expect(detectSdkErrorMetadata(error)?.kind).toBe('connection');
    expect(ws.close).toHaveBeenCalledOnce();
  });

  it('does not crash the process when the pooled connection errors with no request in flight', async () => {
    const { ws } = await connectTransport();

    // Node throws synchronously on `emit('error', ...)` when the emitter has
    // zero 'error' listeners — this is exactly the unhandled-rejection crash
    // observed in production (`websocket_connection_limit_reached` firing on
    // an idle connection between requests). A persistent listener bound at
    // connection time must prevent that.
    expect(() =>
      ws.emit('error', new WebSocketError('connection limit reached', null)),
    ).not.toThrow();
  });

  it('invalidates the connection so the next execute() reconnects', async () => {
    const { transport, ws: first } = await connectTransport();
    expect(internals(transport).wsConnection).toBe(first);

    first.emit('error', new WebSocketError('connection limit reached', null));

    expect(internals(transport).wsConnection).toBeNull();
    expect(first.socket.platformSocket.terminate).toHaveBeenCalled();

    const second = await internals(transport).getOrCreateWebSocket(fakeClient);
    expect(second).not.toBe(first);
    expect(createdSockets).toHaveLength(2);
  });

  it('keeps late errors on an orphan isolated from a later connection', async () => {
    const { transport, ws: first } = await connectTransport();

    transport.dispose();
    const second = await internals(transport).getOrCreateWebSocket(fakeClient);

    expect(() =>
      first.emit('error', new WebSocketError('late orphan error', null)),
    ).not.toThrow();
    expect(internals(transport).wsConnection).toBe(second);
    expect(second.socket.platformSocket.terminate).not.toHaveBeenCalled();
  });

  it('preserves the request error when closing emits synchronously', async () => {
    const { transport, ws } = await connectTransport();
    ws.close.mockImplementation(() => {
      ws.socket.emit('close', 1006, Buffer.from('closed'));
    });

    const request = internals(transport).executeViaWebSocket(ws, {});
    const error = new WebSocketError('request failed', null);
    ws.emit('error', error);

    await expect(request).rejects.toBe(error);
    expect(detectSdkErrorMetadata(error)?.kind).toBe('connection');
  });

  it('preserves structured provider errors while invalidating the socket', async () => {
    // Classification and invalidation are independent: a structured API error
    // keeps its own code (no connection kind, no route cooling), but the
    // server may refuse further service on this socket without closing it, so
    // the cached connection is dropped and the next execute() reconnects.
    const { transport, ws } = await connectTransport();
    const request = internals(transport).executeViaWebSocket(ws, {});
    const error = new WebSocketError('invalid request', {
      type: 'error',
      code: 'invalid_request_error',
      message: 'invalid request',
      param: null,
      sequence_number: 1,
    });

    ws.emit('error', error);

    await expect(request).rejects.toBe(error);
    expect(detectSdkErrorMetadata(error)).toBeUndefined();
    expect(normalizeProviderError(error).statusCode).toBe(400);
    expect(internals(transport).wsConnection).toBeNull();
  });

  it('tags an unexpected in-flight socket close as a connection failure', async () => {
    const { transport, ws } = await connectTransport();
    const request = internals(transport).executeViaWebSocket(ws, {});

    ws.socket.emit('close', 1006, Buffer.from('idle timeout'));

    const error = await request.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(detectSdkErrorMetadata(error)?.kind).toBe('connection');
  });
});
