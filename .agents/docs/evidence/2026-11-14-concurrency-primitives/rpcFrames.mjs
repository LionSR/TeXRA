// effect/rpc over a postMessage-shaped pair: what the session frames would
// need from it.
//
//   node rpcFrames.mjs
//
// The two ends exchange plain objects, each delivered on a later macrotask
// after a structured clone, as a webview's or an Electron renderer's
// postMessage does. Each scenario prints what the client saw and what the
// server's handlers saw.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(
  new URL('../../../../packages/texra/package.json', import.meta.url),
);
const imp = (n) => import(pathToFileURL(require.resolve(n)).href);
const { Effect, Exit, Fiber, FiberSet, Layer, Queue, Schema, Stream } =
  await imp('effect');
const { Rpc, RpcClient, RpcGroup, RpcServer } = await imp('effect/rpc');

class Refused extends Schema.TaggedError()('Refused', {
  reason: Schema.String,
}) {}

const Group = RpcGroup.make(
  Rpc.make('frames', {
    payload: { count: Schema.Int },
    success: Schema.Int,
    stream: true,
  }),
  Rpc.make('ask', {
    payload: { mode: Schema.Literals(['ok', 'refuse', 'die', 'slow']) },
    success: Schema.String,
    error: Refused,
  }),
);

const log = [];
const note = (line) => log.push(line);
const stats = { produced: 0, maxLead: 0, consumed: 0 };
let outer;

const handlers = Group.toLayer({
  frames: ({ count }) =>
    Stream.range(1, count).pipe(
      Stream.tap(() =>
        Effect.sync(() => {
          stats.produced++;
          stats.maxLead = Math.max(
            stats.maxLead,
            stats.produced - stats.consumed,
          );
        }),
      ),
      Stream.onExit((exit) =>
        Effect.sync(() =>
          note(
            `server: frames ended ${exit._tag}${Exit.hasInterrupts(exit) ? ' (interrupted)' : ''} after ${stats.produced}`,
          ),
        ),
      ),
    ),
  ask: ({ mode }) => {
    if (mode === 'ok') return Effect.succeed('answered');
    if (mode === 'refuse') return Effect.fail(new Refused({ reason: 'no' }));
    if (mode === 'die') return Effect.die(new Error('secret defect text'));
    // A request the server must finish even if its asker goes away: the
    // work runs in a set the server owns and the handler only joins it.
    return FiberSet.run(
      outer,
      Effect.sleep(200).pipe(
        Effect.andThen(Effect.sync(() => note('server: slow work finished'))),
        Effect.onInterrupt(() =>
          Effect.sync(() => note('server: slow work interrupted')),
        ),
      ),
    ).pipe(
      Effect.flatMap(Fiber.join),
      Effect.as('slow answered'),
      Effect.onInterrupt(() =>
        Effect.sync(() => note('server: slow handler interrupted')),
      ),
    );
  },
});

/** A pair of ends; `close()` is the port going away. */
const pair = () => {
  let toServer;
  let toClient;
  let open = true;
  // A message posted before the other end listens is lost, as a
  // postMessage to a page that has not loaded is.
  const post = (to, data) => {
    const copy = structuredClone(data);
    setImmediate(() => open && to()?.(copy));
  };
  const disconnects = Effect.runSync(Queue.make());
  const server = RpcServer.Protocol.make((write) =>
    Effect.sync(() => {
      toServer = (data) => Effect.runFork(write(0, data));
      return {
        disconnects,
        send: (_id, data) => Effect.sync(() => post(() => toClient, data)),
        end: () => Effect.void,
        clientIds: Effect.succeed(new Set([0])),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false,
        supportsNotifications: false,
        codecFor: Schema.toCodecJson,
      };
    }),
  );
  const client = RpcClient.Protocol.make((write, clientIds) =>
    Effect.sync(() => {
      toClient = (data) => {
        for (const id of clientIds) Effect.runFork(write(id, data));
      };
      return {
        send: (_id, data) => Effect.sync(() => post(() => toServer, data)),
        supportsAck: true,
        supportsTransferables: false,
        codecFor: Schema.toCodecJson,
      };
    }),
  );
  return {
    server,
    client,
    close: () => {
      open = false;
      Queue.offerUnsafe(disconnects, 0);
    },
  };
};

const scenario = async (name, body) => {
  log.length = 0;
  stats.produced = 0;
  stats.maxLead = 0;
  stats.consumed = 0;
  const p = pair();
  const program = Effect.gen(function* () {
    outer = yield* FiberSet.make();
    yield* RpcServer.make(Group).pipe(
      Effect.provide(handlers),
      Effect.provide(Layer.effect(RpcServer.Protocol, p.server)),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    const client = yield* RpcClient.make(Group).pipe(
      Effect.provide(Layer.effect(RpcClient.Protocol, p.client)),
    );
    yield* body(client, p);
    yield* Effect.sleep(300);
  });
  await Effect.runPromise(Effect.scoped(program));
  console.log(JSON.stringify({ name, log: [...log] }));
};

const show = (exit) =>
  Exit.isSuccess(exit)
    ? `success ${JSON.stringify(exit.value)}`
    : `failure ${exit.cause.reasons
        .map((r) =>
          r._tag === 'Fail'
            ? `Fail ${r.error._tag ?? r.error.constructor.name}${r.error instanceof Refused ? ' (the class)' : ''}`
            : r._tag === 'Die'
              ? `Die ${JSON.stringify(String(r.defect?.message ?? r.defect))}`
              : r._tag,
        )
        .join(', ')}`;

await scenario('order and lead of a stream read slowly', (client) =>
  Effect.gen(function* () {
    let last = 0;
    let ordered = true;
    yield* client.frames({ count: 300 }).pipe(
      Stream.runForEach((n) =>
        Effect.sync(() => {
          if (n !== last + 1) ordered = false;
          last = n;
          stats.consumed++;
        }).pipe(Effect.andThen(Effect.sleep(1))),
      ),
    );
    note(
      `client: 300 read, in order ${ordered}; server ran ahead of the reader by at most ${stats.maxLead}`,
    );
  }),
);

await scenario('the client stops reading a stream', (client) =>
  Effect.gen(function* () {
    yield* client
      .frames({ count: 100000 })
      .pipe(Stream.take(5), Stream.runDrain);
    note('client: took 5 and stopped');
  }),
);

await scenario('answers and errors', (client) =>
  Effect.gen(function* () {
    for (const mode of ['ok', 'refuse', 'die'])
      note(
        `client: ask ${mode} -> ${show(yield* Effect.exit(client.ask({ mode })))}`,
      );
  }),
);

await scenario('the port closes during a request', (client, p) =>
  Effect.gen(function* () {
    const asked = yield* Effect.forkChild(
      Effect.exit(client.ask({ mode: 'slow' })),
    );
    yield* Effect.sleep(50);
    p.close();
    note('client: port closed at 50 ms');
    const exit = yield* Fiber.join(asked).pipe(Effect.timeoutOption(500));
    note(
      `client: the ask ${exit._tag === 'None' ? 'still waits after 500 ms' : show(exit.value)}`,
    );
  }),
);

await scenario('the client interrupts a request', (client) =>
  Effect.gen(function* () {
    const asked = yield* Effect.forkChild(client.ask({ mode: 'slow' }));
    yield* Effect.sleep(50);
    yield* Fiber.interrupt(asked);
    note('client: interrupted the ask at 50 ms');
  }),
);
