/**
 * Cross-process execution liveness via a per-execution heartbeat file.
 *
 * The shared `~/.texra` root is read and written by independent CLI, desktop,
 * and extension processes (#8622), so "is this run active right now?" cannot
 * be answered from any in-process registry: `ExecutionMeta.terminalStatus` is
 * write-once at the end, and a crashed run never writes it. The owning
 * process touches `executions/{id}/heartbeat.json` on an interval while the
 * run is active; any process classifies an execution as live when its meta
 * has no terminal status AND the heartbeat mtime is fresher than
 * {@link HEARTBEAT_FRESH_MS}. A crashed run stops heartbeating and becomes
 * deletable once the freshness window lapses (#8625).
 */

// Third-party imports
import { z } from 'zod';

// Platform imports
import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';

// Local imports - utils
import { isFileNotFoundError } from '@common/errors';
import type { ExecutionId } from '@shared/schemas';
import { StorageFS } from '@utils/files/storageFS';

// Local imports - storage
import { getExecutionStore } from './ExecutionKVStore';
import { listExecutions } from './executionListing';

// Type imports

/** Cadence at which the owning process refreshes active heartbeats. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Staleness window for classifying a heartbeat as live. Three intervals, so
 * one missed touch (event-loop stall, slow disk) never flags a live run as
 * dead, while a crashed run becomes deletable within half a minute.
 */
export const HEARTBEAT_FRESH_MS = 3 * HEARTBEAT_INTERVAL_MS;

const HEARTBEAT_KEY_FILE = 'heartbeat.json';

function heartbeatPath(executionId: ExecutionId): string {
  return resolveRunStoragePath(executionId, HEARTBEAT_KEY_FILE);
}

export type HeartbeatOwnerHost = 'extension' | 'desktop' | 'cli' | 'unknown';

const HeartbeatSchema = z.object({
  at: z.string(),
  host: z.string().optional(),
  pid: z.number().optional(),
});

let ownerHost: HeartbeatOwnerHost = 'unknown';

/**
 * Identify which host this process is, stamped into every heartbeat it
 * writes so other hosts can tell the user where a live run is actually
 * running. Called once at host startup (extension/desktop/CLI init).
 */
export function setHeartbeatOwnerHost(host: HeartbeatOwnerHost): void {
  ownerHost = host;
}

/**
 * Refresh `executionId`'s heartbeat. Called only by the process that owns the
 * run (single-writer-per-execution); freshness is carried by the file's
 * mtime, the body records the owner for guard messages and diagnosis.
 */
export async function touchExecutionHeartbeat(
  executionId: ExecutionId,
): Promise<void> {
  await StorageFS.writeJson(heartbeatPath(executionId), {
    at: new Date().toISOString(),
    host: ownerHost,
    pid: process.pid,
  });
}

async function heartbeatMtime(
  executionId: ExecutionId,
): Promise<number | null> {
  try {
    const stat = await StorageFS.stat(heartbeatPath(executionId));
    return stat.mtime;
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw error;
  }
}

export interface ExecutionLiveness {
  readonly live: boolean;
  /** Which host owns the live run, when its heartbeat records one. */
  readonly ownerHost?: string;
  readonly ownerPid?: number;
}

/**
 * Classify whether `executionId` is running in SOME process — this one or
 * another host sharing the storage root — and, when live, who owns it.
 * Executions that predate the heartbeat and runs that crashed without
 * finalizing read as not live (stale or missing heartbeat), so they stay
 * deletable.
 */
export async function getExecutionLiveness(
  executionId: ExecutionId,
): Promise<ExecutionLiveness> {
  const meta = await getExecutionStore(executionId).readMeta();
  if (!meta || meta.terminalStatus) return { live: false };
  const mtime = await heartbeatMtime(executionId);
  if (mtime == null || Date.now() - mtime >= HEARTBEAT_FRESH_MS) {
    return { live: false };
  }
  const heartbeat = await StorageFS.readJson(
    heartbeatPath(executionId),
    HeartbeatSchema,
  ).catch(() => null);
  return {
    live: true,
    ownerHost: heartbeat?.host,
    ownerPid: heartbeat?.pid,
  };
}

/** True when `executionId` is live in any process sharing the storage root. */
export async function isExecutionLiveOnDisk(
  executionId: ExecutionId,
): Promise<boolean> {
  return (await getExecutionLiveness(executionId)).live;
}

/** Human label for where a live run is running, for guard messages. */
export function describeHeartbeatOwner(ownerHost: string | undefined): string {
  switch (ownerHost) {
    case 'cli':
      return 'the TeXRA CLI';
    case 'desktop':
      return 'the TeXRA desktop app';
    case 'extension':
      return 'the TeXRA VS Code extension';
    default:
      return 'another TeXRA host';
  }
}

/**
 * Ids of every execution currently live in any process. Only non-terminal
 * listing entries pay the heartbeat stat.
 */
export async function listLiveExecutionIds(): Promise<ExecutionId[]> {
  const entries = await listExecutions();
  const candidates = entries.filter((entry) => !entry.terminalStatus);
  const results = await Promise.all(
    candidates.map(async (entry) => {
      const mtime = await heartbeatMtime(entry.id).catch(() => null);
      return mtime != null && Date.now() - mtime < HEARTBEAT_FRESH_MS
        ? entry.id
        : null;
    }),
  );
  return results.filter((id): id is ExecutionId => id != null);
}
