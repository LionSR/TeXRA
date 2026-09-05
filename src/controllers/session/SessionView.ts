/**
 * `SessionViewService`: the one in-process `SessionView` of a session (PRD
 * one-fold-three-renderers, 7.2). A fold fiber, forked under the layer's
 * scope, folds the session's event plane and the three local inputs into a
 * `SubscriptionRef` every renderer of the session reads; nothing else
 * writes it.
 *
 * The cold reads are sequenced, never merged, and re-run for every value of
 * the transcript subscription set, the first included: the listing, the set
 * itself, each subscribed aggregate's history from the seq the view has
 * retained, the current local snapshot, the one replay-complete marker, and
 * then the tail from the view's cursor. `Stream.concat` is what makes the
 * fold's seq threshold order-safe, `switchMap` closes the previous set's
 * reads, and nothing is published before the marker, so a surface mounting
 * onto an existing session never renders the intermediate states of a replay.
 */
import { Context, Effect, Layer, Stream, SubscriptionRef } from 'effect';

import { SessionEvents } from '@agent/runtime/SessionEvents';
import type { FoldInput, SessionEvent } from '@shared/schemas';
import { fold } from '@shared/session/sessionFold';
import {
  emptySessionView,
  type SessionView,
} from '@shared/session/sessionView';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from './sessionSources';
import { WorkspaceRoots } from './WorkspaceRoots';

export class SessionViewService extends Context.Service<
  SessionViewService,
  { readonly ref: SubscriptionRef.SubscriptionRef<SessionView> }
>()('@texra/session/SessionView') {
  static readonly layer = Layer.effect(
    SessionViewService,
    Effect.gen(function* () {
      const events = yield* SessionEvents;
      const liveness = yield* LocalRuntimeSource;
      const chunks = yield* TextChunkSource;
      const subscriptions = yield* TranscriptSubscriptions;
      const roots = yield* WorkspaceRoots;
      // The key is the layer's, not an input: no fold arm carries one. The
      // cursor starts at the layer's tail anchor.
      const empty = emptySessionView(roots.storage, events.anchor);
      const ref = yield* SubscriptionRef.make(empty);
      // Every row enters the fold with the read that delivered it (5.2).
      const from = (read: 'listing' | 'aggregate' | 'all') =>
        Stream.map((event: SessionEvent): FoldInput => ({
          _tag: 'event',
          read,
          event,
        }));
      const reads = SubscriptionRef.changes(subscriptions.ref).pipe(
        Stream.switchMap((set) =>
          Stream.unwrap(
            SubscriptionRef.get(ref).pipe(
              Effect.map((view) =>
                Stream.concat(
                  set.reduce(
                    (history, s) =>
                      Stream.concat(
                        history,
                        events
                          .aggregate(s.id, view.folded.get(s.id) ?? s.fromSeq)
                          .pipe(from('aggregate')),
                      ),
                    Stream.concat(
                      events.listing().pipe(from('listing')),
                      Stream.make<[FoldInput]>({
                        _tag: 'subscriptions',
                        set: [...set],
                      }),
                    ),
                  ),
                  Stream.concat(
                    // The local snapshot is a level: read once here, ahead
                    // of the marker, so the first published view has it.
                    Stream.fromEffect(SubscriptionRef.get(liveness.ref)).pipe(
                      Stream.map((local): FoldInput => ({
                        _tag: 'local',
                        local,
                      })),
                    ),
                    Stream.concat(
                      Stream.make<[FoldInput]>({ _tag: 'replay.complete' }),
                      events.all(view.cursor).pipe(from('all')),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      const local = liveness.changes.pipe(
        Stream.map((local): FoldInput => ({ _tag: 'local', local })),
      );
      const text = chunks.changes.pipe(Stream.map((chunk): FoldInput => chunk));
      yield* Effect.forkScoped(
        Stream.mergeAll([reads, local, text], { concurrency: 3 }).pipe(
          // Each state paired with the input that produced it, so the gate
          // can see the marker without the view carrying a flag for it.
          Stream.mapAccum(
            () => empty,
            (view, input: FoldInput) => {
              const next = fold(view, input);
              return [next, [{ view: next, input }]] as const;
            },
          ),
          Stream.dropWhile(({ input }) => input._tag !== 'replay.complete'),
          Stream.runForEach(({ view }) => SubscriptionRef.set(ref, view)),
        ),
      );
      return { ref };
    }),
  );
}
