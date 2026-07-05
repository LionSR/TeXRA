/**
 * Execution lifecycle operations.
 *
 * Business logic that orchestrates reads/writes across execution stores
 * and invalidates the listing cache. Separated from ExecutionKVStore to
 * keep the store a clean storage interface — no cross-store mutations,
 * no cache side effects, no error-swallowing policies.
 */

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { getAgent, isAgentRegistryReady } from '@agent/index/agentRegistry';

import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import { WorkspaceFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  type ExecutionMeta,
  type ExecutionMetaInput,
  getExecutionStore,
} from './ExecutionKVStore';
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
  if (
    getAgent(agentName, AgentCategory.ToolUse)?.category ===
    AgentCategory.ToolUse
  ) {
    return config;
  }
  return { ...config, agentCategory: AgentCategory.Workflow };
}

function pinExecutionWorkingDirectory(config: AgentConfig): AgentConfig {
  const workingDirectory =
    config.workingDirectory?.trim() || WorkspaceFS.getPath()?.trim();
  return workingDirectory ? { ...config, workingDirectory } : config;
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

  const meta: ExecutionMetaInput = { timestamp, parentExecutionId };
  if (category) meta.category = category;
  if (delegationDepth !== undefined) meta.delegationDepth = delegationDepth;
  const persistedConfig = normalizeWriterCategory(
    pinExecutionWorkingDirectory(config),
    agentName,
  );

  const writes: Promise<void>[] = [
    store.writeConfig(persistedConfig),
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
 * Persist supplementary metadata fields on an existing execution.
 * Serialized with other meta updates for the same execution to prevent
 * read-modify-write races (e.g. between terminal status and description).
 * Never throws — these are non-critical bookkeeping writes, so storage
 * failures are swallowed and callers' lifecycle logic (registry untrack,
 * follow-up delivery) always runs.
 */
async function persistMetaField(
  executionId: ExecutionId,
  fields: Partial<ExecutionMeta>,
  what: string,
): Promise<void> {
  try {
    await enqueueMetaUpdate(executionId, () => fields);
  } catch (err) {
    // Non-critical bookkeeping — don't let I/O errors disrupt execution lifecycle.
    logger.debug(
      'ExecutionLifecycle',
      `Failed to persist ${what} for ${executionId}: ${toErrorMessage(err)}`,
    );
  }
}

/** Persist a terminal status on an existing execution's metadata. */
export async function writeTerminalStatus(
  executionId: ExecutionId,
  status: string,
): Promise<void> {
  await persistMetaField(
    executionId,
    { terminalStatus: status },
    'terminal status',
  );
}

/** Persist an AI-generated session description on an existing execution's metadata. */
export async function writeSessionDescription(
  executionId: ExecutionId,
  description: string,
): Promise<void> {
  await persistMetaField(executionId, { description }, 'session description');
}
