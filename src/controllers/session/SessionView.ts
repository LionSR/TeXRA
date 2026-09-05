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
 * `SessionGraph.folded`, is derived from `ref` where the log is, in the
 * session graph opener (`sessionLayer.ts`).
 */
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Stream,
  SubscriptionRef,
} from 'effect';

import { SessionInputs } from '@shared/session/sessionInputs';
import { fold } from '@shared/session/sessionFold';
import {
  emptySessionView,
  type SessionView,
} from '@shared/session/sessionView';
import { TranscriptSubscriptions } from './sessionSources';
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
      const ref = yield* SubscriptionRef.make(emptySessionView(roots.storage));
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
