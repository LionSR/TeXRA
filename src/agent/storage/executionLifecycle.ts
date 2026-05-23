/**
 * Execution lifecycle operations.
 *
 * Business logic that orchestrates reads/writes across execution stores
 * and invalidates the listing cache. Separated from ExecutionKVStore to
 * keep the store a clean storage interface — no cross-store mutations,
 * no cache side effects, no error-swallowing policies.
 */

import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { getAgent, isAgentRegistryReady } from '@agent/index/agentRegistry';

import type { ExecutionId } from '@shared/schemas';
import { type ExecutionMeta, getExecutionStore } from './ExecutionKVStore';
import { invalidateListingCache } from './executionListing';

/**
 * Tool-driven executions (e.g. the `bash` background tool) persist a synthetic
 * config tagged `agentCategory: ToolUse` with a name that is not a real
 * tool-use agent. Those rows would otherwise be picked up as chat-session
 * defaults (see `chatDefaults.loadHistoryDefaults`, which keys off
 * `agentConfig.agentCategory === ToolUse`). Demote the persisted category to
 * Workflow for names the loaded registry does not know as tool-use agents so
 * the rows stop polluting defaults resolution.
 *
 * Skipped when the registry is not loaded — an empty registry can't tell
 * "agent absent" from "not loaded yet", and we must never demote a legitimate
 * tool-use agent's run. The displayed history category is unaffected: listing
 * surfaces `meta.category` (e.g. `'process'`) ahead of `config.agentCategory`.
 */
export function normalizeWriterCategory(
  config: AgentConfig,
  agentName: string,
): AgentConfig {
  if (config.agentCategory !== AgentCategory.ToolUse) return config;
  if (!isAgentRegistryReady()) return config;
  if (getAgent(agentName)?.category === AgentCategory.ToolUse) return config;
  return { ...config, agentCategory: AgentCategory.Workflow };
}

// ---------------------------------------------------------------------------
// Per-execution write queue — serializes read-modify-write cycles on meta
// so that concurrent writeTerminalStatus / writeSessionDescription calls
// never race and silently drop each other's fields.
// ---------------------------------------------------------------------------

const metaWriteQueues = new Map<ExecutionId, Promise<void>>();

/**
 * Enqueue a read-modify-write operation on an execution's metadata.
 * Operations for the same executionId are serialized; different IDs run
 * independently. The queue entry is cleaned up when the chain settles.
 */
function enqueueMetaUpdate(
  executionId: ExecutionId,
  updater: (existing: ExecutionMeta) => Partial<ExecutionMeta>,
): Promise<void> {
  const prev = metaWriteQueues.get(executionId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const store = getExecutionStore(executionId);
    const existing = await store.readMeta();
    if (!existing) return;
    await store.writeMeta({ ...existing, ...updater(existing) });
    invalidateListingCache();
  });
  // Swallow errors in the chain so subsequent enqueued ops still run.
  const safe = next.catch(() => {});
  metaWriteQueues.set(executionId, safe);
  // Clean up when chain settles to avoid unbounded growth.
  safe.then(() => {
    if (metaWriteQueues.get(executionId) === safe) {
      metaWriteQueues.delete(executionId);
    }
  });
  return next;
}

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
  delegationDepth?: number,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const store = getExecutionStore(executionId);

  const meta: ExecutionMeta = { timestamp, parentExecutionId };
  if (category) meta.category = category;
  if (delegationDepth !== undefined) meta.delegationDepth = delegationDepth;

  const writes: Promise<void>[] = [
    store.writeConfig(normalizeWriterCategory(config, agentName)),
    store.writeMeta(meta),
  ];

  if (parentExecutionId) {
    writes.push(
      getExecutionStore(parentExecutionId).writeChild(executionId, {
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
 * Serialized with other meta updates for the same execution to prevent
 * read-modify-write races (e.g. with writeSessionDescription).
 * Never throws — storage failures are swallowed so callers' lifecycle
 * logic (untrackExecution, follow-up delivery) always runs.
 */
export async function writeTerminalStatus(
  executionId: ExecutionId,
  status: string,
): Promise<void> {
  try {
    await enqueueMetaUpdate(executionId, () => ({ terminalStatus: status }));
  } catch {
    // Non-critical bookkeeping — don't let I/O errors disrupt execution lifecycle.
  }
}

/**
 * Persist an AI-generated session description on an existing execution's metadata.
 * Serialized with other meta updates for the same execution to prevent
 * read-modify-write races (e.g. with writeTerminalStatus).
 * Never throws — description is supplementary data.
 */
export async function writeSessionDescription(
  executionId: ExecutionId,
  description: string,
): Promise<void> {
  try {
    await enqueueMetaUpdate(executionId, () => ({ description }));
  } catch {
    // Non-critical bookkeeping — don't let I/O errors disrupt execution lifecycle.
  }
}
