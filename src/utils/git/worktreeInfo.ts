/**
 * Resolve git worktree context (branch, dirty status) for a working directory.
 *
 * Host-neutral: shells out via the shared command runner so the same resolver
 * is usable from the VS Code extension host and the Electron desktop main process. PR
 * enrichment is intentionally out of scope for this module — that will layer
 * on top once the chip is in the UI.
 *
 * A tiny per-path cache lets sync render paths (`buildStreamTabInfo`) read
 * the last-known value via `peekWorktreeInfo()` while async resolution is
 * triggered separately by callers (e.g. on stream creation).
 */

import { LRUCache } from 'lru-cache';

import type { WorktreeInfo } from '@shared/schemas';

import { coalesceAsync } from '@utils/core';
import { executeCommand } from '@utils/system/execUtils';

const GIT_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 32;

// Cap entries so an unusual session that probes many distinct working
// directories doesn't grow this Map forever; the LRU drops cold paths.
// `noDeleteOnStaleGet` keeps stale entries in place so a render path can
// keep showing the last-known value across many frames while an async
// refresh runs — without it, the first stale read would evict the entry
// and subsequent frames would see `undefined` until the probe completes.
const cache = new LRUCache<string, WorktreeInfo>({
  max: CACHE_MAX_ENTRIES,
  ttl: CACHE_TTL_MS,
  noDeleteOnStaleGet: true,
});
const inflight = new Map<string, Promise<WorktreeInfo>>();

/** Read the last-known worktree info synchronously. Returns stale entries
 *  too — callers are expected to trigger an async refresh separately. */
export function peekWorktreeInfo(
  workingDirectory: string,
): WorktreeInfo | undefined {
  // `allowStale` so a render path can show the last-known value while a
  // refresh is in flight; an empty slot still returns undefined.
  return cache.get(workingDirectory, { allowStale: true });
}

/**
 * Resolve branch + dirty status for `workingDirectory`. Results are cached
 * for a short TTL; concurrent callers share one in-flight probe.
 */
export async function resolveWorktreeInfo(
  workingDirectory: string,
): Promise<WorktreeInfo> {
  return coalesceAsync<string, WorktreeInfo>(
    cache,
    inflight,
    workingDirectory,
    () => probeWorktree(workingDirectory),
  );
}

async function probeWorktree(workingDirectory: string): Promise<WorktreeInfo> {
  const [branch, dirty] = await Promise.all([
    readBranch(workingDirectory),
    readDirty(workingDirectory),
  ]);

  return { workingDirectory, branch, dirty };
}

async function readBranch(cwd: string): Promise<string | undefined> {
  const result = await executeCommand(
    ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd, timeout: GIT_TIMEOUT_MS, channel: 'worktreeInfo' },
  );
  if (!result.success) return undefined;
  const name = result.stdout?.trim();
  return name && name !== 'HEAD' ? name : undefined;
}

async function readDirty(cwd: string): Promise<boolean | undefined> {
  const result = await executeCommand(['git', 'status', '--porcelain'], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    channel: 'worktreeInfo',
  });
  return result.success ? result.stdout.trim().length > 0 : undefined;
}
