/**
 * A window's session held by the background service: the `Session` a
 * window drives when its runs run in `texra serve`. Starts, resumes and
 * requests are procedures of the service, so this window writes nothing to
 * the run history; the view it reads run state from is the service's
 * listing folded here, and a watch is the service's feed, read back as the
 * fold inputs it carries.
 */
import {
  Cause,
  Effect,
  FiberHandle,
  Layer,
  Option,
  Semaphore,
  Ref,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import {
  Cancelled,
  Internal,
  NotOwner,
  Rejected,
  ResumeRefused,
  RunFailure,
  ToolsRefused,
  TraceUnavailable,
  Unavailable,
  type RequestError,
  type Run,
  type Session,
  type WorkspaceRoots,
} from '@texra-ai/harness';
import { describeFollowUpFailure } from '@agent/followUp/ToolUseFollowUp';
import type { RunEndResult } from '@agent/runtime/RunEndResult';
import { markFailurePresented } from '@agent/runtime/terminalResultToast';
import { agentErrorPresentation } from '@common/errors';
import {
  RUN_OUTCOME,
  type FoldInput,
  type RunId,
  type TranscriptSubscription,
} from '@shared/schemas';
import type {
  EventsFrame,
  RequestErrorWire,
} from '@texra/shared/session/sessionFrames';
import { WebviewSessions } from '@texra/controllers/session/webviewSessionLayer';
import { generateRunId } from '@utils/core';

import { attachWindowHost } from './windowHost';
import type { ServiceClient, ServiceLink } from './client';

/** What a call made while the link reconnects is told. */
const OFFLINE = 'The TeXRA service is offline; TeXRA is reconnecting to it.';

/** The transcript port of the window's own view. */
const WINDOW_PORT = 'window';

/** A refused request as the runtime spells it; a transport failure is a
 *  refusal worded for the user. */
function requestError(
  error:
    | RequestErrorWire
    | { readonly _tag: 'RpcClientError'; readonly message: string },
): RequestError {
  switch (error._tag) {
    case 'NotOwner':
      return new NotOwner({ runId: error.runId });
    case 'Unavailable':
      return new Unavailable({ runId: error.runId, reason: error.reason });
    case 'Cancelled':
      return new Cancelled();
    case 'Rejected':
      return new Rejected({
        reason: error.reason,
        ...(error.docsPage && { docsPage: error.docsPage }),
      });
    case 'Invalid':
      return new Rejected({ reason: error.reason });
    case 'Internal':
      return new Internal({ ref: error.ref });
    case 'RpcClientError':
      return new Rejected({
        reason: `The TeXRA service did not answer: ${error.message}`,
      });
  }
}

/** A service frame as the fold inputs it carries (not its host snapshot). */
function frameInputs(frame: EventsFrame): FoldInput[] {
  const inputs: FoldInput[] = [];
  if (frame.debug !== null)
    inputs.push({ _tag: 'debug', enabled: frame.debug });
  inputs.push(...frame.events, ...frame.chunks);
  if (frame.local !== null) inputs.push({ _tag: 'local', local: frame.local });
  if (frame.existence !== null)
    inputs.push(
      frame.replayComplete
        ? { _tag: 'replay.complete', existence: frame.existence }
        : { _tag: 'drained', cursor: frame.cursor, existence: frame.existence },
    );
  return inputs;
}

/** A failure of a call to the service, as a run's own. */
const runFailure = (message: string, cause: Error = new Error(message)) =>
  new RunFailure({ cause, message });

/**
 * The session of `workspace` in the service, keyed by `roots.storage` (the
 * session's storage root, as this window spells it). The view it folds
 * lives for the caller's scope.
 */
export const serviceSession = Effect.fn('serviceSession')(function* (
  link: ServiceLink,
  workspace: string,
  roots: WorkspaceRoots,
): Effect.fn.Return<Session, never, Scope.Scope> {
  const key = roots.storage;
  /** The client now; `offline` answers a call made while there is none. */
  const call = <A, E>(
    offline: () => E,
    use: (client: ServiceClient) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.flatMap(SubscriptionRef.get(link.client), (client) =>
      client === null ? Effect.fail(offline()) : use(client),
    );
  /** The client, once the link has one. */
  const connected = SubscriptionRef.changes(link.client).pipe(
    Stream.filter((client) => client !== null),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
  const sessions = yield* Layer.build(WebviewSessions.layerNoDeps);
  const graph = yield* WebviewSessions.open(key).pipe(
    Effect.provideContext(sessions),
  );
  // The window's own view: the listing, plus the transcripts its watches
  // name. A change of that set is a new generation of one watch, from the
  // cursor and history the view already holds, as a webview resubscribes.
  const watches = new Map<number, readonly TranscriptSubscription[]>();
  let watchIds = 0;
  const feed = yield* FiberHandle.make<void, never>();
  const lane = Semaphore.makeUnsafe(1);
  let generation = 0;
  const resubscribe = lane.withPermits(1)(
    Effect.gen(function* () {
      generation += 1;
      const view = yield* SubscriptionRef.get(graph.view.ref);
      const named = new Set(
        [...watches.values()].flatMap((set) => set.map((entry) => entry.id)),
      );
      const aggregates = [...named].map((id) => ({
        id,
        fromSeq: view.folded.get(id) ?? 0,
      }));
      yield* graph.frames.begin(generation);
      yield* graph.subscriptions.set(WINDOW_PORT, aggregates);
      const client = yield* SubscriptionRef.get(link.client);
      // Offline: the link's return resubscribes.
      if (client === null) return yield* FiberHandle.clear(feed);
      yield* FiberHandle.run(
        feed,
        client['task.watch']({
          workspace,
          subscribe: {
            kind: 'subscribe',
            session: key,
            generation,
            debug: view.debug,
            cursor: view.cursor,
            aggregates,
          },
        }).pipe(
          Stream.runForEach(graph.frames.feed),
          Effect.catch((error) =>
            Effect.logWarning(
              `The TeXRA service stopped sending ${workspace}; this window's run state no longer updates`,
            ).pipe(Effect.annotateLogs({ data: error })),
          ),
        ),
      );
    }),
  );
  yield* resubscribe;
  // The service went (offline: the feed stops) or the link reached it
  // again (the view resubscribes from where it is). The window tells it
  // nothing else: the project's approval policy is its persisted setting,
  // which the service reads itself.
  yield* Effect.forkScoped(
    SubscriptionRef.changes(link.client).pipe(
      Stream.drop(1),
      Stream.runForEach((client) =>
        client === null ? Effect.void : resubscribe,
      ),
    ),
  );
  /** What a task the service runs ends with: asked of the service the
   *  link holds, again of the next one if the link is lost meanwhile (a
   *  retired service finishes its tasks first). A run that failed fails
   *  this with its error, as a run here does; the service's terminal
   *  presenter showed the error this window, so it is marked presented. A
   *  service that cannot answer fails it offline. */
  const ended = (runId: RunId): Effect.Effect<RunEndResult, RunFailure> =>
    Effect.flatMap(connected, (client) =>
      client['task.ended']({ workspace, runId }),
    ).pipe(
      Effect.retry({ times: 2 }),
      Effect.catch((error) =>
        Effect.logWarning(
          `The TeXRA service stopped before task ${runId} ended`,
        ).pipe(
          Effect.annotateLogs({ data: error }),
          Effect.andThen(Effect.fail(runFailure(OFFLINE))),
        ),
      ),
      Effect.flatMap(({ error, ...end }) => {
        if (end.outcome !== RUN_OUTCOME.FAILED || error === undefined)
          return Effect.succeed({ ...end, runId });
        const cause = new Error(error.message ?? `Task ${runId} failed.`);
        if (agentErrorPresentation(error) !== null) markFailurePresented(cause);
        return Effect.fail(runFailure(cause.message, cause));
      }),
    );
  const request: Session['request'] = (runtimeRequest) =>
    call(
      () => new Rejected({ reason: OFFLINE }),
      (client) =>
        client['task.request']({ workspace, request: runtimeRequest }).pipe(
          Effect.mapError(requestError),
        ),
    );
  /** The run the service admitted, as this window holds it: its end is the
   *  service's answer (asked once), its view this window's fold sliced to
   *  this activation, and its trace stays in the service. */
  const runOf = (runId: RunId, redirectedFrom?: RunId): Effect.Effect<Run> =>
    Effect.map(Effect.cached(ended(runId)), (result) => ({
      runId,
      ...(redirectedFrom !== undefined && { redirectedFrom }),
      result,
      // A resumed run's levels can still show the outcome its previous
      // activation ended with: the slice starts at a level where it is
      // live, and ends with the outcome after that, or with the result.
      view: SubscriptionRef.changes(graph.view.ref).pipe(
        Stream.dropWhile(
          (level) => level.runs.get(runId)?.durableOutcome !== null,
        ),
        Stream.takeUntil(
          (level) => level.runs.get(runId)?.durableOutcome != null,
        ),
        Stream.haltWhen(Effect.exit(result)),
      ),
      events: Stream.fail(
        new TraceUnavailable({
          runId,
          reason: 'remote',
          message: `Task ${runId} runs in the TeXRA service, which keeps its trace.`,
        }),
      ),
      interrupt: request({ kind: 'run.stop', runId, reason: 'user' }).pipe(
        Effect.ignore({ log: 'Warn', message: `Stopping task ${runId}` }),
      ),
    }));
  const offline = () => runFailure(OFFLINE);
  return {
    roots,
    view: {
      current: () => SubscriptionRef.getUnsafe(graph.view.ref),
      changes: SubscriptionRef.changes(graph.view.ref),
      // The watch names its runs to this window's own view too, so the
      // view folds their transcripts while it runs; each service the link
      // holds serves it from the cursor it last delivered.
      watch: (set, from) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.suspend(() => {
                const id = (watchIds += 1);
                watches.set(id, set);
                return Effect.as(resubscribe, id);
              }),
              (id) =>
                Effect.suspend(() => {
                  watches.delete(id);
                  return resubscribe;
                }),
            );
            const cursor = yield* Ref.make(from.cursor);
            return SubscriptionRef.changes(link.client).pipe(
              Stream.switchMap((client) =>
                client === null
                  ? Stream.empty
                  : Stream.unwrap(
                      Effect.map(Ref.get(cursor), (at) =>
                        client['task.watch']({
                          workspace,
                          subscribe: {
                            kind: 'subscribe',
                            session: key,
                            generation: 0,
                            debug: from.debug,
                            cursor: at,
                            aggregates: [...set],
                          },
                        }),
                      ),
                    ).pipe(
                      Stream.tap((frame) => Ref.set(cursor, frame.cursor)),
                      Stream.map(frameInputs),
                      Stream.filter((inputs) => inputs.length > 0),
                      // A lost service's stream fails, or is interrupted
                      // when the link closes its connection: either ends
                      // this service's part, and the next one takes over.
                      Stream.catchCause((cause) =>
                        Cause.hasInterruptsOnly(cause)
                          ? Stream.empty
                          : Stream.fromEffect(
                              Effect.logWarning(
                                `The TeXRA service stopped sending ${workspace}; the watch resumes when the service is back`,
                              ).pipe(
                                Effect.annotateLogs({
                                  data: Cause.squash(cause),
                                }),
                              ),
                            ).pipe(Stream.drain),
                      ),
                    ),
              ),
            );
          }),
        ),
    },
    request,
    start: (input) => {
      if (!('config' in input))
        // The service takes a host's whole configuration.
        return Effect.fail(runFailure('A service task needs its config.'));
      const tools = input.tools ?? [];
      if (tools.length > 0)
        return Effect.fail(
          new ToolsRefused({
            tools: tools.map((tool) => tool.definition.name),
            message: "The TeXRA service cannot run a window's own tools.",
          }),
        );
      return call(offline, (client) =>
        client['task.start']({
          workspace,
          runId: input.runId ?? generateRunId(),
          config: input.config,
          continues: input.continues ?? null,
          preferHelperModel: input.helperModel ?? false,
          ownApiKeyFallback: input.ownKeyFallback ?? false,
          approveDelegatedWork: input.approval?.delegated ?? false,
          approvalPolicy: input.approval?.policy ?? null,
        }).pipe(
          Effect.mapError((error) => {
            const cause = new Error(
              `The TeXRA service could not start the task: ${error.message}`,
            );
            // The service presented it to this window already.
            if ('presented' in error && error.presented === true)
              markFailurePresented(cause);
            return runFailure(cause.message, cause);
          }),
        ),
      ).pipe(Effect.flatMap((runId) => runOf(runId)));
    },
    resume: (runId) =>
      call(offline, (client) =>
        client['task.resume']({ workspace, runId }).pipe(
          Effect.mapError((error) => runFailure(error.message)),
        ),
      ).pipe(
        Effect.flatMap((resumed) =>
          // Waiting for what blocks it (its agent, a plugin): the service
          // continues it once that is back.
          resumed === null
            ? Effect.fail(
                new ResumeRefused({
                  runId,
                  reason: 'blocked',
                  message: describeFollowUpFailure('blocked'),
                }),
              )
            : runOf(resumed, resumed === runId ? undefined : runId),
        ),
      ),
    // The notices; a window's editor and previews are its own attachment.
    // An approval handler is a defect here: the service's windows answer
    // its prompts, so a handler would be asked nothing.
    attach: (host) =>
      host.approve === undefined
        ? attachWindowHost(link, workspace, {
            emit: host.emit,
            approvalDenied: host.approvalDenied,
            languageModel: host.languageModel,
          })
        : Effect.die(
            new Error(
              "approve handlers are not supported on a service-backed session; the service's windows answer prompts",
            ),
          ),
  };
});
