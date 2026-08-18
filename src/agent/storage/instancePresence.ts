import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
import { toErrorMessage } from '@utils/errors/errorMessage';

// This module deliberately bypasses the Platform ports: presence is made of
// kernel facts — real sockets, a 0o700 socket directory, a synchronous unlink
// on process exit — that no host abstraction can virtualize without breaking
// the proofs. A port here would be a single-caller wrapper over Node-only
// primitives, which the factory guardrails forbid.

const log = createLog('InstancePresence');

const BANNER_PREFIX = 'texra-presence:';
const PROBE_TIMEOUT_MS = 1_500;
const MAX_BANNER_BYTES = 256;
/** macOS caps `sun_path` at 104 bytes; keep margin below it. */
const MAX_SOCKET_PATH_BYTES = 96;

/**
 * Identity of the process that owns an execution lease. Liveness verdicts
 * come from probing `socketPath`. `pid` is a diagnostic breadcrumb plus a
 * death-proof-only tiebreak (ESRCH) where the socket file itself may have
 * been unlinked from under a live owner — never an aliveness input. The
 * `hostname` guards against cross-machine probes of a shared home directory.
 */
export const InstanceOwnerSchema = z.strictObject({
  instanceId: z.string().min(1),
  socketPath: z.string().min(1),
  pid: z.int().nonnegative(),
  hostname: z.string().min(1),
});

export type InstanceOwnerRecord = z.infer<typeof InstanceOwnerSchema>;

/**
 * A liveness verdict is a proof or an admission that no proof exists. Callers
 * must treat `unprovable` as alive: we never reclaim on ambiguity. Which
 * observation yields which verdict is stated once, in {@link classifyPresence}.
 */
export type InstanceLiveness = 'alive' | 'dead' | 'unprovable';

let presenceRecord: Promise<InstanceOwnerRecord> | undefined;

