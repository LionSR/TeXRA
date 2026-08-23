/**
 * Process start times from the operating system, for execution-lease owner
 * liveness. A pid alone proves nothing once it can be reused; a pid plus the
 * start time the kernel reports for it identifies one process.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createLog } from '@logger/logUtils';

import type { ProcessesPort } from '../interfaces';

const log = createLog('NodeProcesses');
const execFileAsync = promisify(execFile);

/**
 * POSIX: `ps -o lstart=` prints the start time as "Sun Aug 23 04:40:24 2026",
 * which `Date.parse` reads. procps renders it through `ctime()` regardless of
 * locale; BSD and macOS `ps` honour `LC_TIME`, so the call pins `LC_ALL=C`.
 *
 * Known limit: the value has whole-second resolution, so a pid reused within
 * the same second as the recorded process started is not detected. No cheaper
 * portable source has finer precision (`/proc/<pid>/stat` needs the clock
 * tick rate, which Node does not expose). Windows has no equally cheap source
 * (`wmic` is deprecated and PowerShell costs hundreds of milliseconds), so it
 * reports undefined and a Windows owner stays unprovable beyond pid existence.
 */
async function readStartTime(pid: number): Promise<number | undefined> {
  if (process.platform === 'win32') return undefined;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { env: { ...process.env, LC_ALL: 'C' } },
    ));
  } catch (error) {
    // `ps` exits non-zero when the pid does not exist; callers probing a
    // foreign pid have already separated that case with `kill(pid, 0)`. Any
    // other failure (no `ps` binary, spawn failure) is worth seeing once.
    if (pid === process.pid) {
      log.warn('Could not read this process start time', { data: error });
    }
    return undefined;
  }
  const parsed = Date.parse(stdout.trim());
  if (Number.isNaN(parsed)) {
    log.warn(`Unparseable start time for pid ${pid}: ${stdout.trim()}`);
    return undefined;
  }
  return Math.floor(parsed / 1000) * 1000;
}

/** Memoized only once read successfully, so a transient failure is retried. */
let selfStartTime: number | undefined;

export const nodeProcesses: ProcessesPort = {
  startTime: readStartTime,
  async selfStartTime() {
    selfStartTime ??= await readStartTime(process.pid);
    return selfStartTime;
  },
};
