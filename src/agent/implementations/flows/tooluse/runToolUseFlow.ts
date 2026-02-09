/**
 * Entry point for tool-use flow execution.
 *
 * Manages session lifecycle, tool execution cycles, interrupt handling,
 * and state persistence via PersistedFlow.
 */

import { EXECUTION_STATUS, type EndGroupStatus } from '@shared/schemas';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import { PersistedFlow } from '@agent/node/persisted-flow';

import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { executionToEndStatus } from '@common/constants/streamStatus';
import type { ToolDefinition } from '@model';
import { getDefaultToolRegistry } from '@tools/registry';
import { getToolUseMemoryEnabled } from '@utils/config/constants';
import { runPersistedFlow } from '../common/runPersistedFlow';
import { ToolUsePrepareNode } from './nodes/ToolUsePrepareNode';
import { ToolUseCycleNode } from './nodes/ToolUseCycleNode';
import { ToolUseWaitNode } from './nodes/ToolUseWaitNode';
import { migrateSharedState, type ToolUseRunShared } from './nodes/types';
import { ToolUseSessionLifecycle } from './ToolUseSessionLifecycle';
import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';
import type { ToolUseServices } from './ToolUseServices';

/**
 * Input for running a tool-use flow.
 * Follows same pattern as RunReflectionFlowInput: extends BaseFlowContextInit
 * and adds flow-specific fields. toolRegistry is a separate parameter.
 */
export interface RunToolUseFlowInput<
  C = unknown,
> extends BaseFlowContextInit<C> {
  setting: AgentToolUseSetting;
  resumeSnapshot?: ToolUseSessionSnapshot | null;
  onFollowUpConsumed?: () => void;
  /** When true, proposal tools are filtered out to prevent nesting. */
  isSubagent?: boolean;
}

/** Result from running a tool-use flow. */
export interface RunToolUseFlowResult {
  status: EndGroupStatus;
  lastResponse?: string;
}

/**
 * Runtime context for tool-use flow execution (implements IInterruptible).
 * The `session` field provides direct access for follow-up operations,
 * avoiding the need to traverse through services for common operations.
 */
export interface ToolUseFlowContext<C = unknown> {
  services: ToolUseServices<C>;
  /** Direct accessor for follow-up operations (also available via services.session). */
  session: ToolUseSessionLifecycle;
  interrupt(): void;
  dispose(): void;
}

/** Setup callback invoked after context creation, before execution starts. */
export type ToolUseFlowSetupCallback = (
  context: ToolUseFlowContext<unknown>,
) => void;

/** Proposal tool names that subagents must not receive. */
const PROPOSAL_TOOLS = new Set(['propose_workflow', 'propose_agent']);

/** Options for tool resolution. */
interface ResolveToolsOptions {
  /** When true, proposal tools are filtered out to prevent nesting. */
  isSubagent?: boolean;
}

/** Resolve tool definitions from agent settings, validating against registry. */
function resolveTools(
  tools: AgentToolUseSetting['tools'],
  registry: IToolRegistry,
  logger: { warn: (msg: string) => void },
  options?: ResolveToolsOptions,
): ToolDefinition[] {
  const toolConfigs = Array.isArray(tools) ? tools : [];
  const resolved = toolConfigs
    .map((config) => (typeof config === 'string' ? { name: config } : config))
    .filter((def) => {
      if (options?.isSubagent && PROPOSAL_TOOLS.has(def.name)) return false;
      if (!registry.has(def.name)) {
        logger.warn(`Tool "${def.name}" not found in registry`);
        return false;
      }
      return true;
    });
  if (getToolUseMemoryEnabled() && !resolved.some((d) => d.name === 'memory')) {
    const memoryTool = registry.get('memory');
    if (memoryTool) {
      resolved.push(memoryTool.definition);
    } else {
      logger.warn('Memory tool not found in registry');
    }
  }
  return resolved;
}

/**
 * Run a tool-use flow. Interrupt registration is handled automatically.
 * @param input - Flow input (extends BaseFlowContextInit with tool-use fields)
 * @param toolRegistry - Optional tool registry (defaults to global registry)
 * @param onSetup - Optional callback invoked after context creation
 */
export async function runToolUseFlow<C = unknown>(
  input: RunToolUseFlowInput<C>,
  toolRegistry?: IToolRegistry,
  onSetup?: ToolUseFlowSetupCallback,
): Promise<RunToolUseFlowResult> {
  const { logger, streamId, executionId, setting, onInterrupt } = input;
  const snapshot = input.resumeSnapshot ?? null;
  const sessionLifecycle = new ToolUseSessionLifecycle(streamId);
  const registry = toolRegistry ?? getDefaultToolRegistry();
  const resolvedTools = resolveTools(setting.tools, registry, logger, {
    isSubagent: input.isSubagent,
  });

  // Build services: spread input + add computed fields (matches reflection flow pattern)
  const services: ToolUseServices<C> = {
    ...input,
    session: sessionLifecycle,
    resolvedTools,
    toolRegistry: registry,
    snapshot,
    onRoundFinalized: input.onRoundFinalized ?? (async () => {}),
  };

  const flowContext: ToolUseFlowContext<C> = {
    services,
    session: sessionLifecycle,
    interrupt(): void {
      onInterrupt?.();
      retryCoordinator.clearRequest(streamId);
      sessionLifecycle.interrupt();
    },
    dispose(): void {
      sessionLifecycle.dispose();
    },
  };

  // Track shared across the execute closure for lastResponse extraction
  const shared: ToolUseRunShared = {
    messages: [],
    shouldSkipCycle: false,
    stateSlices: null,
  };

  let status: EndGroupStatus;
  try {
    status = await runPersistedFlow<ToolUseRunShared>({
      ctx: { streamId, executionId, logger },
      interruptible: flowContext,

      migrateResume: async (flowRecord, kv) => {
        const migrationResult = migrateSharedState(flowRecord.shared);
        if (migrationResult === null) return null;
        if (migrationResult.migrated) {
          logger.debug('Migrated legacy shared state to flat format');
          flowRecord.shared = migrationResult.data;
          await kv.write(`flow:${executionId}`, flowRecord);
        }
        return flowRecord;
      },

      execute: async (resume) => {
        onSetup?.(flowContext);

        const prepareNode = new ToolUsePrepareNode<C>();
        const cycleNode = new ToolUseCycleNode<C>();
        const waitNode = new ToolUseWaitNode<C>();
        prepareNode.next(cycleNode);
        cycleNode.next(waitNode);
        waitNode.on(FlowTransition.CONTINUE, cycleNode);

        const pf = new PersistedFlow<
          ToolUseRunShared,
          Record<string, unknown>,
          ToolUseServices<C>
        >(prepareNode, resume.kv);
        pf.setServices(flowContext.services);
        await pf.run(shared);

        const execStatus = input.checkInterruption()
          ? EXECUTION_STATUS.INTERRUPTED
          : EXECUTION_STATUS.COMPLETED;
        return executionToEndStatus(execStatus) as EndGroupStatus;
      },

      preserveFlowRecord: () => {
        if (shared.userCancelledRetry) {
          logger.debug('Flow record preserved for resume after retry cancellation');
          return true;
        }
        return false;
      },
    });
  } finally {
    flowContext.dispose();
  }

  // Extract last assistant text using the model handler's typed extraction
  let lastResponse: string | undefined;
  for (let i = shared.messages.length - 1; i >= 0; i--) {
    const text = input.modelHandler.extractAssistantText(shared.messages[i]);
    if (text !== undefined) {
      lastResponse = text;
      break;
    }
  }

  return { status, lastResponse };
}
