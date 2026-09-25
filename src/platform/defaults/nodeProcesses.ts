/**
 * Process start identities from the operating system, for execution-lease
 * owner liveness. A pid alone proves nothing once it can be reused; a pid
 * plus an identity that is fixed for the process's whole life identifies one
 * process. Each platform uses the source that is stable under a live
 * process; none of them is converted to a clock value, so a wall-clock step
 * cannot make a live owner look dead.
 */
import { hostname } from 'node:os';

import { Data, Effect, FileSystem } from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import { withLogChannel } from '@logger/effectLog';
import type { OwnerId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** This process's complete owner identity (contract C5). */
export function processOwnerId(processStart: string | undefined): OwnerId {
  return JSON.stringify([
    hostname().toLowerCase(),
    process.pid,
    processStart ?? null,
  ]);
}

const CHANNEL = 'NodeProcesses';

/** What reading a start identity takes: `/proc` on Linux, `ps` or PowerShell
 *  elsewhere. */
export type ProcessProbe = FileSystem.FileSystem | ChildProcessSpawner;

/** A start identity that could not be read or parsed for `pid`. */
class ProcessIdentityUnreadable extends Data.TaggedError(
  'ProcessIdentityUnreadable',
)<{ readonly pid: number; readonly detail: string }> {}

/** The one filesystem read of this module, worded by its errno text. */
const readTextFile = (
  pid: number,
  file: string,
): Effect.Effect<string, ProcessIdentityUnreadable, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file);
  }).pipe(
    Effect.mapError(
      (error) =>
        new ProcessIdentityUnreadable({
          pid,
          detail: toErrorMessage(error.reason.cause ?? error),
        }),
    ),
  );

/**
 * The one child-process edge of this module: `file args`, stdout as text.
 * `string` does not inspect the exit code; a missing pid prints nothing, and
 * empty or unparsable stdout already reads as unreadable below.
 */
const runCommand = (
  pid: number,
  file: string,
  args: readonly string[],
  env?: Record<string, string>,
): Effect.Effect<string, ProcessIdentityUnreadable, ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    return yield* spawner.string(
      ChildProcess.make(file, args, {
        env,
        extendEnv: true,
        stdin: 'ignore',
        stderr: 'ignore',
        detached: false,
        forceKillAfter: '5 seconds',
      }),
    );
  }).pipe(
    Effect.mapError(
      (error) =>
        new ProcessIdentityUnreadable({ pid, detail: error.reason._tag }),
    ),
  );

/**
 * Linux: the boot id plus the raw start ticks from field 22 of
 * `/proc/<pid>/stat`. The ticks are boot-relative and never converted (a
 * conversion would need `btime`, which the kernel rederives from the realtime
 * clock and which therefore moves under a running process); the boot id
 * makes them unique across reboots. The field is parsed after the last `)`
 * because the command name before it may itself contain spaces or parens.
 */
let linuxBootId: string | undefined;

const readLinuxIdentity = (
  pid: number,
): Effect.Effect<string, ProcessIdentityUnreadable, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    linuxBootId ??= (yield* readTextFile(
      pid,
      '/proc/sys/kernel/random/boot_id',
    )).trim();
    const stat = yield* readTextFile(pid, `/proc/${pid}/stat`);
    const afterComm = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/);
    // `afterComm[0]` is field 3 (state); field 22 is therefore index 19.
    const startTicks = afterComm[19];
    if (startTicks === undefined || !/^\d+$/.test(startTicks)) {
      return yield* new ProcessIdentityUnreadable({
        pid,
        detail: `Unparseable /proc/${pid}/stat: ${stat.trim()}`,
      });
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
const readPsIdentity = (
  pid: number,
): Effect.Effect<string, ProcessIdentityUnreadable, ChildProcessSpawner> =>
  Effect.gen(function* () {
    const stdout = yield* runCommand(
      pid,
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { LC_ALL: 'C' },
    );
    const identity = stdout.trim();
    if (identity === '') {
      return yield* new ProcessIdentityUnreadable({
        pid,
        detail: `ps printed no start time for ${pid}`,
      });
    }
    return identity;
  });

/**
 * Windows: the process creation time as an ISO-8601 round-trip string via
 * PowerShell. It costs a few hundred milliseconds, which only the lease
 * probes pay, and it is the one source that makes a Windows owner provable.
 */
const readWindowsIdentity = (
  pid: number,
): Effect.Effect<string, ProcessIdentityUnreadable, ChildProcessSpawner> =>
  Effect.gen(function* () {
    const stdout = yield* runCommand(pid, 'powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
    ]);
    const identity = stdout.trim();
    if (identity === '') {
      return yield* new ProcessIdentityUnreadable({
        pid,
        detail: `PowerShell printed no start time for ${pid}`,
      });
    }
    return identity;
  });

const readIdentity = (
  pid: number,
): Effect.Effect<string | undefined, never, ProcessProbe> =>
  Effect.suspend(
    (): Effect.Effect<string, ProcessIdentityUnreadable, ProcessProbe> => {
      switch (process.platform) {
        case 'linux':
          return readLinuxIdentity(pid);
        case 'win32':
          return readWindowsIdentity(pid);
        default:
          return readPsIdentity(pid);
      }
    },
  ).pipe(
    // The source fails when the pid does not exist; callers probing a
    // foreign pid separate that case with `kill(pid, 0)`. Any failure to
    // read this process's own identity is worth seeing once.
    Effect.catch((error: ProcessIdentityUnreadable) =>
      pid === process.pid
        ? Effect.logWarning('Could not read this process start identity').pipe(
            Effect.annotateLogs({ data: error }),
            withLogChannel(CHANNEL),
            Effect.as(undefined),
          )
        : Effect.succeed(undefined),
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
  selfIdentity: (): Effect.Effect<string | undefined, never, ProcessProbe> =>
    Effect.suspend(() =>
      selfIdentity === undefined
        ? Effect.map(readIdentity(process.pid), (identity) => {
            selfIdentity = identity;
            return identity;
          })
        : Effect.succeed(selfIdentity),
    ),
};
