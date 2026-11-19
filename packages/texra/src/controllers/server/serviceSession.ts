/**
 * A window's session held by the background service: the `Session` a
 * window drives when its runs run in `texra serve`. Starts, resumes and
 * requests are procedures of the service, so this window writes nothing to
 * the run history; the view it reads run state from is the service's
 * listing folded here, and a watch is the service's feed, read back as the
 * fold inputs it carries.
 */
import {
  type RunId,
  Rejected,
  type SessionView,
} from '@texra-ai/harness/schemas';
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  Ref,
  Result,
  Schema,
  type Scope,
  Stream,
  Struct,
} from 'effect';
import type { RpcClientError } from 'effect/rpc';

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
import { remoteSessionView } from '@texra/shared/session/webviewSessionLayer';
import { requestErrorText } from '@ui/copy/requestErrors';

import { attachWindowHost } from './windowHost';
import {
  SERVICE_OFFLINE,
  environmentApiKeys,
  linkRefusals,
  linkedClient,
  requestOnService,
  ServiceUnavailable,
  type ServiceClient,
  type ServiceLink,
} from './client';
import type { EventsFrame } from '@texra/shared/session/sessionFrames';
import {
  RUN_RECORDS,
  type ProjectStateFailed,
  type TaskSummary,
  type TaskFailed,
  type TaskRecordsFailed,
} from './protocol';
import type { CommitOrdinal } from '@texra-ai/harness/transcript';

const isRpcClientError = (
  error: unknown,
): error is RpcClientError.RpcClientError =>
  Predicate.isTagged(error, 'RpcClientError');

/**
 * A call through `link`'s client now, its failures to reach an answer
 * worded once: a call made while the link holds none fails `failed` with
 * why it holds none, and a failed transport with what it said. The
 * service's own refusals pass through as the classes it failed with.
 */
const callService = <A, E, F>(
  link: ServiceLink,
  failed: (message: string, cause: Error) => F,
  use: (
    client: ServiceClient,
  ) => Effect.Effect<A, E | RpcClientError.RpcClientError>,
): Effect.Effect<A, E | F> =>
  linkedClient(link).pipe(
    Effect.mapError((away) => failed(away.message, away)),
    Effect.flatMap(use),
    Effect.mapError((error) =>
      isRpcClientError(error)
        ? failed(`The TeXRA service did not answer: ${error.message}`, error)
        : error,
    ),
  );

/** A failure to reach an answer: the link holds no service, or the
 *  service did not answer. */
const failedCall = (reason: string) => new ServiceUnavailable({ reason });

/** How many times a change to project state keys is tried again while
 *  another writer moves one between its read and its write. */
const STATE_CHANGE_ATTEMPTS = 8;

/**
 * The project's state store (`roots.workspaceState`) as the service holds
 * it: a window in service mode opens no project store of its own. A change
 * is a compare-and-set of its keys in the service, tried again while another
 * writer moves one between the read and the write.
 */
