import { Effect } from 'effect';
/**
 * Whether a run is still going, decided from facts that outlive this process:
 * the gate a caller asks before advancing past a run that recorded no
 * outcome. A caller that holds a `run.end` row decides from it first; this
 * answers only for a run without one. Display surfaces read the session fold
 * instead, which has already decided all of this for every run at once.
 *
 * "No handle in this process" is not liveness. A run this shell never
 * launched, one another TeXRA process owns, and one whose owner crashed all
 * look identical from the registry, so a missing handle can never on its own
 * justify calling a run interrupted. The ladder:
 *
 * 1. a handle in this process: the run is live here;
 * 2. the run claim: held by a live foreign owner, or by this process with no
 *    run behind it: nothing terminal may be claimed, and the reason is shown;
 * 3. no owner: the run stopped without recording how it ended: interrupted
 *    (a crash, or a host that quit).
 *
 * The claim alone is the liveness authority (R6): single-owner sessions make
 * ownership the fact that says whether anything is still running, and the
 * existence of a `flow.snapshot` says only whether there is something to
 * continue, which is the resume path's question, not this one.
 */

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { Runs } from '@agent/runtime/runRegistry';
import { withLogChannel } from '@logger/effectLog';
import { type RunId } from '@shared/schemas';
import { runHeldClause } from '@shared/runs/runStatusDisplay';
import { claimStanding } from '@shared/session/database';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'RunLiveness';

/**
 * What may be said about a run right now. `unsettled` carries a mid-sentence
 * clause naming the fact that forbids a terminal reading, so each caller can
 * word it in its own voice.
 */
export type RunLiveness =
  | { readonly kind: 'live' }
  | { readonly kind: 'unsettled'; readonly reason: string }
  | { readonly kind: 'interrupted' };

/**
 * This process holds the claim and tracks no run for it: the registry and the
 * claim disagree with nothing durable to fall back on, which is a leak to
 * report, never a run to call interrupted.
 */
const OWNED_HERE_REASON = "held by this process's claim with no live run";

export const resolveRunLiveness = Effect.fn('resolveRunLiveness')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<RunLiveness, never, Runs> {
  const runs = yield* Runs;
  if (runs.getHandle(runId)) return { kind: 'live' };

  return yield* Effect.gen(function* (): Effect.fn.Return<RunLiveness, Error> {
    const standing = claimStanding(yield* session.claimOwner(runId));
    if (standing.kind === 'self') {
      yield* Effect.logWarning(
        `Run ${runId} holds this process's claim with no tracked run and no recorded outcome; reporting it as unsettled rather than interrupted`,
      ).pipe(withLogChannel(CHANNEL));
      return { kind: 'unsettled', reason: OWNED_HERE_REASON };
    }
    if (standing.kind === 'held') {
      return { kind: 'unsettled', reason: runHeldClause(standing.owner) };
    }
    // Nobody owns the run and nothing recorded how it ended: it stopped
    // without finishing.
    return { kind: 'interrupted' };
  }).pipe(
    Effect.catch((error) => {
      const cause = toErrorMessage(error);
      return Effect.logWarning(
        `Cannot read the durable facts for run ${runId}: ${cause}`,
      ).pipe(
        Effect.annotateLogs({ data: error }),
        withLogChannel(CHANNEL),
        Effect.as({
          kind: 'unsettled',
          reason: `in a state this process cannot read (${cause})`,
        } as RunLiveness),
      );
    }),
  );
});
