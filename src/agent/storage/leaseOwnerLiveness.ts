import * as os from 'node:os';

import { z } from 'zod';

import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';

const log = createLog('LeaseOwnerLiveness');

/**
 * Identity of the process that owns an execution lease: a pid, the opaque
 * process-start identity the `processes` port produced for it when the lease
 * was written (null where the host could not read one), and the machine it
 * runs on. Liveness is a kernel fact derived from these three fields;
 * nothing here is compared to a clock and no socket protocol is involved.
 */
export const LeaseOwnerSchema = z.strictObject({
  pid: z.int().positive(),
  processStart: z.string().min(1).nullable(),
  hostname: z.string().min(1),
});

export type LeaseOwnerRecord = z.infer<typeof LeaseOwnerSchema>;

/**
 * A verdict is a proof or an admission that no proof exists. `unprovable`
 * means "do not touch": every acquire and delete path treats it exactly like
 * `alive`, and the user sees the run as held. The user's only way out is to
 * delete the run.
 */
export type OwnerLiveness = 'alive' | 'dead' | 'unprovable';

/** The identity this process stamps into the leases it claims. */
export async function currentLeaseOwner(): Promise<LeaseOwnerRecord> {
  return {
    pid: process.pid,
    processStart: (await platform().processes.selfIdentity()) ?? null,
    hostname: os.hostname(),
  };
}

/**
 * `kill(pid, 0)` throwing ESRCH is a kernel proof that no such process
 * exists. Success, including EPERM, proves only that some process has the
 * pid; the start identity decides whether it is the recorded one.
 */
function pidProvablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
  }
}

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
 */
export async function proveOwnerLiveness(
  owner: LeaseOwnerRecord,
): Promise<OwnerLiveness> {
  const localHostname = os.hostname();
  if (owner.hostname.toLowerCase() !== localHostname.toLowerCase()) {
    log.warn(
      `Lease owner pid ${owner.pid} was recorded on host ${owner.hostname}; its liveness is unprovable from ${localHostname}`,
    );
    return 'unprovable';
  }
  if (pidProvablyDead(owner.pid)) return 'dead';
  const observed = await platform().processes.identity(owner.pid);
  if (observed === undefined) {
    // The process may have exited between the two probes.
    if (pidProvablyDead(owner.pid)) return 'dead';
    log.warn(
      `Lease owner pid ${owner.pid} exists but its start identity cannot be read; its liveness is unprovable`,
    );
    return 'unprovable';
  }
  if (owner.processStart === null) {
    log.warn(
      `Lease owner pid ${owner.pid} exists but its record carries no start identity; its liveness is unprovable`,
    );
    return 'unprovable';
  }
  return observed === owner.processStart ? 'alive' : 'dead';
}
