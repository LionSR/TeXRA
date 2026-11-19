/**
 * A window's side of the host calls: what the window can do for its
 * project's tasks, offered when it attaches and answered call by call, to
 * the service or to its own process (`HostWindows.localLink`). Every host
 * (the extension, the desktop app, the terminal chat of a service session)
 * attaches through this one function with the capabilities it has.
 */
import {
  Cause,
  Deferred,
  Effect,
  FiberHandle,
  Ref,
  type Schema,
  type Scope,
  Stream,
} from 'effect';
import { RpcServer, type RpcMessage } from 'effect/rpc';

import type { HostInteractions } from '@texra-ai/harness';
import { withLogChannel } from '@texra-ai/harness/plugins';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import type { EditorCapabilities } from '@texra/tools/editorHost';
import { serveOverMessages } from '@texra/shared/rpcOverMessages';
import { WINDOW_OUTDATED, linkOutage, type ServiceLink } from './client';

import {
  HostCallFailed,
  HostCapabilitySchema,
  WindowRpcs,
  type HostCapability,
  type HostAttachFrame,
} from './hostCalls';

const CHANNEL = 'WindowHost';

/** The procedures a window attaches through, of the service's client or
 *  of its own process's windows. */
export interface WindowClient {
  readonly 'host.attach': (input: {
    readonly workspace: string;
    readonly capabilities: readonly HostCapability[];
  }) => Stream.Stream<HostAttachFrame, Error>;
  readonly 'host.answer': (input: {
    readonly attachment: string;
    readonly message: typeof Schema.Json.Type;
  }) => Effect.Effect<void, Error>;
  readonly 'host.focus': (input: {
    readonly attachment: string;
  }) => Effect.Effect<void, Error>;
}

/** What a window does for its project's tasks; a capability it leaves out
 *  is one it does not offer. */
export interface WindowHost
  extends Pick<HostInteractions, 'emit'>, EditorCapabilities {
  /** Files a task of the project wrote past the editor's own write path,
   *  as the service's announcer heard them: the host tells its own
   *  listeners (a file tree, decorations), as a task here would. */
  readonly filesWritten?: (absolutePaths: readonly string[]) => void;
}

/** The calls `host` can carry out: each it has the member for, the runtime's
 *  notices through `emit`. */
const capabilitiesOf = (host: WindowHost): HostCapability[] =>
  HostCapabilitySchema.literals.filter(
    (kind) => host[kind === 'notices' ? 'emit' : kind] !== undefined,
  );

/** A call `host` was asked but does not offer: the service routes a call
 *  only to a window that offers it, so this is a service of another mind. */
const unoffered = (kind: HostCapability) =>
  Effect.fail(
    new HostCallFailed({ message: `This window does not offer ${kind}.` }),
  );

/** A call a run waits on, answered however it ends, a defect included, so
 *  the service never waits on a call that died here. */
const asked = <A>(
  kind: HostCapability,
  call: Effect.Effect<A, Error> | undefined,
): Effect.Effect<A, HostCallFailed> =>
  call === undefined
    ? unoffered(kind)
    : call.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.fail(
                new HostCallFailed({ message: toErrorMessage(cause) }),
              ),
        ),
      );

/** A told call: the service waits for nothing past this window having it,
 *  so a failure is said here. */
const told = (
  kind: HostCapability,
  call: Effect.Effect<void, Error> | undefined,
): Effect.Effect<void> =>
  (call ?? Effect.void).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning(
            `This window could not carry out a host call (${kind})`,
          ).pipe(Effect.annotateLogs({ data: cause })),
    ),
    withLogChannel(CHANNEL),
  );

/** The calls `host` serves its project's tasks. */
const windowHandlers = (host: WindowHost) =>
  WindowRpcs.toLayer({
    readDiagnostics: ({ path }) =>
      asked('readDiagnostics', host.readDiagnostics?.(path)),
    addCriticism: ({ entry }) =>
      asked('addCriticism', host.addCriticism?.(entry)),
    openPdf: ({ location, preserveFocus }) =>
      asked('openPdf', host.openPdf?.({ location, preserveFocus })),
    notices: ({ notice }) =>
      told(
        'notices',
        host.emit === undefined
          ? unoffered('notices')
          : Effect.suspend(
              () => host.emit?.(notice.event, notice.payload) ?? Effect.void,
            ),
      ),
    filesWritten: ({ absolutePaths }) =>
      told(
        'filesWritten',
        host.filesWritten === undefined
          ? undefined
          : Effect.sync(() => host.filesWritten?.(absolutePaths)),
      ),
  });

