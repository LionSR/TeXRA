// Type imports
import {
  FileInteractionState,
  TodoState,
} from '@agent/core/AgentWorkspaceState';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

export interface ToolFileInteractionContext {
  streamId?: StreamTabId;
  executionId?: ExecutionId;
  toolCallId?: string;
  tracker: FileInteractionState;
  /** Todo state for managing task lists. Optional for backward compatibility. */
  todoState?: TodoState;
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