function socketPathFor(instanceId: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\texra-${instanceId}`;
  const preferred = path.join(
    platform().storage.getGlobalStoragePath(),
    'instances',
    `${instanceId}.sock`,
  );
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
  // A tmp cleaner may unlink a live owner's socket file here; probes treat a
  // missing file as death only with a pid proof (classifyPresence). Loud so
  // a user hitting it can shorten their storage root.
  const fallback = path.join(os.tmpdir(), `texra-${instanceId}.sock`);
  log.warn(
    `Instance presence socket path exceeds the platform limit; falling back to ${fallback}`,
    { data: { preferred } },
  );
  return fallback;
}

async function startPresenceServer(): Promise<InstanceOwnerRecord> {
  const instanceId = randomBytes(8).toString('hex');
  const socketPath = socketPathFor(instanceId);
  if (process.platform !== 'win32') {
    await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  }
  const server = net.createServer((socket) => {
    // Answer with our identity, then hold the connection open: the kernel
    // closes it when this process dies, which is the exit signal watchers
    // subscribe to. Watchers disconnecting is routine.
    socket.on('error', () => undefined);
    socket.write(`${BANNER_PREFIX}${instanceId}\n`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  // Presence must never keep the process alive on its own. The listening
  // server stays rooted by the event loop's handle list, so nothing here needs
  // to hold a reference to it.
  server.unref();
  if (process.platform !== 'win32') {
    process.once('exit', () => {
      try {
        unlinkSync(socketPath);
      } catch {
        // Crash-path cleanup is best effort; a leftover file yields
        // ECONNREFUSED, which is itself a death proof.
      }
    });
  }
  return {
    instanceId,
    socketPath,
    pid: process.pid,
    hostname: os.hostname(),
  };
}

/**
 * The identity this process stamps into execution leases it acquires. Binds
 * the presence socket on first use and keeps it for the process lifetime.
 */
export function ensureInstancePresence(): Promise<InstanceOwnerRecord> {
  presenceRecord ??= startPresenceServer().catch((error: unknown) => {
    presenceRecord = undefined;
    throw error;
  });
  return presenceRecord;
}

/**
 * Hostnames are case-insensitive on every platform TeXRA supports. A cross-host
 * owner is unprovable by construction — a local connect failure says nothing
 * about a process on another machine — so both the probe and the exit watch
 * refuse it here, loudly, before any socket is opened. `consequence` completes
 * the warning: "…host <owner>; <consequence> from <this host>".
 */
function ownerIsOnThisHost(
  owner: InstanceOwnerRecord,
  consequence: string,
): boolean {
  if (owner.hostname.toLowerCase() === os.hostname().toLowerCase()) return true;
  log.warn(
    `Execution lease owner lives on host ${owner.hostname}; ${consequence} from ${os.hostname()}`,
  );
  return false;
}

/**
 * `kill(pid, 0)` throwing ESRCH is a kernel proof that no such process
 * exists. Success proves nothing (the pid may be recycled), so this is a
 * death-proof-only oracle.
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
 * Everything one presence connection can observe. The socket mechanics only
 * *produce* these; {@link classifyPresence} alone decides what they mean.
 */
type PresenceOutcome =
  | { readonly kind: 'banner'; readonly banner: string }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'oversized' };

/**
 * The single source of liveness truth — every verdict in this module comes
 * from this table, and nothing outside it decides alive/dead:
 *
 * | observed                            | verdict    | proof                            |
 * | ----------------------------------- | ---------- | -------------------------------- |
 * | our owner's own banner              | alive      | the owner answered on its socket |
 * | another TeXRA banner                | dead       | the path was released and reused |
 * | `ECONNREFUSED`                      | dead       | the kernel knows no listener     |
 * | `ENOENT` + `kill(pid, 0)` => ESRCH  | dead       | socket gone *and* process gone   |
 * | timeout / close / oversized / other | unprovable | no proof either way              |
 *
 * A cross-host owner never reaches here: {@link ownerIsOnThisHost} refuses it
 * as unprovable before a socket is opened. `unprovable` is never reclaimed —
 * callers must treat it as alive. The switch is exhaustive on purpose: a new
 * outcome must be classified explicitly rather than defaulting.
 */
function classifyPresence(
  outcome: PresenceOutcome,
  owner: InstanceOwnerRecord,
): InstanceLiveness {
  switch (outcome.kind) {
    case 'banner':
      if (outcome.banner === `${BANNER_PREFIX}${owner.instanceId}`) {
        return 'alive';
      }
      // A different TeXRA instance answering on this path proves the recorded
      // owner is gone: the path was released and reused.
      if (outcome.banner.startsWith(BANNER_PREFIX)) return 'dead';
      return 'unprovable';
    case 'error': {
      const { error } = outcome;
      if (!(error instanceof Error) || !('code' in error)) return 'unprovable';
      if (error.code === 'ECONNREFUSED') return 'dead';
      // A crashed owner leaves its socket file behind (ECONNREFUSED above), so
      // a missing file means it was unlinked — by graceful exit, or from under
      // a live owner (e.g. a tmp cleaner in the fallback directory). Death then
      // additionally requires the recorded pid to be provably gone.
      return error.code === 'ENOENT' && pidProvablyDead(owner.pid)
        ? 'dead'
        : 'unprovable';
    }
    case 'timeout':
    case 'closed':
    case 'oversized':
      return 'unprovable';
  }
}

interface PresenceConnection {
  readonly socket: net.Socket;
  /** Resolves once, with the first thing this connection observed. */
  readonly outcome: Promise<PresenceOutcome>;
}

/** Transport only: connect and report what happened. No verdict lives here. */
function connectForBanner(owner: InstanceOwnerRecord): PresenceConnection {
  const socket = net.connect(owner.socketPath);
  const outcome = new Promise<PresenceOutcome>((resolve) => {
    let settled = false;
    const finish = (observed: PresenceOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(observed);
    };
    const timer = setTimeout(
      () => finish({ kind: 'timeout' }),
      PROBE_TIMEOUT_MS,
    );
    timer.unref();
    let buffered = '';
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline === -1) {
        if (Buffer.byteLength(buffered) > MAX_BANNER_BYTES) {
          finish({ kind: 'oversized' });
        }
        return;
      }
      finish({ kind: 'banner', banner: buffered.slice(0, newline) });
    });
    socket.on('error', (error: unknown) => finish({ kind: 'error', error }));
    socket.on('close', () => finish({ kind: 'closed' }));
  });
  return { socket, outcome };
}

/**
 * Prove whether the process identified by `owner` is alive. `unprovable`
 * means exactly that; callers treat it as alive and must not reclaim.
 */
export async function probeInstance(
  owner: InstanceOwnerRecord,
): Promise<InstanceLiveness> {
  if (!ownerIsOnThisHost(owner, 'liveness is unprovable')) return 'unprovable';
  const connection = connectForBanner(owner);
  const verdict = classifyPresence(await connection.outcome, owner);
  connection.socket.destroy();
  return verdict;
}

interface InstanceExitWatch {
  readonly listeners: Set<() => void>;
  socket: net.Socket | undefined;
}

const exitWatches = new Map<string, InstanceExitWatch>();

/** Callers must have just confirmed `watch` is the registered one for the path. */
function fireExitWatch(socketPath: string, watch: InstanceExitWatch): void {
  exitWatches.delete(socketPath);
  watch.socket?.destroy();
  for (const listener of watch.listeners) {
    try {
      listener();
    } catch (error) {
      log.warn(
        `Instance-exit listener failed for ${socketPath}: ${toErrorMessage(error)}`,
      );
    }
  }
}

async function runExitWatch(
  owner: InstanceOwnerRecord,
  watch: InstanceExitWatch,
): Promise<void> {
  let unprovableStreak = 0;
  while (unprovableStreak < 2) {
    const { socket, outcome } = connectForBanner(owner);
    watch.socket = socket;
    // Watch connections are held open; they must not keep the process alive.
    socket.unref();
    const liveness = classifyPresence(await outcome, owner);
    if (exitWatches.get(owner.socketPath) !== watch) {
      socket.destroy();
      return;
    }
    if (liveness === 'dead') {
      fireExitWatch(owner.socketPath, watch);
      return;
    }
    if (liveness === 'alive') {
      unprovableStreak = 0;
      await new Promise<void>((resolve) =>
        socket.once('close', () => resolve()),
      );
      if (exitWatches.get(owner.socketPath) !== watch) return;
      // The held connection closed: usually the owner's death, occasionally a
      // disturbed connection. Reconnect for the actual verdict either way.
      continue;
    }
    unprovableStreak += 1;
    socket.destroy();
  }
  exitWatches.delete(owner.socketPath);
  log.warn(
    `Liveness of execution lease owner ${owner.instanceId} is repeatedly unprovable; its executions stay untouched until a later repair trigger`,
    { data: { socketPath: owner.socketPath } },
  );
}

/**
 * Invoke `listener` when the owner process exits. The kernel closes the held
 * connection on process death, so exit is pushed, never polled; every
 * inconclusive outcome reconnects for a fresh verdict. An owner that is
 * already dead fires immediately; a repeatedly unprovable owner is logged and
 * never fires (we neither poll on a clock nor reclaim on ambiguity — the next
 * natural repair trigger re-encounters it). The returned disposer detaches
 * the listener.
 */
export function watchInstanceExit(
  owner: InstanceOwnerRecord,
  listener: () => void,
): () => void {
  if (!ownerIsOnThisHost(owner, 'its exit cannot be watched')) {
    return () => undefined;
  }
  const existing = exitWatches.get(owner.socketPath);
  if (existing) {
    existing.listeners.add(listener);
    return () => existing.listeners.delete(listener);
  }
  const watch: InstanceExitWatch = {
    listeners: new Set([listener]),
    socket: undefined,
  };
  exitWatches.set(owner.socketPath, watch);
  void runExitWatch(owner, watch);
  return () => {
    watch.listeners.delete(listener);
    if (
      watch.listeners.size === 0 &&
      exitWatches.get(owner.socketPath) === watch
    ) {
      exitWatches.delete(owner.socketPath);
      watch.socket?.destroy();
    }
  };
}
