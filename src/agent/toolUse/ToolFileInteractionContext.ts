// Type imports
import {
  FileInteractionState,
  TodoState,
} from '@agent/core/AgentWorkspaceState';
import type { ExecutionId, StreamTabId } from '@shared/identifiers';
// Internal imports

export interface ToolFileInteractionContext {
  streamId?: StreamTabId;
  executionId?: ExecutionId;
  toolCallId?: string;
  tracker: FileInteractionState;
  /** Todo state for managing task lists. Optional for backward compatibility. */
  todoState?: TodoState;
}

const contextStack: ToolFileInteractionContext[] = [];

export function withToolFileInteractionContext<T>(
  context: ToolFileInteractionContext,
  run: () => Promise<T> | T,
): Promise<T> {
  contextStack.push(context);
  const maybeCleanup = () => {
    const index = contextStack.lastIndexOf(context);
    if (index >= 0) {
      contextStack.splice(index, 1);
    }
  };

  try {
    const result = run();
    return Promise.resolve(result).finally(maybeCleanup);
  } catch (error) {
    maybeCleanup();
    throw error;
  }
}

export function getCurrentToolFileInteractionContext():
  | ToolFileInteractionContext
  | undefined {
  if (contextStack.length === 0) {
    return undefined;
  }
  return contextStack.at(-1);
}