export const serviceProjectState = (
  link: ServiceLink,
  workspace: string,
): StateStore => {
  const call = <A, E>(
    failed: (message: string, cause: Error) => E,
    use: (
      client: ServiceClient,
    ) => Effect.Effect<A, ProjectStateFailed | RpcClientError.RpcClientError>,
  ): Effect.Effect<A, E> =>
    callService(link, failed, (client) =>
      use(client).pipe(
        Effect.catchTag('ProjectStateFailed', (error) =>
          Effect.fail(failed(error.message, error)),
        ),
      ),
    );
  const read = (keys: readonly string[]) =>
    call(
      (message, cause) =>
        new StateReadFailed({ key: keys.join(', '), message, cause }),
      (client) =>
        Effect.map(client['state.get']({ workspace, keys }), (stored) =>
          Object.fromEntries(keys.map((key) => [key, stored[key]?.value])),
        ),
    );
  /** `values` as the wire carries them: each JSON, or absent. Anything else
   *  is refused here, as the local store refuses it. */
  const stored = (values: Readonly<Record<string, unknown>>) =>
    Effect.forEach(Object.entries(values), ([key, value]) => {
      const parsed = Schema.decodeUnknownResult(Schema.optional(Schema.Json))(
        value,
      );
      return Result.isSuccess(parsed)
        ? Effect.succeed([key, { value: parsed.success }] as const)
        : Effect.fail(
            new StateWriteFailed({
              key,
              message: `State key ${key} was given a value that is not JSON`,
              cause: parsed.failure,
            }),
          );
    }).pipe(Effect.map((entries) => Object.fromEntries(entries)));
  const set = Effect.fn('set')(function* (
    next: Readonly<Record<string, unknown>>,
    ifCurrent: Readonly<Record<string, unknown>> | null,
  ) {
    const nextStored = yield* stored(next);
    const currentStored = ifCurrent === null ? null : yield* stored(ifCurrent);
    return yield* call(
      (message, cause) =>
        new StateWriteFailed({
          key: Object.keys(next).join(', '),
          message,
          cause,
        }),
      (client) =>
        client['state.set']({
          workspace,
          next: nextStored,
          ifCurrent: currentStored,
        }),
    );
  });
  return {
    get: (key) => Effect.map(read([key]), (values) => values[key]),
    update: (key, value) => Effect.asVoid(set({ [key]: value }, null)),
    modify: (keys, change) => {
      const named = keys.join(', ');
      return Effect.gen(function* () {
        const current = yield* read(keys).pipe(
          Effect.mapError(
            (error) =>
              new StateWriteFailed({
                key: named,
                message: error.message,
                cause: error,
              }),
          ),
        );
        // cast: `read` answers one entry for each of `keys`.
        const result = change(
          current as Readonly<Record<(typeof keys)[number], unknown>>,
        );
        if (Result.isFailure(result)) return yield* Effect.fail(result.failure);
        if (result.success.length === 1) return Option.some(result.success[0]);
        // None: another writer moved a key between the read and the write.
        return (yield* set(result.success[1], current))
          ? Option.some(result.success[0])
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
                  key: named,
                  message: `"${named}" kept changing in the TeXRA service while this window wrote it; try again.`,
                  cause: undefined,
                }),
              ),
          }),
        ),
      );
    },
  };
};

/** A failure of a call to the service, as a run's own. */
const runFailure = (message: string) =>
  new RunFailure({ cause: new Error(message), message });

/** The service's own reason for a start or resume it did not run (it is
 *  shutting down, the project would not open), as the run's failure,
 *  worded `prefix` and its message. What the session's start or resume
 *  failed with passes as itself, for this window to present as it would
 *  its own session's. */
