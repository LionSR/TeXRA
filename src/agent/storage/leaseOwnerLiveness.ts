import * as os from 'node:os';
import { Effect } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import type { OwnerLiveness } from '@shared/schemas';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

const CHANNEL = 'LeaseOwnerLiveness';

/**
 * Identity of the process recorded as an aggregate's claim owner: a pid, the
 * opaque process-start identity `nodeProcesses` produced for it when the
 * claim was taken (null where the host could not read one), and the machine
 * it runs on. Liveness is a kernel fact derived from these three fields;
 * nothing here is compared to a clock and no socket protocol is involved.
 * The owner id the database stores decodes to exactly this shape
 * (`ownerIdentity` in `@shared/schemas`).
 */
interface ClaimOwnerRecord {
  readonly pid: number;
  readonly processStart: string | null;
  readonly hostname: string;
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
 * | owner recorded on another host                 | unprovable |
 * | `kill(pid, 0)` gives ESRCH                     | dead       |
 * | pid exists, identity equals the record         | alive      |
 * | pid exists, identity differs (pid reuse)       | dead       |
 * | pid exists, identity unreadable on either side | unprovable |
 *
 * Hostnames compare case-insensitively on every platform TeXRA supports. A
 * cross-host owner is unprovable by construction: a local pid says nothing
 * about a process on another machine sharing the storage directory.
 *
 * The verdict is total: `nodeProcesses.identity` reports an unreadable
 * identity as undefined rather than rejecting, and the `kill(pid, 0)` beside
 * it folds its own throw, so this effect has no error channel and a prober
 * that yields it cannot be ended by one.
 */
export const proveOwnerLiveness = (
  owner: ClaimOwnerRecord,
): Effect.Effect<OwnerLiveness, never, ChildProcessSpawner> =>
  Effect.gen(function* () {
    const localHostname = os.hostname();
    if (owner.hostname.toLowerCase() !== localHostname.toLowerCase()) {
      yield* Effect.logWarning(
        `Claim owner pid ${owner.pid} was recorded on host ${owner.hostname}; its liveness is unprovable from ${localHostname}`,
      ).pipe(withLogChannel(CHANNEL));
      return 'unprovable';
    }
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
