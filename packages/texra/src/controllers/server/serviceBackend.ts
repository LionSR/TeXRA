/**
 * A window's session held by the background service: the `SessionBackend`
 * a window drives when its runs run in `texra serve`. Launches, resumes and
 * requests are procedures of the service, so this window writes nothing to
 * the run history; the frames its ports render are the service's, with this
 * window's own host snapshot merged in; and the view it reads run state from
 * is the service's listing, folded here.
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
  Unavailable,
  type RequestError,
} from '@texra-ai/harness';
import {
  buildTerminalRunEndResult,
  type RunEndResult,
} from '@agent/runtime/RunEndResult';
import {
  RUN_OUTCOME,
  type RunId,
  type TranscriptSubscription,
} from '@shared/schemas';
import { isLiveRun } from '@shared/session/sessionView';
import type {
  EventsFrame,
  RequestErrorWire,
} from '@shared/session/sessionFrames';
import type { SessionBackend } from '@texra/controllers/session/sessionBackend';
import { WebviewSessions } from '@texra/controllers/session/webviewSessionLayer';
import { generateRunId } from '@utils/core';

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

/**
 * The backend of `workspace`'s session in the service, keyed by `key` (the
 * session's storage root, as this window spells it). The view it folds
 * lives for the caller's scope.
 */
