/**
 * Process start identities from the operating system, for execution-lease
 * owner liveness. A pid alone proves nothing once it can be reused; a pid
 * plus an identity that is fixed for the process's whole life identifies one
 * process. Each platform uses the source that is stable under a live
 * process; none of them is converted to a clock value, so a wall-clock step
 * cannot make a live owner look dead.
 */
import { hostname } from 'node:os';

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { Effect } from 'effect';

import { createLog } from '@logger/logUtils';
import type { OwnerId } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

/** This process's complete owner identity (contract C5). */
export function processOwnerId(processStart: string | undefined): OwnerId {
  return JSON.stringify([
    hostname().toLowerCase(),
    process.pid,
    processStart ?? null,
  ]);
}

const log = createLog('NodeProcesses');
const execFileAsync = promisify(execFile);

/** The one wrap of this module's `node:fs` edge. */
const readTextFile = (file: string): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: () => readFile(file, 'utf8'),
    catch: ensureError,
  });

/** The one wrap of this module's `node:child_process` edge. */
const runCommand = (
  file: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: () => execFileAsync(file, [...args], env ? { env } : {}),
    catch: ensureError,
  }).pipe(Effect.map(({ stdout }) => stdout));

/**
 * Linux: the boot id plus the raw start ticks from field 22 of
 * `/proc/<pid>/stat`. The ticks are boot-relative and never converted (a
 * conversion would need `btime`, which the kernel rederives from the realtime
 * clock and which therefore moves under a running process); the boot id
 * makes them unique across reboots. The field is parsed after the last `)`
 * because the command name before it may itself contain spaces or parens.
 */
let linuxBootId: string | undefined;

const readLinuxIdentity = (pid: number): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    linuxBootId ??= (yield* readTextFile(
      '/proc/sys/kernel/random/boot_id',
    )).trim();
    const stat = yield* readTextFile(`/proc/${pid}/stat`);
    const afterComm = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/);
    // `afterComm[0]` is field 3 (state); field 22 is therefore index 19.
    const startTicks = afterComm[19];
    if (startTicks === undefined || !/^\d+$/.test(startTicks)) {
      return yield* Effect.fail(
        new Error(`Unparseable /proc/${pid}/stat: ${stat.trim()}`),
      );
    }
    return `${linuxBootId}:${startTicks}`;
  });

/**
 * macOS and the BSDs: `ps -o lstart=` prints the start time as
 * "Sun Aug 23 04:40:24 2026". `kern.boottime` is fixed for the boot on these
 * kernels, so the value is stable for a live process. BSD `ps` honours
 * `LC_TIME`, so the call pins `LC_ALL=C` for one spelling. The string is
 * compared verbatim, never parsed.
 */
const readPsIdentity = (pid: number): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const stdout = yield* runCommand(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { ...process.env, LC_ALL: 'C' },
    );
    const identity = stdout.trim();
    if (identity === '') {
      return yield* Effect.fail(
        new Error(`ps printed no start time for ${pid}`),
      );
    }
    return identity;
  });

/**
 * Windows: the process creation time as an ISO-8601 round-trip string via
 * PowerShell. It costs a few hundred milliseconds, which only the lease
 * probes pay, and it is the one source that makes a Windows owner provable.
 */
const readWindowsIdentity = (pid: number): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const stdout = yield* runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
    ]);
    const identity = stdout.trim();
    if (identity === '') {
      return yield* Effect.fail(
        new Error(`PowerShell printed no start time for ${pid}`),
      );
    }
    return identity;
  });

const readIdentity = (pid: number): Effect.Effect<string | undefined> =>
  Effect.suspend(() => {
    switch (process.platform) {
      case 'linux':
        return readLinuxIdentity(pid);
      case 'win32':
        return readWindowsIdentity(pid);
      default:
        return readPsIdentity(pid);
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        // The source fails when the pid does not exist; callers probing a
        // foreign pid separate that case with `kill(pid, 0)`. Any failure to
        // read this process's own identity is worth seeing once.
        if (pid === process.pid) {
          log.warn('Could not read this process start identity', {
            data: error,
          });
        }
        return undefined;
      }),
    ),
  );

/** Memoized only once read successfully, so a transient failure is retried. */
let selfIdentity: string | undefined;

/**
 * Kernel facts about processes, used to prove whether the owner recorded in
 * an execution lease is still the same process. An identity is an opaque
 * string that cannot change while a process runs and that no later process
 * with the same pid can repeat: two equal strings name one process, two
 * different strings name two. Callers only compare it verbatim. Neither
 * program fails: an unreadable identity is undefined, and `selfIdentity` is
 * memoized once read, retried until then.
 */
export const nodeProcesses = {
  identity: readIdentity,
  selfIdentity: (): Effect.Effect<string | undefined> =>
    Effect.suspend(() =>
      selfIdentity === undefined
        ? Effect.map(readIdentity(process.pid), (identity) => {
            selfIdentity = identity;
            return identity;
          })
        : Effect.succeed(selfIdentity),
    ),
};
