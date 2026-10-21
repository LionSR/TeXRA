/**
 * A window's side of the service's host calls: what the window can do for
 * its project's tasks, offered to the service when it attaches and answered
 * call by call. Every host (the extension, the desktop app, the terminal
 * chat) attaches through this one function with the capabilities it has.
 */
import {
  Cause,
  type Context,
  Deferred,
  Duration,
  Effect,
  FiberHandle,
  FiberMap,
  RcMap,
  Ref,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import { ModelError, ModelErrorFieldsSchema, type Model } from '@texra-ai/llm';

import { withLogChannel, type HostInteractions } from '@texra-ai/harness';
import { toErrorMessage, toJsonValue } from '@texra-ai/harness/schemas';
import type { ToolEditApprovalController } from '@texra/controllers/approval/ToolEditApprovalController';
import type { EditorCapabilities } from '@texra/tools/editorHost';
import {
  WINDOW_OUTDATED,
  type ServiceClient,
  type ServiceLink,
} from './client';
import type { RpcClientError } from 'effect/rpc';
import type { LanguageModelPort, WorkspaceRoots } from '@texra-ai/harness';

import type { HostAnswer, HostCall, HostCapability } from './hostCalls';

const CHANNEL = 'WindowHost';

type PreviewServices = Effect.Services<
  ReturnType<ToolEditApprovalController['dispose']>
>;

/** What a window does for its project's tasks; a capability it leaves out
 *  is one it does not offer. */
export interface WindowHost
  extends
    Pick<HostInteractions, 'emit' | 'approvalDenied'>,
    EditorCapabilities {
  /** The editor's language models, which the service's runs of this
   *  project bind through this window. */
  readonly languageModel?: LanguageModelPort;
  /** Files a task of the project wrote past the editor's own write path,
   *  as the service's announcer heard them: the host tells its own
   *  listeners (a file tree, decorations), as a task here would. */
  readonly filesWritten?: (absolutePaths: readonly string[]) => void;
  /** The tool-edit preview a window stages beside the request, which the
   *  window releases when the request settles, and whose edited content an
   *  approve-all reads: its controller, the window's roots the staged files
   *  resolve against, and the services its previews take. */
  readonly toolEdits?: {
    readonly controller: ToolEditApprovalController;
    readonly roots: WorkspaceRoots;
    readonly services: Context.Context<PreviewServices>;
  };
}

function capabilitiesOf(host: WindowHost): HostCapability[] {
  return [
    ...(host.readDiagnostics ? (['readDiagnostics'] as const) : []),
    ...(host.addCriticism ? (['addCriticism'] as const) : []),
    ...(host.openPdf ? (['openPdf'] as const) : []),
    ...(host.toolEdits ? (['toolEdits'] as const) : []),
    ...(host.emit || host.approvalDenied || host.filesWritten
      ? (['notices'] as const)
      : []),
    ...(host.languageModel ? (['languageModel'] as const) : []),
  ];
}

/** A failure as the window answers it: a model's failure keeps its fields,
 *  which the service rebuilds into the same `ModelError`. */
function failureAnswer(error: unknown): HostAnswer {
  const answer = { ok: false as const, message: toErrorMessage(error) };
  if (!(error instanceof ModelError)) return answer;
  const fields = ModelErrorFieldsSchema.safeParse(
    toJsonValue(
      Object.fromEntries(
        Object.keys(ModelErrorFieldsSchema.shape).map((name) => [
          name,
          Reflect.get(error, name),
        ]),
      ),
    ),
  );
  return fields.success ? { ...answer, model: fields.data } : answer;
}

/** The streamed call's items: a turn of the editor's model. */
function performStream(
  call: Extract<HostCall, { kind: 'lmStream' }>,
  modelFor: ModelFor,
): Stream.Stream<unknown, Error> {
  const { turn } = call;
  // An editor model runs only foreground turns.
  if (turn.mode !== 'foreground')
    return Stream.fail(
      new Error('An editor model runs foreground turns only.'),
    );
  return Stream.unwrap(
    Effect.map(modelFor(call), (model) => model.streamTurn(turn)),
  );
}

/** The window's one acquisition of an editor model per configuration, held
 *  for the attachment: a turn prepared through it streams through it. */
type ModelFor = (
  call: Extract<HostCall, { kind: 'lmPrepare' | 'lmStream' }>,
) => Effect.Effect<Model, Error>;

/** Carry out one call; its value, or the window's failure. */
function perform(
  host: WindowHost,
  call: HostCall,
  modelFor: ModelFor,
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
      return previews(host, call, ({ controller, roots }) =>
        controller.present({ ...call.request, roots }).pipe(Effect.as(null)),
      );
    case 'releaseToolEdit':
      return previews(host, call, ({ controller }) =>
        controller.release(call.requestId).pipe(Effect.as(null)),
      );
    case 'approveToolEdit':
      return previews(host, call, ({ controller }) =>
        controller.approveStaged(call.requestId),
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
    case 'lmModels':
      return (
        host.languageModel?.selectModels(
          call.vendor === null ? undefined : { vendor: call.vendor },
        ) ?? unoffered(call)
      );
    case 'lmPrepare':
      return Effect.flatMap(modelFor(call), (model) =>
        model.prepareTurn(call.request),
      );
    // Streamed and cancelled by `attachTo`, never performed here.
    case 'lmStream':
    case 'cancel':
      return unoffered(call);
  }
}

/** A tool-edit call on the window's preview controller, under the services
 *  its previews take. */
function previews(
  host: WindowHost,
  call: HostCall,
  program: (
    toolEdits: NonNullable<WindowHost['toolEdits']>,
  ) => Effect.Effect<unknown, Error, PreviewServices>,
): Effect.Effect<unknown, Error> {
  const { toolEdits } = host;
  if (toolEdits === undefined) return unoffered(call);
  return Effect.provideContext(program(toolEdits), toolEdits.services);
}

const unofferedError = (call: HostCall) =>
  new Error(`This window does not offer ${call.kind}.`);
const unoffered = (call: HostCall) => Effect.fail(unofferedError(call));

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
  client: ServiceClient,
  workspace: string,
  host: WindowHost,
  focused: Stream.Stream<void>,
  attached: Deferred.Deferred<void>,
): Effect.Effect<void> {
  const send = (id: string, answer: HostAnswer) =>
    client['host.answer']({ id, answer });
  return Effect.gen(function* () {
    // The calls answering now, by id, so the service's `cancel` stops one.
    const answering = yield* FiberMap.make<string>();
    const editor = host.languageModel;
    const acquisitions = yield* RcMap.make({
      lookup: (configuration: string) =>
        editor === undefined
          ? Effect.fail(new Error('This window offers no editor models.'))
          : editor.acquire(JSON.parse(configuration)),
      // Kept until the attachment ends, so a turn prepared through one
      // acquisition streams through the same one.
      idleTimeToLive: Duration.infinity,
    });
    const modelFor: ModelFor = (call) => {
      const key = JSON.stringify(call.configuration);
      // A failed acquisition is not kept: the next turn tries again.
      return Effect.scoped(RcMap.get(acquisitions, key)).pipe(
        Effect.onError(() => RcMap.invalidate(acquisitions, key)),
      );
    };
    const answer = (id: string, call: HostCall) => {
      const work: Effect.Effect<
        unknown,
        Error | RpcClientError.RpcClientError
      > =
        call.kind === 'lmStream'
          ? // Each item as it comes, then the end; the service's `cancel`
            // interrupts it (`answering`).
            Stream.runForEach(performStream(call, modelFor), (item) =>
              send(id, { ok: true, value: toJsonValue(item), more: true }),
            ).pipe(Effect.as(null))
          : perform(host, call, modelFor);
      return work.pipe(
        // Any end but an interrupt is answered, a defect included, so the
        // service never waits on a call that died here.
        Effect.matchCauseEffect({
          onSuccess: (value) =>
            send(id, { ok: true, value: toJsonValue(value) }),
          onFailure: (cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : send(id, failureAnswer(Cause.squash(cause))),
        }),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning(
                `A host call (${call.kind}) was not answered`,
              ).pipe(Effect.annotateLogs({ data: Cause.squash(cause) })),
        ),
      );
    };
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
        if (frame.call.kind === 'cancel')
          return FiberMap.remove(answering, frame.call.call);
        // Each call on its own fiber: a slow build never holds the next.
        return FiberMap.run(answering, frame.id, answer(frame.id, frame.call));
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
