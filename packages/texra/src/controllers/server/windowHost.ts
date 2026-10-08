/**
 * A window's side of the service's host calls: what the window can do for
 * its project's tasks, offered to the service when it attaches and answered
 * call by call. Every host (the extension, the desktop app, the terminal
 * chat) attaches through this one function with the capabilities it has.
 */
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  FiberHandle,
  FiberMap,
  RcMap,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import { ModelError, ModelErrorFieldsSchema, type Model } from '@texra-ai/llm';

import type { HostInteractions } from '@agent/runtime/HostInteractions';
import { withLogChannel } from '@logger/effectLog';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { LanguageModelPort } from '@texra-ai/harness';

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
  /** The editor's language models, which the service's runs of this
   *  project bind through this window. */
  readonly languageModel?: LanguageModelPort;
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
    ...(host.languageModel ? (['languageModel'] as const) : []),
  ];
}

/** A value as JSON carries it (no `undefined` fields), for an answer; a
 *  call with nothing to say says null. */
const asJson = (value: unknown): unknown =>
  value === undefined ? null : JSON.parse(JSON.stringify(value));
const asJsonValue = (value: unknown) =>
  // JSON round-tripped above, so it is a JSON value.
  asJson(value) as Extract<HostAnswer, { ok: true }>['value'];

/** A failure as the window answers it: a model's failure keeps its fields,
 *  which the service rebuilds into the same `ModelError`. */
function failureAnswer(error: unknown): HostAnswer {
  const answer = { ok: false as const, message: toErrorMessage(error) };
  if (!(error instanceof ModelError)) return answer;
  const fields = ModelErrorFieldsSchema.safeParse(
    asJson(
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
    const modelFor: ModelFor = (call) =>
      Effect.scoped(
        RcMap.get(acquisitions, JSON.stringify(call.configuration)),
      );
    const answer = (id: string, call: HostCall) => {
      const work: Effect.Effect<unknown, unknown> =
        call.kind === 'lmStream'
          ? // Each item as it comes, then the end; the service's `cancel`
            // interrupts it (`answering`).
            Stream.runForEach(performStream(call, modelFor), (item) =>
              send(id, { ok: true, value: asJsonValue(item), more: true }),
            ).pipe(Effect.as(null))
          : perform(host, call, modelFor);
      return work.pipe(
        // Any end but an interrupt is answered, a defect included, so the
        // service never waits on a call that died here.
        Effect.matchCauseEffect({
          onSuccess: (value) =>
            send(id, { ok: true, value: asJsonValue(value) }),
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
