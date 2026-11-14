/**
 * A window's session held by the background service: the `Session` a
 * window drives when its runs run in `texra serve`. Starts, resumes and
 * requests are procedures of the service, so this window writes nothing to
 * the run history; the view it reads run state from is the service's
 * listing folded here, and a watch is the service's feed, read back as the
 * fold inputs it carries.
 */
import {
  JsonValueSchema,
  type RunId,
  Rejected,
} from '@texra-ai/harness/schemas';
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  Layer,
  Option,
  Predicate,
  Ref,
  Result,
  Schema,
  type Scope,
  Semaphore,
  Stream,
  Struct,
  SubscriptionRef,
} from 'effect';

import {
  LaunchRefused,
  RunFailure,
  ToolsRefused,
  type Run,
  type RunEnd,
  type RunRecords,
  type Session,
  type WorkspaceRoots,
} from '@texra-ai/harness';
import type { ITool } from '@texra-ai/harness/plugins';
import {
  activationView,
  StateReadFailed,
  StateWriteFailed,
  type StateStore,
  replayTrace,
} from '@texra-ai/harness/host';
import { WebviewSessions } from '@texra/shared/session/webviewSessionLayer';
import { requestErrorText } from '@ui/copy/requestErrors';

import { attachWindowHost } from './windowHost';
import {
  WINDOW_OUTDATED,
  environmentApiKeys,
  requestOnService,
  type ServiceClient,
  type ServiceLink,
} from './client';
import {
  RUN_RECORDS,
  type ProjectStateFailed,
  type TaskFailed,
} from './protocol';
import type {
  CommitOrdinal,
  TranscriptInterest,
  TranscriptSubscription,
} from '@texra-ai/harness/transcript';

/** The service's client now; `offline` words a call made while the link
 *  holds none, with why it holds none (`ServiceLink.away`). A reconnect
 *  needs nothing here: the next call takes it. */
const callService = <A, E>(
  link: ServiceLink,
  offline: (reason: string) => E,
  use: (client: ServiceClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.flatMap(link.client.get, (client) =>
    client === null
      ? Effect.flatMap(SubscriptionRef.get(link.away), (reason) =>
          Effect.fail(offline(reason)),
        )
      : use(client),
  );

/** A call the service answers or fails as the session's own `Error`: the
 *  service's refusal as the class it failed with, a transport failure or
 *  an offline link worded for the user. */
const asked = <A>(
  link: ServiceLink,
  use: (client: ServiceClient) => Effect.Effect<A, Error>,
): Effect.Effect<A, Error> =>
  callService(
    link,
    (reason) => new Error(`The TeXRA service did not answer: ${reason}`),
    (client) =>
      use(client).pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error, 'RpcClientError')
            ? new Error(`The TeXRA service did not answer: ${error.message}`)
            : error,
        ),
      ),
  );

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
    const parsed = Schema.decodeUnknownResult(Schema.optional(JsonValueSchema))(
      value,
    );
    return Result.isSuccess(parsed)
      ? Effect.succeed({ value: parsed.success })
      : Effect.fail(
          new StateWriteFailed({
            key,
            message: `State key ${key} was given a value that is not JSON`,
            cause: parsed.failure,
          }),
        );
  };
  const set = Effect.fn('set')(function* (
    key: string,
    next: unknown,
    ifCurrent: { value: unknown } | null,
  ) {
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
        // None: another writer moved the key between the read and the write.
        return (yield* set(key, next.success, { value: current }))
          ? Option.some(next.success)
          : Option.none();
      }).pipe(
        Effect.repeat({
          times: STATE_CHANGE_ATTEMPTS - 1,
          until: Option.isSome,
        }),
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                new StateWriteFailed({
                  key,
                  message: `"${key}" kept changing in the TeXRA service while this window wrote it; try again.`,
                  cause: undefined,
                }),
              ),
          }),
        ),
      ),
  };
};

/** A failure of a call to the service, as a run's own. */
const runFailure = (message: string) =>
  new RunFailure({ cause: new Error(message), message });

/** The service's answer to a start or resume it did not run: a refused
 *  launch as itself, for this window's presenter to show with its notice,
 *  anything else worded `prefix` and its message, as the run's own. */
