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
 * A liveness verdict is a proof or an admission that no proof exists:
 * - `alive`: the owner's socket accepted and answered with its own banner.
 * - `dead`: the kernel states no such listener exists (`ECONNREFUSED` /
 *   `ENOENT`), or a *newer TeXRA instance* answered on a reused path.
 * - `unprovable`: anything else (timeout, permission error, foreign hostname,
 *   non-TeXRA banner). Callers must treat this as alive: we never reclaim on
 *   ambiguity.
 */
export type InstanceLiveness = 'alive' | 'dead' | 'unprovable';

interface PresenceServer {
  readonly record: InstanceOwnerRecord;
  readonly server: net.Server;
}

let presenceServer: Promise<PresenceServer> | undefined;
let cleanupRegistered = false;

function isWindows(): boolean {
  return process.platform === 'win32';
}

function newInstanceId(): string {
  return randomBytes(8).toString('hex');
}

function socketPathFor(instanceId: string): string {
  if (isWindows()) return `\\\\.\\pipe\\texra-${instanceId}`;
  const preferred = path.join(
    platform().storage.getGlobalStoragePath(),
    'instances',
    `${instanceId}.sock`,
  );
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
  // A tmp cleaner may unlink a live owner's socket file here; probes treat a
  // missing file as death only with a pid proof (isDeathProofError). Loud so
  // a user hitting it can shorten their storage root.
  const fallback = path.join(os.tmpdir(), `texra-${instanceId}.sock`);
  log.warn(
    `Instance presence socket path exceeds the platform limit; falling back to ${fallback}`,
    { data: { preferred } },
  );
  return fallback;
}

async function startPresenceServer(): Promise<PresenceServer> {
  const instanceId = newInstanceId();
  const socketPath = socketPathFor(instanceId);
  if (!isWindows()) {
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
  // Presence must never keep the process alive on its own.
  server.unref();
  if (!cleanupRegistered && !isWindows()) {
    cleanupRegistered = true;
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
    record: {
      instanceId,
      socketPath,
      pid: process.pid,
      hostname: os.hostname(),
    },
    server,
  };
}

/**
 * The identity this process stamps into execution leases it acquires. Binds
 * the presence socket on first use and keeps it for the process lifetime.
 */
export function ensureInstancePresence(): Promise<InstanceOwnerRecord> {
  presenceServer ??= startPresenceServer().catch((error: unknown) => {
    presenceServer = undefined;
    throw error;
  });
  return presenceServer.then((running) => running.record);
}

/** Hostnames are case-insensitive on every platform TeXRA supports. */
function isSameHost(owner: InstanceOwnerRecord): boolean {
  return owner.hostname.toLowerCase() === os.hostname().toLowerCase();
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

function isDeathProofError(
  error: unknown,
  owner: InstanceOwnerRecord,
): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  if (error.code === 'ECONNREFUSED') return true;
  // A crashed owner leaves its socket file behind (ECONNREFUSED above), so a
  // missing file means it was unlinked — by graceful exit, or from under a
  // live owner (e.g. a tmp cleaner in the fallback directory). Death then
  // additionally requires the recorded pid to be provably gone.
  return error.code === 'ENOENT' && pidProvablyDead(owner.pid);
}

interface BannerConnection {
  readonly socket: net.Socket;
  /** Resolves once, with the probe verdict for `owner`. */
  readonly verdict: Promise<InstanceLiveness>;
}

function connectForBanner(owner: InstanceOwnerRecord): BannerConnection {
  const socket = net.connect(owner.socketPath);
  const verdict = new Promise<InstanceLiveness>((resolve) => {
    let settled = false;
    const finish = (liveness: InstanceLiveness): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(liveness);
    };
    const timer = setTimeout(() => finish('unprovable'), PROBE_TIMEOUT_MS);
    timer.unref();
    let buffered = '';
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline === -1) {
        if (Buffer.byteLength(buffered) > MAX_BANNER_BYTES) {
          finish('unprovable');
        }
        return;
      }
      const banner = buffered.slice(0, newline);
      if (banner === `${BANNER_PREFIX}${owner.instanceId}`) {
        finish('alive');
      } else if (banner.startsWith(BANNER_PREFIX)) {
        // A different TeXRA instance answering on this path proves the
        // recorded owner is gone: the path was released and reused.
        finish('dead');
      } else {
        finish('unprovable');
      }
    });
    socket.on('error', (error: unknown) => {
      finish(isDeathProofError(error, owner) ? 'dead' : 'unprovable');
    });
    socket.on('close', () => finish('unprovable'));
  });
  return { socket, verdict };
}

/**
 * Prove whether the process identified by `owner` is alive. `unprovable`
 * means exactly that; callers treat it as alive and must not reclaim.
 */
export async function probeInstance(
  owner: InstanceOwnerRecord,
): Promise<InstanceLiveness> {
  if (!isSameHost(owner)) {
    log.warn(
      `Execution lease owner lives on host ${owner.hostname}; liveness is unprovable from ${os.hostname()}`,
    );
    return 'unprovable';
  }
  const connection = connectForBanner(owner);
  const verdict = await connection.verdict;
  connection.socket.destroy();
  return verdict;
}

interface InstanceExitWatch {
  readonly listeners: Set<() => void>;
  socket: net.Socket | undefined;
}

const exitWatches = new Map<string, InstanceExitWatch>();

function fireExitWatch(socketPath: string): void {
  const watch = exitWatches.get(socketPath);
  if (!watch) return;
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
    const connection = connectForBanner(owner);
    watch.socket = connection.socket;
    // Watch connections are held open; they must not keep the process alive.
    connection.socket.unref();
    const liveness = await connection.verdict;
    if (exitWatches.get(owner.socketPath) !== watch) {
      connection.socket.destroy();
      return;
    }
    if (liveness === 'dead') {
      fireExitWatch(owner.socketPath);
      return;
    }
    if (liveness === 'alive') {
      unprovableStreak = 0;
      await new Promise<void>((resolve) =>
        connection.socket.once('close', () => resolve()),
      );
      if (exitWatches.get(owner.socketPath) !== watch) return;
      // The held connection closed: usually the owner's death, occasionally a
      // disturbed connection. Reconnect for the actual verdict either way.
      continue;
    }
    unprovableStreak += 1;
    connection.socket.destroy();
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
  // Mirror probeInstance's cross-host guard: a local connect failure says
  // nothing about an owner on another machine, so the watch must never fire.
  if (!isSameHost(owner)) {
    log.warn(
      `Execution lease owner lives on host ${owner.hostname}; its exit cannot be watched from ${os.hostname()}`,
    );
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
