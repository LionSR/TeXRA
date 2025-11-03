// Local imports - agent types
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

export interface ToolEditApprovalContext {
  streamId?: StreamTabId;
  executionId?: ExecutionId;
  toolCallId?: string;
}

const contextStack: ToolEditApprovalContext[] = [];

export function withToolEditApprovalContext<T>(
  context: ToolEditApprovalContext,
  run: () => Promise<T> | T,
): Promise<T> {
  contextStack.push(context);
  const maybeCleanup = () => {
    const last = contextStack.pop();
    if (last !== context) {
      const index = contextStack.lastIndexOf(context);
      if (index >= 0) {
        contextStack.splice(index, 1);
      }
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

export function getCurrentToolEditApprovalContext():
  | ToolEditApprovalContext
  | undefined {
  if (contextStack.length === 0) {
    return undefined;
  }
  return contextStack[contextStack.length - 1];
}
