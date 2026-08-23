import * as os from 'node:os';

import { z } from 'zod';

import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';

const log = createLog('LeaseOwnerLiveness');

/**
 * Identity of the process that owns an execution lease: a pid, the start time
 * the kernel reported for it when the lease was written (null where the host
 * cannot read start times), and the machine it runs on. Liveness is a kernel
 * fact derived from these three fields; nothing here is compared to a clock
 * and no socket protocol is involved.
 */
export const LeaseOwnerSchema = z.strictObject({
  pid: z.int().nonnegative(),
  processStartTime: z.int().nonnegative().nullable(),
  hostname: z.string().min(1),
});

export type LeaseOwnerRecord = z.infer<typeof LeaseOwnerSchema>;

/**
 * A verdict is a proof or an admission that no proof exists. `unprovable`
 * means "do not touch" to every acquire, reclaim, and delete path, and is
 * surfaced to the user as a held run whose owner cannot be reached.
 */
export type OwnerLiveness = 'alive' | 'dead' | 'unprovable';

/** The identity this process stamps into the leases it claims. */
export async function currentLeaseOwner(): Promise<LeaseOwnerRecord> {
  return {
    pid: process.pid,
    processStartTime: (await platform().processes.selfStartTime()) ?? null,
    hostname: os.hostname(),
  };
}

/**
 * `kill(pid, 0)` throwing ESRCH is a kernel proof that no such process
 * exists. Success, including EPERM, proves only that some process has the
 * pid; the start time decides whether it is the recorded one.
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
 * | observed                                     | verdict    |
 * | -------------------------------------------- | ---------- |
 * | owner recorded on another host               | unprovable |
 * | `kill(pid, 0)` gives ESRCH                   | dead       |
 * | pid exists, start time matches the record    | alive      |
 * | pid exists, start time differs (pid reuse)   | dead       |
 * | start time unreadable on either side         | unprovable |
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
  const startTime = await platform().processes.startTime(owner.pid);
  if (startTime === undefined || owner.processStartTime === null) {
    log.warn(
      `Lease owner pid ${owner.pid} exists but its start time cannot be compared; its liveness is unprovable`,
      { data: { recorded: owner.processStartTime, observed: startTime } },
    );
    return 'unprovable';
  }
  return startTime === owner.processStartTime ? 'alive' : 'dead';
}

/**
 * Whether some process holds the recorded pid on this host, whatever its
 * start time. A destructive reclaim must not guess that such a process is a
 * coincidence: on hosts without readable start times this is every live owner.
 */
export function ownerPidExistsOnThisHost(owner: LeaseOwnerRecord): boolean {
  return (
    owner.hostname.toLowerCase() === os.hostname().toLowerCase() &&
    !pidProvablyDead(owner.pid)
  );
}
