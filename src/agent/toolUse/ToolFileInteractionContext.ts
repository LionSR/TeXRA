// Type imports
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
// Internal imports
import { FileInteractionState } from '@agent/core/AgentWorkspaceState';

export interface ToolFileInteractionContext {
  streamId?: StreamTabId;
  executionId?: ExecutionId;
  toolCallId?: string;
  tracker: FileInteractionState;
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
