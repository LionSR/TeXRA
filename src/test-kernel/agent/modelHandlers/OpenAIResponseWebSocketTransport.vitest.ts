import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WebSocketError } from 'openai/resources/responses/internal-base';
import type { AgentTrace } from '@agent/trace';
import { OpenAIResponseWebSocketTransport } from '@agent/modelHandlers/openai/OpenAIResponseWebSocketTransport';

import type OpenAI from 'openai';

const WS_OPEN = 1;

const { createdSockets } = vi.hoisted(() => ({
  createdSockets: [] as InstanceType<typeof FakeResponsesWS>[],
}));

class FakeSocket extends EventEmitter {
  readyState = WS_OPEN;
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

function createLogger(): AgentTrace {
  return {
    streamId: 'test',
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    domain: vi.fn(),
  } as unknown as AgentTrace;
}

interface TransportInternals {
  wsConnection: FakeResponsesWS | null;
  getOrCreateWebSocket(
    client: OpenAI,
    signal?: AbortSignal,
  ): Promise<FakeResponsesWS>;
}

function internals(
  transport: OpenAIResponseWebSocketTransport,
): TransportInternals {
  return transport as unknown as TransportInternals;
}

function createTransport(): OpenAIResponseWebSocketTransport {
  return new OpenAIResponseWebSocketTransport({
    logger: createLogger(),
    createStreamProcessor: vi.fn(),
  });
}

const fakeClient = {} as unknown as OpenAI;

describe('OpenAIResponseWebSocketTransport idle connection errors', () => {
  beforeEach(() => {
    createdSockets.length = 0;
  });

  it('does not crash the process when the pooled connection errors with no request in flight', async () => {
    const transport = createTransport();
    const ws = await internals(transport).getOrCreateWebSocket(fakeClient);

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
    const transport = createTransport();
    const first = await internals(transport).getOrCreateWebSocket(fakeClient);
    expect(internals(transport).wsConnection).toBe(first);

    first.emit('error', new WebSocketError('connection limit reached', null));

    expect(internals(transport).wsConnection).toBeNull();
    expect(first.socket.platformSocket.terminate).toHaveBeenCalled();

    const second = await internals(transport).getOrCreateWebSocket(fakeClient);
    expect(second).not.toBe(first);
    expect(createdSockets).toHaveLength(2);
  });

  it('unregisters the idle listener from a disposed connection', async () => {
    // Each fresh ResponsesWS gets its own `onIdleWsError` registration;
    // dispose() must strip it from the outgoing connection object. Otherwise
    // a stray late event on that now-orphaned socket would call
    // closeWebSocket() again and could tear down a connection established
    // afterward, since `onIdleWsError` always acts on the transport's
    // *current* `wsConnection`, not the specific socket that fired.
    const transport = createTransport();
    const ws = await internals(transport).getOrCreateWebSocket(fakeClient);

    transport.dispose();

    expect(ws.listenerCount('error')).toBe(0);
  });
});
