/**
 * `SessionViewService`: the one in-process `SessionView` of a session (PRD
 * one-fold-three-renderers, 7.2). A fold fiber, forked under the layer's
 * scope, folds complete, ordered input batches (`SessionInputs.read`) into a
 * `SubscriptionRef` every renderer of the session reads; nothing else
 * writes it.
 *
 * The reads are re-run for every value of the transcript subscription set,
 * the first included, from the seq the view has retained for each aggregate
 * and from the view's cursor: `switchMap` closes the previous set's reads,
 * and each batch arrives whole, so an incomplete or superseded read never
 * mutates the indexes held by the published view.
 *
 * The service holds no log: the webview builds it over frames
 * (`webviewSessionLayer`). The plane's tail as this view has folded it,
 * `SessionStore.folded`, is derived from `ref` where the log is
 * (`sessionStore.ts`).
 */
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import type { SessionViewAccess } from '@agent/runtime/SessionHandle';
import { aggregateId, type LocalRuntimeState } from '@shared/schemas';
import { Database, type DatabaseReadFailed } from '@shared/session/database';
import { SessionInputs } from '@shared/session/sessionInputs';
import { fold } from '@shared/session/sessionFold';
import {
  emptySessionView,
  type SessionView,
} from '@shared/session/sessionView';
import { announceRunFacts } from '@tools/pluginArms';
import { LocalRuntimeSource, TranscriptSubscriptions } from './sessionSources';
import { WorkspaceRoots } from './WorkspaceRoots';

export class SessionViewService extends Context.Service<
  SessionViewService,
  {
    readonly ref: SubscriptionRef.SubscriptionRef<SessionView>;
    /**
     * `ref` as a level stream: the current view on subscribe, then every
     * later one, ending as the fold does. A reader waiting on a view the
     * fold will never publish must not wait forever: the stream dies with
     * the fold's defect, and ends when the graph closes under it.
     */
    readonly changes: Stream.Stream<SessionView>;
  }
>()('@texra/session/SessionView') {
  static readonly layer = Layer.effect(
    SessionViewService,
    Effect.gen(function* () {
      const inputs = yield* SessionInputs;
      const subscriptions = yield* TranscriptSubscriptions;
      const roots = yield* WorkspaceRoots;
      // Each replay begins with the process reader's sampled verbosity. The
      // transport carries that same policy to the webview fold.
      const ref = yield* SubscriptionRef.make(
        emptySessionView(roots.storage, 0, false),
      );
      const folding = yield* Effect.forkScoped(
        SubscriptionRef.changes(subscriptions.ref).pipe(
          Stream.switchMap((set) =>
            Stream.unwrap(
              SubscriptionRef.get(ref).pipe(
                Effect.map((view) =>
                  inputs.read(
                    set.map((entry) => ({
                      ...entry,
                      fromSeq: view.folded.get(entry.id) ?? entry.fromSeq,
                    })),
                    view.cursor,
                    view.debug,
                  ),
                ),
              ),
            ),
          ),
          // Replay arrives as one batch. An incomplete or superseded read
          // cannot mutate the indexes held by the published view.
          Stream.runForEach((batch) =>
            SubscriptionRef.update(ref, (view) => fold(view, batch)),
          ),
          Effect.tapDefect((defect) =>
            Effect.logError(
              'Session fold died; the view no longer advances',
              defect,
            ),
          ),
        ),
      );
      // The fold's own exit ends the level stream (the merge halts on it): a
      // defect fails every reader of `changes` at the boundary that named it
      // once above; the graph closing, an interrupt, ends them cleanly.
      const changes = SubscriptionRef.changes(ref).pipe(
        Stream.merge(
          Stream.fromEffect(Fiber.await(folding)).pipe(
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
 * A session's view as its handle carries it (`SessionHandle.view`): the
 * fold's level, the replay it is folded from, the transcript subscriptions
 * that decide what it folds, and the local truth it folds beside the rows.
 * For the session's scope it announces what its runs' facts tell this
 * process (`announceRunFacts`).
 * `closed` is the session's: once its doors shut, a subscription or a mark
 * writes nothing.
 */
export const makeSessionViewAccess = (
  storage: string,
  closed: () => boolean,
): Effect.Effect<
  SessionViewAccess,
  DatabaseReadFailed,
  | Scope.Scope
  | Database
  | SessionViewService
  | SessionInputs
  | TranscriptSubscriptions
  | LocalRuntimeSource
> =>
  Effect.gen(function* () {
    const { ref, changes } = yield* SessionViewService;
    const inputs = yield* SessionInputs;
    const subscriptions = yield* TranscriptSubscriptions;
    const local = yield* LocalRuntimeSource;
    // What the session's runs announce from here on, to this process's
    // listeners, for the session's life: rows above the commit the store
    // holds now, so a reopened session never replays history as news.
    const database = yield* Database;
    yield* announceRunFacts(
      changes,
      (runId) =>
        database.readAggregate(aggregateId('run', runId), 1, ['plugin.fact']),
      yield* database.currentCommit,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Session ${storage} stopped announcing its runs' facts`,
        ).pipe(Effect.annotateLogs({ data: Cause.squash(cause) })),
      ),
      Effect.forkScoped,
    );
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
              id: aggregateId('run', id),
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
                  Effect.die(
                    new Error('Session input read produced no replay'),
                  ),
                onSome: (replay) =>
                  Effect.succeed(fold(emptySessionView(storage), replay)),
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
          const rest = state.resumeBlocked.filter((b) => b.runId !== runId);
          if (blocked === null && rest.length === state.resumeBlocked.length)
            return state;
          // The same block again leaves the state, and the view, as it is.
          const held = state.resumeBlocked.find((b) => b.runId === runId);
          if (
            blocked !== null &&
            held !== undefined &&
            held.retry === blocked.retry &&
            held.reason.kind === blocked.reason.kind &&
            held.reason.name === blocked.reason.name
          )
            return state;
          return {
            ...state,
            resumeBlocked:
              blocked === null ? rest : [...rest, { runId, ...blocked }],
          };
        }),
      resumeBlocks: () => SubscriptionRef.getUnsafe(local.ref).resumeBlocked,
    };
  });
