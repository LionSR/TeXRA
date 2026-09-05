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
 * The fold's unit is a frame: the cold reads arrive in frames of
 * `REPLAY_FRAME_INPUTS`, so a workflow board the replay touches derives its
 * run model once per frame rather than once per entry, while the marker, the
 * tail, and the two live inputs arrive one per frame.
 *
 * `all` is the plane's tail as this view has folded it: the same rows
 * `SessionEvents.all` delivers, woken by the view's cursor instead of the
 * log's level, so a reader that reads the view beside each row (the
 * canonical-store applier, until lane 4 retires it) never sees a row the
 * fold has not.
 */
import { Context, Effect, Layer, Stream, SubscriptionRef } from 'effect';

import {
  SessionEventLog,
  SessionEvents,
  tailFrom,
  type SessionCursor,
} from '@agent/runtime/SessionEvents';
import { createLog } from '@logger/logUtils';
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

const logger = createLog('sessionView');

/** What one `fold` call consumes: the cold reads in frames of this many
 *  inputs, everything else one input per frame. Nothing is published before
 *  the marker, so the frame size costs no latency, only buffer. */
type Frame = readonly FoldInput[];
const REPLAY_FRAME_INPUTS = 512;
const single = (input: FoldInput): Frame => [input];

export class SessionViewService extends Context.Service<
  SessionViewService,
  {
    readonly ref: SubscriptionRef.SubscriptionRef<SessionView>;
    /** Every tail row above `fromCommit` in commit order, released once
     *  `ref` holds the state that folded it. */
    readonly all: (fromCommit: SessionCursor) => Stream.Stream<SessionEvent>;
  }
>()('@texra/session/SessionView') {
  static readonly layer = Layer.effect(
    SessionViewService,
    Effect.gen(function* () {
      const log = yield* SessionEventLog;
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
                    // The local snapshot is a level: read once here, ahead
                    // of the marker, so the first published view has it.
                    Stream.fromEffect(SubscriptionRef.get(liveness.ref)).pipe(
                      Stream.map((local): FoldInput => ({
                        _tag: 'local',
                        local,
                      })),
                    ),
                  ).pipe(Stream.grouped(REPLAY_FRAME_INPUTS)),
                  Stream.concat(
                    Stream.make(single({ _tag: 'replay.complete' })),
                    events
                      .all(view.cursor)
                      .pipe(from('all'), Stream.map(single)),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      const local = liveness.changes.pipe(
        Stream.map((local): FoldInput => ({ _tag: 'local', local })),
        Stream.map(single),
      );
      const text = chunks.changes.pipe(Stream.map(single));
      yield* Effect.forkScoped(
        Stream.mergeAll([reads, local, text], { concurrency: 3 }).pipe(
          // Each state paired with the frame that produced it, so the gate
          // can see the marker without the view carrying a flag for it.
          Stream.mapAccum(
            () => empty,
            (view, inputs: Frame) => {
              const next = fold(view, inputs);
              return [next, [{ view: next, inputs }]] as const;
            },
          ),
          Stream.dropWhile(
            ({ inputs }) => !inputs.some((i) => i._tag === 'replay.complete'),
          ),
          Stream.runForEach(({ view }) => SubscriptionRef.set(ref, view)),
          // A fold defect ends the view here: every renderer of the session
          // and every reader of `all` stop at this cursor, so the cause is
          // named once at the boundary instead of leaving with the fiber.
          Effect.tapDefect((defect) =>
            Effect.sync(() => {
              logger.error('Session fold died; the view no longer advances', {
                data: defect,
              });
            }),
          ),
        ),
      );
      const all = (fromCommit: SessionCursor): Stream.Stream<SessionEvent> =>
        tailFrom(
          log.readAll,
          {
            get: SubscriptionRef.get(ref).pipe(Effect.map((v) => v.cursor)),
            changes: SubscriptionRef.changes(ref).pipe(
              Stream.map((v) => v.cursor),
            ),
          },
          fromCommit,
        );
      return { ref, all };
    }),
  );
}