export const serviceSessionBackend = Effect.fn('serviceSessionBackend')(
  function* (
    link: ServiceLink,
    workspace: string,
    key: string,
  ): Effect.fn.Return<SessionBackend, never, Scope.Scope> {
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
    // The window's own view: the listing, plus the transcripts its ports
    // name. A change of that set is a new generation of one watch, from the
    // cursor and history the view already holds, as a webview resubscribes.
    const ports = new Map<string, readonly TranscriptSubscription[]>();
    const watch = yield* FiberHandle.make<void, never>();
    const lane = Semaphore.makeUnsafe(1);
    let generation = 0;
    const resubscribe = lane.withPermits(1)(
      Effect.gen(function* () {
        generation += 1;
        const view = yield* SubscriptionRef.get(graph.view.ref);
        const named = new Set(
          [...ports.values()].flatMap((set) => set.map((entry) => entry.id)),
        );
        const aggregates = [...named].map((id) => ({
          id,
          fromSeq: view.folded.get(id) ?? 0,
        }));
        yield* graph.frames.begin(generation);
        yield* graph.subscriptions.set(WINDOW_PORT, aggregates);
        const client = yield* SubscriptionRef.get(link.client);
        // Offline: the link's return resubscribes.
        if (client === null) return yield* FiberHandle.clear(watch);
        yield* FiberHandle.run(
          watch,
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
    // The window's approval policy, told again to a service the link
    // reaches anew, which holds none.
    let policy: Parameters<SessionBackend['setApprovalPolicy']>[0] | undefined;
    const tellPolicy = (client: ServiceClient) =>
      policy === undefined
        ? Effect.void
        : client['project.policy']({ workspace, policy }).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `The TeXRA service did not take ${workspace}'s approval policy; its tasks keep the previous one`,
              ).pipe(Effect.annotateLogs({ data: error })),
            ),
          );
    // The service went (offline: the watch stops) or the link reached it
    // again (the view resubscribes from where it is).
    yield* Effect.forkScoped(
      SubscriptionRef.changes(link.client).pipe(
        Stream.drop(1),
        Stream.runForEach((client) =>
          client === null
            ? Effect.void
            : Effect.andThen(tellPolicy(client), resubscribe),
        ),
      ),
    );
    /** What a task the service runs ends with: asked of the service the
     *  link holds, again of the next one if the link is lost meanwhile (a
     *  retired service finishes its tasks first). One that cannot answer
     *  ends it, cancelled, for this window. */
    const ended = (runId: RunId): Effect.Effect<RunEndResult> =>
      Effect.flatMap(connected, (client) =>
        client['task.ended']({ workspace, runId }),
      ).pipe(
        Effect.retry({ times: 2 }),
        Effect.map((end): RunEndResult => ({ ...end, runId })),
        Effect.catch((error) =>
          Effect.logWarning(
            `The TeXRA service stopped before task ${runId} ended`,
          ).pipe(
            Effect.annotateLogs({ data: error }),
            Effect.as(buildTerminalRunEndResult(RUN_OUTCOME.CANCELLED, runId)),
          ),
        ),
      );
    return {
      key,
      view: {
        ref: graph.view.ref,
        changes: SubscriptionRef.changes(graph.view.ref),
      },
      frames: (port, host, subscribe) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Host-only frames carry the cursor the service last framed, so
            // the window's fold never sees its tail move backwards.
            const cursor = yield* Ref.make(subscribe.cursor);
            // Each service the link holds serves the port from the cursor
            // it last framed; the fold drops transcript rows it holds.
            const served = SubscriptionRef.changes(link.client).pipe(
              Stream.switchMap((client) =>
                client === null
                  ? Stream.empty
                  : Stream.unwrap(
                      Effect.map(Ref.get(cursor), (at) =>
                        client['task.watch']({
                          workspace,
                          subscribe: { ...subscribe, session: key, cursor: at },
                        }),
                      ),
                    ).pipe(
                      Stream.tap((frame) => Ref.set(cursor, frame.cursor)),
                      // This window's key; its host snapshot rides the
                      // frames below.
                      Stream.map((frame): EventsFrame => ({
                        ...frame,
                        session: key,
                      })),
                      // A lost service's stream fails, or is interrupted
                      // when the link closes its connection: either ends
                      // this service's part, and the next one takes over.
                      Stream.catchCause((cause) =>
                        Cause.hasInterruptsOnly(cause)
                          ? Stream.empty
                          : Stream.fromEffect(
                              Effect.logWarning(
                                `The TeXRA service stopped sending port ${port}; it resumes when the service is back`,
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
            const hosts = SubscriptionRef.changes(host).pipe(
              Stream.filter((snapshot) => snapshot !== null),
              Stream.mapEffect((snapshot) =>
                Effect.map(Ref.get(cursor), (at): EventsFrame => ({
                  kind: 'events',
                  session: key,
                  generation: subscribe.generation,
                  cursor: at,
                  events: [],
                  chunks: [],
                  local: null,
                  host: snapshot,
                  debug: null,
                  replayComplete: false,
                  existence: null,
                })),
              ),
            );
            return Stream.merge(served, hosts, { haltStrategy: 'left' });
          }),
        ),
      transcripts: (port, set) =>
        Effect.suspend(() => {
          if (set.length === 0) ports.delete(port);
          else ports.set(port, set);
          return resubscribe;
        }),
      request: (request) =>
        call(
          () => new Rejected({ reason: OFFLINE }),
          (client) =>
            client['task.request']({ workspace, request }).pipe(
              Effect.mapError(requestError),
            ),
        ),
      launch: (request, options) =>
        call(
          () => new Error(OFFLINE),
          (client) =>
            client['task.start']({
              workspace,
              runId: request.runId ?? generateRunId(),
              config: request.config,
              continues: options.continues ?? null,
              preferHelperModel: options.preferHelperModel ?? false,
              ownApiKeyFallback: options.ownApiKeyFallback ?? false,
              approveDelegatedWork: options.approveDelegatedWork ?? false,
            }).pipe(
              Effect.mapError(
                (error) =>
                  new Error(
                    `The TeXRA service could not start the task: ${error.message}`,
                  ),
              ),
            ),
        ).pipe(
          Effect.tap((runId) => options.onRun?.(runId) ?? Effect.void),
          Effect.tap((runId) =>
            Effect.sync(() => options.onRunResolved?.(runId)),
          ),
          Effect.flatMap(ended),
        ),
      resume: (runId) =>
        call(
          () => new Unavailable({ runId, reason: OFFLINE }),
          (client) =>
            client['task.resume']({ workspace, runId }).pipe(
              Effect.mapError(
                (error) => new Unavailable({ runId, reason: error.message }),
              ),
            ),
        ).pipe(
          // A workflow answers with its whole run, as a window's own session
          // does; any other run answers once it is resumed.
          Effect.flatMap((resumed) => {
            if (resumed === null) return Effect.succeed(null);
            const { runId: resumedId } = resumed;
            if (!resumed.workflow)
              return Effect.succeed({ runId: resumedId, result: null });
            return Effect.map(
              ended(resumedId),
              (result): { runId: RunId; result: RunEndResult | null } => ({
                runId: resumedId,
                result,
              }),
            );
          }),
        ),
      controls: (runId) => {
        const run = SubscriptionRef.getUnsafe(graph.view.ref).runs.get(runId);
        if (run === undefined || !isLiveRun(run)) return undefined;
        return {
          // The service checks the switch against the run when it is asked.
          modelSwitchDisabledReason: () => Effect.succeed(undefined),
          switchModel: (model) =>
            call(
              () => new Error(OFFLINE),
              (client) =>
                client['task.model']({ workspace, runId, model }).pipe(
                  Effect.mapError((error) => new Error(error.message)),
                ),
            ),
        };
      },
      ended,
      preview: (requestId) =>
        call(
          () => new Error(OFFLINE),
          (client) =>
            client['request.preview']({ workspace, requestId }).pipe(
              Effect.mapError((error) => new Error(error.message)),
            ),
        ),
      setApprovalPolicy: (next) =>
        Effect.suspend(() => {
          policy = next;
          // Offline: told when the link is back.
          const client = SubscriptionRef.getUnsafe(link.client);
          return client === null ? Effect.void : tellPolicy(client);
        }),
    };
  },
);
