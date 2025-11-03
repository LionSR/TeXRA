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
  run: () => Promise<T>,
): Promise<T> {
  contextStack.push(context);
  const maybeCleanup = () => {
    contextStack.pop();
  };

  const result = run();
  if (result instanceof Promise) {
    return result.finally(maybeCleanup);
  }

  try {
    return Promise.resolve(result);
  } finally {
    maybeCleanup();
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
