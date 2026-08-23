/**
 * Process start identities from the operating system, for execution-lease
 * owner liveness. A pid alone proves nothing once it can be reused; a pid
 * plus an identity that is fixed for the process's whole life identifies one
 * process. Each platform uses the source that is stable under a live
 * process; none of them is converted to a clock value, so a wall-clock step
 * cannot make a live owner look dead.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { createLog } from '@logger/logUtils';

import type { ProcessesPort } from '../interfaces';

const log = createLog('NodeProcesses');
const execFileAsync = promisify(execFile);

/**
 * Linux: the boot id plus the raw start ticks from field 22 of
 * `/proc/<pid>/stat`. The ticks are boot-relative and never converted (a
 * conversion would need `btime`, which the kernel rederives from the realtime
 * clock and which therefore moves under a running process); the boot id
 * makes them unique across reboots. The field is parsed after the last `)`
 * because the command name before it may itself contain spaces or parens.
 */
let linuxBootId: string | undefined;

async function readLinuxIdentity(pid: number): Promise<string> {
  linuxBootId ??= (
    await readFile('/proc/sys/kernel/random/boot_id', 'utf8')
  ).trim();
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const afterComm = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  // `afterComm[0]` is field 3 (state); field 22 is therefore index 19.
  const startTicks = afterComm[19];
  if (startTicks === undefined || !/^\d+$/.test(startTicks)) {
    throw new Error(`Unparseable /proc/${pid}/stat: ${stat.trim()}`);
  }
  return `${linuxBootId}:${startTicks}`;
}

/**
 * macOS and the BSDs: `ps -o lstart=` prints the start time as
 * "Sun Aug 23 04:40:24 2026". `kern.boottime` is fixed for the boot on these
 * kernels, so the value is stable for a live process. BSD `ps` honours
 * `LC_TIME`, so the call pins `LC_ALL=C` for one spelling. The string is
 * compared verbatim, never parsed.
 */
async function readPsIdentity(pid: number): Promise<string> {
  const { stdout } = await execFileAsync(
    'ps',
    ['-o', 'lstart=', '-p', String(pid)],
    { env: { ...process.env, LC_ALL: 'C' } },
  );
  const identity = stdout.trim();
  if (identity === '') throw new Error(`ps printed no start time for ${pid}`);
  return identity;
}

/**
 * Windows: the process creation time as an ISO-8601 round-trip string via
 * PowerShell. It costs a few hundred milliseconds, which only the lease
 * probes pay, and it is the one source that makes a Windows owner provable.
 */
async function readWindowsIdentity(pid: number): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
  ]);
  const identity = stdout.trim();
  if (identity === '') {
    throw new Error(`PowerShell printed no start time for ${pid}`);
  }
  return identity;
}

async function readIdentity(pid: number): Promise<string | undefined> {
  try {
    switch (process.platform) {
      case 'linux':
        return await readLinuxIdentity(pid);
      case 'win32':
        return await readWindowsIdentity(pid);
      default:
        return await readPsIdentity(pid);
    }
  } catch (error) {
    // The source fails when the pid does not exist; callers probing a
    // foreign pid separate that case with `kill(pid, 0)`. Any failure to read
    // this process's own identity is worth seeing once.
    if (pid === process.pid) {
      log.warn('Could not read this process start identity', { data: error });
    }
    return undefined;
  }
}

/** Memoized only once read successfully, so a transient failure is retried. */
let selfIdentity: string | undefined;

export const nodeProcesses: ProcessesPort = {
  identity: readIdentity,
  async selfIdentity() {
    selfIdentity ??= await readIdentity(process.pid);
    return selfIdentity;
  },
};
