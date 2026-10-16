/**
 * A window's session held by the background service: the `Session` a
 * window drives when its runs run in `texra serve`. Starts, resumes and
 * requests are procedures of the service, so this window writes nothing to
 * the run history; the view it reads run state from is the service's
 * listing folded here, and a watch is the service's feed, read back as the
 * fold inputs it carries.
 */
import { generateRunId } from '@texra-ai/harness/schemas';
import {
  Cause,
  Data,
  Effect,
  FiberHandle,
  Layer,
  Option,
  Result,
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
  StateReadFailed,
  StateWriteFailed,
  ToolsRefused,
  TraceUnavailable,
  Unavailable,
  type ITool,
  type RequestError,
  type Run,
  type Session,
  type StateStore,
  type WorkspaceRoots,
} from '@texra-ai/harness';
import { attachErrorPresentationClaimed } from '@texra-ai/harness';
import { describeFollowUpFailure } from '@agent/followUp/ToolUseFollowUp';
import { agentErrorPresentation } from '@common/errors';
import {
  JsonValueSchema,
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

import { attachWindowHost } from './windowHost';
import {
  WINDOW_OUTDATED,
  type ServiceClient,
  type ServiceLink,
} from './client';
import type { RunEndResult } from '@texra-ai/harness';
import type { ProjectStateFailed, TaskRecordsFailed } from './protocol';

/** What a call made while the link reconnects is told. */

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

/** The service's client now; `offline` words a call made while the link
 *  holds none, with why it holds none (`ServiceLink.away`). A reconnect
 *  needs nothing here: the next call takes it. */
const callService = <A, E>(
  link: ServiceLink,
  offline: (reason: string) => E,
  use: (client: ServiceClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.flatMap(SubscriptionRef.get(link.client), (client) =>
    client === null
      ? Effect.flatMap(SubscriptionRef.get(link.away), (reason) =>
          Effect.fail(offline(reason)),
        )
      : use(client),
  );

/** A task's records the service could not answer for: it is offline (or
 *  did not answer), holds no such run, or its records would not read. */
export class TaskRecordsUnavailable extends Data.TaggedError(
  'TaskRecordsUnavailable',
)<{
  readonly runId: RunId;
  readonly reason: 'offline' | 'unknownRun' | 'unreadable';
  readonly message: string;
}> {}

/**
 * A window's reads of its project's task records, answered by the service
 * from its own session: the run's saved setup, and what its transcript
 * exports read. The window opens no records of its own in service mode.
 */
export const serviceRecords = (link: ServiceLink, workspace: string) => {
  const ask = <A>(
    runId: RunId,
    use: (
      client: ServiceClient,
    ) => Effect.Effect<
      A,
      TaskRecordsFailed | { readonly _tag: 'RpcClientError'; message: string }
    >,
  ): Effect.Effect<A, TaskRecordsUnavailable> =>
    callService(
      link,
      (message) =>
        new TaskRecordsUnavailable({
          runId,
          reason: 'offline',
          message,
        }),
      (client) =>
        use(client).pipe(
          Effect.mapError(
            (error) =>
              new TaskRecordsUnavailable({
                runId,
                ...(error._tag === 'TaskRecordsFailed'
                  ? { reason: error.reason, message: error.message }
                  : {
                      reason: 'offline',
                      message: `The TeXRA service did not answer: ${error.message}`,
                    }),
              }),
          ),
        ),
    );
  return {
    readConfig: (runId: RunId) =>
      ask(runId, (client) => client['task.config']({ workspace, runId })),
    exportInput: (runId: RunId) =>
      ask(runId, (client) => client['task.exportInput']({ workspace, runId })),
    exportTrace: (runId: RunId) =>
      ask(runId, (client) => client['task.exportTrace']({ workspace, runId })),
  };
};

/** How many times a change to a project state key is tried again while
 *  another writer moves the key between its read and its write. */
const STATE_CHANGE_ATTEMPTS = 8;

/**
 * The project's state store (`roots.workspaceState`) as the service holds
 * it: a window in service mode opens no project store of its own. A change
 * is a compare-and-set in the service, tried again while another writer
 * moves the key between the read and the write.
 */
export const serviceProjectState = (
  link: ServiceLink,
  workspace: string,
): StateStore => {
  const call = <A, E>(
    failed: (message: string, cause: unknown) => E,
    use: (
      client: ServiceClient,
    ) => Effect.Effect<
      A,
      ProjectStateFailed | { readonly _tag: 'RpcClientError'; message: string }
    >,
  ): Effect.Effect<A, E> =>
    callService(
      link,
      (reason) => failed(reason, undefined),
      (client) =>
        use(client).pipe(
          Effect.mapError((error) =>
            failed(
              error._tag === 'ProjectStateFailed'
                ? error.message
                : `The TeXRA service did not answer: ${error.message}`,
              error,
            ),
          ),
        ),
    );
  const get = (key: string) =>
    call(
      (message, cause) => new StateReadFailed({ key, message, cause }),
      (client) =>
        Effect.map(
          client['state.get']({ workspace, key }),
          (stored) => stored.value,
        ),
    );
  /** `value` as the wire carries it: JSON, or absent. Anything else is
   *  refused here, as the local store refuses it. */
  const json = (key: string, value: unknown) => {
    const parsed = JsonValueSchema.optional().safeParse(value);
    return parsed.success
      ? Effect.succeed({ value: parsed.data })
      : Effect.fail(
          new StateWriteFailed({
            key,
            message: `State key ${key} was given a value that is not JSON`,
            cause: parsed.error,
          }),
        );
  };
  const set = (
    key: string,
    next: unknown,
    ifCurrent: { value: unknown } | null,
  ) =>
    Effect.gen(function* () {
      const nextJson = yield* json(key, next);
      const currentJson =
        ifCurrent === null ? null : yield* json(key, ifCurrent.value);
      return yield* call(
        (message, cause) => new StateWriteFailed({ key, message, cause }),
        (client) =>
          client['state.set']({
            workspace,
            key,
            next: nextJson,
            ifCurrent: currentJson,
          }),
      );
    });
  return {
    get,
    update: (key, value) => Effect.asVoid(set(key, value, null)),
    modify: (key, change) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < STATE_CHANGE_ATTEMPTS; attempt += 1) {
          const current = yield* get(key).pipe(
            Effect.mapError(
              (error) =>
                new StateWriteFailed({
                  key,
                  message: error.message,
                  cause: error,
                }),
            ),
          );
          const next = change(current);
          if (Result.isFailure(next)) return yield* Effect.fail(next.failure);
          if (yield* set(key, next.success, { value: current }))
            return next.success;
        }
        return yield* Effect.fail(
          new StateWriteFailed({
            key,
            message: `"${key}" kept changing in the TeXRA service while this window wrote it; try again.`,
            cause: undefined,
          }),
        );
      }),
  };
};

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
  /** The client, once the link has one. */
  /** The client, once the link has one; or the refusal, once a newer
   *  TeXRA's service refused this window, which no reconnect undoes. */
  const connected = Stream.merge(
    SubscriptionRef.changes(link.client).pipe(
      Stream.filter((client) => client !== null),
      Stream.map((client) => ({ client })),
    ),
    SubscriptionRef.changes(link.away).pipe(
      Stream.filter((reason) => reason === WINDOW_OUTDATED),
      Stream.map((refused) => ({ refused })),
    ),
  ).pipe(
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.flatMap((reached) =>
      'client' in reached
        ? Effect.succeed(reached.client)
        : Effect.fail(new Error(reached.refused)),
    ),
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
   *  retired service finishes its tasks first), and held until this
   *  window's fold shows it too. A run that failed fails this at once, as
   *  a run here does: with its error, which the service's terminal
   *  presenter showed this window, so it is marked presented, or without
   *  one (an end with no error recorded) as a plain failure. A service
   *  that cannot answer fails it offline. */
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
          Effect.andThen(SubscriptionRef.get(link.away)),
          Effect.flatMap((reason) => Effect.fail(runFailure(reason))),
        ),
      ),
      Effect.flatMap(({ at, error, ...end }) => {
        if (end.outcome === RUN_OUTCOME.FAILED) {
          const cause = new Error(
            error?.message ?? `The task failed (run ${runId}).`,
          );
          if (error !== undefined && agentErrorPresentation(error) !== null)
            attachErrorPresentationClaimed(cause);
          return Effect.fail(runFailure(cause.message, cause));
        }
        // The answer and the fold's `task.watch` stream arrive apart: a
        // result that settled on the answer alone could find the window
        // still showing the run live, or a resumed run with the outcome
        // its previous activation left. Held until this window's fold is
        // at or past `at`, the log's commit when the service answered,
        // where it holds the run's end, or its removal. The fold-aware
        // stream ends the wait with the fold, never parks on it.
        return Effect.as(
          Stream.runDrain(
            graph.view.changes.pipe(
              Stream.takeUntil((level) => level.cursor >= at),
            ),
          ),
          { ...end, runId },
        );
      }),
    );
  const request: Session['request'] = (runtimeRequest) =>
    callService(
      link,
      (reason) => new Rejected({ reason }),
      (client) =>
        client['task.request']({ workspace, request: runtimeRequest }).pipe(
          Effect.mapError(requestError),
        ),
    );
  /** The run the service admitted, as this window holds it: its end is the
   *  service's answer (asked once), held until this window's fold shows it
   *  too; its view this window's fold sliced to this activation; and its
   *  trace stays in the service. */
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
  const offline = (reason: string) => runFailure(reason);
  /** A start or resume naming a window's own tools is refused: the service
   *  runs its own, so a run continued with them would wait on a tool no
   *  one serves. */
  const windowTools = (
    tools: readonly ITool[] | undefined,
  ): ToolsRefused | undefined =>
    tools === undefined || tools.length === 0
      ? undefined
      : new ToolsRefused({
          tools: tools.map((tool) => tool.definition.name),
          message: "The TeXRA service cannot run a window's own tools.",
        });
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
      const refused = windowTools(input.tools);
      if (refused) return Effect.fail(refused);
      return callService(link, offline, (client) =>
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
              attachErrorPresentationClaimed(cause);
            return runFailure(cause.message, cause);
          }),
        ),
      ).pipe(Effect.flatMap(runOf));
    },
    resume: (runId, input) => {
      const refused = windowTools(input?.tools);
      if (refused) return Effect.fail(refused);
      return callService(link, offline, (client) =>
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
      );
    },
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
