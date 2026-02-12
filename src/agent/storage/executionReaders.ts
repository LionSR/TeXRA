/**
 * Persistence readers and registration for execution-scoped data.
 *
 * Each reader tries a direct KV key first (written at production time),
 * then falls back to extracting from the flow blob or history for
 * backward compatibility and in-flight executions.
 */

import type { AgentConfig } from '@agent/core/AgentConfig';
import type { ExecutionId } from '@shared/schemas';

import { getExecutionStore } from './ExecutionKVStore';

/** Lazy-loaded AgentHistoryManager to avoid circular imports. */
async function getHistoryManager() {
  const { AgentHistoryManager } =
    await import('@common/history/AgentHistoryManager');
  return AgentHistoryManager;
}

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

/** Execution metadata stored alongside config at launch time. */
export interface ExecutionMeta {
  timestamp: string;
  parentExecutionId?: ExecutionId;
}

/** Read execution metadata: direct key first, history fallback. */
export async function readMeta(
  executionId: ExecutionId,
): Promise<ExecutionMeta | null> {
  const store = getExecutionStore(executionId);
  const direct = await store.read<ExecutionMeta>('meta');
  if (direct?.timestamp) return direct;

  // Fallback: history index
  const mgr = await getHistoryManager();
  const item = await mgr.getHistoryItemById(executionId);
  if (!item) return null;
  return {
    timestamp: item.timestamp,
    parentExecutionId: item.parentExecutionId,
  };
}

/** Read agent config: direct key first, history fallback. */
export async function readConfig(
  executionId: ExecutionId,
): Promise<unknown | null> {
  const store = getExecutionStore(executionId);
  const direct = await store.read('config');
  if (direct) return direct;

  // Fallback: history index
  const mgr = await getHistoryManager();
  const item = await mgr.getHistoryItemById(executionId);
  return item?.agentConfig ?? null;
}

/** Read children: per-child KV keys first, history fallback. */
export async function readChildren(
  executionId: ExecutionId,
): Promise<ChildRecord[]> {
  const store = getExecutionStore(executionId);
  const childKeys = await store.listKeys('child-');

  if (childKeys.length > 0) {
    const entries = await Promise.all(
      childKeys.map(async (key) => {
        const id = key.replace('child-', '') as ExecutionId;
        const data = await store.read<{ agent: string; timestamp: string }>(
          key,
        );
        return data
          ? { id, agent: data.agent, timestamp: data.timestamp }
          : null;
      }),
    );
    return entries.filter((e): e is ChildRecord => e !== null);
  }

  // Fallback: history index
  const mgr = await getHistoryManager();
  const items = await mgr.getChildrenOf(executionId);
  return items.map((item) => ({
    id: item.id,
    agent: item.agentConfig.agent,
    timestamp: item.timestamp,
  }));
}

// ============================================================================
// Registration (write path)
// ============================================================================

/**
 * Register a new execution: persist config, metadata, history entry,
 * and parent linkage. Awaits all writes before returning.
 */
export async function registerExecution(
  executionId: ExecutionId,
  config: AgentConfig,
  agentName: string,
  parentExecutionId?: ExecutionId,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const store = getExecutionStore(executionId);
  const mgr = await getHistoryManager();

  const writes: Promise<void>[] = [
    mgr.addToHistory(executionId, config, parentExecutionId),
    store.write('config', config),
    store.write('meta', {
      timestamp,
      parentExecutionId,
    } satisfies ExecutionMeta),
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
}
