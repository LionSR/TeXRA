/** The one fold over complete, ordered input batches in every renderer. */
import { Context, Effect, Layer, Stream, SubscriptionRef } from 'effect';

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
  { readonly ref: SubscriptionRef.SubscriptionRef<SessionView> }
>()('@texra/session/SessionView') {
  static readonly layer = Layer.effect(
    SessionViewService,
    Effect.gen(function* () {
      const inputs = yield* SessionInputs;
      const subscriptions = yield* TranscriptSubscriptions;
      const roots = yield* WorkspaceRoots;
      const ref = yield* SubscriptionRef.make(emptySessionView(roots.storage));
      yield* Effect.forkScoped(
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
      return { ref };
    }),
  );
}
