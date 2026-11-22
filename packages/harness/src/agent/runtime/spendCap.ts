/**
 * A run's spend cap: the amount its launch named (`run.start.maxCostUsd`),
 * which the session view carries beside what the run and every run under
 * it have spent (`treeUsage`).
 *
 * One watcher per session holds every run to its cap, whoever launched it
 * and whether or not a call waits for it. The cap is a fact of the run, so
 * a run resumed after it reached its cap is stopped again: more spend takes
 * a new run. The cap is read after each priced reply commits, never before
 * a request, so the tree can pass it by the replies in flight when it is
 * reached.
 */
// Third-party imports
import { Effect, Stream } from 'effect';

// Local imports
import { RunRegistry } from '@agent/runtime/runRegistry';
import { logFailure } from '@logger/effectLog';
import type { RunId, RunStopReason } from '@shared/schemas';
import { SessionViewAccess } from '@shared/session/runHistory';
import type { RunView, SessionView } from '@shared/session/sessionView';

const CHANNEL = 'spendCap';

/** The runs still open at or under `run`: itself, or under an ended run
 *  the runs it left running. */
function* openUnder(view: SessionView, run: RunView): Generator<RunId> {
  if (run.outcome === null) {
    yield run.id;
    return;
  }
  for (const childId of run.childIds) {
    const child = view.runs.get(childId);
    if (child !== undefined) yield* openUnder(view, child);
  }
}

/** The open runs a reached cap stops. A stop covers the runs under the one
 *  it names, so each capped tree is named once, at its top open runs. */
function* toStop(view: SessionView): Generator<RunId> {
  for (const run of view.runs.values())
    if (run.maxCostUsd !== null && run.treeUsage.cost >= run.maxCostUsd)
      yield* openUnder(view, run);
}

/**
 * Stops each run that has reached its cap, with the runs under it, for as
 * long as the session's view changes. A stop already asked records nothing
 * a second time, so a view that changes while one commits asks again at no
 * cost.
 */
export const stopRunsAtCap: Effect.Effect<
  void,
  never,
  RunRegistry | SessionViewAccess
> = Effect.gen(function* () {
  const { changes } = yield* SessionViewAccess;
  const runs = yield* RunRegistry;
  yield* Stream.runForEach(changes, (view) =>
    Effect.forEach(
      new Set(toStop(view)),
      (runId) =>
        runs
          .stop(runId, 'cap')
          .pipe(
            Effect.catch(
              logFailure(
                CHANNEL,
                `Run ${runId}: its stop at its spend cap was not recorded`,
              ),
            ),
          ),
      { discard: true },
    ),
  );
});

/** The sentence for a run stopped at its own cap, or null when `stop` was
 *  not a cap's or the cap reached was a run's above it. */
export function capReached(
  view: SessionView,
  runId: RunId,
  stop: RunStopReason | undefined,
): string | null {
  const run = view.runs.get(runId);
  if (stop !== 'cap' || run === undefined || run.maxCostUsd === null)
    return null;
  const { cost } = run.treeUsage;
  if (cost < run.maxCostUsd) return null;
  return `reached its spend cap of $${run.maxCostUsd} before it finished (spent $${Number(cost.toPrecision(4))}, the runs it started included); its run was stopped.`;
}
