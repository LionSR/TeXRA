/**
 * Resolve git worktree context (branch, dirty status) for a working directory.
 *
 * Host-neutral: shells out via `execFile` so the same resolver is usable from
 * the VS Code extension host and the Electron desktop main process. PR
 * enrichment is intentionally out of scope for this module — that will layer
 * on top once the chip is in the UI.
 *
 * A tiny per-path cache lets sync render paths (`buildStreamTabInfo`) read
 * the last-known value via `peekWorktreeInfo()` while async resolution is
 * triggered separately by callers (e.g. on stream creation).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { WorktreeInfo } from '@shared/schemas';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 10_000;

type CacheEntry = {
  value: WorktreeInfo;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<WorktreeInfo>>();

/** Read the last-known worktree info synchronously. Returns stale entries
 *  too — callers are expected to trigger an async refresh separately. */
export function peekWorktreeInfo(
  workingDirectory: string,
): WorktreeInfo | undefined {
  return cache.get(workingDirectory)?.value;
}

/**
 * Resolve branch + dirty status for `workingDirectory`. Results are cached
 * for a short TTL; concurrent callers share one in-flight probe.
 */
export async function resolveWorktreeInfo(
  workingDirectory: string,
): Promise<WorktreeInfo> {
  const cached = cache.get(workingDirectory);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const pending = inflight.get(workingDirectory);
  if (pending) return pending;

  const probe = probeWorktree(workingDirectory).finally(() => {
    inflight.delete(workingDirectory);
  });
  inflight.set(workingDirectory, probe);
  return probe;
}

async function probeWorktree(workingDirectory: string): Promise<WorktreeInfo> {
  const [branch, dirty] = await Promise.all([
    readBranch(workingDirectory),
    readDirty(workingDirectory),
  ]);

  const value: WorktreeInfo = {
    workingDirectory,
    branch,
    dirty,
  };
  cache.set(workingDirectory, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

async function readBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, timeout: GIT_TIMEOUT_MS },
    );
    const name = stdout.trim();
    return name && name !== 'HEAD' ? name : undefined;
  } catch {
    return undefined;
  }
}

async function readDirty(cwd: string): Promise<boolean | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim().length > 0;
  } catch {
    return undefined;
  }
}
