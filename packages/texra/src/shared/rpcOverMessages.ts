/**
 * `effect/rpc` between two of TeXRA's own ends that exchange whole
 * messages: a webview's or a renderer's `postMessage`, an Electron IPC
 * channel, or a stream and a call of the service's own protocol. Each side
 * wraps `rpc`'s messages in its channel's own envelope; this module turns a
 * way to send one message, and the messages that arrive, into the
 * `Protocol` an `RpcServer` or `RpcClient` runs over.
 *
 * Both ends speak JSON (`Schema.toCodecJson`), so a message survives a
 * structured clone and a socket alike. Acks are on: a stream's server runs
 * a bounded way ahead of its reader, and a reader that stops interrupts it.
 *
 * Browser-safe: the webview bundles and the trace viewer import it.
 */
import { Effect, Queue, Schema } from 'effect';
import { RpcClient, RpcServer, type RpcMessage } from 'effect/rpc';

/**
 * A server's end. `receive` hands it one message from the client `client`
 * names; one live client at a time: a message from a new client retires the
 * one before (its calls are interrupted, its answers dropped, and anything
 * it still sends ignored), which is what a frontend that reloads on the same
 * channel needs. `send` posts an answer to the client it names.
 */
export const serveOverMessages = Effect.fnUntraced(function* (
  send: (
    client: string,
    message: RpcMessage.FromServerEncoded,
  ) => Effect.Effect<void>,
) {
  /** The live client's id for the server, and its name on the channel. */
  let current: { readonly name: string; readonly id: number } | undefined;
  let nextId = 0;
  const retired = new Set<string>();
  // One retirement at a time is ever outstanding: the server takes each as
  // soon as it is offered, and a reload is a person's action.
  const disconnects = yield* Queue.bounded<number>(1);
  let receive = (
    _client: string,
    _message: RpcMessage.FromClientEncoded,
  ): Effect.Effect<void> => Effect.void;
  const protocol = yield* RpcServer.Protocol.make((write) =>
    Effect.sync(() => {
      receive = (client, message) =>
        Effect.suspend(() => {
          if (retired.has(client)) return Effect.void;
          if (current?.name === client) return write(current.id, message);
          const previous = current;
          const next = { name: client, id: nextId++ };
          current = next;
          if (previous === undefined) return write(next.id, message);
          retired.add(previous.name);
          return Queue.offer(disconnects, previous.id).pipe(
            Effect.andThen(write(next.id, message)),
          );
        });
      return {
        disconnects,
        send: (id, response) =>
          Effect.suspend(() =>
            current?.id === id ? send(current.name, response) : Effect.void,
          ),
        end: () => Effect.void,
        clientIds: Effect.sync(
          () => new Set(current === undefined ? [] : [current.id]),
        ),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false,
        supportsNotifications: false,
        codecFor: Schema.toCodecJson,
      };
    }),
  );
  return {
    protocol,
    receive: (client: string, message: RpcMessage.FromClientEncoded) =>
      receive(client, message),
  };
});

/**
 * A client's end. `send` posts one message to the server; `receive` hands
 * the client one message the server sent.
 */
export const callOverMessages = Effect.fnUntraced(function* (
  send: (message: RpcMessage.FromClientEncoded) => Effect.Effect<void>,
) {
  let receive = (_message: RpcMessage.FromServerEncoded): Effect.Effect<void> =>
    Effect.void;
  const protocol = yield* RpcClient.Protocol.make((write, clientIds) =>
    Effect.sync(() => {
      receive = (message) =>
        Effect.forEach(clientIds, (id) => write(id, message), {
          discard: true,
        });
      return {
        send: (_id, message) => send(message),
        supportsAck: true,
        supportsTransferables: false,
        codecFor: Schema.toCodecJson,
      };
    }),
  );
  return {
    protocol,
    receive: (message: RpcMessage.FromServerEncoded) => receive(message),
  };
});
