/**
 * What a host's run actions check as each request is handled, not only as it
 * was rendered: the run's current `actions`, and whether this window is
 * already resuming it. A pack or clean is held by the process that holds the
 * run (`run.files`), not here. A latexdiff, pack or clean is gated as the
 * run's `files` action.
 */
import { Effect } from 'effect';

import { Rejected } from '@texra-ai/harness';
import { runActionRefusal } from '@texra-ai/harness/schemas';
import type { RunAction, RunId } from '@shared/schemas';
import type { RunView } from '@texra-ai/harness';

export function runActionGuard(view: {
  readonly run: (runId: RunId) => RunView | undefined;
}) {
  /** Runs this process is resuming: a second Resume, and a pack, clean,
   *  diff or restore, is refused while one is in flight, never queued
   *  behind a whole run. Across processes the run's claim answers. */
  const resuming = new Set<RunId>();
  const busy = () => new Rejected({ reason: 'This run is already resuming.' });
  const idle = (runId: RunId): Effect.Effect<void, Rejected> =>
    resuming.has(runId) ? Effect.fail(busy()) : Effect.void;
  return {
    idle,
    /** The run's `actions` must still hold `action`; a run the view no
     *  longer holds is left to the action's own read. */
    require: (runId: RunId, action: RunAction): Effect.Effect<void, Rejected> =>
      Effect.suspend(() => {
        const run = view.run(runId);
        return run === undefined || run.actions.includes(action)
          ? Effect.void
          : Effect.fail(
              new Rejected({ reason: runActionRefusal(run, action) }),
            );
      }),
    /** Run `resume` marked as resuming: checked and marked in one
     *  synchronous step, cleared however it ends. */
    resuming: <A, E, R>(
      resume: Effect.Effect<A, E, R>,
      runId: RunId,
    ): Effect.Effect<A, E | Rejected, R> =>
      Effect.suspend((): Effect.Effect<A, E | Rejected, R> => {
        if (resuming.has(runId)) return Effect.fail(busy());
        resuming.add(runId);
        return resume.pipe(
          Effect.ensuring(Effect.sync(() => resuming.delete(runId))),
        );
      }),
  };
}
