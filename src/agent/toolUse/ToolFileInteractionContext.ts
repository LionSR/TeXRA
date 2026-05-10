// Type imports
import type {
  FileInteractionState,
  PlanState,
  TodoState,
} from '@agent/core/AgentWorkspaceState';
import {
  getAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { NestedDelegationConfig } from '@shared/constants/delegationPolicy';

/**
 * Fields that describe the run executing a tool call.
 *
 * These are candidates for RunContext ownership. New code should prefer passing
 * them explicitly from the run boundary rather than reading the process-wide
 * tool-call stack directly.
 */
export interface ToolRunContext {
  streamId?: StreamTabId;
  executionId?: ExecutionId;
  /** Model short name of the parent agent (e.g. "opus46T", "sonnet46T"). */
  model?: string;
  /** Agent name of the parent agent (e.g. "orchestrator", "search-agent"). */
  agentName?: string;
  /** Working directory override for tool calls (e.g. a git worktree path). */
  workingDirectory?: string;
  /** Runtime host inherited from the executing agent. */
  runtimeHost?: AgentRuntimeHost;
  /**
   * Delegation depth of the agent executing this tool call. 0 for root (user-initiated),
   * N for an agent N levels deep. Read by delegation tools to compute the child's depth.
   */
  delegationDepth?: number;
  /**
   * Delegation policy snapshot for the executing agent. Keeps delegation tool
   * enforcement aligned with the tool list shown to the model without carrying
   * a second depth value.
   */
  delegationConfig?: NestedDelegationConfig;
}

/** Fields that belong to one concrete tool call or tool-cycle state snapshot. */
export interface ToolCallContext {
  toolCallId?: string;
  tracker: FileInteractionState;
  /** Todo state for managing task lists. Optional for backward compatibility. */
  todoState?: TodoState;
  /** Plan state for managing implementation plans. Optional for backward compatibility. */
  planState?: PlanState;
  /** Called by tools with approval flows to trigger in-progress log after approval. */
  onExecutionReady?: () => void;
  /** Called by tools to push partial output for live streaming to the UI. */
  onToolOutput?: (chunk: string) => void;
}

export interface ToolFileInteractionContext
  extends ToolRunContext, ToolCallContext {}

const contextStack: ToolFileInteractionContext[] = [];

export function withToolFileInteractionContext<T>(
  context: ToolFileInteractionContext,
  run: () => Promise<T> | T,
): Promise<T> {
  contextStack.push(context);

  function cleanup(): void {
    const index = contextStack.lastIndexOf(context);
    if (index >= 0) {
      contextStack.splice(index, 1);
    }
  }

  try {
    const result = run();
    return Promise.resolve(result).finally(cleanup);
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function getCurrentToolFileInteractionContext():
  | ToolFileInteractionContext
  | undefined {
  return contextStack.at(-1);
}

function getCurrentToolRunContext(): ToolRunContext | undefined {
  const context = getCurrentToolFileInteractionContext();
  if (!context) return undefined;
  const {
    streamId,
    executionId,
    model,
    agentName,
    workingDirectory,
    runtimeHost,
    delegationDepth,
    delegationConfig,
  } = context;
  return {
    streamId,
    executionId,
    model,
    agentName,
    workingDirectory,
    runtimeHost,
    delegationDepth,
    delegationConfig,
  };
}

export function getCurrentToolRuntimeHost(): AgentRuntimeHost {
  return getCurrentToolRunContext()?.runtimeHost ?? getAgentRuntimeHost();
}
