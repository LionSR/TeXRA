/**
 * The owner-liveness prober every session graph runs (`sessionGraphLayer` in
 * `./sessionLayer`), apart from the graph that builds it in, and the one
 * probe a cold read takes (`./readSessionView`).
 */
import { Effect, Layer, Stream, SubscriptionRef } from 'effect';

import { proveOwnerLiveness } from '@agent/storage/leaseOwnerLiveness';
import type { ProcessProbe } from '@platform/defaults/nodeProcesses';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { ownerIdentity, type OwnerId } from '@shared/schemas';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import type { SessionView } from '@shared/session/sessionView';

import { LocalRuntimeSource } from './sessionSources';
import { SessionViewService } from './SessionView';

/** How often the owners the view names are re-probed (PRD 5.2). */
const OWNER_LIVENESS_PROBE_INTERVAL = '5 seconds';

/** The owner ids of the non-terminal runs another process wrote; with no
 *  `self` (a cold read), every owner of a non-terminal run. */
function foreignOwners(view: SessionView, self: OwnerId | null): OwnerId[] {
  const foreign = [...view.runs.values()].flatMap((run) =>
    run.ownerId !== null &&
    run.ownerId !== self &&
    !isTerminalOutcomePhase(run.status)
      ? [run.ownerId]
      : [],
  );
  return [...new Set(foreign)].sort();
}

/** The foreign owners of `view` a probe proves dead, in owner order. */
export const deadOwners = (
  view: SessionView,
  self: OwnerId | null,
): Effect.Effect<OwnerId[], never, ProcessProbe> =>
  Effect.gen(function* () {
    const dead: OwnerId[] = [];
    for (const owner of foreignOwners(view, self)) {
      const liveness = yield* proveOwnerLiveness(ownerIdentity(owner));
      if (liveness === 'dead') dead.push(owner);
    }
    return dead;
  });

/**
 * The liveness prober: every owner the view names on a
 * non-terminal run other than this process, proved by `kill(pid, 0)` plus the
 * start-identity check per distinct owner, never per run. Probed whenever that
 * owner set changes and, while it is not empty, on an interval: a holder
 * that dies reads held until the next tick. Alive and unprovable owners hold
 * their runs; only an explicit death verdict permits an interrupted
 * classification. It writes `dead`; `unreadable` is the session inputs'.
 */
export const ownerLiveness = Layer.effectDiscard(
  Effect.gen(function* () {
    const view = yield* SessionViewService;
    const local = yield* LocalRuntimeSource;
    const identity = yield* ProcessIdentity;
    const probe = Effect.gen(function* () {
      const dead = yield* deadOwners(
        yield* SubscriptionRef.get(view.ref),
        identity.ownerId,
      );
      // One atomic update: a `get` then `set` would let `markDamaged` or
      // `updateLocal` land between them and be overwritten by this stale copy.
      yield* SubscriptionRef.update(local.ref, (snapshot) =>
        snapshot.dead.length === dead.length &&
        snapshot.dead.every((owner, i) => owner === dead[i])
          ? snapshot
          : { ...snapshot, dead },
      );
    });
    yield* Effect.forkScoped(
      SubscriptionRef.changes(view.ref).pipe(
        Stream.map((current) =>
          foreignOwners(current, identity.ownerId).join(' '),
        ),
        Stream.changes,
        // Probed on every change, and again on an interval only while some
        // foreign owner holds a run: a session nobody else writes to runs
        // no timer.
        Stream.switchMap((owners) =>
          owners === ''
            ? Stream.make(undefined)
            : Stream.tick(OWNER_LIVENESS_PROBE_INTERVAL),
        ),
        Stream.mapEffect(() => probe),
        Stream.runDrain,
      ),
    );
  }),
);
