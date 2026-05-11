// Third-party imports
import { AsyncLocalStorage } from 'async_hooks';

// Type imports
import type {
  FileInteractionState,
  PlanState,
  TodoState,
} from '@agent/core/AgentWorkspaceState';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
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

interface ToolContextFrame {
  full: ToolFileInteractionContext;
  run: ToolRunContext;
  call: ToolCallContext;
}

export interface CurrentToolContexts {
  runContext: ToolRunContext;
  callContext: ToolCallContext;
}

const contextStackScope = new AsyncLocalStorage<readonly ToolContextFrame[]>();

type ContextKeyMap<T> = { [K in keyof T]-?: true };

const TOOL_RUN_CONTEXT_KEYS = {
  streamId: true,
  executionId: true,
  model: true,
  agentName: true,
  workingDirectory: true,
  runtimeHost: true,
  delegationDepth: true,
  delegationConfig: true,
} satisfies ContextKeyMap<ToolRunContext>;

const TOOL_CALL_CONTEXT_KEYS = {
  toolCallId: true,
  tracker: true,
  todoState: true,
  planState: true,
  onExecutionReady: true,
  onToolOutput: true,
} satisfies ContextKeyMap<ToolCallContext>;

function pickContextFields<T extends object>(
  context: T,
  keyMap: ContextKeyMap<T>,
): T {
  const fields = {} as T;
  for (const key of Object.keys(keyMap) as (keyof T)[]) {
    fields[key] = context[key];
  }
  return fields;
}

function buildContextFrame(
  context: ToolFileInteractionContext,
): ToolContextFrame {
  return {
    full: context,
    run: pickContextFields<ToolRunContext>(context, TOOL_RUN_CONTEXT_KEYS),
    call: pickContextFields<ToolCallContext>(context, TOOL_CALL_CONTEXT_KEYS),
  };
}

export function withToolFileInteractionContext<T>(
  context: ToolFileInteractionContext,
  run: () => Promise<T> | T,
): Promise<T> {
  try {
    const parentStack = contextStackScope.getStore() ?? [];
    return contextStackScope.run(
      [...parentStack, buildContextFrame(context)],
      async () => run(),
    );
  } catch (error) {
    return Promise.reject(error);
  }
}

export function getCurrentToolFileInteractionContext():
  | ToolFileInteractionContext
  | undefined {
  return contextStackScope.getStore()?.at(-1)?.full;
}

export function getCurrentToolRunContext(): ToolRunContext | undefined {
  return contextStackScope.getStore()?.at(-1)?.run;
}

export function getCurrentToolCallContext(): ToolCallContext | undefined {
  return contextStackScope.getStore()?.at(-1)?.call;
}

export function getCurrentToolContexts(): CurrentToolContexts | undefined {
  const frame = contextStackScope.getStore()?.at(-1);
  if (!frame) {
    return undefined;
  }

  return {
    runContext: frame.run,
    callContext: frame.call,
  };
}
