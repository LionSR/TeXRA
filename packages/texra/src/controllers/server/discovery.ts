/**
 * Where a client finds the service: its record in the global root's current
 * values, naming the running service's pid, protocol, build and socket.
 * Each service listens on a socket of its own (`serve-<pid>.sock`), so a
 * retired service that exits while its successor serves removes only its
 * own file (closing a Unix socket server unlinks its path, whatever file is
 * there by then). The directory is the user's alone (0700), which is what
 * keeps the socket private. A storage root whose socket path would pass the
 * Unix limit keeps its sockets in a private directory under `/tmp`, named
 * by the user and a hash of the root. Windows has no service yet: a named
 * pipe there would take the default ACL, which is not the user's alone.
 */
import { hash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import * as path from 'node:path';

import { Effect, FileSystem, PlatformError, Result } from 'effect';

import {
  type DatabaseReadFailed,
  type DatabaseWriteFailed,
  GlobalValues,
} from '@texra-ai/harness';
import { toErrorMessage } from '@texra-ai/harness/schemas';

import { TEXRA_SERVICE, type ServiceRecord } from './protocol';

/** The longest Unix socket path every platform accepts (macOS: 104 bytes). */
const MAX_UNIX_SOCKET_PATH = 100;

/** The files of one storage root's service. */
export interface ServicePaths {
  /** The private directory beside the store: `<storageRoot>/run`. */
  readonly runDirectory: string;
  /** `serve.log`: what a detached service writes. */
  readonly log: string;
  /** The private directory the sockets live in: `runDirectory`, or a long
   *  root's temp fallback. */
  readonly socketDirectory: string;
  /** The socket the service of process `pid` listens on. */
  readonly socketFor: (pid: number) => string;
}

/** A service's socket file name, which names its process. */
const SOCKET_NAME = /^serve-(\d+)\.sock$/;
const socketName = (pid: number) => `serve-${pid}.sock`;

/** The service files of `storageRoot` (`~/.texra` in production). */
export function servicePaths(storageRoot: string): ServicePaths {
  const runDirectory = path.join(storageRoot, 'run');
  const log = path.join(runDirectory, 'serve.log');
  const tag = hash('sha256', path.resolve(storageRoot), 'hex').slice(0, 16);
  // Sized for the longest pid a socket can name.
  const local = path.join(runDirectory, socketName(4_294_967_295));
  if (Buffer.byteLength(local) <= MAX_UNIX_SOCKET_PATH) {
    return {
      runDirectory,
      log,
      socketDirectory: runDirectory,
      socketFor: (pid) => path.join(runDirectory, socketName(pid)),
    };
  }
  // `/tmp`, not the per-user temp folder: a client and the service it
  // started must agree on the path whatever environment each runs with.
  // Named by the user, and checked to be theirs before it is used.
  const socketDirectory = path.join(
    '/tmp',
    `texra-${process.getuid?.() ?? 0}-${tag}`,
  );
  return {
    runDirectory,
    log,
    socketDirectory,
    socketFor: (pid) => path.join(socketDirectory, socketName(pid)),
  };
}

/** Make the run directory and the socket's directory, each the user's
 *  alone; an existing one is narrowed to 0700. */
export function prepareServiceDirectories(
  paths: ServicePaths,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const directory of new Set([
      paths.runDirectory,
      paths.socketDirectory,
    ])) {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* ownDirectory(directory);
      yield* fs.chmod(directory, 0o700);
    }
  });
}

/** Fails unless `directory` is a real directory (not a link) this user
 *  owns: one someone else made in `/tmp` must not hold the socket. */
function ownDirectory(
  directory: string,
): Effect.Effect<void, PlatformError.PlatformError> {
  return Effect.try({
    try: () => {
      const stat = lstatSync(directory);
      const uid = process.getuid?.();
      if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid))
        throw new Error(
          `${directory} is not a directory this user owns; remove it and start the service again`,
        );
    },
    catch: (cause) =>
      PlatformError.badArgument({
        module: 'TexraService',
        method: 'prepareServiceDirectories',
        description: toErrorMessage(cause),
        cause,
      }),
  });
}

/** The family's one key: a storage root has one service. */
const CURRENT = 'current';

/** Whether `a` and `b` are one service's record (or both none). */
const sameService = (
  a: ServiceRecord | undefined,
  b: ServiceRecord | undefined,
): boolean => a?.pid === b?.pid && a?.startedAt === b?.startedAt;

/** The record of the storage root's running service, or null when there is
 *  none. */
export const readServiceRecord: Effect.Effect<
  ServiceRecord | null,
  DatabaseReadFailed,
  GlobalValues
> = Effect.flatMap(GlobalValues, (values) =>
  Effect.map(values.get(TEXRA_SERVICE, CURRENT), (record) => record ?? null),
);

/**
 * Publish `record` as the storage root's service. The holder in place is
 * probed outside the transaction (`probe`: its answer when live, null when
 * dead); a live one's answer is returned and the caller does not start. The
 * claim replaces only the record it probed: a contender that claimed since
 * is kept, and probed in turn, so of services that start at once exactly
 * one is ever findable, whatever happens to the others between their probe
 * and their commit.
 */
export function claimServiceRecord<A, E>(
  record: ServiceRecord,
  probe: (held: ServiceRecord) => Effect.Effect<A | null, E>,
): Effect.Effect<
  A | null,
  E | DatabaseReadFailed | DatabaseWriteFailed,
  GlobalValues
> {
  return Effect.gen(function* () {
    const values = yield* GlobalValues;
    for (;;) {
      const held = yield* values.get(TEXRA_SERVICE, CURRENT);
      const live = held === undefined ? null : yield* probe(held);
      if (live !== null) return live;
      const claimed = yield* values.modify(TEXRA_SERVICE, CURRENT, (current) =>
        Result.succeed(
          sameService(current, held) ? ([true, record] as const) : [false],
        ),
      );
      if (claimed) return null;
    }
  });
}

/**
 * Remove what the service `record` names left: the record while it is
 * still this service's (a successor's is the successor's), and its socket.
 */
export function releaseServiceRecord(
  paths: ServicePaths,
  record: ServiceRecord,
): Effect.Effect<void, never, FileSystem.FileSystem | GlobalValues> {
  return Effect.gen(function* () {
    const values = yield* GlobalValues;
    yield* values.modify(TEXRA_SERVICE, CURRENT, (current) =>
      Result.succeed(
        sameService(current, record)
          ? ([undefined, undefined] as const)
          : [undefined],
      ),
    );
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(paths.socketFor(record.pid), { force: true });
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning('Could not remove the service files').pipe(
        Effect.annotateLogs({ data: error }),
      ),
    ),
  );
}

/** Remove the sockets of services whose process is gone (one that was
 *  killed leaves its file). */
export function removeDeadSockets(
  paths: ServicePaths,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const name of yield* fs.readDirectory(paths.socketDirectory)) {
      const pid = Number(SOCKET_NAME.exec(name)?.[1]);
      if (Number.isInteger(pid) && !processAlive(pid))
        yield* fs.remove(path.join(paths.socketDirectory, name), {
          force: true,
        });
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not remove dead services' sockets").pipe(
        Effect.annotateLogs({ data: error }),
      ),
    ),
  );
}

/** Whether process `pid` runs (one of another user counts as running). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
