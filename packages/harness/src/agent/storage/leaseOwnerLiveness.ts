import { Effect } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  nodeProcesses,
  type ProcessProbe,
} from '@platform/defaults/nodeProcesses';
import type { OwnerLiveness } from '@shared/schemas';

const CHANNEL = 'LeaseOwnerLiveness';

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
 * another process, and reads dead. A hostname does not identify the
 * machine anyway: macOS renames it with the network it joins, so comparing
 * one would hold a crashed process's runs on every other network. Pids
 * compare only within one pid namespace, so a process inside a container
 * that bind-mounts the store and one outside it read each other dead while
 * both run. A claim taken across that boundary moves in one write
 * transaction, and the process it was taken from has its next append
 * refused as `DatabaseNotOwner`, nothing written.
 *
 * The verdict is total: `nodeProcesses.identity` reports an unreadable
 * identity as undefined rather than rejecting, and the `kill(pid, 0)` beside
 * it folds its own throw, so this effect has no error channel and a prober
 * that yields it cannot be ended by one.
 */
export const proveOwnerLiveness = Effect.fn(
  'leaseOwnerLiveness.proveOwnerLiveness',
)(function* (
  owner: ClaimOwnerRecord,
): Effect.fn.Return<OwnerLiveness, never, ProcessProbe> {
  if (yield* pidProvablyDead(owner.pid)) return 'dead';
  const observed = yield* nodeProcesses.identity(owner.pid);
  if (observed === undefined) {
    // The process may have exited between the two probes.
    if (yield* pidProvablyDead(owner.pid)) return 'dead';
    yield* Effect.logWarning(
      `Claim owner pid ${owner.pid} exists but its start identity cannot be read; its liveness is unprovable`,
    ).pipe(withLogChannel(CHANNEL));
    return 'unprovable';
  }
  if (owner.processStart === null) {
    yield* Effect.logWarning(
      `Claim owner pid ${owner.pid} exists but its record carries no start identity; its liveness is unprovable`,
    ).pipe(withLogChannel(CHANNEL));
    return 'unprovable';
  }
  return observed === owner.processStart ? 'alive' : 'dead';
});
