// Type imports
import type {
  FileInteractionState,
  PlanState,
  TodoState,
} from '@agent/core/AgentWorkspaceState';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { ToolConfig } from '@shared/schemas/toolConfig';

export interface ToolFileInteractionContext {
  streamId?: StreamTabId;
  executionId?: ExecutionId;
  toolCallId?: string;
  /** Model short name of the parent agent (e.g. "opus46T", "sonnet46T"). */
  model?: string;
  /** Agent name of the parent agent (e.g. "orchestrator", "search-agent"). */
  agentName?: string;
  /** Parent agent's tool configuration (extraction flags, etc.). Used by delegation tools to inherit settings. */
  toolConfig?: ToolConfig;
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
