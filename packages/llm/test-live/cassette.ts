/**
 * Recorded provider exchanges ("cassettes") and the local server that relays
 * them from a real provider or replays them without one.
 *
 * A cassette is one live case's HTTP exchanges in the order the binding sent
 * them: the method and path of each request and the provider's status,
 * allowlisted headers and body, or for a WebSocket the provider's frames.
 * Request headers, request bodies and the frames a client sends are never
 * recorded, so no credential or prompt reaches a file. Response bodies are
 * scrubbed before they are written: every identifier is renumbered, model
 * text, reasoning, signatures and tool arguments become fixed placeholders,
 * and account fields are blanked (`scrubbed`). A cassette whose text still
 * matches {@link LEAKED_SECRET} is refused on write and on read.
 *
 * {@link wireServer} is the one local server: a handler per request, every
 * request it received readable afterwards. {@link relay} forwards to the real
 * provider and keeps what it answered; {@link replay} answers from a cassette
 * and fails a request the cassette does not hold. A test that needs a
 * scripted provider passes its own handler.
 */

// Node imports
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';

// Third-party imports
import { NodeHttpServer, NodeSocket } from '@effect/platform-node';
import { Deferred, Effect, Ref, Schema, type Scope, Stream } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { Socket } from 'effect/socket';

/** One recorded request and the provider's answer to it. */
const ExchangeSchema = Schema.Struct({
  method: Schema.String,
  /** The path and query on the provider's host, scrubbed like the body. */
  path: Schema.String,
  status: Schema.Int,
  /** Only {@link RESPONSE_HEADERS}. */
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
  /**
   * A WebSocket's frames (status 101): the provider's frames after each
   * frame the client sent, by the client frame's position. What the client
   * sent is never kept.
   */
  replies: Schema.optional(Schema.Array(Schema.Array(Schema.String))),
});
export type Exchange = typeof ExchangeSchema.Type;

/**
 * A credential's shape in any of the routes' formats: an OpenAI-style
 * `sk-` key, a bearer header, a Google API key.
 */
const LEAKED_SECRET = /sk-[A-Za-z0-9]|Bearer|AIza/;

const CassetteSchema = Schema.Struct({
  exchanges: Schema.Array(ExchangeSchema),
});
const CassetteJson = Schema.fromJsonString(CassetteSchema);
export type Cassette = typeof CassetteSchema.Type;

/** The response headers a cassette keeps: what a codec reads off a reply. */
const RESPONSE_HEADERS = [
  'content-type',
  'retry-after',
  'retry-after-ms',
  'x-should-retry',
];

/** Where the cassette of one route's case lives. */
export const cassettePath = (route: string, caseId: string): string =>
  new URL(`cassettes/${route}/${caseId}.json`, import.meta.url).pathname;

const refuseSecrets = (text: string, path: string): void => {
  if (LEAKED_SECRET.test(text))
    throw new Error(`${path} holds a credential-shaped string; not used.`);
};

/** The cassette at `path`, or `undefined` when nothing was recorded there. */
export function readCassette(path: string): Cassette | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  refuseSecrets(text, path);
  return Schema.decodeUnknownSync(CassetteJson)(text);
}

