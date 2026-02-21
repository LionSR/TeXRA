import {
  END_GROUP_STATUS,
  EXECUTION_STATUS,
  STREAM_STATUS,
  type EndGroupStatus,
  type ExecutionId,
} from '@shared/schemas';
import { getExecutionStore } from '@agent/storage';
import type { ExecutionKVStore } from '@agent/storage/ExecutionKVStore';
import {
  registerInterruptible,
  unregisterInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';

import type { FlowRecord } from '@agent/node/persisted-flow';

import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';
import { executionToEndStatus } from '@common/constants/streamStatus';
import type { ToolDefinition } from '@model';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import { getDefaultToolRegistry } from '@tools/registry';
import { getUnavailableToolNamesCached } from '@tools/toolAvailability';
import { notifyUnavailableTools } from '@tools/toolUnavailableNotification';
import { getToolUseMemoryEnabled } from '@utils/config/constants';

import {
  prepareToolUse,
  runToolUseCycle,
  waitForFollowUp,
} from './toolUsePipeline';
import {
  findLastAssistantText,
  migrateSharedState,
  type ToolUseRunShared,
} from './nodes/types';
import { ToolUseSessionLifecycle } from './ToolUseSessionLifecycle';
import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';
import type { ToolUseServices } from './ToolUseServices';
import type { SubagentProgressUpdate } from '@tools/subagentResults';

export interface RunToolUseFlowInput<
  C = unknown,
> extends BaseFlowContextInit<C> {
  setting: AgentToolUseSetting;
  resumeSnapshot?: ToolUseSessionSnapshot | null;
  onFollowUpConsumed?: () => void;
  /** When true, delegation tools are filtered out to prevent nesting. */
  isSubagent?: boolean;
  /** Fires before the subagent enters WAITING, delivering the last response to the orchestrator. */
  onBeforeWaiting?: (lastResponse: string | undefined) => void | Promise<void>;
  /** Fires on meaningful progress: todo changes, tool call milestones. */
  onProgress?: (update: SubagentProgressUpdate) => void;
}

export interface RunToolUseFlowResult {
  status: EndGroupStatus;
  lastResponse?: string;
}

export interface ToolUseFlowContext {
  readonly session: ToolUseSessionLifecycle;
  readonly modelHandler: ToolUseServices['modelHandler'];
  interrupt(): void;
}

export type ToolUseFlowSetupCallback = (context: ToolUseFlowContext) => void;

function resolveTools(
  tools: AgentToolUseSetting['tools'],
  registry: IToolRegistry,
  logger: { warn: (msg: string) => void },
  options?: { isSubagent?: boolean },
): ToolDefinition[] {
  const unavailable = getUnavailableToolNamesCached();
  const excluded: string[] = [];

  const toolConfigs = Array.isArray(tools) ? tools : [];
  const resolved = toolConfigs
    .map((config) => (typeof config === 'string' ? { name: config } : config))
    .filter((def) => {
      if (options?.isSubagent && DELEGATION_TOOLS.has(def.name)) return false;
      if (unavailable.has(def.name)) {
        logger.warn(
          `Tool "${def.name}" excluded: external dependency not installed`,
        );
        excluded.push(def.name);
        return false;
      }
      if (!registry.has(def.name)) {
        logger.warn(`Tool "${def.name}" not found in registry`);
        return false;
      }
      return true;
    });

  // Inject memory tool into all tool-use agents (including subagents)
  // so they share the same /memories directory.
  if (getToolUseMemoryEnabled() && !resolved.some((d) => d.name === 'memory')) {
    const memoryTool = registry.get('memory');
    if (memoryTool) {
      resolved.push(memoryTool.definition);
    } else {
      logger.warn('Memory tool not found in registry');
    }
  }

  if (excluded.length > 0) {
    notifyUnavailableTools(excluded);
  }

  return resolved;
}

export async function runToolUseFlow<C = unknown>(
  input: RunToolUseFlowInput<C>,
  toolRegistry?: IToolRegistry,
  onSetup?: ToolUseFlowSetupCallback,
): Promise<RunToolUseFlowResult> {
  const { logger, streamId, executionId, setting, onInterrupt } = input;
  const sessionLifecycle = new ToolUseSessionLifecycle(streamId);
  const registry = toolRegistry ?? getDefaultToolRegistry();
  const resolvedTools = resolveTools(setting.tools, registry, logger, {
    isSubagent: input.isSubagent,
  });

  const services: ToolUseServices<C> = {
    ...input,
    session: sessionLifecycle,
    resolvedTools,
    toolRegistry: registry,
    snapshot: input.resumeSnapshot ?? null,
    onRoundFinalized: input.onRoundFinalized ?? (async () => {}),
  };

  const flowContext: ToolUseFlowContext = {
    session: sessionLifecycle,
    modelHandler: input.modelHandler,
    interrupt(): void {
      onInterrupt?.();
      retryCoordinator.clearRequest(streamId);
      sessionLifecycle.interrupt();
    },
  };

  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;

  let shared: ToolUseRunShared = {
    messages: [],
    shouldSkipCycle: false,
    stateSlices: null,
  };

  const kv = getExecutionStore(executionId);

  try {
    registerInterruptible(streamId, flowContext);
    onSetup?.(flowContext);

    // --- Resume from persistence ---
    let flowRecord: FlowRecord | null = null;
    try {
      flowRecord =
        (await kv.read<FlowRecord>(`flow:${executionId}`)) ?? null;
    } catch {
      logger.debug('Resume parse failed, starting fresh');
    }
    if (flowRecord?.shared) {
      logger.debug('Resuming tool-use flow from persistence');
      const migrationResult = migrateSharedState(flowRecord.shared);
      if (migrationResult === null) {
        logger.warn(
          'Failed to parse flow record shared state, starting fresh',
        );
        await kv.delete(`flow:${executionId}`);
        flowRecord = null;
      } else if (migrationResult.migrated) {
        logger.debug('Migrated legacy shared state to flat format');
        shared = migrationResult.data;
      } else {
        shared = migrationResult.data;
      }
    }

    // Persist initial state so hasPersistedFlowRecord() can detect this flow
    if (!flowRecord) {
      await kv.write(`flow:${executionId}`, {
        flowName: 'texra',
        params: {},
        shared: structuredClone(shared),
        createdAt: new Date().toISOString(),
        nodes: [],
      } satisfies FlowRecord);
    }

    // --- Pipeline (replaces PersistedFlow + 3 node classes) ---

    // Step 1: Prepare
    await prepareToolUse(shared, services);

    // Checkpoint after prepare
    await persistCheckpoint(kv, executionId, shared);

    // Step 2+3: Cycle → Wait loop
    while (true) {
      const cycleResult = await runToolUseCycle(shared, services);

      // Checkpoint after cycle
      await persistCheckpoint(kv, executionId, shared);

      if (cycleResult.outcome === 'failed') {
        shared.lastError = {
          message: cycleResult.message,
          retryable: cycleResult.retryable ?? false,
        };
        break;
      }

      if (cycleResult.outcome === 'cancelled') {
        shared.userCancelledRetry = true;
        break;
      }

      // 'completed' or 'skipped' — wait for follow-up
      const waitResult = await waitForFollowUp(shared, services);

      if (waitResult.kind === 'stop') {
        break;
      }

      // Follow-up received — prepare messages and loop back to cycle
      services.onFollowUpConsumed?.();
      StreamStatusService.set(streamId, STREAM_STATUS.RUNNING);
      logger.userMessage(waitResult.followUp);
      shared.messages = await services.modelHandler.createUserFollowUpMessages(
        shared.messages,
        waitResult.followUp,
      );

      // Checkpoint after follow-up
      await persistCheckpoint(kv, executionId, shared);
    }

    if (shared.lastError) {
      status = END_GROUP_STATUS.ERROR;
      // Re-throw after state persistence (handled in finally) so
      // runFlowWithLifecycle logs the error and shows the user notification.
      throw new Error(shared.lastError.message);
    } else {
      const execStatus = input.checkInterruption()
        ? EXECUTION_STATUS.INTERRUPTED
        : EXECUTION_STATUS.COMPLETED;
      status = executionToEndStatus(execStatus) as EndGroupStatus;
    }
  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
    throw error;
  } finally {
    // Persist conversation and todos regardless of success or failure so
    // the executions tool can show what happened before a crash.
    try {
      const writes: Promise<void>[] = [];
      if (shared.messages.length > 0) {
        writes.push(kv.write('conversation', shared.messages));
      }
      const todos = shared.stateSlices?.workspaceSnapshot?.todos?.todos;
      if (Array.isArray(todos) && todos.length > 0) {
        writes.push(kv.write('todos', todos));
      }
      await Promise.all(writes);
    } catch {
      // Best-effort — don't mask the original error
    }

    if (shared.userCancelledRetry) {
      logger.debug('Flow record preserved for resume after retry cancellation');
    } else {
      try {
        await kv.delete(`flow:${executionId}`);
      } catch {
        // Ignore cleanup errors
      }
    }

    sessionLifecycle.dispose();
    unregisterInterruptible(streamId);
  }

  const lastResponse = findLastAssistantText(shared.messages, (m) =>
    input.modelHandler.extractAssistantText(m),
  );

  return { status, lastResponse };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function persistCheckpoint(
  kv: ExecutionKVStore,
  executionId: ExecutionId,
  shared: ToolUseRunShared,
): Promise<void> {
  await kv.write(`flow:${executionId}`, {
    flowName: 'texra',
    params: {},
    shared: structuredClone(shared),
    createdAt: new Date().toISOString(),
    nodes: [],
  } satisfies FlowRecord);
}
