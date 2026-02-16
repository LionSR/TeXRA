/**
 * Execution lifecycle operations.
 *
 * Business logic that orchestrates reads/writes across execution stores
 * and invalidates the listing cache. Separated from ExecutionKVStore to
 * keep the store a clean storage interface — no cross-store mutations,
 * no cache side effects, no error-swallowing policies.
 */

import type { AgentConfig } from '@agent/core/AgentConfig';
import type { ExecutionId } from '@shared/schemas';

import { type ExecutionMeta, getExecutionStore } from './ExecutionKVStore';
import { invalidateListingCache } from './executionListing';

/**
 * Register a new execution: persist config, metadata, and parent linkage.
 * Awaits all writes before returning, then invalidates the listing cache.
 */
export async function registerExecution(
  executionId: ExecutionId,
  config: AgentConfig,
  agentName: string,
  parentExecutionId?: ExecutionId,
  category?: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const store = getExecutionStore(executionId);

  const meta: ExecutionMeta = { timestamp, parentExecutionId };
  if (category) meta.category = category;

  const writes: Promise<void>[] = [
    store.write('config', config),
    store.write('meta', meta),
  ];

  if (parentExecutionId) {
    writes.push(
      getExecutionStore(parentExecutionId).write(`child-${executionId}`, {
        agent: agentName,
        timestamp,
      }),
    );
  }

  await Promise.all(writes);
  invalidateListingCache();
}

/**
 * Persist a terminal status on an existing execution's metadata.
 * Reads the current meta, merges `terminalStatus`, and writes back.
 * Never throws — storage failures are swallowed so callers' lifecycle
 * logic (untrackExecution, follow-up delivery) always runs.
 */
export async function writeTerminalStatus(
  executionId: ExecutionId,
  status: string,
): Promise<void> {
  try {
    const store = getExecutionStore(executionId);
    const existing = await store.read<ExecutionMeta>('meta');
    if (!existing) return;
    await store.write('meta', { ...existing, terminalStatus: status });
    invalidateListingCache();
  } catch {
    // Non-critical bookkeeping — don't let I/O errors disrupt execution lifecycle.
  }
}

/**
 * Persist an AI-generated session description on an existing execution's metadata.
 * Never throws — description is supplementary data.
 */
export async function writeSessionDescription(
  executionId: ExecutionId,
  description: string,
): Promise<void> {
  try {
    const store = getExecutionStore(executionId);
    const existing = await store.read<ExecutionMeta>('meta');
    if (!existing) return;
    await store.write('meta', { ...existing, description });
    invalidateListingCache();
  } catch {
    // Non-critical bookkeeping — don't let I/O errors disrupt execution lifecycle.
  }
}
