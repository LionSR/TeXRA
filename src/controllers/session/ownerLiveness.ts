/**
 * The owner-liveness prober every session graph runs (`sessionGraphLayer` in
 * `./sessionLayer`), apart from the graph that builds it in.
 */
import { Effect, Layer, Stream, SubscriptionRef } from 'effect';

import { proveOwnerLiveness } from '@agent/storage/leaseOwnerLiveness';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { ownerIdentity, type OwnerId } from '@shared/schemas';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import type { SessionView } from '@shared/session/sessionView';

import { LocalRuntimeSource } from './sessionSources';
import { SessionViewService } from './SessionView';

/** How often the owners the view names are re-probed (PRD 5.2). */
const OWNER_LIVENESS_PROBE_INTERVAL = '5 seconds';

/** The owner ids of the non-terminal runs another process wrote. */
function foreignOwners(view: SessionView, self: OwnerId): OwnerId[] {
  const foreign = [...view.runs.values()].flatMap((run) =>
    run.ownerId !== null &&
    run.ownerId !== self &&
    !isTerminalOutcomePhase(run.status)
      ? [run.ownerId]
      : [],
  );
  return [...new Set(foreign)].sort();
}

/**
 * The liveness prober (PRD 5.2, contract C5): every owner the view names on a
 * non-terminal run other than this process, proved by `kill(pid, 0)` plus the
 * start-identity check per distinct owner, never per run. Probed whenever that
 * owner set changes and on an interval between changes. Alive and unprovable
 * owners hold their runs; only an explicit death verdict permits an
 * interrupted classification. It writes `dead`; `unreadable` is the status
 * machine's.
 */
export const ownerLiveness = Layer.effectDiscard(
  Effect.gen(function* () {
    const view = yield* SessionViewService;
    const local = yield* LocalRuntimeSource;
    const identity = yield* ProcessIdentity;
    const probe = Effect.gen(function* () {
      const owners = foreignOwners(
        yield* SubscriptionRef.get(view.ref),
        identity.ownerId,
      );
      const dead: OwnerId[] = [];
      for (const owner of owners) {
        const liveness = yield* proveOwnerLiveness(ownerIdentity(owner));
        if (liveness === 'dead') dead.push(owner);
      }
      const snapshot = yield* SubscriptionRef.get(local.ref);
      if (
        snapshot.dead.length === dead.length &&
        snapshot.dead.every((owner, i) => owner === dead[i])
      ) {
        return;
      }
      yield* SubscriptionRef.set(local.ref, { ...snapshot, dead });
    });
    const ownerSetChanges = SubscriptionRef.changes(view.ref).pipe(
      Stream.map((current) =>
        foreignOwners(current, identity.ownerId).join(' '),
      ),
      Stream.changes,
    );
    yield* Effect.forkScoped(
      Stream.merge(
        ownerSetChanges,
        Stream.tick(OWNER_LIVENESS_PROBE_INTERVAL),
      ).pipe(
        Stream.mapEffect(() => probe),
        Stream.runDrain,
      ),
    );
  }),
);
