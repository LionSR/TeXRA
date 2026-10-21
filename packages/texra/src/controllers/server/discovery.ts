/**
 * Where a client finds the service: `<storageRoot>/run/serve.json`, the
 * running service's pid, protocol, build and socket. Each service listens
 * on a socket of its own (`serve-<pid>.sock`), so a retired service that
 * exits while its successor serves removes only its own file (closing a
 * Unix socket server unlinks its path, whatever file is there by then).
 * The directory is the user's alone (0700), which is what keeps the socket
 * private. A storage root whose socket path would pass the Unix limit
 * keeps its sockets in a private directory under `/tmp`, named by the user
 * and a hash of the root. Windows has no service yet: a named pipe
 * there would take the default ACL, which is not the user's alone.
 */
import { hash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import * as path from 'node:path';

import { Effect, FileSystem, PlatformError } from 'effect';
import { z } from 'zod';

import { toErrorMessage } from '@texra-ai/harness/schemas';
import { absentReason } from '@texra-ai/harness/node';

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
  const record = path.join(runDirectory, 'serve.json');
  const log = path.join(runDirectory, 'serve.log');
  const tag = hash('sha256', path.resolve(storageRoot), 'hex').slice(0, 16);
  // Sized for the longest pid a socket can name.
  const local = path.join(runDirectory, socketName(4_294_967_295));
  if (Buffer.byteLength(local) <= MAX_UNIX_SOCKET_PATH) {
    return {
      runDirectory,
      record,
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
    record,
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

/** The record a running service wrote, or null when there is none. A
 *  record that does not parse is reported and read as none: the next
 *  service to start moves it aside. */
export function readServiceRecord(
  paths: ServicePaths,
): Effect.Effect<ServiceRecord | null, never, FileSystem.FileSystem> {
  return Effect.map(readRecord(paths), (read) => read?.record ?? null);
}

/** The record file's text and what it parses to (null when it does not). */
function readRecord(
  paths: ServicePaths,
): Effect.Effect<
  { readonly text: string; readonly record: ServiceRecord | null } | null,
  never,
  FileSystem.FileSystem
> {
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
    return { text, record: yield* parseRecord(paths, text) };
  });
}

/** The record `text` holds, or null, reported, when it does not parse. */
function parseRecord(
  paths: ServicePaths,
  text: string,
): Effect.Effect<ServiceRecord | null> {
  const parsed = ServiceRecordSchema.safeParse(safeJson(text));
  if (parsed.success) return Effect.succeed(parsed.data);
  return Effect.as(
    Effect.logWarning(
      `Ignoring the malformed service record ${paths.record}: ${z.prettifyError(parsed.error)}`,
    ),
    null,
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // The schema check that follows reports the record as malformed.
    return undefined;
  }
}

/** How a claim treats the service whose record is in its place. */
interface RecordHolder<A, E> {
  /** The holder's answer when it is live, or null when it is dead. */
  readonly probe: (record: ServiceRecord) => Effect.Effect<A | null, E>;
  /** Retire a live holder whose record this claim displaced. */
  readonly retire: (record: ServiceRecord) => Effect.Effect<void, E>;
}

/**
 * Publish `record` as the storage root's service. Creating the record is
 * the claim (a hard link, which fails where a record is), so of services
 * that start at once only one is ever findable. A record in place is its
 * holder's: a live holder's answer is returned (the caller does not start);
 * a dead holder's record, or one that does not parse, is moved aside and
 * the claim made again.
 */
export function claimServiceRecord<A, E>(
  paths: ServicePaths,
  record: ServiceRecord,
  holder: RecordHolder<A, E>,
): Effect.Effect<
  A | null,
  E | PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const staged = `${paths.record}.${record.pid}.tmp`;
    const aside = `${paths.record}.${record.pid}.stale`;
    /** Link `from` to the record unless one is there. */
    const publish = (from: string) =>
      fs.link(from, paths.record).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === 'AlreadyExists',
          () => Effect.succeed(false),
        ),
      );
    const claim: Effect.Effect<
      A | null,
      E | PlatformError.PlatformError,
      FileSystem.FileSystem
    > = Effect.gen(function* () {
      if (yield* publish(staged)) return null;
      const held = yield* readRecord(paths);
      // Released since the link failed.
      if (held === null) return yield* claim;
      const live =
        held.record === null ? null : yield* holder.probe(held.record);
      if (live !== null) return live;
      const moved = yield* fs.rename(paths.record, aside).pipe(
        Effect.as(true),
        Effect.catchIf(absentReason, () => Effect.succeed(false)),
      );
      const movedText = moved ? yield* fs.readFileString(aside) : held.text;
      // Moved aside, not removed: a contender that took the dead record
      // over first may have claimed since the read. Its record goes back,
      // unless a third claimed in that instant: the third's stands, and the
      // one displaced is retired.
      if (movedText !== held.text && !(yield* publish(aside))) {
        const displaced = yield* parseRecord(paths, movedText);
        if (displaced !== null) yield* holder.retire(displaced);
      }
      yield* fs.remove(aside, { force: true });
      return yield* claim;
    });
    yield* fs.writeFileString(staged, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
    return yield* claim.pipe(
      Effect.ensuring(
        Effect.ignore(fs.remove(staged, { force: true }), { log: 'Warn' }),
      ),
    );
  });
}

/**
 * Remove the files a service of process `pid` left: its socket, and the
 * record while it still names `pid` (a successor's record is the
 * successor's).
 */
export function removeServiceFiles(
  paths: ServicePaths,
  pid: number,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const record = yield* readServiceRecord(paths);
    if (record?.pid === pid) yield* fs.remove(paths.record, { force: true });
    yield* fs.remove(paths.socketFor(pid), { force: true });
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