export function writeCassette(path: string, cassette: Cassette): void {
  const text = `${JSON.stringify(cassette, null, 2)}\n`;
  refuseSecrets(text, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// ---------------------------------------------------------------------------
// Scrubbing

/** Keys whose string value is an identifier the provider minted. */
const isIdKey = (key: string): boolean => key === 'id' || key.endsWith('_id');

/** Keys whose string value is the model's own prose or reasoning. */
const MODEL_TEXT = new Set(['text', 'thinking', 'refusal']);

/** Keys whose value is opaque provider state handed back on the next turn. */
const OPAQUE = new Set([
  'signature',
  'encrypted_content',
  'thought_signature',
  'data',
]);

/** Keys whose value names the account or user a request ran under. */
const ACCOUNT = new Set([
  'user',
  'organization',
  'project',
  'safety_identifier',
  'prompt_cache_key',
]);

/** What every tool call's arguments become. */
const SYNTHETIC_ARGUMENTS = { country: 'France' };

/**
 * One cassette's scrubber. Identifiers are renumbered consistently across
 * its exchanges (a response id a later poll or cancel names keeps its
 * synthetic value), and a streamed tool call's argument fragments become
 * the synthetic arguments once, then empty, so they still join into JSON.
 */
function scrubber() {
  const ids = new Map<string, string>();
  const argumentStreams = new Set<string>();

  const idFor = (real: string): string => {
    const known = ids.get(real);
    if (known !== undefined) return known;
    const prefix = /^[A-Za-z]+[_-]/.exec(real)?.[0] ?? 'id_';
    const synthetic = `${prefix}${ids.size + 1}`;
    ids.set(real, synthetic);
    return synthetic;
  };

  /** A fragment of streamed tool arguments: whole once per call, then empty. */
  const fragment = (owner: Record<string, unknown>): string => {
    const call = String(owner.index ?? owner.output_index ?? owner.item_id);
    if (argumentStreams.has(call)) return '';
    argumentStreams.add(call);
    return JSON.stringify(SYNTHETIC_ARGUMENTS);
  };

  const value = (
    key: string,
    item: unknown,
    owner: Record<string, unknown>,
  ): unknown => {
    // An empty value opens a block the deltas fill; it says nothing.
    if (typeof item === 'string' && item !== '') {
      if (isIdKey(key)) return idFor(item);
      if (MODEL_TEXT.has(key)) return 'Synthetic text.';
      if (OPAQUE.has(key)) return 'synthetic-opaque';
      if (ACCOUNT.has(key)) return 'synthetic-account';
      if (key === 'arguments') return JSON.stringify(SYNTHETIC_ARGUMENTS);
      if (key === 'partial_json') return fragment(owner);
      if (key === 'delta')
        return String(owner.type).includes('arguments')
          ? fragment(owner)
          : 'Synthetic text.';
      return item;
    }
    // Google and a non-streamed Anthropic call carry arguments as an object.
    if (
      (key === 'arguments' || key === 'input') &&
      isRecord(item) &&
      Object.keys(item).length > 0
    )
      return SYNTHETIC_ARGUMENTS;
    return walk(item);
  };

  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (!isRecord(item)) return item;
    return Object.fromEntries(
      Object.entries(item).map(([key, inner]) => [
        key,
        value(key, inner, item),
      ]),
    );
  };

  const json = (text: string): string | undefined => {
    try {
      return JSON.stringify(walk(JSON.parse(text)));
    } catch {
      return undefined;
    }
  };

  return {
    /** A response body: JSON, or server-sent events whose data is JSON. */
    body(text: string): string {
      // A call's fragments all arrive in one response.
      argumentStreams.clear();
      const whole = json(text);
      if (whole !== undefined) return whole;
      return text
        .split('\n')
        .map((line) => {
          if (!line.startsWith('data:')) return line;
          const scrubbed = json(line.slice('data:'.length).trim());
          return scrubbed === undefined ? line : `data: ${scrubbed}`;
        })
        .join('\n');
    },
    /** A request path: the ids it names, renumbered; no key parameter. */
    path(path: string): string {
      const url = new URL(path, 'http://recorded.invalid');
      url.searchParams.delete('key');
      let scrubbed = `${url.pathname}${url.search}`;
      for (const [real, synthetic] of ids)
        scrubbed = scrubbed.replaceAll(real, synthetic);
      return scrubbed;
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `raw` scrubbed in order, so an id a later path names was renumbered by the
 * body that first returned it.
 */
export function scrubbed(raw: ReadonlyArray<Exchange>): Cassette {
  const scrub = scrubber();
  return {
    exchanges: raw.map((exchange) => {
      const body = scrub.body(exchange.body);
      const replies = exchange.replies?.map((frames) =>
        frames.map((frame) => scrub.body(frame)),
      );
      return {
        ...exchange,
        path: scrub.path(exchange.path),
        body,
        ...(replies === undefined ? {} : { replies }),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// The local server

/** A request the server received, kept in memory for the test to read. */
export interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: Uint8Array<ArrayBuffer>;
}

/** How a {@link wireServer} answers one received request. */
export type Respond = (
  request: ReceivedRequest,
  raw: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse>;

export interface WireServer {
  /** `http://127.0.0.1:<port>`; a request's path is kept as sent. */
  readonly url: string;
  /** Every request received so far, in arrival order. */
  readonly received: Effect.Effect<ReadonlyArray<ReceivedRequest>>;
}

/**
 * A local HTTP server on a free loopback port for the caller's scope, which
 * answers each request with `respond`. A raw request still reaches
 * `respond`, so a test can upgrade it to a WebSocket. Close the clients
 * first: a socket still open holds the server's shutdown.
 */
export const wireServer = Effect.fn('wire.server')(function* (
  respond: Respond,
): Effect.fn.Return<WireServer, never, Scope.Scope> {
  const server = yield* NodeHttpServer.make(() => createServer(), {
    port: 0,
    host: '127.0.0.1',
  }).pipe(Effect.orDie);
  const received = yield* Ref.make<ReadonlyArray<ReceivedRequest>>([]);
  yield* server.serve(
    Effect.gen(function* () {
      const raw = yield* HttpServerRequest.HttpServerRequest;
      const body = new Uint8Array(yield* Effect.orDie(raw.arrayBuffer));
      const request = { method: raw.method, path: raw.url, body };
      yield* Ref.update(received, (all) => [...all, request]);
      return yield* respond(request, raw);
    }).pipe(Effect.interruptible),
  );
  return {
    url: HttpServer.formatAddress(server.address),
    received: Ref.get(received),
  };
});

/** Whether `raw` asks to become a WebSocket. */
const upgrading = (raw: HttpServerRequest.HttpServerRequest): boolean =>
  raw.headers.upgrade?.toLowerCase() === 'websocket';

const frameText = new TextDecoder();

/**
 * Hands each frame `socket` reads to `onFrame`, in order, until the peer
 * closes it.
 */
const eachFrame = (
  reader: Socket.Reader,
  onFrame: (frame: string) => Effect.Effect<void, Socket.SocketError>,
): Effect.Effect<void, Socket.SocketError> =>
  Effect.forever(
    Effect.flatMap(reader.pull, (frames) =>
      Effect.forEach(
        frames,
        (frame) =>
          onFrame(typeof frame === 'string' ? frame : frameText.decode(frame)),
        { discard: true },
      ),
    ),
  ).pipe(
    Effect.catchTag('SocketError', (error) =>
      error.reason._tag === 'SocketCloseError'
        ? Effect.void
        : Effect.fail(error),
    ),
  );

/** The two ends of an accepted WebSocket. */
const accepted = Effect.fnUntraced(function* (
  raw: HttpServerRequest.HttpServerRequest,
) {
  const socket = yield* Effect.orDie(raw.upgrade);
  return {
    reader: yield* Effect.orDie(socket.reader),
    writer: yield* socket.writer,
  };
});

const answer = (exchange: Omit<Exchange, 'method' | 'path'>) =>
  HttpServerResponse.text(exchange.body, {
    status: exchange.status,
    headers: exchange.headers,
    contentType: exchange.headers['content-type'],
  });

/**
 * Answers from `cassette` in order. A request that is not the next one
 * recorded is answered 599 with what was expected, which fails the case at
 * the codec; `unused` names the exchanges never asked for.
 */
export const replay = Effect.fn('wire.replay')(function* (cassette: Cassette) {
  const pending = yield* Ref.make(cassette.exchanges);
  /** Socket replies not yet sent, by the exchange that holds them. */
  const unsent = yield* Ref.make<ReadonlyArray<string>>([]);
  const respond: Respond = (request, raw) =>
    Effect.gen(function* () {
      const next = yield* Ref.modify(pending, ([first, ...rest]) =>
        first !== undefined &&
        first.method === request.method &&
        first.path === request.path
          ? [first, rest]
          : [undefined, []],
      );
      if (next === undefined)
        return answer({
          status: 599,
          headers: { 'content-type': 'text/plain' },
          body: `The cassette does not hold ${request.method} ${request.path} here.`,
        });
      if (next.replies === undefined || !upgrading(raw)) return answer(next);
      const label = `${next.method} ${next.path} (socket)`;
      yield* Ref.update(unsent, (all) => [...all, label]);
      const { reader, writer } = yield* accepted(raw);
      let sent = 0;
      yield* eachFrame(reader, () => {
        const frames = next.replies?.[sent] ?? [];
        sent += 1;
        if (sent === next.replies?.length)
          return Effect.andThen(
            Effect.forEach(frames, writer.write, { discard: true }),
            Ref.update(unsent, (all) => all.filter((each) => each !== label)),
          );
        return Effect.forEach(frames, writer.write, { discard: true });
      }).pipe(Effect.orDie);
      return HttpServerResponse.empty();
    }).pipe(Effect.scoped);
  return {
    respond,
    unused: Effect.zipWith(Ref.get(pending), Ref.get(unsent), (rest, open) => [
      ...rest.map((exchange) => `${exchange.method} ${exchange.path}`),
      ...open,
    ]),
  };
});

/** Headers that describe one hop's connection, not the request. */
const HOP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'keep-alive',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
]);

/**
 * One WebSocket relayed to `upstream` frame by frame, both ways, until
 * either side closes; `recorded` then holds the provider's frames grouped
 * by the client frame they followed.
 */
const relaySocket = (
  upstream: string,
  request: ReceivedRequest,
  headers: ReadonlyArray<readonly [string, string]>,
  raw: HttpServerRequest.HttpServerRequest,
  recorded: Deferred.Deferred<Exchange>,
) =>
  Effect.gen(function* () {
    const target = new URL(request.path, upstream);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const provider = yield* Socket.makeWebSocket(target.href, {
      headers: Object.fromEntries(headers),
    }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
    const fromProvider = yield* Effect.orDie(provider.reader);
    const toProvider = yield* provider.writer;
    const client = yield* accepted(raw);
    const replies: Array<Array<string>> = [];
    yield* Effect.raceFirst(
      eachFrame(client.reader, (frame) => {
        replies.push([]);
        return toProvider.write(frame);
      }),
      eachFrame(fromProvider, (frame) => {
        replies.at(-1)?.push(frame);
        return client.writer.write(frame);
      }),
    ).pipe(
      Effect.orDie,
      Effect.ensuring(
        Effect.suspend(() =>
          Deferred.succeed(recorded, {
            method: request.method,
            path: request.path,
            status: 101,
            headers: {},
            body: '',
            replies,
          }),
        ),
      ),
    );
    return HttpServerResponse.empty();
  }).pipe(Effect.scoped);

/**
 * Forwards each request to `upstream` (the provider's origin) and streams
 * its answer back with only {@link RESPONSE_HEADERS}, so a case run through
 * the relay sees what its replay will. `recorded` holds each exchange in
 * arrival order once its body has ended or been cut off, unscrubbed: only
 * {@link scrubbed} output is ever written.
 */
export const relay = Effect.fn('wire.relay')(function* (upstream: string) {
  const exchanges = yield* Ref.make<ReadonlyArray<Deferred.Deferred<Exchange>>>(
    [],
  );
  const respond: Respond = (request, raw) =>
    Effect.gen(function* () {
      const recorded = yield* Deferred.make<Exchange>();
      yield* Ref.update(exchanges, (all) => [...all, recorded]);
      const headers = Object.entries(raw.headers).filter(
        ([name]) => !HOP_HEADERS.has(name),
      );
      if (upgrading(raw))
        return yield* relaySocket(upstream, request, headers, raw, recorded);
      const reply = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(new URL(request.path, upstream), {
            method: request.method,
            headers,
            ...(request.body.length > 0 ? { body: request.body } : {}),
            signal,
          }),
        catch: (cause) =>
          new Error(`The relay could not reach ${upstream}.`, { cause }),
      }).pipe(Effect.orDie);
      const kept = Object.fromEntries(
        RESPONSE_HEADERS.flatMap((name) => {
          const value = reply.headers.get(name);
          return value === null ? [] : [[name, value]];
        }),
      );
      const decoder = new TextDecoder();
      let text = '';
      const source = reply.body;
      const body = (
        source === null
          ? Stream.empty
          : Stream.fromReadableStream({
              evaluate: () => source,
              onError: (cause) =>
                new Error('The provider stream failed.', { cause }),
            })
      ).pipe(
        Stream.tap((chunk) =>
          Effect.sync(() => {
            text += decoder.decode(chunk, { stream: true });
          }),
        ),
        // Ended or cut off by the client: what arrived is the exchange.
        Stream.ensuring(
          Effect.suspend(() =>
            Deferred.succeed(recorded, {
              method: request.method,
              path: request.path,
              status: reply.status,
              headers: kept,
              body: text + decoder.decode(),
            }),
          ),
        ),
      );
      return HttpServerResponse.stream(body, {
        status: reply.status,
        headers: kept,
        contentType: kept['content-type'],
      });
    });
  return {
    respond,
    /** Every exchange so far, once each has finished. */
    recorded: Effect.flatMap(Ref.get(exchanges), (all) =>
      Effect.forEach(all, (recorded) => Deferred.await(recorded)),
    ),
  };
});
