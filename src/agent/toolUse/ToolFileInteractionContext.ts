// Third-party imports
import { AsyncLocalStorage } from 'async_hooks';

// Type imports
import type {
  FileInteractionState,
  WorkPlanState,
} from '@agent/core/AgentWorkspaceState';
import { tryUseRunContext, type RunContext } from '@agent/runtime/RunContext';

/** Fields that belong to one concrete tool call or tool-cycle state snapshot. */
export interface ToolCallContext {
  toolCallId?: string;
  tracker: FileInteractionState;
  /** Plan and todo progress state. Absent in contexts without work-plan support. */
  workPlanState?: WorkPlanState;
  /** Called by tools with approval flows to trigger in-progress log after approval. */
  onExecutionReady?: () => void;
  /** Called by tools to push partial output for live streaming to the UI. */
  onToolOutput?: (chunk: string) => void;
}

export interface CurrentToolContexts {
  runContext: RunContext | undefined;
  callContext: ToolCallContext;
}

const contextStackScope = new AsyncLocalStorage<readonly ToolCallContext[]>();

export function withToolFileInteractionContext<T>(
  context: ToolCallContext,
  run: () => Promise<T> | T,
): Promise<T> {
  try {
    const parentStack = contextStackScope.getStore() ?? [];
    return contextStackScope.run([...parentStack, context], async () => run());
  } catch (error) {
    return Promise.reject(error);
  }
}

export function getCurrentToolCallContext(): ToolCallContext | undefined {
  return contextStackScope.getStore()?.at(-1);
}

export function getCurrentToolContexts(): CurrentToolContexts | undefined {
  const callContext = getCurrentToolCallContext();
  if (!callContext) {
    return undefined;
  }
  return {
    runContext: tryUseRunContext(),
    callContext,
  };
}