const taskFailed = (prefix: string) => (error: TaskFailed) =>
  Effect.fail(runFailure(`${prefix}${error.message}`));

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
  /** The client, once the link has one; or why it is away for good (a
   *  newer TeXRA's service refused this window, or the service keeps
   *  failing to start), which no wait undoes. */
  const connected = Stream.merge(
    link.client.changes.pipe(
      Stream.filter(Predicate.isNotNull),
      Stream.map((client) => ({ client })),
    ),
    linkRefusals(link).pipe(Stream.map((refused) => ({ refused }))),
  ).pipe(
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.flatMap((reached) =>
      'client' in reached
        ? Effect.succeed(reached.client)
        : Effect.fail(new ServiceUnavailable({ reason: reached.refused })),
    ),
  );
  // The window's own view: the listing, plus the transcripts its readers
  // name, each reader's set held for its scope. A change of that set is a
  // new watch, from the cursor and history the view already holds; the
  // view interrupts the watch it replaces.
  const view = yield* remoteSessionView(key, (aggregates, cursor, debug) =>
    Stream.unwrap(
      Effect.map(link.client.get, (client) =>
        // Offline: the link's return asks again.
        client === null
          ? Stream.empty
          : client['task.watch']({
              workspace,
              subscribe: { debug, cursor, aggregates },
            }),
      ),
    ).pipe(
      Stream.map((frame) => frame.inputs),
      // A service that went ends this read: the link closing its connection
      // interrupts the call, which must not end the view with it, and the
      // next service the link reaches is asked again (below).
      Stream.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Stream.empty
          : Stream.fromEffect(
              Effect.logWarning(
                `The TeXRA service stopped sending ${workspace}; this window's run state no longer updates`,
              ).pipe(Effect.annotateLogs({ data: cause })),
            ).pipe(Stream.drain),
      ),
    ),
  );
  const { subscribe } = view;
  // Each service the link reaches, the one it holds now included (the
  // view's first read may have found none): naming the window's own empty
  // set again has the view ask that service from where the view is. Offline,
  // the watch stops. The window tells the service nothing else: the
  // project's approval policy is its persisted setting, which the service
  // reads itself.
  const window = yield* subscribe([]);
  yield* Effect.forkScoped(
    link.client.changes.pipe(
      Stream.runForEach((client) =>
        client === null ? Effect.void : window.set([]),
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
              Effect.andThen(link.state.get),
              // Why the link is away, or offline when it has not heard yet.
              Effect.flatMap((state) =>
                Effect.fail(
                  runFailure('away' in state ? state.away : SERVICE_OFFLINE),
                ),
              ),
            ),
      ),
    );
  /** The run's stored end from the service's answer, whatever its outcome,
   *  held until this window's fold shows it too: the answer and the fold's
   *  `task.watch` stream arrive apart, so an end that went by the answer
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
        view.changes.pipe(Stream.takeUntil((level) => level.cursor >= at)),
      ),
      end,
    );
  const request: Session['request'] = (runtimeRequest) =>
    callService(
      link,
      (reason) => new Rejected({ reason }),
      (client) =>
        requestOnService(client, workspace, runtimeRequest).pipe(
          // The service's own bridge error (a request it could not parse, a
          // handler that died) is a refusal worded for the user; a runtime
          // refusal arrives as its class.
          Effect.catchTags({
            Invalid: (error) =>
              Effect.fail(new Rejected({ reason: requestErrorText(error) })),
            Internal: (error) =>
              Effect.fail(new Rejected({ reason: requestErrorText(error) })),
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
  /** The run the service started, as this window holds it: the `Run` of
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
        { current: view.current, changes: view.changes, subscribe },
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
      // store, final once it answered.
      events: replayTrace(
        {
          view: {
            inputs: (set, cursor, debug) => watch(set, { cursor, debug }),
          },
          log: {
            drained: Effect.exit(answer).pipe(
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
        callService<unknown, TaskRecordsFailed, ServiceUnavailable>(
          link,
          failedCall,
          (client) => client[`records.${member}`]({ workspace, runId }),
        ),
      ]),
    ) as unknown as RunRecords;
  return {
    roots,
    view: {
      current: view.current,
      changes: view.changes,
      watch,
      read: (runIds) =>
        callService(link, failedCall, (client) =>
          client['session.view']({ workspace, runIds }),
        ),
    },
    records,
    listRuns: callService(link, failedCall, (client) =>
      client['session.listRuns']({ workspace }),
    ),
    deleteRuns: (target) =>
      callService(link, failedCall, (client) =>
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
          Effect.catchTag(
            'TaskFailed',
            taskFailed('The TeXRA service could not start the task: '),
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
        }).pipe(Effect.catchTag('TaskFailed', taskFailed(''))),
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

/**
 * The live view of `task`'s session, as the service's frames build it: one
 * level per change, with `task`'s transcript named so its rows load. Each
 * frame is handed to `onFrame` before it is applied. The stream fails with
 * {@link ServiceUnavailable} when the service stops sending; it never ends on
 * its own. The session view's graph lives as long as the stream, one per
 * watch. Unlike a window's session view, which follows its link through
 * a reconnect, it ends with the client it was given: a terminal attached to
 * a task says the service went, rather than waiting on the next one.
 */
export function watchTask(
  client: ServiceClient,
  task: Pick<TaskSummary, 'workspace' | 'runId'>,
  onFrame: (frame: EventsFrame) => void = () => {},
): Stream.Stream<SessionView, ServiceUnavailable> {
  return Stream.unwrap(
    Effect.gen(function* () {
      // The watch only ends when the service does: the task did not end.
      const ended = yield* Deferred.make<never, ServiceUnavailable>();
      const endWith = (reason: string) =>
        Deferred.fail(
          ended,
          new ServiceUnavailable({
            reason: `The TeXRA service stopped sending task ${task.runId}: ${reason}`,
          }),
        );
      const view = yield* remoteSessionView(
        task.workspace,
        (aggregates, cursor, debug) =>
          client['task.watch']({
            workspace: task.workspace,
            subscribe: { debug, cursor, aggregates },
          }).pipe(
            Stream.tap((frame) => Effect.sync(() => onFrame(frame))),
            Stream.map((frame) => frame.inputs),
            // Each end is said through `ended`, which ends the levels below.
            Stream.concat(
              Stream.fromEffect(endWith('the service closed the watch.')).pipe(
                Stream.drain,
              ),
            ),
            Stream.catch((error) =>
              Stream.fromEffect(endWith(error.message)).pipe(Stream.drain),
            ),
          ),
      );
      // Name the transcript: the view asks for it from where it stands.
      yield* view.subscribe([{ id: task.runId, fromSeq: 0 }]);
      return view.changes.pipe(Stream.interruptWhen(Deferred.await(ended)));
    }),
  );
}
