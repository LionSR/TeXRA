/**
 * `SessionViewService`: the one in-process `SessionView` of a session. An
 * update fiber, forked under the layer's scope, applies complete, ordered
 * input batches (`SessionInputs.read`) to the session's view updater and
 * publishes each result to a `SubscriptionRef` every renderer of the session
 * reads; nothing else writes it.
 *
 * The reads are re-run for every value of the transcript subscription set,
 * the first included, from the seq the view has applied for each aggregate
 * and from the view's cursor: `switchMap` closes the previous set's reads,
 * and each batch arrives whole, so an incomplete or superseded read never
 * reaches the updater.
 *
 * The service holds no log: a view across a process boundary is built from
 * its transport's inputs (`RemoteSessionView`). The plane's tail as this view
 * has applied it, `SessionStore.folded`, is derived from `ref` where the log
 * is (`sessionStore.ts`).
 */
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import type {
  SessionLog,
  SessionViewAccess,
} from '@agent/runtime/SessionHandle';
import {
  qualifyAggregateId,
  ToolEditContentSchema,
  type LocalRuntimeState,
  type TranscriptSubscription,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import type {
  PendingRequest,
  SessionView as ReadonlySessionView,
} from '@shared/session/readonlyViews';
import type { Outcome } from '@shared/session/runtimeRequest';
import { SessionInputs } from '@shared/session/sessionInputs';
import { makeSessionViewUpdater } from '@shared/session/sessionViewUpdate';
import type { SessionView } from '@shared/session/sessionView';
import { LocalRuntimeSource, TranscriptSubscriptions } from './sessionSources';
import { WorkspaceRoots } from './WorkspaceRoots';

export class SessionViewService extends Context.Service<
  SessionViewService,
  {
    readonly ref: SubscriptionRef.SubscriptionRef<SessionView>;
    /**
     * `ref` as a level stream: the current view on subscribe, then every
     * later one, ending as the update fiber does. A reader waiting on a view
     * that will never be published must not wait forever: the stream dies
     * with the fiber's defect, and ends when the graph closes under it.
     */
    readonly changes: Stream.Stream<SessionView>;
  }
>()('@texra-ai/harness/session/SessionView') {
  static readonly layer = Layer.effect(
    SessionViewService,
    Effect.gen(function* () {
      const inputs = yield* SessionInputs;
      const subscriptions = yield* TranscriptSubscriptions;
      const roots = yield* WorkspaceRoots;
      // Each replay begins with the process reader's sampled verbosity. The
      // transport carries that same policy to the webview's view.
      const updater = makeSessionViewUpdater(roots.storage);
      const ref = yield* SubscriptionRef.make(updater.current());
      const updating = yield* Effect.forkScoped(
        SubscriptionRef.changes(subscriptions.ref).pipe(
          Stream.switchMap((set) =>
            Stream.unwrap(
              SubscriptionRef.get(ref).pipe(
                Effect.map((view) =>
                  inputs.read(
                    set.map((entry) => ({
                      ...entry,
                      fromSeq:
                        view.transcriptSeq.get(entry.id) ?? entry.fromSeq,
                    })),
                    view.cursor,
                    view.debug,
                  ),
                ),
              ),
            ),
          ),
          // Replay arrives as one batch, so an incomplete or superseded read
          // never reaches the updater.
          Stream.runForEach((batch) =>
            Effect.suspend(() =>
              SubscriptionRef.set(ref, updater.apply(batch)),
            ),
          ),
          Effect.tapDefect((defect) =>
            Effect.logError(
              'Session view update died; the view no longer advances',
              defect,
            ),
          ),
        ),
      );
      // The update fiber's own exit ends the level stream (the merge halts on
      // it): a defect fails every reader of `changes` at the boundary that
      // named it once above; the graph closing, an interrupt, ends them
      // cleanly.
      const changes = SubscriptionRef.changes(ref).pipe(
        Stream.merge(
          Stream.fromEffect(Fiber.await(updating)).pipe(
            Stream.flatMap((exit) =>
              Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                ? Stream.failCause(exit.cause)
                : Stream.empty,
            ),
          ),
          { haltStrategy: 'right' },
        ),
      );
      return { ref, changes };
    }),
  );
}

/**
 * A session's view built where its store is not: a webview, a renderer, a
 * client of another process. The caller serves `SessionInputs` from its
 * transport, in the order the store's reader produced them; the layer runs
 * the same updater over them a session runs over its store, keyed by the
 * session's storage root, and `subscribe` names the aggregates each of the
 * caller's ports wants transcripts for (an empty set removes the port).
 */
export class RemoteSessionView extends Context.Service<
  RemoteSessionView,
  {
    /** The current view. */
    readonly current: () => ReadonlySessionView;
    /** The current view, then every later one; as
     *  `SessionViewService.changes`, it ends, or dies, with the updates. */
    readonly changes: Stream.Stream<ReadonlySessionView>;
    readonly subscribe: (
      port: string,
      set: readonly TranscriptSubscription[],
    ) => Effect.Effect<void>;
  }
>()('@texra-ai/harness/session/RemoteSessionView') {
  /** Fresh per call: two views never share an updater, even in one memo
   *  map. */
  static layer(
    storage: string,
  ): Layer.Layer<RemoteSessionView, never, SessionInputs> {
    return Layer.fresh(
      Layer.effect(
        RemoteSessionView,
        Effect.gen(function* () {
          const { ref, changes } = yield* SessionViewService;
          const subscriptions = yield* TranscriptSubscriptions;
          return {
            current: () => SubscriptionRef.getUnsafe(ref),
            changes,
            subscribe: subscriptions.set,
          };
        }),
      ).pipe(
        Layer.provide(
          SessionViewService.layer.pipe(
            Layer.provideMerge(TranscriptSubscriptions.layer),
            Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
          ),
        ),
      ),
    );
  }
}

/**
 * A session's view as its handle carries it (`SessionHandle.view`): the
 * current view, the replay it is built from, the transcript subscriptions
 * that decide which transcripts it holds, and the local runtime state it
 * applies beside the rows.
 * `closed` is the session's: once its doors shut, a subscription or a mark
 * writes nothing.
 */
export const makeSessionViewAccess = Effect.fn(
  'SessionView.makeSessionViewAccess',
)(function* (
  storage: string,
  closed: () => boolean,
): Effect.fn.Return<
  SessionViewAccess,
  DatabaseReadFailed,
  | Scope.Scope
  | SessionViewService
  | SessionInputs
  | TranscriptSubscriptions
  | LocalRuntimeSource
> {
  const { ref, changes } = yield* SessionViewService;
  const inputs = yield* SessionInputs;
  const subscriptions = yield* TranscriptSubscriptions;
  const local = yield* LocalRuntimeSource;
  /** Update the local truth unless the session has closed. */
  const updateLocal = (
    next: (state: LocalRuntimeState) => LocalRuntimeState,
  ): Effect.Effect<void> =>
    Effect.suspend(() =>
      closed() ? Effect.void : SubscriptionRef.update(local.ref, next),
    );
  return {
    ref,
    changes,
    run: (runId) => SubscriptionRef.getUnsafe(ref).runs.get(runId),
    read: (runIds) =>
      inputs
        .read(
          runIds.map((id) => ({
            id: qualifyAggregateId('run', id),
            fromSeq: 0,
          })),
          0,
          false,
        )
        .pipe(
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.die(new Error('Session input read produced no replay')),
              onSome: (replay) =>
                Effect.sync(() =>
                  makeSessionViewUpdater(storage).apply(replay),
                ),
            }),
          ),
        ),
    inputs: inputs.read,
    subscribe: (port, set) =>
      Effect.suspend(() =>
        closed() ? Effect.void : subscriptions.set(port, set),
      ),
    markResumeBlocked: (runId, blocked) =>
      updateLocal((state) => {
        const held = state.resumeBlocked.find((b) => b.runId === runId);
        // The same block again, or none again, leaves the state, and the
        // view, as it is.
        const same =
          blocked === null
            ? held === undefined
            : held !== undefined &&
              held.reason.kind === blocked.kind &&
              held.reason.name === blocked.name;
        if (same) return state;
        const rest = state.resumeBlocked.filter((b) => b.runId !== runId);
        return {
          ...state,
          resumeBlocked:
            blocked === null ? rest : [...rest, { runId, reason: blocked }],
        };
      }),
    resumeBlocks: () => SubscriptionRef.getUnsafe(local.ref).resumeBlocked,
  };
});

/**
 * A surface's `request.preview` of `pending`: the content its row names,
 * read back from the store under that address. Null for a request the view
 * no longer lists (none given), one of another kind, or one an earlier
 * build wrote, which has no content to show: the card answers from its
 * payload.
 */
export const toolEditPreview = (
  log: Pick<SessionLog, 'blobs'>,
  pending: PendingRequest | undefined,
): Effect.Effect<Extract<Outcome, { kind: 'preview' }>> => {
  const address =
    pending?.payload.kind === 'toolEdit'
      ? pending.payload.data.content
      : undefined;
  if (address === undefined)
    return Effect.succeed({ kind: 'preview', preview: null });
  // The row links the blob, which the store keeps while the row lives: a
  // read that fails or finds nothing is a corrupt store.
  return Effect.map(Effect.orDie(log.blobs([address])), (held) => {
    const text = held.get(address);
    if (text === undefined)
      throw new Error(`The store holds no tool edit proposal at ${address}`);
    const preview = Schema.decodeUnknownSync(ToolEditContentSchema)(
      JSON.parse(text),
    );
    return { kind: 'preview', preview };
  });
};
