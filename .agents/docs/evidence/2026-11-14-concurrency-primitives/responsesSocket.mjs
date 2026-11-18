// The Responses WebSocket model against a scripted local server.
//
//   node responsesSocket.mjs
//
// Bundles packages/llm/src/api/openaiResponsesWebSocket.ts as it stands in
// the tree (dependencies stay external and resolve from packages/llm), then
// drives one model through each scenario below and prints what the caller
// saw and what the server saw. Run it before and after a change to the
// socket to compare the two.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const llm = new URL('../../../../packages/llm/', import.meta.url);
const require = createRequire(new URL('package.json', llm));
const imp = (n) => import(pathToFileURL(require.resolve(n)).href);
const { build } = await imp('esbuild');
const { Effect, Exit, Stream, Fiber } = await imp('effect');
const { WebSocketServer } = (await imp('ws')).default;

const out = new URL('node_modules/.cache/responses-socket.mjs', llm);
await build({
  entryPoints: [new URL('src/api/openaiResponsesWebSocket.ts', llm).pathname],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  outfile: out.pathname,
  logLevel: 'error',
});
const { openaiResponsesWebSocketModel } = await import(
  `${out.href}?t=${Date.now()}`
);

const config = (port) => ({
  protocol: 'openai-responses',
  requestedModel: 'synthetic-model',
  deployment: {
    endpoint: `http://127.0.0.1:${port}/v1`,
    credentialScope: 'synthetic-account',
  },
  supportsDocumentInput: true,
  allowedReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high'],
  continuationInheritsInstructions: false,
  supportsForcedToolChoice: true,
  requestDialect: 'openai',
  background: false,
  defaults: {
    temperature: 0.7,
    maxOutputTokens: 100,
    store: false,
    reasoning: { effort: 'high', mode: 'pro', summary: 'auto' },
    serviceTier: 'fast',
  },
});
const REQUEST = {
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hello.' }] }],
};

let responses = 0;
/** The frames of one complete turn; `deltas` text deltas of `size` chars. */
const turnFrames = (deltas = 1, size = 5) => {
  const id = `resp_${++responses}`;
  const snapshot = (status, output) => ({
    id,
    object: 'response',
    model: 'returned-model',
    status,
    output,
    usage: null,
  });
  const done = {
    type: 'message',
    role: 'assistant',
    id: 'msg_1',
    status: 'completed',
    content: [{ type: 'output_text', text: 'x', annotations: [] }],
  };
  const frames = [
    { type: 'response.created', response: snapshot('in_progress', []) },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...done, status: 'in_progress', content: [] },
    },
    ...Array.from({ length: deltas }, () => ({
      type: 'response.output_text.delta',
      output_index: 0,
      item_id: 'msg_1',
      delta: 'y'.repeat(size),
    })),
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: snapshot('completed', [done]) },
  ];
  return frames.map((f, sequence_number) =>
    JSON.stringify({ ...f, sequence_number }),
  );
};

/**
 * A server whose `onUpgrade(req, socket)` may reject a handshake by
 * returning true, and whose `onMessage(ws, data, n)` answers a request on
 * connection `n`.
 */
const serve = async ({ onUpgrade = () => false, onMessage }) => {
  const seen = { connections: 0, closed: 0, requests: 0, maxBuffered: 0 };
  const wss = new WebSocketServer({ noServer: true });
  const http = createServer();
  http.on('upgrade', (req, socket, head) => {
    if (onUpgrade(req, socket)) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const n = ++seen.connections;
      ws.on('close', () => seen.closed++);
      ws.on('message', (data) => {
        seen.requests++;
        onMessage(ws, String(data), n, seen);
      });
    });
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  return {
    port: http.address().port,
    seen,
    close: () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate();
        http.close(() => r());
      }),
  };
};
const answer = (ws, frames) => {
  for (const f of frames) ws.send(f);
};

/** A turn's outcome as the caller sees it. */
const turnOf = (model, take) =>
  Effect.gen(function* () {
    const prepared = yield* model.prepareTurn(REQUEST);
    const events = model.streamTurn(prepared);
    const exit = yield* Effect.exit(
      Stream.runCollect(take ? Stream.take(events, take) : events),
    );
    if (Exit.isSuccess(exit))
      return `ok(${[...exit.value].map((e) => e.kind).at(-1)})`;
    const error = exit.cause.reasons.find((r) => r._tag === 'Fail')?.error;
    return error
      ? `fail(${error.kind}${error.status ? ` ${error.status}` : ''}${error.requestId ? ` ${error.requestId}` : ''}: ${error.message})`
      : `cause(${String(exit.cause)})`;
  });

