/**
 * The owner-liveness prober every session graph runs (`sessionGraphLayer` in
 * `./sessionLayer`), apart from the graph that builds it in, and the proof
 * every read of an owner's liveness takes through the process's verdicts,
 * a cold read's (`./readSessionView`) included.
 */
import { Effect, Layer, Stream, SubscriptionRef } from 'effect';

import { proveOwnerLiveness } from '@agent/storage/leaseOwnerLiveness';
import type { ProcessProbe } from '@platform/defaults/nodeProcesses';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import {
  ownerIdentity,
  type OwnerId,
  type OwnerLiveness,
} from '@shared/schemas';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import type { SessionView } from '@shared/session/sessionView';

import { LocalRuntimeSource } from './sessionSources';
import { SessionViewService } from './SessionView';

/** How often the owners the view names are re-probed. */
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

/** `owner`'s verdict through the process's record (`ProcessIdentity.owners`):
 *  a recorded `dead` is final; any other is proved again and recorded. */
export const proveRecorded = Effect.fn('ownerLiveness.proveRecorded')(
  function* (
    owners: ProcessIdentity['Service']['owners'],
    owner: OwnerId,
  ): Effect.fn.Return<OwnerLiveness, never, ProcessProbe> {
    if ((yield* SubscriptionRef.get(owners)).get(owner) === 'dead')
      return 'dead';
    const verdict = yield* proveOwnerLiveness(ownerIdentity(owner));
    yield* SubscriptionRef.update(owners, (recorded) =>
      recorded.get(owner) === 'dead' || recorded.get(owner) === verdict
        ? recorded
        : new Map(recorded).set(owner, verdict),
    );
    return verdict;
  },
);

/** The foreign owners of `view` a proof finds dead, in owner order. */
export const deadOwners = Effect.fn('ownerLiveness.deadOwners')(function* (
  view: SessionView,
  self: OwnerId | null,
): Effect.fn.Return<OwnerId[], never, ProcessProbe | ProcessIdentity> {
  const { owners: recorded } = yield* ProcessIdentity;
  // Owners are few, so every probe runs at once; results keep owner order.
  const owners = foreignOwners(view, self);
  const verdicts = yield* Effect.forEach(
    owners,
    (owner) => proveRecorded(recorded, owner),
    { concurrency: 'unbounded' },
  );
  return owners.filter((_, i) => verdicts[i] === 'dead');
});

/**
 * The liveness prober: every owner the view names on a
 * non-terminal run other than this process, proved by `kill(pid, 0)` plus the
 * start-identity check per distinct owner, never per run, through the
 * process's verdicts (`ProcessIdentity.owners`). Probed whenever that owner
 * set changes and, while it is not empty, on an interval: a holder that dies
 * reads held until the next tick or another proof. Alive and unprovable
 * owners hold their runs; only an explicit death verdict permits an
 * interrupted classification. It writes the verdicts' `dead`; `unreadable`
 * is the session inputs'.
 */
export const ownerLiveness = Layer.effectDiscard(
  Effect.gen(function* () {
    const view = yield* SessionViewService;
    const local = yield* LocalRuntimeSource;
    const identity = yield* ProcessIdentity;
    yield* Effect.forkScoped(
      SubscriptionRef.changes(identity.owners).pipe(
        Stream.map((verdicts) =>
          [...verdicts.keys()].filter((o) => verdicts.get(o) === 'dead'),
        ),
        // A dead verdict is final: a list as long is the same list.
        Stream.changesWith((a, b) => a.length === b.length),
        // An update, not a `get` then `set`: other writers share the snapshot.
        Stream.runForEach((dead) =>
          SubscriptionRef.update(local.ref, (snapshot) => ({
            ...snapshot,
            dead,
          })),
        ),
      ),
    );
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
        Stream.mapEffect(() =>
          Effect.flatMap(SubscriptionRef.get(view.ref), (current) =>
            deadOwners(current, identity.ownerId),
          ),
        ),
        Stream.runDrain,
      ),
    );
  }),
);
