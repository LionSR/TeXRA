/**
 * A window's side of the service's host calls: what the window can do for
 * its project's tasks, offered to the service when it attaches and answered
 * call by call. Every host (the extension, the desktop app, the terminal
 * chat) attaches through this one function with the capabilities it has.
 */
import {
  Cause,
  Deferred,
  Effect,
  FiberHandle,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import type { HostInteractions } from '@agent/runtime/HostInteractions';
import { withLogChannel } from '@logger/effectLog';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { ServiceClient, ServiceLink } from './client';
import type {
  HostAnswer,
  HostCall,
  HostCapability,
  ToolEditStaging,
} from './hostCalls';

const CHANNEL = 'WindowHost';

/** What a window does for its project's tasks; a capability it leaves out
 *  is one it does not offer. */
export interface WindowHost extends Pick<
  HostInteractions,
  'readDiagnostics' | 'addCriticism' | 'openPdf' | 'emit' | 'approvalDenied'
> {
  /** The tool-edit preview a window stages beside the request, which the
   *  window releases when the request settles, and whose edited content an
   *  approve-all reads. */
  readonly toolEdits?: {
    readonly stage: (request: ToolEditStaging) => Effect.Effect<void, Error>;
    readonly release: (requestId: string) => Effect.Effect<void>;
    readonly approve: (requestId: string) => Effect.Effect<boolean>;
  };
}

function capabilitiesOf(host: WindowHost): HostCapability[] {
  return [
    ...(host.readDiagnostics ? (['readDiagnostics'] as const) : []),
    ...(host.addCriticism ? (['addCriticism'] as const) : []),
    ...(host.openPdf ? (['openPdf'] as const) : []),
    ...(host.toolEdits ? (['toolEdits'] as const) : []),
    ...(host.emit || host.approvalDenied ? (['notices'] as const) : []),
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
    case 'presentToolEdit':
      return (
        host.toolEdits?.stage(call.request).pipe(Effect.as(null)) ??
        unoffered(call)
      );
    case 'releaseToolEdit':
      return (
        host.toolEdits?.release(call.requestId).pipe(Effect.as(null)) ??
        unoffered(call)
      );
    case 'approveToolEdit':
      return host.toolEdits?.approve(call.requestId) ?? unoffered(call);
    case 'notice':
      return Effect.suspend(() => {
        const presented = host.emit?.(
          call.notice.event,
          // The notice's schema paired the event with its payload.
          call.notice.payload as never,
        );
        return presented ?? Effect.void;
      }).pipe(Effect.as(null));
    case 'approvalDenied':
      return Effect.sync(() => {
        host.approvalDenied?.(call.denial, call.runId);
        return null;
      });
  }
}

const unoffered = (call: HostCall) =>
  Effect.fail(new Error(`This window does not offer ${call.kind}.`));

/**
 * Attach `host` to the service as a window of `workspace`, for the scope's
 * life; returns once the service holds the attachment. `focused` emits when
 * the window gains focus, so the project's calls come here first. When the
 * link loses the service, the window goes on with its own process's
 * capabilities, and attaches again to the service the link reaches next.
 */
export const attachWindowHost = Effect.fn('server.attachWindowHost')(function* (
  link: ServiceLink,
  workspace: string,
  host: WindowHost,
  focused: Stream.Stream<void> = Stream.empty,
): Effect.fn.Return<void, never, Scope.Scope> {
  // Settled once the first service holds the attachment, or once it
  // refused or ended it: the caller goes on either way, and the logs say
  // which.
  const attached = yield* Deferred.make<void>();
  const attachment = yield* FiberHandle.make<void, never>();
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
  client: ServiceClient,
  workspace: string,
  host: WindowHost,
  focused: Stream.Stream<void>,
  attached: Deferred.Deferred<void>,
): Effect.Effect<void> {
  const answer = (id: string, call: HostCall) =>
    perform(host, call).pipe(
      Effect.match({
        onSuccess: (value): HostAnswer => ({
          ok: true,
          // Undefined is no JSON value; a call with nothing to say says null.
          value: (value ?? null) as Extract<HostAnswer, { ok: true }>['value'],
        }),
        onFailure: (error): HostAnswer => ({
          ok: false,
          message: toErrorMessage(error),
        }),
      }),
      Effect.flatMap((result) => client['host.answer']({ id, answer: result })),
      Effect.catchCause((cause) =>
        Effect.logWarning(`A host call (${call.kind}) was not answered`).pipe(
          Effect.annotateLogs({ data: Cause.squash(cause) }),
        ),
      ),
    );
  return client['host.attach']({
    workspace,
    capabilities: capabilitiesOf(host),
  }).pipe(
    Stream.runForEach((frame) =>
      frame.kind === 'attached'
        ? Deferred.succeed(attached, undefined).pipe(
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
          )
        : // Each call on its own fiber: a slow build never holds the next.
          Effect.forkScoped(answer(frame.id, frame.call)),
    ),
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
