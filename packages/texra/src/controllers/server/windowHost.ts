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
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import { withLogChannel, type HostInteractions } from '@texra-ai/harness/host';
import { toErrorMessage, toJsonValue } from '@texra-ai/harness/schemas';
import type { EditorCapabilities } from '@texra/tools/editorHost';
import { WINDOW_OUTDATED, type ServiceLink } from './client';

import type {
  HostAnswer,
  HostCall,
  HostCapability,
  HostFrame,
} from './hostCalls';

const CHANNEL = 'WindowHost';

/** The procedures a window attaches through, of the service's client or
 *  of its own process's windows. */
export interface WindowClient {
  readonly 'host.attach': (input: {
    readonly workspace: string;
    readonly capabilities: readonly HostCapability[];
  }) => Stream.Stream<HostFrame, Error>;
  readonly 'host.answer': (input: {
    readonly id: string;
    readonly answer: HostAnswer;
  }) => Effect.Effect<void, Error>;
  readonly 'host.focus': (input: {
    readonly attachment: string;
  }) => Effect.Effect<void, Error>;
}

/** What a window does for its project's tasks; a capability it leaves out
 *  is one it does not offer. */
export interface WindowHost
  extends
    Pick<HostInteractions, 'emit' | 'approvalDenied'>,
    EditorCapabilities {
  /** Files a task of the project wrote past the editor's own write path,
   *  as the service's announcer heard them: the host tells its own
   *  listeners (a file tree, decorations), as a task here would. */
  readonly filesWritten?: (absolutePaths: readonly string[]) => void;
}

function capabilitiesOf(host: WindowHost): HostCapability[] {
  return [
    ...(host.readDiagnostics ? (['readDiagnostics'] as const) : []),
    ...(host.addCriticism ? (['addCriticism'] as const) : []),
    ...(host.openPdf ? (['openPdf'] as const) : []),
    ...(host.emit || host.approvalDenied || host.filesWritten
      ? (['notices'] as const)
      : []),
  ];
}

/** Carry out one call; its value, or the window's failure. */
function perform(
  host: WindowHost,
  call: HostCall,
): Effect.Effect<unknown, Error> {
  switch (call.kind) {
    case 'readDiagnostics':
      return host.readDiagnostics?.(call.path) ?? unoffered(call);
    case 'addCriticism':
      return host.addCriticism?.(call.entry) ?? unoffered(call);
    case 'openPdf':
      return (
        host
          .openPdf?.({
            location: call.location,
            preserveFocus: call.preserveFocus,
          })
          .pipe(Effect.as(null)) ?? unoffered(call)
      );
    case 'notice':
      return Effect.suspend(() => {
        const presented = host.emit?.(
          call.notice.event,
          // The notice's schema paired the event with its payload.
          call.notice.payload as never,
        );
        return presented ?? Effect.void;
      }).pipe(Effect.as(null));
    case 'filesWritten':
      return Effect.sync(() => {
        host.filesWritten?.(call.absolutePaths);
        return null;
      });
    case 'approvalDenied':
      return Effect.sync(() => {
        host.approvalDenied?.(call.denial, call.runId);
        return null;
      });
  }
}

const unofferedError = (call: HostCall) =>
  new Error(`This window does not offer ${call.kind}.`);
const unoffered = (call: HostCall) => Effect.fail(unofferedError(call));

/**
 * Attach `host` through `link` as a window of `workspace`, for the scope's
 * life; returns once the service (or, for a link to this process, its own
 * windows) holds the attachment. `focused` emits when
 * the window gains focus, so the project's calls come here first. When the
 * link loses the service, the window goes on with its own process's
 * capabilities, and attaches again to the service the link reaches next.
 */
export const attachWindowHost = Effect.fn('server.attachWindowHost')(function* <
  Client extends WindowClient,
>(
  link: ServiceLink<Client>,
  workspace: string,
  host: WindowHost,
  focused: Stream.Stream<void> = Stream.empty,
): Effect.fn.Return<void, never, Scope.Scope> {
  // Settled once the first service holds the attachment, or once it
  // refused or ended it: the caller goes on either way, and the logs say
  // which.
  const attached = yield* Deferred.make<void>();
  const attachment = yield* FiberHandle.make<void, never>();
  // A newer TeXRA's service that refused this window settles the wait (no
  // attachment comes) and is said once per refusal and link, in the first
  // window that hears it (a reconnect resets `refusalTold`, so a later
  // refusal is said again): every call it makes says it too.
  yield* Effect.forkScoped(
    SubscriptionRef.changes(link.away).pipe(
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
    Stream.runForEach(SubscriptionRef.changes(link.client), (client) =>
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
  const send = (id: string, answer: HostAnswer) =>
    client['host.answer']({ id, answer });
  return Effect.gen(function* () {
    const answer = (id: string, call: HostCall) =>
      perform(host, call).pipe(
        // Any end but an interrupt is answered, a defect included, so the
        // service never waits on a call that died here.
        Effect.matchCauseEffect({
          onSuccess: (value) =>
            send(id, { ok: true, value: toJsonValue(value) }),
          onFailure: (cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : send(id, {
                  ok: false,
                  message: toErrorMessage(Cause.squash(cause)),
                }),
        }),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning(
                `A host call (${call.kind}) was not answered`,
              ).pipe(Effect.annotateLogs({ data: Cause.squash(cause) })),
        ),
      );
    return yield* client['host.attach']({
      workspace,
      capabilities: capabilitiesOf(host),
    }).pipe(
      Stream.runForEach((frame) => {
        if (frame.kind === 'attached')
          return Deferred.succeed(attached, undefined).pipe(
            Effect.andThen(
              Effect.forkScoped(
                Stream.runForEach(focused, () =>
                  client['host.focus']({
                    attachment: frame.attachment,
                  }).pipe(
                    Effect.ignore({ log: 'Warn', message: 'Focus not told' }),
                  ),
                ),
              ),
            ),
          );
        // Each call on its own fiber: a slow build never holds the next.
        return Effect.forkScoped(answer(frame.id, frame.call));
      }),
    );
  }).pipe(
    Effect.matchCauseEffect({
      // The service stopped or restarted: the window goes on with its
      // own process's capabilities.
      onSuccess: () =>
        Effect.logWarning(
          `The TeXRA service ended this window's attachment to ${workspace}`,
        ),
      onFailure: (cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning(
              `The TeXRA service stopped asking this window of ${workspace}; tasks there run without its editor until it reconnects`,
            ).pipe(Effect.annotateLogs({ data: Cause.squash(cause) })),
    }),
    Effect.ensuring(Deferred.succeed(attached, undefined)),
    Effect.scoped,
    withLogChannel(CHANNEL),
  );
}