const scenarios = {
  'two turns reuse one connection': {
    onMessage: (ws) => answer(ws, turnFrames()),
    turns: 2,
  },
  'handshake 401 with a request id': {
    onUpgrade: (req, socket) => {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nx-request-id: req_9\r\ncontent-length: 0\r\n\r\n',
      );
      return true;
    },
    turns: 1,
  },
  'handshake 503': {
    onUpgrade: (req, socket) => {
      socket.end(
        'HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n',
      );
      return true;
    },
    turns: 1,
  },
  'a frame while idle, then a turn': {
    onMessage: (ws, data, n, seen) => {
      answer(ws, turnFrames());
      if (seen.requests === 1)
        setTimeout(() => ws.send('{"type":"unsolicited"}'), 50);
    },
    turns: 2,
    pause: 150,
  },
  'close mid-turn, then a turn': {
    onMessage: (ws, data, n) => {
      if (n === 1) {
        ws.send(turnFrames()[0]);
        setTimeout(() => ws.close(1011, 'bye'), 20);
      } else answer(ws, turnFrames());
    },
    turns: 2,
  },
  'an error frame with a status, then a turn': {
    onMessage: (ws, data, n) => {
      if (n === 1)
        ws.send(
          JSON.stringify({
            type: 'error',
            status: 429,
            error: {
              type: 'rate_limit',
              code: null,
              message: 'slow down',
              param: null,
            },
          }),
        );
      else answer(ws, turnFrames());
    },
    turns: 2,
  },
  'a frame after the terminal event, the next turn 50 ms later': {
    onMessage: (ws, data, n) => {
      answer(ws, turnFrames());
      if (n === 1) ws.send('{"type":"late"}');
    },
    turns: 2,
    pause: 50,
  },
  // The late frame and the next turn's start race: whichever the socket
  // sees first decides which turn fails.
  'a frame after the terminal event, the next turn at once': {
    onMessage: (ws, data, n) => {
      answer(ws, turnFrames());
      if (n === 1) ws.send('{"type":"late"}');
    },
    turns: 2,
  },
  'a binary frame': {
    onMessage: (ws) => ws.send(Buffer.from([1, 2, 3])),
    turns: 1,
  },
  'caller stops after one event, then a turn': {
    onMessage: (ws) => answer(ws, turnFrames(50)),
    turns: 2,
    take: [1, 0],
  },
  'slow consumer of 4 MB in 4000 frames': {
    onMessage: (ws, data, n, seen) => {
      for (const f of turnFrames(4000, 1024)) {
        ws.send(f);
        seen.maxBuffered = Math.max(
          seen.maxBuffered,
          ws._socket.writableLength,
        );
      }
    },
    turns: 1,
    slow: true,
  },
};

const results = [];
for (const [name, s] of Object.entries(scenarios)) {
  const server = await serve(s);
  const outcomes = [];
  const started = Date.now();
  const program = Effect.scoped(
    Effect.gen(function* () {
      const model = yield* openaiResponsesWebSocketModel(
        config(server.port),
        'synthetic-not-a-secret',
      );
      for (let i = 0; i < s.turns; i++) {
        if (i > 0 && s.pause) yield* Effect.sleep(s.pause);
        const take = s.take?.[i] || undefined;
        if (s.slow) {
          // Read one event every 2 ms for the first 200 events, then drain.
          const prepared = yield* model.prepareTurn(REQUEST);
          let read = 0;
          const exit = yield* Effect.exit(
            Stream.runForEach(model.streamTurn(prepared), () =>
              read++ < 200 ? Effect.sleep(2) : Effect.void,
            ),
          );
          outcomes.push(Exit.isSuccess(exit) ? `ok(${read} events)` : 'fail');
        } else outcomes.push(yield* turnOf(model, take));
      }
    }),
  );
  const exit = await Effect.runPromiseExit(
    program.pipe(Effect.timeout('10 seconds')),
  );
  if (Exit.isFailure(exit)) {
    const error = exit.cause.reasons.find((r) => r._tag === 'Fail')?.error;
    outcomes.push(
      error
        ? `model: ${error.kind ?? error._tag}${error.status ? ` ${error.status}` : ''}${error.requestId ? ` ${error.requestId}` : ''}: ${error.message}`
        : `model: ${String(exit.cause)}`,
    );
  }
  // Give the server a moment to see the client's close.
  await new Promise((r) => setTimeout(r, 50));
  const { connections, closed, requests, maxBuffered } = server.seen;
  results.push({
    name,
    outcomes,
    connections,
    closedAfterScope: `${closed}/${connections}`,
    requests,
    ...(s.slow ? { maxServerBacklogKiB: Math.round(maxBuffered / 1024) } : {}),
    ms: Date.now() - started,
  });
  await server.close();
}

// An open that never completes: the server accepts TCP and says nothing.
{
  const http = createServer();
  http.on('upgrade', () => {});
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const started = Date.now();
  const fiber = Effect.runFork(
    Effect.scoped(
      Effect.flatMap(
        openaiResponsesWebSocketModel(
          config(http.address().port),
          'synthetic-not-a-secret',
        ),
        (model) =>
          Effect.flatMap(model.prepareTurn(REQUEST), (p) =>
            Stream.runCollect(model.streamTurn(p)),
          ),
      ),
    ),
  );
  await new Promise((r) => setTimeout(r, 300));
  await Effect.runPromise(Fiber.interrupt(fiber));
  results.push({
    name: 'a silent handshake, interrupted at 300 ms',
    outcomes: [`interrupt returned after ${Date.now() - started} ms`],
  });
  http.closeAllConnections();
  http.close();
}

for (const r of results) console.log(JSON.stringify(r));
