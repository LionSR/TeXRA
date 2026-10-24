/**
 * One resume of a run in flight per session: a second caller joins the one
 * running instead of starting another, and hears its result.
 */
import { Deferred, Effect } from 'effect';

import type { ResumeAttempt } from '@agent/runtime/resumeRun';
import type { RunId } from '@shared/schemas';

/** A resume's result, and whether this caller joined one in flight. */
export type Resumed = {
  readonly result: ResumeAttempt;
  readonly joined: boolean;
};

/** The resumes in flight here, by run. */
export class Resumes {
  /** The runs whose resume is in flight here. */
  readonly inFlight = new Set<RunId>();
  private readonly running = new Map<
    RunId,
    { readonly done: Deferred.Deferred<ResumeAttempt, Error>; joiners: number }
  >();

  /** One resume of `runId` at a time; a joiner (`onJoined`) hears its result. */
  once<R>(
    runId: RunId,
    resume: Effect.Effect<ResumeAttempt, Error, R>,
    onJoined?: () => void,
  ): Effect.Effect<Resumed, Error, R> {
    return Effect.suspend((): Effect.Effect<Resumed, Error, R> => {
      const running = this.running.get(runId);
      if (running !== undefined) {
        running.joiners += 1;
        onJoined?.();
        return Effect.map(Deferred.await(running.done), (result) => ({
          result,
          joined: true,
        })).pipe(Effect.ensuring(Effect.sync(() => (running.joiners -= 1))));
      }
      const done = Deferred.makeUnsafe<ResumeAttempt, Error>();
      this.running.set(runId, { done, joiners: 0 });
      this.inFlight.add(runId);
      return resume.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            this.running.delete(runId);
            this.inFlight.delete(runId);
            Deferred.doneUnsafe(done, exit);
          }),
        ),
        Effect.map((result) => ({ result, joined: false })),
      );
    });
  }

  /** Settles when `runId`'s resume in flight here ends; at once if none. */
  settled(runId: RunId): Effect.Effect<void> {
    const done = this.running.get(runId)?.done;
    return done
      ? Effect.asVoid(Effect.exit(Deferred.await(done)))
      : Effect.void;
  }

  /** Whether a caller is joined to `runId`'s resume in flight. */
  joined(runId: RunId): boolean {
    return (this.running.get(runId)?.joiners ?? 0) > 0;
  }
}
