/**
 * Execution lifecycle operations.
 *
 * Business logic that orchestrates reads and writes across execution stores.
 * Separated from ExecutionKVStore to keep the store a clean storage interface
 * with no cross-store mutations or error-swallowing policies.
 */

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { getAgent, isAgentRegistryReady } from '@agent/index/agentRegistry';
import { flowKey } from '@agent/node/persistedFlow';

import * as logger from '@logger/logUtils';
import {
  RUN_OUTCOME,
  executionStatusToRunOutcome,
  type ExecutionId,
  type ExecutionMeta,
  type ExecutionStatus,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import { WorkspaceFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getExecutionStore } from './ExecutionKVStore';
import {
  acquireFreshExecutionLease,
  releaseOwnedExecutionLease,
} from './executionLease';
import { ResultMetaSchema } from './resultMeta';

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

/** Return whether readable persisted metadata directly links to a parent. */
export async function hasPersistedParent(
  executionId: ExecutionId,
): Promise<boolean> {
  const meta = await getExecutionStore(executionId).readMeta();
  return meta?.parentExecutionId !== undefined;
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
    if (!existing) {
      throw new Error(`Execution metadata not found for ${executionId}`);
    }
    await store.writeMeta({ ...existing, ...updater(existing) });
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
 * Awaits all writes before returning.
 */
export async function registerExecution(
  executionId: ExecutionId,
  config: AgentConfig,
  agentName: string,
  parentExecutionId?: ExecutionId,
  category?: string,
): Promise<void> {
  await acquireFreshExecutionLease(executionId);
  try {
    const timestamp = new Date().toISOString();
    const store = getExecutionStore(executionId);
    const meta = {
      timestamp,
      parentExecutionId,
      ...(category ? { category } : {}),
    };
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

    const results = await Promise.allSettled(writes);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `Multiple execution registration writes failed for ${executionId}`,
      );
    }
  } catch (error) {
    try {
      await releaseOwnedExecutionLease(executionId);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `Execution registration and lease rollback failed for ${executionId}`,
      );
    }
    throw error;
  }
}

/**
 * Persist supplementary metadata fields on an existing execution as a
 * best-effort operation.
 * Serialized with other meta updates for the same execution to prevent
 * read-modify-write races (e.g. between terminal status and description).
 * Never throws because these fields are caches or presentation metadata, not
 * lifecycle state. Authoritative metadata must use enqueueMetaUpdate directly.
 */
async function persistSupplementaryMetaFieldsBestEffort(
  executionId: ExecutionId,
  fields: Partial<ExecutionMeta>,
  what: string,
): Promise<void> {
  try {
    await enqueueMetaUpdate(executionId, () => fields);
  } catch (err) {
    // Swallow and log — don't let storage I/O errors disrupt execution lifecycle.
    logger.debug(
      'ExecutionLifecycle',
      `Failed to persist ${what} for ${executionId}: ${toErrorMessage(err)}`,
    );
  }
}

/**
 * Align an existing agent result after a suspended run terminates between
 * turns. Call this only when no later turn-owned result write can replace the
 * record. The durable execution outcome is checked first, so a failed status
 * write cannot relabel the result on its own.
 */
export async function synchronizeAgentResultOutcome(
  executionId: ExecutionId,
  outcome: RunOutcome,
): Promise<void> {
  try {
    const store = getExecutionStore(executionId);
    const meta = await store.readMeta();
    if (meta?.outcome !== outcome) return;

    const resultMeta = await store.readResultMeta();
    if (
      !resultMeta ||
      resultMeta.producer === 'backgroundBash' ||
      resultMeta.result.outcome === outcome
    ) {
      return;
    }
    const updatedResultMeta = ResultMetaSchema.parse({
      ...resultMeta,
      result: { ...resultMeta.result, outcome },
    });
    await store.writeResultMeta(updatedResultMeta);
  } catch (err) {
    // Terminal cleanup stays non-throwing, but this leaves the public result
    // stale and must remain visible to operators.
    logger.warn(
      'ExecutionLifecycle',
      `Failed to synchronize result outcome for ${executionId}: ${toErrorMessage(err)}`,
      { data: err },
    );
  }
}

