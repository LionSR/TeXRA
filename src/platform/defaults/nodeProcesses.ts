/**
 * Process start times from the operating system, for execution-lease owner
 * liveness. A pid alone proves nothing once it can be reused; a pid plus the
 * start time the kernel reports for it identifies one process.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ProcessesPort } from '../interfaces';

const execFileAsync = promisify(execFile);

/**
 * POSIX: `ps -o lstart=` prints the start time in a fixed locale-independent
 * form ("Sun Aug 23 04:40:24 2026") on macOS, Linux, and the BSDs, which
 * `Date.parse` reads. Windows has no equally cheap source (the `wmic` path is
 * deprecated and PowerShell costs hundreds of milliseconds), so it reports
 * undefined and a Windows owner stays unprovable beyond pid existence.
 */
async function readStartTime(pid: number): Promise<number | undefined> {
  if (process.platform === 'win32') return undefined;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ps', [
      '-o',
      'lstart=',
      '-p',
      String(pid),
    ]));
  } catch {
    // `ps` exits non-zero when the pid does not exist; the caller has already
    // separated that case with `kill(pid, 0)`, so nothing is lost here.
    return undefined;
  }
  const parsed = Date.parse(stdout.trim());
  if (Number.isNaN(parsed)) return undefined;
  return Math.floor(parsed / 1000) * 1000;
}

let selfStartTime: Promise<number | undefined> | undefined;

export const nodeProcesses: ProcessesPort = {
  startTime: readStartTime,
  selfStartTime() {
    selfStartTime ??= readStartTime(process.pid);
    return selfStartTime;
  },
};
