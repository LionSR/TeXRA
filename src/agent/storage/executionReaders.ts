/**
 * Persistence readers and registration for execution-scoped data.
 *
 * Each reader tries a direct KV key first (written at production time),
 * then falls back to extracting from the flow blob for
 * backward compatibility and in-flight executions.
 */

import type { AgentConfig } from '@agent/core/AgentConfig';

import { type ExecutionMeta, getExecutionStore } from './ExecutionKVStore';
import { invalidateListingCache } from './executionListing';
import type { ExecutionId } from '@shared/schemas';

export type { ExecutionMeta };

/** Shape of a persisted todo item from tool-use flow state. */
export interface TodoEntry {
  content?: string;
  status?: string;
}

/** Shape of a child execution record stored as `child-{id}` on the parent. */
export interface ChildRecord {
  id: ExecutionId;
  agent: string;
  timestamp: string;
}

/** Read todo items: direct key first, flow blob fallback. */
export async function readTodos(
  executionId: ExecutionId,
): Promise<TodoEntry[]> {
  const store = getExecutionStore(executionId);

  // Direct key (written at flow completion)
  const direct = await store.read<TodoEntry[]>('todos');
  if (Array.isArray(direct) && direct.length > 0) return direct;

  // Fallback: extract from flow blob (backward compat / running executions)
  const flow = await store.read<{
    shared?: {
      stateSlices?: {
        workspaceSnapshot?: { todos?: { todos?: unknown[] } };
      };
    };
  }>(`flow:${executionId}`);

  const raw = flow?.shared?.stateSlices?.workspaceSnapshot?.todos?.todos;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw as TodoEntry[];
}

/** Read conversation messages: direct key first, flow blob fallback. */
export async function readConversation(
  executionId: ExecutionId,
): Promise<unknown[] | null> {
  const store = getExecutionStore(executionId);

  // Direct key (written at flow completion)
  const direct = await store.read<unknown[]>('conversation');
  if (Array.isArray(direct) && direct.length > 0) return direct;

  // Fallback: extract from flow blob (backward compat / running executions)
  const flow = await store.read<{
    shared?: { conversation?: unknown[]; messages?: unknown[] };
  }>(`flow:${executionId}`);
  return flow?.shared?.conversation ?? flow?.shared?.messages ?? null;
}

/** Read the persisted subagent/process report (if any). */
export async function readReport(
  executionId: ExecutionId,
): Promise<string | null> {
  const store = getExecutionStore(executionId);
  return (await store.read<string>('report')) ?? null;
}

/** Read execution metadata from KV. */
export async function readMeta(
  executionId: ExecutionId,
): Promise<ExecutionMeta | null> {
  const store = getExecutionStore(executionId);
  const direct = await store.read<ExecutionMeta>('meta');
  if (direct?.timestamp) return direct;
  return null;
}

/** Read agent config from KV. */
export async function readConfig(
  executionId: ExecutionId,
): Promise<AgentConfig | null> {
  const store = getExecutionStore(executionId);
  return (await store.read<AgentConfig>('config')) ?? null;
}

/** Read children: per-child KV keys. */
export async function readChildren(
  executionId: ExecutionId,
): Promise<ChildRecord[]> {
  const store = getExecutionStore(executionId);
  const childKeys = await store.listKeys('child-');

  if (childKeys.length === 0) return [];

  const entries = await Promise.all(
    childKeys.map(async (key) => {
      const id = key.replace('child-', '') as ExecutionId;
      const data = await store.read<{ agent: string; timestamp: string }>(key);
      return data ? { id, agent: data.agent, timestamp: data.timestamp } : null;
    }),
  );
  return entries.filter((e): e is ChildRecord => e !== null);
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

// ============================================================================
// Registration (write path)
// ============================================================================

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
