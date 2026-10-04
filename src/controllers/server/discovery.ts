/**
 * Where a client finds the service: `<storageRoot>/run/` holds the socket
 * and `serve.json`, the running service's pid, protocol and build. The
 * directory is the user's alone (0700), which is what keeps the socket
 * private. A storage root whose socket path would pass the Unix limit
 * keeps its socket in a private directory under the system temp folder,
 * named by a hash of the root. Windows has no service yet: a named pipe
 * there would take the default ACL, which is not the user's alone.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { Effect, FileSystem, Option, type PlatformError } from 'effect';
import { z } from 'zod';

import { absentReason } from '@utils/files/fsEntryExists';

/** The longest Unix socket path every platform accepts (macOS: 104 bytes). */
const MAX_UNIX_SOCKET_PATH = 100;

/** The running service's record, written once it listens. */
const ServiceRecordSchema = z.object({
  pid: z.int().positive(),
  protocol: z.int().positive(),
  version: z.string(),
  socket: z.string().min(1),
  startedAt: z.int().positive(),
});
export type ServiceRecord = z.infer<typeof ServiceRecordSchema>;

/** The files of one storage root's service. */
export interface ServicePaths {
  /** The private directory beside the store: `<storageRoot>/run`. */
  readonly runDirectory: string;
  /** `serve.json`, the running service's {@link ServiceRecord}. */
  readonly record: string;
  /** `serve.log`: what a detached service writes. */
  readonly log: string;
  /** The socket path clients connect to. */
  readonly socket: string;
  /** The private directory the socket lives in: `runDirectory`, or a
   *  long root's temp fallback. */
  readonly socketDirectory: string;
}

/** The service files of `storageRoot` (`~/.texra` in production). */
export function servicePaths(storageRoot: string): ServicePaths {
  const runDirectory = path.join(storageRoot, 'run');
  const record = path.join(runDirectory, 'serve.json');
  const log = path.join(runDirectory, 'serve.log');
  const tag = createHash('sha256')
    .update(path.resolve(storageRoot))
    .digest('hex')
    .slice(0, 16);
  const local = path.join(runDirectory, 'serve.sock');
  if (Buffer.byteLength(local) <= MAX_UNIX_SOCKET_PATH) {
    return {
      runDirectory,
      record,
      log,
      socket: local,
      socketDirectory: runDirectory,
    };
  }
  // `/tmp`, not the per-user temp folder: a client and the service it
  // started must agree on the path whatever environment each runs with.
  const socketDirectory = path.join('/tmp', `texra-${tag}`);
  return {
    runDirectory,
    record,
    log,
    socket: path.join(socketDirectory, 'serve.sock'),
    socketDirectory,
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
      yield* fs.chmod(directory, 0o700);
    }
  });
}

/** The record a running service wrote, or null when there is none. A
 *  record that does not parse is reported and read as none: the next
 *  service to start writes a fresh one. */
function readServiceRecord(
  paths: ServicePaths,
): Effect.Effect<ServiceRecord | null, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(paths.record).pipe(
      Effect.map((value): string | null => value),
      Effect.catch((error: PlatformError.PlatformError) =>
        absentReason(error)
          ? Effect.succeed(null)
          : Effect.logWarning(
              `Cannot read the service record ${paths.record}`,
            ).pipe(Effect.annotateLogs({ data: error }), Effect.as(null)),
      ),
    );
    if (text === null) return null;
    const parsed = ServiceRecordSchema.safeParse(safeJson(text));
    if (parsed.success) return parsed.data;
    yield* Effect.logWarning(
      `Ignoring the malformed service record ${paths.record}: ${z.prettifyError(parsed.error)}`,
    );
    return null;
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // The schema check that follows reports the record as malformed.
    return undefined;
  }
}

/** Write this service's record, readable by the user alone. */
export function writeServiceRecord(
  paths: ServicePaths,
  record: ServiceRecord,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const staged = `${paths.record}.${record.pid}.tmp`;
    yield* fs.writeFileString(staged, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
    yield* fs.rename(staged, paths.record);
  });
}

/** What identifies one service's own files: its pid, and the inode of the
 *  socket it bound (absent when it could not be read). */
export interface ServiceOwnership {
  readonly pid: number;
  readonly socketIno: number | undefined;
}

/**
 * Remove the record and socket a service left, each only while it is still
 * that service's: a record naming another pid, or a socket file that is
 * not the one it bound, belongs to a successor that took the path over.
 */
export function removeServiceFiles(
  paths: ServicePaths,
  own: ServiceOwnership,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const record = yield* readServiceRecord(paths);
    if (record?.pid === own.pid)
      yield* fs.remove(paths.record, { force: true });
    if (own.socketIno === undefined) return;
    const current = yield* fs.stat(paths.socket).pipe(
      Effect.map((info) => Option.getOrUndefined(info.ino)),
      Effect.orElseSucceed(() => undefined),
    );
    if (current === own.socketIno)
      yield* fs.remove(paths.socket, { force: true });
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning('Could not remove the service files').pipe(
        Effect.annotateLogs({ data: error }),
      ),
    ),
  );
}