/**
 * Persist a terminal status and its canonical outcome projection.
 * @deprecated Use {@link finalizeExecution} so flow-record disposition and
 * durability failures are handled together.
 */
export async function writeTerminalStatus(
  executionId: ExecutionId,
  status: ExecutionStatus,
): Promise<void> {
  const outcome = executionStatusToRunOutcome(status);
  await enqueueMetaUpdate(executionId, () => ({
    terminalStatus: status,
    ...(outcome && { outcome }),
  }));
}

export interface FinalizeExecutionInput {
  readonly executionId: ExecutionId;
  readonly terminalStatus: ExecutionStatus;
  readonly flowRecord: 'preserve' | 'delete';
}

export type FinalizeExecutionResult =
  | {
      readonly status: 'durable';
      readonly terminalStatusPersisted: true;
      readonly flowRecord: 'preserved' | 'deleted';
    }
  | {
      readonly status: 'failed';
      readonly error: unknown;
      readonly stage:
        'terminal-status' | 'terminal-status-and-flow-record-delete';
      readonly terminalStatusPersisted: false;
    }
  | {
      readonly status: 'failed';
      readonly error: unknown;
      readonly stage: 'flow-record-delete';
      readonly terminalStatusPersisted: true;
    };

/** Persist terminal metadata, then apply the requested flow-record policy. */
export async function finalizeExecution({
  executionId,
  terminalStatus,
  flowRecord,
}: FinalizeExecutionInput): Promise<FinalizeExecutionResult> {
  try {
    await writeTerminalStatus(executionId, terminalStatus);
  } catch (error) {
    const outcome = executionStatusToRunOutcome(terminalStatus);
    // A terminal COMPLETED/FAILED result must never retain a resumable flow,
    // even when the caller requested preservation before the status write failed.
    const deleteToFailClosed =
      flowRecord === 'delete' ||
      outcome === RUN_OUTCOME.COMPLETED ||
      outcome === RUN_OUTCOME.FAILED;
    if (deleteToFailClosed) {
      try {
        await getExecutionStore(executionId).delete(flowKey(executionId));
      } catch (deleteError) {
        return {
          status: 'failed',
          error: new AggregateError(
            [error, deleteError],
            `Terminal metadata and flow deletion failed for ${executionId}`,
          ),
          stage: 'terminal-status-and-flow-record-delete',
          terminalStatusPersisted: false,
        };
      }
    }
    return {
      status: 'failed',
      error,
      stage: 'terminal-status',
      terminalStatusPersisted: false,
    };
  }

  if (flowRecord === 'preserve') {
    return {
      status: 'durable',
      terminalStatusPersisted: true,
      flowRecord: 'preserved',
    };
  }

  try {
    await getExecutionStore(executionId).delete(flowKey(executionId));
    return {
      status: 'durable',
      terminalStatusPersisted: true,
      flowRecord: 'deleted',
    };
  } catch (error) {
    return {
      status: 'failed',
      error,
      stage: 'flow-record-delete',
      terminalStatusPersisted: true,
    };
  }
}

/** Persist an AI-generated session description on an existing execution's metadata. */
export async function writeSessionDescription(
  executionId: ExecutionId,
  description: string,
): Promise<void> {
  await persistSupplementaryMetaFieldsBestEffort(
    executionId,
    { description },
    'session description',
  );
}

/**
 * Cache the resolved transcript stream for an execution, once
 * `resolvePersistedStreamIdForExecution` (`executionStreamResolver.ts`) has
 * actually decided it via its meta-scan, so later resolutions for the same
 * executionId can skip straight to this field instead of re-scanning.
 */
export async function writeExecutionStreamId(
  executionId: ExecutionId,
  streamId: StreamTabId,
): Promise<void> {
  await persistSupplementaryMetaFieldsBestEffort(
    executionId,
    { streamId },
    'execution stream id',
  );
}
