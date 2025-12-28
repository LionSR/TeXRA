// Local imports - agent
import type { ToolUseFlowContext } from '@agent/implementations/flows/tooluse';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

/**
 * Common interface for anything that can handle tool-use session interruption.
 */
export interface IInterruptible {
  interrupt(): void;
}

// Registry stores flow contexts that can be interrupted
const registry = new Map<StreamTabId, IInterruptible>();

// Flow context registration
export function registerToolUseFlowContext(
  streamTabId: StreamTabId,
  context: ToolUseFlowContext<any>,
): void {
  registry.set(streamTabId, context);
}

export function unregisterToolUseFlowContext(streamTabId: StreamTabId): void {
  registry.delete(streamTabId);
}

export function getToolUseFlowContext(
  streamTabId: StreamTabId,
): ToolUseFlowContext<any> | undefined {
  const entry = registry.get(streamTabId);
  // Type guard: check if it's a ToolUseFlowContext
  if (entry && 'services' in entry) {
    return entry as ToolUseFlowContext<any>;
  }
  return undefined;
}

/**
 * Get the interruptible entry (agent or flow context) for a stream.
 */
export function getInterruptible(
  streamTabId: StreamTabId,
): IInterruptible | undefined {
  return registry.get(streamTabId);
}

/**
 * Remove registry entries for streams that no longer have an active tool-use session.
 */
export function cleanupInactiveAgents(activeStreams: Set<StreamTabId>): void {
  for (const streamId of registry.keys()) {
    if (!activeStreams.has(streamId)) {
      registry.delete(streamId);
    }
  }
}