const refusedByService =
  (prefix = '') =>
  (
    error:
      | TaskFailed
      | LaunchRefused
      | { readonly _tag: 'RpcClientError'; readonly message: string },
  ) =>
    error._tag === 'LaunchRefused'
      ? error
      : runFailure(`${prefix}${error.message}`);

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
  /** The client, once the link has one; or the refusal, once a newer
   *  TeXRA's service refused this window, which no reconnect undoes. */
  const connected = Stream.merge(
    link.client.changes.pipe(
      Stream.filter(Predicate.isNotNull),
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
  // The window's own view: the listing, plus the transcripts its readers
  // name, each reader's set held for its scope. A change of that set is a
  // new watch, from the cursor and history the view already holds. The
  // watch is one ordered stream, so it needs no generation: the previous
  // watch's fiber is gone before the new watch's frames begin.
  const window = yield* graph.view.subscribe([]);
  const watches = new Map<object, readonly TranscriptSubscription[]>();
  const feed = yield* FiberHandle.make<void, never>();
  const lane = Semaphore.makeUnsafe(1);
  const resubscribe = lane.withPermits(1)(
    Effect.gen(function* () {
      yield* FiberHandle.clear(feed);
      const view = graph.view.current();
      const named = new Set(
        [...watches.values()].flatMap((set) => set.map((entry) => entry.id)),
      );
      const aggregates = [...named].map((id) => ({
        id,
        fromSeq: view.transcriptSeq.get(id) ?? 0,
      }));
      yield* graph.frames.begin(0);
      yield* window.set(aggregates);
      const client = yield* link.client.get;
      // Offline: the link's return resubscribes.
      if (client === null) return;
      yield* FiberHandle.run(
        feed,
        client['task.watch']({
          workspace,
          subscribe: {
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
  /** Name `set`'s transcripts to the view for the caller's scope; the
   *  handle replaces the set. */
  const write = (key: object, set: readonly TranscriptSubscription[] | null) =>
    Effect.suspend(() => {
      if (set === null) watches.delete(key);
      else watches.set(key, set);
      return resubscribe;
    });
  const subscribe = (set: readonly TranscriptSubscription[]) =>
    Effect.acquireRelease(
      Effect.sync(() => ({})).pipe(Effect.tap((key) => write(key, set))),
      (key) => write(key, null),
    ).pipe(
      Effect.map((key): TranscriptInterest => ({
        set: (next) => write(key, next),
      })),
    );
  yield* resubscribe;
  // The service went (offline: the feed stops) or the link reached it
  // again (the view resubscribes from where it is). The window tells it
  // nothing else: the project's approval policy is its persisted setting,
  // which the service reads itself.
  yield* Effect.forkScoped(
    link.client.changes.pipe(
      Stream.drop(1),
      Stream.runForEach((client) =>
        client === null ? Effect.void : resubscribe,
      ),
    ),
  );
  const scope = yield* Effect.scope;
  /** The service's answer to how the activation of a task it runs ended
   *  (`Run.result` there), with `at`, its log's position when it answered:
   *  asked of the service the link holds, or the next one, once the link
   *  has one. A service that cannot answer fails it offline. */
  const answered = (runId: RunId, activation: CommitOrdinal) =>
    Effect.flatMap(connected, (client) =>
      client['task.result']({ workspace, runId, activation }),
    ).pipe(
      // One classification: a service that answered the end could not be
      // read fails with its reason; anything else is the link, offline.
      Effect.catch((error) =>
        Predicate.isTagged(error, 'TaskFailed')
          ? Effect.fail(runFailure(error.message))
          : Effect.logWarning(
              `The TeXRA service stopped before task ${runId} ended`,
            ).pipe(
              Effect.annotateLogs({ data: error }),
              Effect.andThen(SubscriptionRef.get(link.away)),
              // The link's reason once it has one; until then the call's.
              Effect.flatMap((reason) =>
                Effect.fail(runFailure(reason || error.message)),
              ),
            ),
      ),
    );
  /** The run's stored end from the service's answer, whatever its outcome,
   *  held until this window's fold shows it too: the answer and the fold's
   *  `task.watch` stream arrive apart, so an end that settled on the answer
   *  alone could find the window still showing the run live, or a resumed
   *  run with the outcome its previous activation left. Held until this
   *  window's fold is at or past `at`, the log's commit when the service
   *  answered, where it holds the run's end, or its removal. The fold-aware
   *  stream ends the wait with the fold, never parks on it. */
  const endOf = ({
    at,
    ...end
  }: Effect.Success<ReturnType<typeof answered>>): Effect.Effect<RunEnd> =>
    Effect.as(
      Stream.runDrain(
        graph.view.changes.pipe(
          Stream.takeUntil((level) => level.cursor >= at),
        ),
      ),
      end,
    );
  const request: Session['request'] = (runtimeRequest) =>
    callService(
      link,
      (reason) => new Rejected({ reason }),
      (client) =>
        requestOnService(client, workspace, runtimeRequest).pipe(
          // A transport failure is a refusal worded for the user, and so is
          // the service's own bridge error (a request it could not parse, a
          // handler that died); a runtime refusal arrives as its class.
          Effect.mapError((error) => {
            switch (error._tag) {
              case 'RpcClientError':
                return new Rejected({
                  reason: `The TeXRA service did not answer: ${error.message}`,
                });
              case 'Invalid':
              case 'Internal':
                return new Rejected({ reason: requestErrorText(error) });
              default:
                return error;
            }
          }),
        ),
    );
  // The watch names its runs to this window's own view too, so the view
  // folds their transcripts while it runs; each service the link holds
  // serves it from the cursor it last delivered.
  const watch: Session['view']['watch'] = (set, from) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* subscribe(set);
        const cursor = yield* Ref.make(from.cursor);
        return link.client.changes.pipe(
          Stream.switchMap((client) =>
            client === null
              ? Stream.empty
              : Stream.unwrap(
                  Effect.map(Ref.get(cursor), (at) =>
                    client['task.watch']({
                      workspace,
                      subscribe: {
                        debug: from.debug,
                        cursor: at,
                        aggregates: [...set],
                      },
                    }),
                  ),
                ).pipe(
                  Stream.tap((frame) => Ref.set(cursor, frame.cursor)),
                  Stream.map((frame) => frame.inputs),
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
                              data: cause,
                            }),
                          ),
                        ).pipe(Stream.drain),
                  ),
                ),
          ),
        );
      }),
    );
  /** The run the service admitted, as this window holds it: the `Run` of
   *  the activation the service named, over this window's view and the
   *  service's rows. Its end is the service's answer (asked once, at once),
   *  held until this window's view shows it too; its view this window's,
   *  sliced to the activation as a run here slices it; and its trace read
   *  back from the service's rows of the activation through the watch. */
  const runOf = Effect.fn('runOf')(function* (
    {
      runId,
      activation,
    }: { readonly runId: RunId; readonly activation: CommitOrdinal },
    redirectedFrom?: RunId,
  ): Effect.fn.Return<Run> {
    const answer = Fiber.join(
      yield* Effect.forkIn(answered(runId, activation), scope),
    );
    const result = yield* Effect.cached(Effect.flatMap(answer, endOf));
    // The service's commit when it answered, past every row the run
    // wrote, failed or not. With no answer (no service will give one,
    // and no row is coming through the watch), none: the replay ends at
    // once with the result's failure.
    let answeredAt: CommitOrdinal = -1;
    return {
      runId,
      activation,
      ...(redirectedFrom !== undefined && { redirectedFrom }),
      result,
      // The view ends as a run's here does, on the level that shows the
      // activation's outcome or the run gone; and once the result has
      // failed (the service died under the task, the link refused), when no
      // such level is coming through the watch.
      view: activationView(
        { current: graph.view.current, changes: graph.view.changes, subscribe },
        runId,
        activation,
      ).pipe(
        Stream.haltWhen(
          Effect.flatMap(Effect.exit(result), (exit) =>
            Exit.isFailure(exit) ? Effect.void : Effect.never,
          ),
        ),
      ),
      // The service's rows, through the watch; the service's log is the
      // store, settled once it answered.
      events: replayTrace(
        {
          view: {
            inputs: (set, cursor, debug) => watch(set, { cursor, debug }),
          },
          log: {
            settled: Effect.exit(answer).pipe(
              Effect.map((exit) => {
                if (Exit.isSuccess(exit)) answeredAt = exit.value.at;
              }),
            ),
            now: () => answeredAt,
          },
        },
        runId,
        activation,
        result,
      ),
    };
  });
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
  /** `Session.records`: each member its procedure of the service. */
  const records = (runId: RunId): RunRecords =>
    // cast: each entry is its member's procedure, whose answer `RUN_RECORDS`
    // types as that member's.
    Object.fromEntries(
      Struct.keys(RUN_RECORDS).map((member) => [
        member,
        asked<unknown>(link, (client) =>
          client[`records.${member}`]({ workspace, runId }),
        ),
      ]),
    ) as unknown as RunRecords;
  return {
    roots,
    view: {
      current: graph.view.current,
      changes: graph.view.changes,
      watch,
      read: (runIds) =>
        asked(link, (client) => client['session.view']({ workspace, runIds })),
    },
    records,
    listRuns: asked(link, (client) =>
      client['session.listRuns']({ workspace }),
    ),
    deleteRuns: (target) =>
      asked(link, (client) =>
        client['session.deleteRuns']({ workspace, target }),
      ),
    request,
    start: ({ tools, ...start }) => {
      if (!('config' in start))
        // The service takes a host's whole configuration.
        return Effect.fail(
          new LaunchRefused({ message: 'A service task needs its config.' }),
        );
      const refused = windowTools(tools);
      if (refused) return Effect.fail(refused);
      return callService(link, runFailure, (client) =>
        client['task.start']({
          workspace,
          start: { ...start, apiKeys: start.apiKeys ?? environmentApiKeys() },
        }).pipe(
          Effect.mapError(
            refusedByService('The TeXRA service could not start the task: '),
          ),
        ),
      ).pipe(Effect.flatMap(runOf));
    },
    resume: (runId, input) => {
      const refused = windowTools(input?.tools);
      if (refused) return Effect.fail(refused);
      return callService(link, runFailure, (client) =>
        client['task.resume']({
          workspace,
          runId,
          apiKeys: input?.apiKeys ?? environmentApiKeys(),
        }).pipe(Effect.mapError(refusedByService())),
      ).pipe(
        Effect.flatMap((resumed) =>
          runOf(resumed, resumed.runId === runId ? undefined : runId),
        ),
      );
    },
    // The notices; a window's editor and previews are its own attachment.
    // An approval handler is a defect here: the service's windows answer
    // its prompts, so a handler would be asked nothing.
    attach: (host) =>
      host.approve === undefined
        ? attachWindowHost(link, workspace, { emit: host.emit })
        : Effect.die(
            new Error(
              "approve handlers are not supported on a service-backed session; the service's windows answer prompts",
            ),
          ),
  };
});