/**
 * Attach `host` through `link` as a window of `workspace`, for the scope's
 * life; returns once the service (or, for a link to this process, its own
 * windows) holds the attachment. `focused` emits when
 * the window gains focus, so the project's calls come here first. When the
 * link loses the service, the attachment ends and the window waits: no call
 * reaches it, its session refuses with the link's offline reason, and it
 * attaches again to the service the link reaches next.
 */
export const attachWindowHost = Effect.fn('server.attachWindowHost')(function* <
  Client extends WindowClient,
>(
  link: ServiceLink<Client>,
  workspace: string,
  host: WindowHost,
  focused: Stream.Stream<void> = Stream.empty,
): Effect.fn.Return<void, never, Scope.Scope> {
  // Finished once the first service holds the attachment, or once it
  // refused or ended it: the caller goes on either way, and the logs say
  // which.
  const attached = yield* Deferred.make<void>();
  const attachment = yield* FiberHandle.make<void, never>();
  // A newer TeXRA's service that refused this window finishes the wait (no
  // attachment comes) and is said once per refusal and link, in the first
  // window that hears it (a reconnect resets `refusalTold`, so a later
  // refusal is said again): every call it makes says it too.
  yield* Effect.forkScoped(
    linkOutage(link).pipe(
      Stream.filter((reason) => reason === WINDOW_OUTDATED),
      Stream.runForEach((message) =>
        Deferred.succeed(attached, undefined).pipe(
          Effect.andThen(Ref.getAndSet(link.refusalTold, true)),
          Effect.flatMap((told) =>
            told
              ? Effect.void
              : Effect.suspend(
                  () =>
                    host.emit?.('requestShowError', { message }) ?? Effect.void,
                ).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(
                      `${message} (not shown: ${error.message})`,
                    ).pipe(withLogChannel(CHANNEL)),
                  ),
                ),
          ),
        ),
      ),
    ),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(link.client.changes, (client) =>
      client === null
        ? FiberHandle.clear(attachment)
        : FiberHandle.run(
            attachment,
            attachTo(client, workspace, host, focused, attached),
          ),
    ),
  );
  yield* Deferred.await(attached);
});

/** One attachment to the service `client` reaches, until it ends; what it
 *  started ends with it. */
function attachTo(
  client: WindowClient,
  workspace: string,
  host: WindowHost,
  focused: Stream.Stream<void>,
  attached: Deferred.Deferred<void>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    /** The attachment's server of `host`'s calls, from its first frame. */
    let receive: (
      message: RpcMessage.FromClientEncoded,
    ) => Effect.Effect<void> = () => Effect.void;
    return yield* client['host.attach']({
      workspace,
      capabilities: capabilitiesOf(host),
    }).pipe(
      Stream.runForEach((frame) => {
        if (frame.kind === 'call')
          // cast: `rpc` reads its own message.
          return receive(
            frame.message as unknown as RpcMessage.FromClientEncoded,
          );
        return Effect.gen(function* () {
          const served = yield* serveOverMessages((_service, message) =>
            client['host.answer']({
              attachment: frame.attachment,
              // cast: `rpc`'s messages are JSON.
              message: message as unknown as typeof Schema.Json.Type,
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `A host call's answer did not reach the service: ${error.message}`,
                ),
              ),
            ),
          );
          // Each call on its own fiber: a slow build never holds the next.
          yield* RpcServer.make(WindowRpcs).pipe(
            Effect.provide(windowHandlers(host)),
            Effect.provideService(RpcServer.Protocol, served.protocol),
            Effect.forkScoped,
          );
          receive = (message) => served.receive('service', message);
          yield* Deferred.succeed(attached, undefined);
          yield* Effect.forkScoped(
            Stream.runForEach(focused, () =>
              client['host.focus']({
                attachment: frame.attachment,
              }).pipe(
                Effect.ignore({ log: 'Warn', message: 'Focus not told' }),
              ),
            ),
          );
        });
      }),
    );
  }).pipe(
    Effect.matchCauseEffect({
      // The service stopped or restarted: the attachment ended, and the
      // window waits for the link's next client to attach it again.
      onSuccess: () =>
        Effect.logWarning(
          `The TeXRA service ended this window's attachment to ${workspace}`,
        ),
      onFailure: (cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning(
              `The TeXRA service stopped asking this window of ${workspace}; tasks there run without its editor until it reconnects`,
            ).pipe(Effect.annotateLogs({ data: cause })),
    }),
    Effect.ensuring(Deferred.succeed(attached, undefined)),
    Effect.scoped,
    withLogChannel(CHANNEL),
  );
}
