/**
 * The owner-liveness prober every session graph runs (`sessionGraphLayer` in
 * `./sessionLayer`), apart from the graph that builds it in, and the proof
 * every read of an owner's liveness takes through the process's verdicts,
 * a cold read's (`./readSessionView`) included.
 */
import { Effect, Layer, Stream, SubscriptionRef } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  nodeProcesses,
  type ProcessProbe,
} from '@platform/defaults/nodeProcesses';
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

/**
 * Identity of the process recorded as an aggregate's claim owner: a pid and
 * the opaque process-start identity `nodeProcesses` produced for it when the
 * claim was taken (null where the host could not read one). Liveness is a
 * kernel fact derived from these two fields; nothing here is compared to a
 * clock and no socket protocol is involved. The owner id the database
 * stores decodes to this shape plus the hostname the owner started under
 * (`ownerIdentity` in `@shared/schemas`), which no proof reads.
 */
interface ClaimOwnerRecord {
  readonly pid: number;
  readonly processStart: string | null;
}

/**
 * `kill(pid, 0)` throwing ESRCH is a kernel proof that no such process
 * exists. Success, including EPERM, proves only that some process has the
 * pid; the start identity decides whether it is the recorded one.
 */
const pidProvablyDead = (pid: number): Effect.Effect<boolean> =>
  Effect.try({
    try: () => process.kill(pid, 0),
    catch: (error) =>
      error instanceof Error && 'code' in error && error.code === 'ESRCH',
  }).pipe(
    Effect.match({ onSuccess: () => false, onFailure: (esrch) => esrch }),
  );

/**
 * The single source of liveness truth:
 *
 * | observed                                       | verdict    |
 * | ---------------------------------------------- | ---------- |
 * | `kill(pid, 0)` gives ESRCH                     | dead       |
 * | pid exists, identity equals the record         | alive      |
 * | pid exists, identity differs (pid reuse)       | dead       |
 * | pid exists, identity unreadable on either side | unprovable |
 *
 * The recorded hostname is not compared. A session store opens only on a
 * local filesystem (`localDatabasePath`), so an owner it records ran on
 * this machine or on one whose disk, or a copy of it, this machine now
 * holds; a process of the second kind has no pid here, or its pid names
 * another process, and reads dead. The one exception is on macOS and the
 * BSDs, whose start identity is a time to the second: a process here with
 * the same pid that started in the same second reads alive. A hostname does
 * not identify the machine anyway: macOS renames it with the network it
 * joins, so comparing one would hold a crashed process's runs on every
 * other network. Pids compare only within one pid namespace, so a process
 * inside a container that bind-mounts the store and one outside it read
 * each other dead while both run. A claim taken across that boundary moves
 * in one write transaction, and the process it was taken from has its next
 * append refused as `DatabaseNotOwner`, nothing written.
 *
 * The verdict is total: `nodeProcesses.identity` reports an unreadable
 * identity as undefined rather than rejecting, and the `kill(pid, 0)` beside
 * it folds its own throw, so this effect has no error channel and a prober
 * that yields it cannot be ended by one.
 */
const proveOwnerLiveness = Effect.fn('ownerLiveness.proveOwnerLiveness')(
  function* (
    owner: ClaimOwnerRecord,
  ): Effect.fn.Return<OwnerLiveness, never, ProcessProbe> {
    if (yield* pidProvablyDead(owner.pid)) return 'dead';
    const observed = yield* nodeProcesses.identity(owner.pid);
    if (observed === undefined) {
      // The process may have exited between the two probes.
      if (yield* pidProvablyDead(owner.pid)) return 'dead';
      yield* Effect.logWarning(
        `Claim owner pid ${owner.pid} exists but its start identity cannot be read; its liveness is unprovable`,
      ).pipe(withLogChannel('LeaseOwnerLiveness'));
      return 'unprovable';
    }
    if (owner.processStart === null) {
      yield* Effect.logWarning(
        `Claim owner pid ${owner.pid} exists but its record carries no start identity; its liveness is unprovable`,
      ).pipe(withLogChannel('LeaseOwnerLiveness'));
      return 'unprovable';
    }
    return observed === owner.processStart ? 'alive' : 'dead';
  },
);

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
